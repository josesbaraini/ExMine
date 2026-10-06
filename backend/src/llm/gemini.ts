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
 * Google AI Studio (Gemini) implementation of the LLMClient abstraction.
 * Structurally mirrors OpenRouterClient: same LLMClient interface, same
 * validate→retry→502 philosophy in extract()/resolve(), and the same bounded
 * transport retry in chat(). Nothing outside this module may import
 * Gemini-specific types or endpoints.
 */

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
// Verified live with the project's key: gemini-2.5-flash-lite / 2.5-flash /
// 2.5-pro 404 ("no longer available to new users"), and the non-lite flagships
// 503 under demand. The lite tier answers reliably.
const DEFAULT_MODEL = "gemini-3.5-flash-lite";

interface GeminiContent {
  role: "user" | "model" | "system";
  parts: Array<{
    text?: string;
    functionCall?: { name: string; args: Record<string, unknown> };
    functionResponse?: { name: string; response: Record<string, unknown> };
    /** Provider round-trip metadata, e.g. thought_signature for Gemini 3.x. */
    [extra: string]: unknown;
  }>;
}

interface GeminiTool {
  functionDeclarations: Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }>;
}

interface GeminiResponsePart {
  text?: string;
  functionCall?: { name?: string; args?: Record<string, unknown> };
  thoughtSignature?: string;
  thought_signature?: string;
}

interface GeminiCandidate {
  content?: { parts?: GeminiResponsePart[] };
}

interface GeminiResponse {
  candidates?: GeminiCandidate[];
  error?: { message?: string };
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * The ONLY models this project offers, in reliability order (lite tier first —
 * it answers reliably while the non-lite flagships 503 under demand).
 *
 * This is an allowlist on purpose. Google lists ~44 generateContent models on a
 * fresh key, including ids that can only ever fail here: `nano-banana-*`
 * (image), the whole `gemini-2.5` family (404 "no longer available to new
 * users"), `gemini-flash-latest` / `gemini-3.7-flash` (503), tts, lyria,
 * embedding, robotics, antigravity. A blocklist regex leaks the next one we
 * haven't met yet — an allowlist cannot.
 *
 * Every id here returned HTTP 200 on the live gate's tool round trip. Re-verify
 * with `bun run test:live` after any provider change and extend this list only
 * with ids that actually pass.
 */
const TESTED_MODELS = [
  "gemini-3.5-flash-lite",
  "gemini-flash-lite-latest",
  "gemini-3.5-flash",
  "gemini-3.6-flash",
];

export interface GeminiClientOptions {
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
  baseUrl?: string;
  fetchImpl?: FetchLike;
}

export class GeminiClient implements LLMClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly retryDelayMs: number;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: GeminiClientOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.GEMINISTUDIO_API_KEY ?? "";
    if (!this.apiKey) {
      throw new Error("GEMINISTUDIO_API_KEY is required — set it in .env or pass options.apiKey");
    }
    this.model = options.model ?? process.env.GEMINI_MODEL ?? DEFAULT_MODEL;
    this.timeoutMs = options.timeoutMs ?? 90_000;
    this.retries = options.retries ?? 1;
    this.retryDelayMs = options.retryDelayMs ?? 400;
    this.baseUrl = options.baseUrl ?? GEMINI_BASE;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Offer only TESTED_MODELS that this key can still see. The live call keeps
   * the list honest when Google retires an id mid-project; the allowlist keeps
   * it safe when Google ADDS one (nano-banana, gemma, tts, …). If the listing
   * itself fails we still return the allowlist — those ids are known-good.
   */
  async listModels(): Promise<string[]> {
    try {
      const url = `${this.baseUrl}?key=${this.apiKey}`;
      const res = await this.fetchImpl(url, { method: "GET" });
      const data = (await res.json()) as { models?: Array<{ name?: string }> };
      if (!res.ok || !Array.isArray(data?.models)) return [...TESTED_MODELS];
      const visible = new Set(
        data.models
          .filter((m) => typeof m.name === "string")
          .map((m) => (m.name as string).replace(/^models\//, "")),
      );
      const available = TESTED_MODELS.filter((id) => visible.has(id));
      return available.length > 0 ? available : [...TESTED_MODELS];
    } catch {
      return [...TESTED_MODELS];
    }
  }

  async chat(messages: LLMMessage[], tools?: ToolDef[], model?: string): Promise<ChatResult> {
    const contents = toGeminiContents(messages);
    const payload: Record<string, unknown> = {
      contents,
      ...(tools && tools.length > 0 ? { tools: [toGeminiTools(tools)] } : {}),
    };
    const data = await this.request(payload, model);
    const parts = data.candidates?.[0]?.content?.parts ?? [];
    const toolCalls = parseGeminiFunctionCalls(parts);
    const reply = parts.find((p) => typeof p.text === "string" && p.text.trim() !== "")?.text;
    if (reply === undefined && toolCalls.length === 0) {
      throw new LLMProviderError("Gemini returned an empty completion", JSON.stringify(data).slice(0, 300));
    }
    return toolCalls.length > 0 ? { reply, tool_calls: toolCalls } : { reply };
  }

  async extract(transcript: ChatMessage[], meta: ExtractionMeta, model?: string): Promise<ExtractionResult> {
    const systemPrompt = buildExtractionSystemPrompt();
    let raw = await this.completeGemini([
      { role: "user", parts: [{ text: systemPrompt + "\n\n" + transcript.map((m) => `${m.role}: ${m.content}`).join("\n") }] },
    ], model);
    let parsed: unknown;
    try {
      parsed = parseModelJson(raw);
    } catch (err) {
      if (!(err instanceof ExtractionValidationError)) throw err;
      parsed = null;
    }
    let body: RawExtraction | null = null;
    if (parsed !== null) {
      try {
        body = parseExtraction(parsed);
      } catch (err) {
        if (!(err instanceof ExtractionValidationError)) throw err;
        body = null;
      }
    }
    if (body !== null) {
      const violations = danglingEdgeViolations(parsed);
      if (violations.length === 0) {
        return { ...body, conversation_id: meta.conversation_id, extracted_at: new Date().toISOString(), raw_source_ref: meta.raw_source_ref };
      }
      const feedback = violations.join("\n");
      const retrySystemPrompt = buildExtractionRetryPrompt(feedback);
      raw = await this.completeGemini([
        { role: "user", parts: [{ text: retrySystemPrompt + "\n\n" + transcript.map((m) => `${m.role}: ${m.content}`).join("\n") }] },
      ], model);
      try {
        parsed = parseModelJson(raw);
        body = parseExtraction(parsed);
        return { ...body, conversation_id: meta.conversation_id, extracted_at: new Date().toISOString(), raw_source_ref: meta.raw_source_ref };
      } catch (err) {
        if (!(err instanceof ExtractionValidationError)) throw err;
        throw new LLMProviderError("Model output did not match the extraction schema after retry", err.message);
      }
    }
    const retrySystemPrompt = buildExtractionRetryPrompt();
    raw = await this.completeGemini([
      { role: "user", parts: [{ text: retrySystemPrompt + "\n\n" + transcript.map((m) => `${m.role}: ${m.content}`).join("\n") }] },
    ], model);
    try {
      parsed = parseModelJson(raw);
      body = parseExtraction(parsed);
      return { ...body, conversation_id: meta.conversation_id, extracted_at: new Date().toISOString(), raw_source_ref: meta.raw_source_ref };
    } catch (err) {
      if (!(err instanceof ExtractionValidationError)) throw err;
      throw new LLMProviderError("Model output did not match the extraction schema after retry", err.message);
    }
  }

  async resolve(extraction: ExtractionResult, candidates: CandidateSet, model?: string): Promise<ResolutionBody> {
    const attempts = [buildResolutionSystemPrompt(), buildResolutionRetryPrompt()];
    for (const system of attempts) {
      const raw = await this.completeGemini([
        { role: "user", parts: [{ text: system + "\n\n" + JSON.stringify({ extraction, candidates }) }] },
      ], model);
      try {
        return parseResolution(parseModelJson(raw));
      } catch (err) {
        const malformed = err instanceof ResolutionValidationError || err instanceof ExtractionValidationError;
        if (!malformed) throw err;
        const isLastAttempt = attempts.indexOf(system) === attempts.length - 1;
        if (isLastAttempt) {
          throw new LLMProviderError("Model output did not match the resolution schema after retry", err.message);
        }
      }
    }
    throw new LLMProviderError("Model output did not match the resolution schema after retry", "unreachable");
  }

  private async completeGemini(contents: GeminiContent[], model?: string): Promise<string> {
    const data = await this.request({ contents }, model);
    const part = data.candidates?.[0]?.content?.parts?.find((p) => typeof p.text === "string" && p.text.trim() !== "");
    if (!part?.text) {
      throw new LLMProviderError("Gemini returned an empty completion", JSON.stringify(data).slice(0, 300));
    }
    return part.text;
  }

  private async request(payload: Record<string, unknown>, model?: string): Promise<GeminiResponse> {
    const m = model ?? this.model;
    const url = `${this.baseUrl}/${m}:generateContent?key=${this.apiKey}`;
    const attempts = 1 + this.retries;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        if (attempt < attempts) {
          await sleep(this.retryDelayMs);
          continue;
        }
        throw new LLMProviderError("LLM request failed or timed out", err instanceof Error ? err.message : String(err));
      }
      if (res.ok) {
        return (await res.json()) as GeminiResponse;
      }
      let providerMessage = `HTTP ${res.status}`;
      try {
        const json = (await res.json()) as GeminiResponse;
        if (json?.error?.message) providerMessage = json.error.message;
      } catch {
        // keep status text
      }
      if (attempt < attempts && isTransientStatus(res.status)) {
        await sleep(this.retryDelayMs);
        continue;
      }
      throw new LLMProviderError(`Gemini request failed (${res.status})`, providerMessage);
    }
    throw new LLMProviderError("Gemini request failed", "unreachable");
  }
}

function isTransientStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** LLMMessage[] → Gemini contents[]. System messages are inlined into the first user part. */
function toGeminiContents(messages: LLMMessage[]): GeminiContent[] {
  const out: GeminiContent[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      // Gemini has no first-class system role in v1beta contents; prepend as a user context part.
      out.push({ role: "user", parts: [{ text: `[system]\n${m.content}` }] });
      continue;
    }
    if (m.role === "tool") {
      // Tool results arrive as functionResponse parts, linked by name in our ToolCall round-trip.
      const name = m.tool_call_id ?? "search_graph";
      out.push({ role: "user", parts: [{ functionResponse: { name, response: { result: safeParse(m.content) } } }] });
      continue;
    }
    if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
      out.push({
        role: "model",
        parts: m.tool_calls.map((tc) => ({
          functionCall: { name: tc.name, args: tc.arguments },
          // Echo the provider's verbatim round-trip metadata (e.g.
          // thought_signature) back onto the part — Gemini 3.x 400s without it.
          ...(tc.provider_meta ?? {}),
        })),
      });
      continue;
    }
    out.push({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] });
  }
  return out;
}

function safeParse(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? v as Record<string, unknown> : { result: v };
  } catch {
    return { text: s };
  }
}

function toGeminiTools(tools: ToolDef[]): GeminiTool {
  return {
    functionDeclarations: tools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      parameters: sanitizeSchemaForGemini(t.function.parameters),
    })),
  };
}

/**
 * Gemini's functionDeclarations schema is a SUBSET of JSON Schema: it rejects
 * `additionalProperties` and a few other keys that OpenRouter/OpenAI accept.
 * Strip every unsupported key recursively so a tool def valid for one
 * provider can't 400 another — the rest of the shape is preserved verbatim.
 * (Ledger entry #4.)
 */
export function sanitizeSchemaForGemini(schema: Record<string, unknown>): Record<string, unknown> {
  const DENY = new Set(["additionalProperties", "$schema", "$id", "$ref", "definitions", "examples", "default"]);
  const clone = { ...schema };
  for (const key of Object.keys(clone)) {
    if (DENY.has(key)) delete clone[key];
  }
  if (clone.properties && typeof clone.properties === "object") {
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(clone.properties as Record<string, unknown>)) {
      props[k] = v && typeof v === "object" ? sanitizeSchemaForGemini(v as Record<string, unknown>) : v;
    }
    clone.properties = props;
  }
  if (clone.items && typeof clone.items === "object") {
    clone.items = sanitizeSchemaForGemini(clone.items as Record<string, unknown>);
  }
  return clone;
}

function parseGeminiFunctionCalls(parts: GeminiResponsePart[]): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const [i, p] of parts.entries()) {
    if (p.functionCall) {
      const sig = p.thoughtSignature ?? p.thought_signature;
      calls.push({
        id: `gemini_call_${i}`,
        name: p.functionCall.name ?? "unknown",
        arguments: p.functionCall.args ?? {},
        ...(sig ? { provider_meta: { thought_signature: sig } } : {}),
      });
    }
  }
  return calls;
}

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
