import {
  LLMProviderError,
  type CandidateSet,
  type ChatMessage,
  type ChatResult,
  type ExtractionMeta,
  type ExtractionResult,
  type LLMClient,
  type LLMMessage,
  type ResolutionBody,
  type ToolCall,
  type ToolDef,
} from "../types";
import {
  buildExtractionRetryPrompt,
  buildExtractionSystemPrompt,
  buildResolutionRetryPrompt,
  buildResolutionSystemPrompt,
} from "./prompts";
import { ExtractionValidationError, parseExtraction, danglingEdgeViolations, type RawExtraction } from "./validate";
import { ResolutionValidationError, parseResolution } from "../graph/validate";

/**
 * OpenRouter implementation of the LLMClient abstraction (§7).
 *
 * Nothing outside this module may know this class exists or import anything
 * OpenRouter-specific. The chat and extraction code in app.ts calls the
 * interface only.
 */

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = "openai/gpt-4o-mini";

type OpenRouterRole = "system" | "user" | "assistant" | "tool";

/** One OpenAI-style function call as it travels over the wire. */
interface WireToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface WireMessage {
  role: OpenRouterRole;
  content: string | null;
  tool_calls?: WireToolCall[];
  tool_call_id?: string;
}

interface CompletePayload {
  model: string;
  messages: WireMessage[];
  tools?: ToolDef[];
}

interface OpenRouterMessage {
  content?: string | null;
  tool_calls?: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string } }>;
}

interface OpenRouterResponse {
  choices?: { message?: OpenRouterMessage }[];
  error?: { message?: string };
}

/**
 * Structural fetch signature. `typeof fetch` in Bun carries extra members
 * (preconnect) that make test doubles awkward to type; this keeps libraries
 * and fakes interchangeable.
 */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface OpenRouterClientOptions {
  /** Defaults to OPENROUTER_API_KEY. */
  apiKey?: string;
  /** Defaults to OPENROUTER_MODEL (then a sane default). */
  model?: string;
  /** Per-call timeout in ms. Default 90s. */
  timeoutMs?: number;
  /**
   * Transport retries for TRANSIENT failures only: network errors and HTTP
   * 408/429/5xx. Client errors (400/401/402/403/404) are never retried — a
   * retry cannot fix a bad key or malformed body. Default 1 (so a hiccup like
   * OpenRouter's "Provider returned error" becomes an automatic retry instead
   * of a 502 surfacing in the app). Schema-output retries (extract/resolve)
   * are separate and untouched.
   */
  retries?: number;
  /** Delay before each retry, ms. Default 400 (tests pass 0). */
  retryDelayMs?: number;
  /** Test seam: override the OpenRouter endpoint. */
  baseUrl?: string;
  /** Test seam: inject a fetch implementation. */
  fetchImpl?: FetchLike;
}

export class OpenRouterClient implements LLMClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly retryDelayMs: number;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: OpenRouterClientOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY ?? "";
    if (!this.apiKey) {
      throw new Error("OPENROUTER_API_KEY is required — set it in .env (see .env.example) or pass options.apiKey");
    }
    this.model = options.model ?? process.env.OPENROUTER_MODEL ?? DEFAULT_MODEL;
    this.timeoutMs = options.timeoutMs ?? 90_000;
    this.retries = options.retries ?? 1;
    this.retryDelayMs = options.retryDelayMs ?? 400;
    this.baseUrl = options.baseUrl ?? OPENROUTER_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Phase 3.5 §7 — chat with optional tool calling. `tools` are forwarded
   * VERBATIM in the request body (this client never interprets what a tool
   * does), and `tool_calls` are parsed out of the response generically.
   * Returns either a plain reply or the requested tool calls — looping (the
   * "execute then call chat() again" step) is the caller's decision, which is
   * what keeps this class from ever learning what "search_graph" means.
   *
   * A reply-less response is only an error when NO tool calls came back:
   * `content: null` + tool_calls is the normal assistant shape when a model
   * asks to use a tool.
   */
  async chat(messages: LLMMessage[], tools?: ToolDef[], model?: string): Promise<ChatResult> {
    const payload: CompletePayload = {
      model: model ?? this.model,
      messages: messages.map(toWireMessage),
      ...(tools && tools.length > 0 ? { tools } : {}),
    };
    const message = await this.request(payload);
    const toolCalls = parseToolCalls(message.tool_calls);
    const reply =
      typeof message.content === "string" && message.content.trim() !== "" ? message.content : undefined;
    if (reply === undefined && toolCalls.length === 0) {
      throw new LLMProviderError("OpenRouter returned an empty completion", JSON.stringify(message).slice(0, 300));
    }
    return toolCalls.length > 0 ? { reply, tool_calls: toolCalls } : { reply };
  }

  /**
   * Runs one model call with the standard prompt and validates the output.
   * On any parse/validation failure, retries once with the stricter retry
   * prompt (§6); a second failure throws LLMProviderError, which the API layer
   * surfaces as a 502. Transport failures get request()'s bounded retry
   * (network / 408/429/5xx) — they are not "bad schema output" and must never
   * be retried as such.
   *
   * Dangling-edge handling (B + C + drop-fallback):
   * - First attempt: parse with parseExtraction. If valid but has dangling
   *   edges (detected via danglingEdgeViolations), retry ONCE with specific
   *   feedback so the model can fix the edge endpoints (usually saves the edge).
   * - Second attempt: if still has dangling edges, parseExtraction's
   *   drop-fallback silently removes them — extraction NEVER hard-fails on
   *   dangling edges (no 502 of this class).
   * - Structural failures (invalid JSON, missing fields, etc.) still follow
   *   the original two-attempt retry loop and 502 after two bad outputs.
   */
  async extract(transcript: ChatMessage[], meta: ExtractionMeta, model?: string): Promise<ExtractionResult> {
    const systemPrompt = buildExtractionSystemPrompt();
    const retryPrompt = buildExtractionRetryPrompt();

    // First attempt with the standard system prompt
    let raw = await this.complete({
      model: model ?? this.model,
      messages: [
        { role: "system", content: systemPrompt },
        ...transcript.map(({ role, content }) => ({ role, content })),
      ],
    });

    let parsed: unknown;
    try {
      parsed = parseModelJson(raw);
    } catch (err) {
      if (!(err instanceof ExtractionValidationError)) throw err;
      // JSON parse failed — fall through to structural retry logic below
      parsed = null;
    }

    let body: RawExtraction | null = null;
    if (parsed !== null) {
      try {
        body = parseExtraction(parsed);
      } catch (err) {
        if (!(err instanceof ExtractionValidationError)) throw err;
        // Structural validation failed — fall through to structural retry logic below
        body = null;
      }
    }

    // If we have a structurally valid extraction, check for dangling edges
    if (body !== null) {
      const violations = danglingEdgeViolations(parsed);
      if (violations.length === 0) {
        // Clean extraction — no dangling edges, return it
        return {
          ...body,
          conversation_id: meta.conversation_id,
          extracted_at: new Date().toISOString(),
          raw_source_ref: meta.raw_source_ref,
        };
      }
      // Has dangling edges — retry ONCE with specific feedback
      const feedback = violations.join("\n");
      const retrySystemPrompt = buildExtractionRetryPrompt(feedback);
      raw = await this.complete({
        model: model ?? this.model,
        messages: [
          { role: "system", content: retrySystemPrompt },
          ...transcript.map(({ role, content }) => ({ role, content })),
        ],
      });
      try {
        parsed = parseModelJson(raw);
        body = parseExtraction(parsed);
        // parseExtraction drops dangling edges (drop-fallback), so this never
        // throws on dangling edges. Structural failures still throw.
        return {
          ...body,
          conversation_id: meta.conversation_id,
          extracted_at: new Date().toISOString(),
          raw_source_ref: meta.raw_source_ref,
        };
      } catch (err) {
        if (!(err instanceof ExtractionValidationError)) throw err;
        // Structural failure on retry — this is the second bad output, 502
        throw new LLMProviderError(
          "Model output did not match the extraction schema after retry",
          err.message,
        );
      }
    }

    // Structural failure on first attempt — retry once with the standard retry prompt
    const retrySystemPrompt = buildExtractionRetryPrompt();
    raw = await this.complete({
      model: model ?? this.model,
      messages: [
        { role: "system", content: retrySystemPrompt },
        ...transcript.map(({ role, content }) => ({ role, content })),
      ],
    });
    try {
      parsed = parseModelJson(raw);
      body = parseExtraction(parsed);
      return {
        ...body,
        conversation_id: meta.conversation_id,
        extracted_at: new Date().toISOString(),
        raw_source_ref: meta.raw_source_ref,
      };
    } catch (err) {
      if (!(err instanceof ExtractionValidationError)) throw err;
      // Second structural failure — 502
      throw new LLMProviderError(
        "Model output did not match the extraction schema after retry",
        err.message,
      );
    }
  }

  async listModels(): Promise<string[]> {
    // Return a stable hardcoded list for now; the OpenRouter endpoint is
    // intentionally opaque and changes often. Hardcoded lets the UI offer
    // a predictable choice without a network round-trip on every page load.
    return ["openai/gpt-4o-mini", "openai/gpt-4o", "anthropic/claude-3-haiku", "meta-llama/llama-3.1-8b-instruct:free", "mistralai/mistral-7b-instruct:free"];
  }

  /**
   * Phase 3 §7 — LLM call #2. Same schema-retry pattern as extract(): parse +
   * validate, retry once with the stricter prompt on structural failure, then
   * a 502-style LLMProviderError rather than writing anything malformed.
   * Transport failures get request()'s bounded retry; they are never retried
   * as schema failures. Returns the validated model body; the resolver
   * enriches it with resolution id / source ref / timestamp (spec §7).
   */
  async resolve(extraction: ExtractionResult, candidates: CandidateSet, model?: string): Promise<ResolutionBody> {
    const attempts = [buildResolutionSystemPrompt(), buildResolutionRetryPrompt()];
    for (const system of attempts) {
      const raw = await this.complete({
        model: model ?? this.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: JSON.stringify({ extraction, candidates }) },
        ],
      });
      try {
        return parseResolution(parseModelJson(raw));
      } catch (err) {
        // Malformed output includes both broken JSON (ExtractionValidationError
        // from parseModelJson) and schema/business-rule violations
        // (ResolutionValidationError). Either way the retry prompt re-runs;
        // transport/provider failures (LLMProviderError) never retry.
        const malformed = err instanceof ResolutionValidationError || err instanceof ExtractionValidationError;
        if (!malformed) throw err;
        const isLastAttempt = attempts.indexOf(system) === attempts.length - 1;
        if (isLastAttempt) {
          throw new LLMProviderError(
            "Model output did not match the resolution schema after retry",
            err.message,
          );
        }
        // First attempt failed validation -> loop retries with the stricter prompt.
      }
    }
    throw new LLMProviderError("Model output did not match the resolution schema after retry", "unreachable");
  }

  /** Raw model message from one completion call — the transport layer shared by
   * chat (which may also read tool_calls) and complete (which requires text).
   * Bounded transport retry: transient failures only (network, 408/429/5xx).
   * The payload is rebuilt verbatim by the caller on each attempt, so retrying
   * is safe — these POSTs are idempotent from the provider's perspective. */
  private async request(payload: CompletePayload): Promise<OpenRouterMessage> {
    const attempts = 1 + this.retries;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(this.baseUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        if (attempt < attempts) {
          await sleep(this.retryDelayMs);
          continue;
        }
        const detail = err instanceof Error ? err.message : String(err);
        throw new LLMProviderError("LLM request failed or timed out", detail);
      }

      if (res.ok) {
        const data = (await res.json()) as OpenRouterResponse;
        const message = data.choices?.[0]?.message;
        if (!message) {
          throw new LLMProviderError("OpenRouter returned an empty completion", JSON.stringify(data).slice(0, 300));
        }
        return message;
      }

      let providerMessage = `HTTP ${res.status}`;
      try {
        const json = (await res.json()) as OpenRouterResponse;
        if (json?.error?.message) providerMessage = json.error.message;
      } catch {
        // Non-JSON error body — keep the HTTP status text.
      }
      if (attempt < attempts && isTransientStatus(res.status)) {
        await sleep(this.retryDelayMs);
        continue;
      }
      throw new LLMProviderError(`OpenRouter request failed (${res.status})`, providerMessage);
    }
    throw new LLMProviderError("OpenRouter request failed", "unreachable");
  }

  /** Plain-text completion for extract()/resolve() — unchanged Phase 1/3 path.
   * Unlike chat(), an empty content is ALWAYS an error here: these callers
   * have no tool_calls to fall back on. */
  private async complete(payload: CompletePayload): Promise<string> {
    const content = (await this.request(payload)).content;
    if (typeof content !== "string" || content.trim() === "") {
      throw new LLMProviderError("OpenRouter returned an empty completion", JSON.stringify(content).slice(0, 300));
    }
    return content;
  }
}

/** True for statuses a retry can plausibly fix: too-many-requests, and
 * upstream/provider errors (OpenRouter's "Provider returned error" arrives as
 * a 5xx). 4xx client errors are excluded — retrying a bad key/body is worse
 * than failing fast. */
function isTransientStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Map an LLMMessage to the provider's wire shape. Assumes OpenAI/OpenRouter
 * conventions: assistant messages carrying tool_calls use `content: null`
 * (or omitted) — `""` would not round-trip cleanly through every provider.
 */
function toWireMessage(m: LLMMessage): WireMessage {
  const base: WireMessage = { role: m.role, content: m.content };
  if (m.tool_calls && m.tool_calls.length > 0) {
    base.tool_calls = m.tool_calls.map((tc) => ({
      id: tc.id,
      type: "function",
      function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
    }));
    if (base.content === "") base.content = null;
  }
  if (m.tool_call_id) base.tool_call_id = m.tool_call_id;
  return base;
}

/**
 * Parse the provider's tool_calls into the generic ToolCall shape, decoding
 * each call's JSON-stringified arguments. Malformed calls are a provider/model
 * output failure, not something the caller can repair — same philosophy as
 * schema-invalid extraction output: throw LLMProviderError (→ 502).
 */
function parseToolCalls(raw: OpenRouterMessage["tool_calls"]): ToolCall[] {
  if (!Array.isArray(raw)) return [];
  const calls: ToolCall[] = [];
  for (const [index, tc] of raw.entries()) {
    if (tc && tc.type && tc.type !== "function") continue; // only function calls today
    const name = tc?.function?.name;
    if (typeof name !== "string" || name === "") {
      throw new LLMProviderError("OpenRouter returned a malformed tool_call", JSON.stringify(tc).slice(0, 300));
    }
    // The id must be echoed back as tool_call_id on the tool result; if the
    // provider omitted it, synthesize one (the caller owns both sides of the
    // round trip, so a synthesized id round-trips consistently).
    const id = tc && typeof tc.id === "string" && tc.id !== "" ? tc.id : `call_${index}`;
    const rawArgs = tc?.function?.arguments;
    let parsed: Record<string, unknown> = {};
    if (typeof rawArgs === "string" && rawArgs.trim() !== "") {
      let value: unknown;
      try {
        value = JSON.parse(rawArgs);
      } catch {
        throw new LLMProviderError(
          "OpenRouter returned tool_call arguments that are not valid JSON",
          rawArgs.slice(0, 300),
        );
      }
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new LLMProviderError("OpenRouter returned non-object tool_call arguments", JSON.stringify(value).slice(0, 300));
      }
      parsed = value as Record<string, unknown>;
    }
    calls.push({ id, name, arguments: parsed });
  }
  return calls;
}

/** Parse model output as JSON, tolerating ```json ... ``` fences. */
function parseModelJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Fall through to fence-stripping.
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced?.[1] ?? trimmed.replace(/^```(?:json)?/, "").replace(/```$/, "")).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    throw new ExtractionValidationError("model output is not valid JSON");
  }
}