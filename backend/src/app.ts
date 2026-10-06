import { Elysia, t, ValidationError } from "elysia";
import { existsSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join, normalize, sep } from "node:path";
import { ConversationStore } from "./store";
import { diaryTextToTranscript } from "./diary/adapter";
import {
  appendDiaryEntry,
  diaryEntriesPath,
  readDiaryEntries,
  readDiaryEntry,
  updateDiaryEntry,
} from "./storage/diary";
import {
  NotFoundError,
  conversationPath,
  defaultDataDir,
  extractionPath,
  readConversation,
  readExtraction,
  saveConversation,
  saveExtraction,
} from "./storage/files";
import { saveDeletion } from "./storage/deletions";
import { GraphError, type GraphClient } from "./graph/client";
import { searchContext } from "./graph/search";
import { resolveAndPersist } from "./graph/resolver";
import { compile } from "./graph/compiler";
import {
  SEARCH_GRAPH_TOOL_DEF,
  coerceSearchGraphArgs,
  executeSearchGraphTool,
} from "./graph/searchGraphTool";
import {
  DELETE_NODE_TOOL_DEF,
  coerceDeleteNodeArgs,
  executeDeleteNodeTool,
} from "./graph/deleteNodeTool";
import { ExtractionValidationError, parseExtraction } from "./llm/validate";
import { logOperation } from "./storage/opLogger";
import {
  LLMProviderError,
  type ChatMessage,
  type ChatResult,
  type DiaryEntry,
  type ExtractionResult,
  type LLMClient,
  type LLMMessage,
  type ToolDef,
} from "./types";
import { buildChatSystemPrompt } from "./llm/prompts";
import { runAnalyse } from "./graph/propose";
import {
  CREATE_NODE_TOOL_DEF,
  coerceCreateNodeArgs,
  executeCreateNodeTool,
  UPDATE_NODE_TOOL_DEF,
  coerceUpdateNodeArgs,
  executeUpdateNodeTool,
  MERGE_NODES_TOOL_DEF,
  coerceMergeNodesArgs,
  executeMergeNodesTool,
  CREATE_EDGE_TOOL_DEF,
  coerceCreateEdgeArgs,
  executeCreateEdgeTool,
  UPDATE_EDGE_TOOL_DEF,
  coerceUpdateEdgeArgs,
  executeUpdateEdgeTool,
  DELETE_EDGE_TOOL_DEF,
  coerceDeleteEdgeArgs,
  executeDeleteEdgeTool,
} from "./graph/mutationTools";

/**
 * App factory. Tests inject a fake LLMClient and a temp data dir; the dev and
 * container entry points inject the real OpenRouterClient. All routes in §5.
 */

export interface AppOptions {
  llm: LLMClient;
  /**
   * Defaults to defaultDataDir() — <repo-root>/data.
   * Accepts a function so callers (tests) can switch the target at runtime
   * without rebuilding the app.
   */
  dataDir?: string | (() => string);
  /** Path to the built Vite dist. undefined -> default; null -> disable static serving. */
  frontendDist?: string | null;
  /**
   * Phase 3 §2 — the graph client. Absent/undefined only in tests and in
   * deployments without the graph layer: /api/graph/link returns 502
   * ("not configured") and /api/graph/ready reports `unconfigured`.
   */
  graph?: GraphClient;
}

const ID_PATTERN = "^[A-Za-z0-9-]{1,64}$";
const idParams = { params: t.Object({ id: t.String({ pattern: ID_PATTERN }) }) };

const ChatBody = t.Object({
  conversation_id: t.Union([t.String({ minLength: 1 }), t.Null()]),
  message: t.String({ minLength: 1 }),
  model: t.Optional(t.String({ minLength: 1 })),
});

// Phase 3.5 §6 — the body of POST /api/graph/search. Mirrors the tool
// contract (§5): tags optional, name_query optional but must be non-blank
// when present. The "nothing to search on" case (empty/missing tags AND no
// name_query) is rejected in the handler, not here — schema errors must stay
// reserved for structurally invalid bodies.
const GraphSearchBody = t.Object({
  tags: t.Optional(t.Array(t.String())),
  name_query: t.Optional(t.String({ minLength: 1 })),
});

// Upper bound on tool calls executed per turn. search_graph is the only tool
// offered and each call is one cheap Cypher read, but a chatty model emitting
// many calls shouldn't balloon a single turn's cost. Calls beyond the bound
// are simply not echoed (the wire stays consistent: every echoed call is
// answered).
const MAX_TOOL_CALLS_PER_TURN = 4;

// Upper bound on distinct tool-call rounds within one turn (each round
// answers a fresh batch of the model's search calls, then one more chat).
// Live QA showed the model splitting its searches across rounds — see the
// loop below. With both search_graph and delete_node tools available, three
// rounds allows: search A, search B, then delete (or search C) before replying.
// Anything past that is a stuck loop; the reply-less guard turns it into a 502.
const MAX_TOOL_CALL_ROUNDS = 3;

// Phase 3 §5 — the body of POST /api/graph/link is a full ExtractionResult
// (as produced by Phase 1's extract() / the extract endpoints). Structural
// problems → Elysia validation → 400; the handler additionally normalizes
// through parseExtraction.
const ExtractionLinkSchema = t.Object({
  conversation_id: t.String({ minLength: 1 }),
  extracted_at: t.String({ minLength: 1 }),
  summary: t.String(),
  tags: t.Array(t.String()),
  nodes: t.Array(
    t.Object({
      name: t.String({ minLength: 1 }),
      category: t.String({ minLength: 1 }),
      confidence: t.Number(),
      tags: t.Array(t.String()),
    }),
  ),
  edges: t.Array(
    t.Object({
      relation: t.String({ minLength: 1 }),
      from: t.String({ minLength: 1 }),
      to: t.String({ minLength: 1 }),
      confidence: t.Number(),
      attributes: t.Record(t.String(), t.Unknown()),
    }),
  ),
  mood_or_tone: t.Union([t.String(), t.Null()]),
  raw_source_ref: t.String({ minLength: 1 }),
});

const LinkBody = t.Object({ extraction: ExtractionLinkSchema });

export function createApp(options: AppOptions) {
  const { llm } = options;
  const resolveDataDir = () => {
    if (typeof options.dataDir === "function") return options.dataDir();
    return options.dataDir ?? defaultDataDir();
  };
  const dist = options.frontendDist === undefined ? defaultFrontendDist() : options.frontendDist;
  const store = new ConversationStore();

  // NOTE: Elysia 1.4.x only applies onError to routes registered AFTER it.
  // Register it first or error responses silently fall back to defaults.
  const app = new Elysia()
    // --- §5. Error contract --------------------------------------------------
    .onError(({ code, error, set }) => {
      if (code === "VALIDATION" && error instanceof ValidationError) {
        set.status = 400;
        // Concise, human-readable message. The raw ValidationError.message is a
        // serialized TypeBox schema dump — never surface that.
        const issues = (error.all ?? [])
          .slice(0, 3)
          .map((i) => `${i.path ?? "?"} ${i.summary ?? i.message ?? "invalid"}`)
          .join("; ");
        return {
          error: {
            code: "VALIDATION_ERROR",
            message: issues ? `Invalid ${error.type}: ${issues}` : `Invalid ${error.type}`,
          },
        };
      }
      if (error instanceof LLMProviderError) {
        // Never silent: the failure the user saw ("Provider returned error")
        // previously produced NO server log at all, which made it look like a
        // test gap instead of a real (usually transient) provider hiccup.
        console.error(
          `[502] LLM provider error: ${error.message}${error.providerMessage ? ` — ${error.providerMessage}` : ""}`,
        );
        set.status = 502;
        // For provider errors (rate limits, network failures), providerMessage IS the user-friendly message.
        // For schema validation failures after retry, message is user-friendly and providerMessage is raw validation error.
        // For local validation errors (empty completion, etc.), providerMessage has the useful detail.
        const genericMessages = [
          "LLM request failed or timed out",
          "LLM call failed",
          "call failed",
          "OpenRouter request failed",
          "OpenRouter returned an empty completion",
          "Model returned no reply",
        ];
        const isGenericMessage = genericMessages.some((m) => error.message.startsWith(m));
        const isNullishProvider = !error.providerMessage || ["null", "undefined", ""].includes(error.providerMessage.trim());
        const userMessage =
          isGenericMessage && !isNullishProvider
            ? error.providerMessage
            : error.message === "OpenRouter returned an empty completion"
              ? "The AI returned an empty response — try again."
              : error.message;
        const response: { error: { code: string; message: string; providerMessage?: string } } = {
          error: { code: "LLM_PROVIDER_ERROR", message: userMessage },
        };
        if (error.providerMessage && !isGenericMessage && !isNullishProvider) response.error.providerMessage = error.providerMessage;
        return response;
      }
      if (code === "NOT_FOUND") {
        set.status = 404;
        return { error: { code: "NOT_FOUND", message: "Route not found" } };
      }
      console.error("[500] unhandled error:", error);
      set.status = 500;
      return { error: { code: "INTERNAL_ERROR", message: "Unexpected server error" } };
    })

    .get("/api/health", () => ({ status: "ok" }))

    // --- Model selector for the UI. -----------------------------------------
    .get("/api/models", async ({ set }) => {
      try {
        return { models: await llm.listModels() };
      } catch (err) {
        set.status = 502;
        return { error: { code: "LLM_PROVIDER_ERROR", message: "Could not list models from the current provider" } };
      }
    })

    // --- §5. POST /api/chat ------------------------------------------------
    // Phase 3.5 extends this handler (spec §6), it does not replace it: the
    // request/response JSON shape the frontend sees is unchanged. Internally,
    // when the graph layer is configured, the handler now offers the
    // search_graph tool; if the model calls it, the handler executes the
    // read-only search, feeds the result back as a tool message, and calls
    // chat() once more for the final reply. At most ONE tool round trip per
    // turn (§9). Without a graph layer, no tool is offered and behavior is
    // exactly Phase 1.
    .post(
      "/api/chat",
      async ({ body, set }) => {
        const content = body.message.trim();
        if (content === "") {
          set.status = 400;
          return { error: { code: "VALIDATION_ERROR", message: "'message' must not be blank" } };
        }
        let id = body.conversation_id;
        if (id === null) {
          id = store.start().id;
        } else if (!store.has(id)) {
          set.status = 404;
          return { error: { code: "UNKNOWN_CONVERSATION", message: `No conversation with id ${id}` } };
        }

        const userMessage: ChatMessage = {
          role: "user",
          content,
          timestamp: new Date().toISOString(),
        };

        // The tool (and its one-line system nudge, §4) exists only when the
        // graph layer does — otherwise the model would be offered a search it
        // cannot perform, and dev mode without Neo4j must keep chat working.
        // Phase 3.6 adds delete_node alongside search_graph.
        // Phase 4: tools are now the FULL set — search plus all writers.
        const writerTools: ToolDef[] = options.graph
          ? [
              SEARCH_GRAPH_TOOL_DEF,
              DELETE_NODE_TOOL_DEF,
              CREATE_NODE_TOOL_DEF,
              UPDATE_NODE_TOOL_DEF,
              MERGE_NODES_TOOL_DEF,
              CREATE_EDGE_TOOL_DEF,
              UPDATE_EDGE_TOOL_DEF,
              DELETE_EDGE_TOOL_DEF,
            ]
          : [];
        const tools = options.graph ? writerTools : undefined;
        const history = store.get(id)!;

        // Run the LLM against history + the pending message (plus the tool
        // round trip if the model asks) and only commit both messages to the
        // store on success. A failed (502) turn must not leave an orphaned
        // user message behind, otherwise a retry would duplicate it. The
        // synthetic system/tool messages live only in this call — they are
        // never persisted.
        let reply: string;
        try {
          const messages: LLMMessage[] = tools
            ? [
                { role: "system", content: buildChatSystemPrompt(true) },
                ...history,
                userMessage,
              ]
            : [
                { role: "system", content: buildChatSystemPrompt(false) },
                ...history,
                userMessage,
              ];
          const resultPromise = llm.chat(messages, tools, body.model);
          let result: ChatResult = await resultPromise;
          await logOperation(resolveDataDir(), {
            operation: "chat",
            input_summary: content.slice(0, 120),
            result: "ok",
            detail: `conversation_id=${id} tools=${tools ? tools.map((t) => t.function.name).join(",") : "none"}`,
          });

          // Bounded tool-call loop: at most MAX_TOOL_CALL_ROUNDS rounds past
          // the first completion, then the reply-less guard below 502s (a
          // stuck model can never loop forever). Live QA: for "what is the
          // relationship between X and Y?" the model fires one search_graph
          // per endpoint (Ana AND Jev), and it does not always send them in
          // the SAME round — it was observed to search Ana, then ask for Jev
          // in its second response. Capping at one round made that legitimate
          // second search hit the guard and 502 a question the user asked
          // directly. Two bounded rounds covers both splits while keeping the
          // cap hard.
          for (let round = 0; round < MAX_TOOL_CALL_ROUNDS; round++) {
            if (tools && result.tool_calls && result.tool_calls.length > 0) {
              // Answer EVERY call the model emitted (search_graph and delete_node).
              // The assistant echo lists EXACTLY the calls we answer: echoing ids
              // we never resolve makes providers reject the conversation as an
              // unanswered tool call (a live 400 "Provider returned error").
              // content is "" so the wire message nulls it (content + tool_calls
              // together is also rejected upstream).
              const calls = result.tool_calls.slice(0, MAX_TOOL_CALLS_PER_TURN);
              const toolResults = await Promise.all(
                calls.map(async (call) => {
                  if (call.name === "search_graph") {
                    return executeSearchGraphTool(coerceSearchGraphArgs(call.arguments), options.graph!);
                  }
                  if (call.name === "delete_node") {
                    const args = coerceDeleteNodeArgs(call.arguments);
                    if (!args) throw new Error("Invalid delete_node arguments: missing node_id");
                    return executeDeleteNodeTool(args, options.graph!, resolveDataDir());
                  }
                  if (call.name === "create_node") {
                    const args = coerceCreateNodeArgs(call.arguments);
                    if (!args) throw new Error("Invalid create_node arguments");
                    return executeCreateNodeTool(args, options.graph!, resolveDataDir());
                  }
                  if (call.name === "update_node") {
                    const args = coerceUpdateNodeArgs(call.arguments);
                    if (!args) throw new Error("Invalid update_node arguments");
                    return executeUpdateNodeTool(args, options.graph!, resolveDataDir());
                  }
                  if (call.name === "merge_nodes") {
                    const args = coerceMergeNodesArgs(call.arguments);
                    if (!args) throw new Error("Invalid merge_nodes arguments");
                    return executeMergeNodesTool(args, options.graph!, resolveDataDir());
                  }
                  if (call.name === "create_edge") {
                    const args = coerceCreateEdgeArgs(call.arguments);
                    if (!args) throw new Error("Invalid create_edge arguments");
                    return executeCreateEdgeTool(args, options.graph!, resolveDataDir());
                  }
                  if (call.name === "update_edge") {
                    const args = coerceUpdateEdgeArgs(call.arguments);
                    if (!args) throw new Error("Invalid update_edge arguments");
                    return executeUpdateEdgeTool(args, options.graph!, resolveDataDir());
                  }
                  if (call.name === "delete_edge") {
                    const args = coerceDeleteEdgeArgs(call.arguments);
                    if (!args) throw new Error("Invalid delete_edge arguments");
                    return executeDeleteEdgeTool(args, options.graph!, resolveDataDir());
                  }
                  throw new Error(`Unknown tool: ${call.name}`);
                }),
              );
              messages.push({ role: "assistant", content: "", tool_calls: calls });
              calls.forEach((call, i) => {
                messages.push({ role: "tool", content: JSON.stringify(toolResults[i]), tool_call_id: call.id });
              });
              result = await llm.chat(messages, tools, body.model);
            } else {
              break;
            }
          }

          reply = (result.reply ?? "").trim();
          // A reply-less final result — the model looped past the bounded
          // tool rounds, or produced nothing to say — is a provider-side
          // failure (same spirit as OpenRouterClient's empty-completion guard).
          if (reply === "") {
            throw new LLMProviderError("Model returned no reply", "empty completion after the tool round trip");
          }
        } catch (err) {
          // The tool's read can fail on the graph itself — same contract as
          // /api/graph/link and /api/graph/search: graph failures surface as
          // 502 GRAPH_UNAVAILABLE, not as an LLM provider error.
          if (err instanceof GraphError) {
            set.status = 502;
            return { error: { code: "GRAPH_UNAVAILABLE", message: err.message } };
          }
          throw toLLMProviderError(err);
        }

        store.append(id, userMessage);
        store.append(id, {
          role: "assistant",
          content: reply,
          timestamp: new Date().toISOString(),
        });

        return {
          conversation_id: id,
          reply,
          messages: [...store.get(id)!],
        };
      },
      { body: ChatBody },
    )

    // ^legacy^ — old Phase 1/2 extraction route. Kept for internal/debug use,
    // not exposed in UI/docs. Do not add callers. ^legacy^
    // --- §5. POST /api/conversations/:id/extract ----------------------------
    .post(
      "/api/conversations/:id/extract",
      async ({ params, set, body }) => {
        const id = params.id;
        const history = store.get(id);
        if (!history) {
          set.status = 404;
          return { error: { code: "UNKNOWN_CONVERSATION", message: `No conversation with id ${id}` } };
        }

        const dir = resolveDataDir();
        const conversationRef = conversationPath(dir, id);
        const extractionRef = extractionPath(dir, id);

        // Run the extraction BEFORE writing anything. A failed extraction (502)
        // must not leave an orphaned conversations/*.json on disk (§6: no
        // half-written state). The path is known upfront and passed as
        // raw_source_ref; it only becomes real once both files are written.
        let extraction: ExtractionResult;
        try {
          extraction = await llm.extract(history, { conversation_id: id, raw_source_ref: conversationRef }, body?.model);
        } catch (err) {
          throw toLLMProviderError(err);
        }

        // Defensive: the files we write always carry the server's facts.
        extraction = {
          ...extraction,
          conversation_id: id,
          extracted_at: extraction.extracted_at ?? new Date().toISOString(),
          raw_source_ref: conversationRef,
        };

        try {
          await saveConversation(dir, id, history);
          await saveExtraction(dir, id, extraction);
        } catch (err) {
          // Best-effort rollback: a transcript without its extraction is an
          // orphan. Never leave one behind, even on a storage failure.
          await rm(conversationRef, { force: true }).catch(() => {});
          throw err;
        }

        return {
          conversation_id: id,
          extraction,
          saved_to: {
            conversation_file: conversationRef,
            extraction_file: extractionRef,
          },
        };
      },
      {
        params: t.Object({ id: t.String({ pattern: ID_PATTERN }) }),
        body: t.Optional(t.Object({ model: t.Optional(t.String()) })),
      },
    )

    // --- §5. GET /api/conversations/:id -------------------------------------
    .get(
      "/api/conversations/:id",
      async ({ params, set }) => {
        const id = params.id;
        let conversation;
        let extraction: ExtractionResult | null = null;
        try {
          conversation = await readConversation(resolveDataDir(), id);
        } catch (err) {
          if (err instanceof NotFoundError) {
            set.status = 404;
            return { error: { code: "NOT_FOUND", message: `No saved conversation with id ${id}` } };
          }
          throw err;
        }
        try {
          extraction = await readExtraction(resolveDataDir(), id);
        } catch (err) {
          if (!(err instanceof NotFoundError)) throw err;
        }
        return { conversation, extraction };
      },
      idParams,
    )

    // --- Phase 2 §6. POST /api/diary/entries --------------------------------
    //
    // Persists the entry FIRST (never lose the user's writing to an LLM
    // failure), then runs Phase 1's extraction function unchanged via the
    // thin adapter (§5.2), then persists the completed entry. Extraction
    // failure still saves the entry with `extraction: null` + a `warning`.
    //
    // Status-code note: the spec's §6 error contract says "502 if extraction
    // call fails (... return it with a warning field — do not lose the user's
    // writing)". We return **201** with the persisted entry because the entry
    // WAS created; a 502 response body would be swallowed by the frontend's
    // api() helper and the user's text would look lost. The LLM failure is
    // surfaced via `entry.warning`, which the test plan's "502-or-similar"
    // wording permits and §8's "show that inline" requires.
    .post(
      "/api/diary/entries",
      async ({ body, set }) => {
        const text = body.text.trim();
        if (text === "") {
          set.status = 400;
          return { error: { code: "VALIDATION_ERROR", message: "'text' must not be blank" } };
        }

        const dir = resolveDataDir();
        const sourceRef = diaryEntriesPath(dir);

        const entry: DiaryEntry = {
          id: randomUUID(),
          timestamp: new Date().toISOString(),
          text,
          extraction: null,
        };

        await appendDiaryEntry(dir, entry);

        const transcript = diaryTextToTranscript(text, entry.timestamp);
        let completed: DiaryEntry;
        try {
          const extraction = await llm.extract(transcript, {
            conversation_id: entry.id,
            raw_source_ref: sourceRef,
          }, body.model);
          completed = { ...entry, extraction };
        } catch (err) {
          const providerError = toLLMProviderError(err);
          completed = {
            ...entry,
            warning: `Extraction failed — entry saved without extraction: ${
              providerError.providerMessage || providerError.message
            }`,
          };
        }

        await updateDiaryEntry(dir, completed);

        set.status = 201;
        return { entry: completed };
      },
      { body: t.Object({ text: t.String({ minLength: 1 }), model: t.Optional(t.String()) }) },
    )

    // --- Phase 2 §6. GET /api/diary/entries ---------------------------------
    // Chronological, oldest first (file order — no sorting needed).
    .get("/api/diary/entries", async () => {
      const entries = await readDiaryEntries(resolveDataDir());
      return { entries };
    })

    // --- Phase 2 §6. GET /api/diary/entries/:id -----------------------------
    .get(
      "/api/diary/entries/:id",
      async ({ params, set }) => {
        try {
          const entry = await readDiaryEntry(resolveDataDir(), params.id);
          return { entry };
        } catch (err) {
          if (err instanceof NotFoundError) {
            set.status = 404;
            return { error: { code: "NOT_FOUND", message: `No diary entry with id ${params.id}` } };
          }
          throw err;
        }
      },
      idParams,
    )

    // ^legacy^ — old Phase 3 graph/link route. Kept for internal/debug use,
    // not exposed in UI/docs. Do not add callers. ^legacy^
    // --- Phase 3 §5. POST /api/graph/link -----------------------------------
    //
    // Deliberately source-agnostic (same principle as extract() not caring
    // whether text came from chat or diary): takes an already-produced
    // ExtractionResult and runs the full Phase 3 pipeline —
    //
    //   1. deterministic context search (fixed Cypher, NO LLM)
    //   2. LLM call #2: resolve every node/edge against the candidates
    //   3. persist the resolution as the audit entry (append-only,
    //      ./data/resolutions/{resolution_id}.json) — nothing reaches the
    //      graph without this entry (§7 invariant)
    //   4. deterministic query compiler writes the decision and builds the
    //      templated (non-LLM) summary
    //
    // Errors (§5): 400 malformed extraction; 502 when the resolve LLM call OR
    // any Neo4j access fails (surfaced with the underlying error); 500 only
    // for genuinely unexpected failures.
    .post(
      "/api/graph/link",
      async ({ body, set }) => {
        const graph = options.graph;
        if (!graph) {
          set.status = 502;
          return {
            error: { code: "GRAPH_UNAVAILABLE", message: "Graph layer is not configured on this server" },
          };
        }

        // Normalize the client's extraction the same way Phase 1 does (so the
        // pipeline sees data shaped exactly like extract() output).
        const payload = body.extraction;
        let extraction: ExtractionResult;
        try {
          const normalized = parseExtraction(payload);
          extraction = {
            ...normalized,
            conversation_id: payload.conversation_id,
            extracted_at: payload.extracted_at,
            raw_source_ref: payload.raw_source_ref,
          };
        } catch (err) {
          if (err instanceof ExtractionValidationError) {
            set.status = 400;
            return { error: { code: "VALIDATION_ERROR", message: `Invalid extraction: ${err.message}` } };
          }
          throw err;
        }

        try {
          const candidates = await searchContext(extraction, graph);
          const { resolution, resolution_file } = await resolveAndPersist(llm, extraction, candidates, resolveDataDir());
          const { summary } = await compile(resolution, graph);
          return { resolution, summary, saved_to: { resolution_file } };
        } catch (err) {
          if (err instanceof LLMProviderError) {
            // Human-facing message: the extraction files are safe on disk.
            // Do NOT leak the model-directed "copy names verbatim" text.
            set.status = 502;
            return {
              error: {
                code: "LLM_PROVIDER_ERROR",
                message:
                  "Graph link skipped — the extraction was saved to disk safely, but the resolution step failed. " +
                  "Your data is not lost; you can retry linking later or inspect the saved extraction files.",
              },
            };
          }
          if (err instanceof GraphError) {
            set.status = 502;
            return { error: { code: "GRAPH_UNAVAILABLE", message: err.message } };
          }
          throw err;
        }
      },
      { body: LinkBody },
    )

    // --- Phase 3.5 §6 — POST /api/graph/search -------------------------------
    // Read-only direct access to the same search the chat tool-call loop uses
    // (and useful for debugging): tool args in, Phase 3 CandidateSet out. It is
    // the adapter + searchContext(), never any write. 400 when there is nothing
    // to search on; 502 when the graph read fails.
    .post(
      "/api/graph/search",
      async ({ body, set }) => {
        const graph = options.graph;
        if (!graph) {
          set.status = 502;
          return {
            error: { code: "GRAPH_UNAVAILABLE", message: "Graph layer is not configured on this server" },
          };
        }
        const tags = body.tags ?? [];
        if (tags.length === 0 && body.name_query === undefined) {
          set.status = 400;
          return {
            error: {
              code: "VALIDATION_ERROR",
              message: "Nothing to search on: provide at least one tag or a name_query",
            },
          };
        }
        try {
          return await executeSearchGraphTool(
            { tags, name_query: body.name_query },
            graph,
          );
        } catch (err) {
          if (err instanceof GraphError) {
            set.status = 502;
            return { error: { code: "GRAPH_UNAVAILABLE", message: err.message } };
          }
          throw err;
        }
      },
      { body: GraphSearchBody },
    )

    // --- Phase 4 §6. POST /api/analyse — the new save/remember trigger -------
    // Gathers chat history, runs searchContext for evidence, then the
    // propose→judge loop. Returns a judge-approved proposal for the frontend
    // to present to the user for whole-proposal confirmation.
    .post(
      "/api/analyse",
      async ({ body, set }) => {
        const graph = options.graph;
        if (!graph) {
          set.status = 502;
          return { error: { code: "GRAPH_UNAVAILABLE", message: "Graph layer is not configured on this server" } };
        }
        let history: { role: "user" | "assistant"; content: string; timestamp: string }[] | undefined = undefined;
        if (body.conversation_id) {
          history = store.get(body.conversation_id);
          if (!history) {
            set.status = 404;
            return { error: { code: "UNKNOWN_CONVERSATION", message: `No conversation with id ${body.conversation_id}` } };
          }
        } else if (body.text && body.text.trim() !== "") {
          history = [{ role: "user", content: body.text.trim(), timestamp: new Date().toISOString() }];
        } else {
          set.status = 400;
          return { error: { code: "VALIDATION_ERROR", message: "Provide either conversation_id or text" } };
        }
        try {
          const result = await runAnalyse(history, llm, graph, resolveDataDir(), body.model);
          if (!result.ok) {
            await logOperation(resolveDataDir(), {
              operation: "analyse",
              input_summary: `${history.length} messages in conversation ${body.conversation_id}`,
              result: "error",
              detail: result.error,
            });
            set.status = 200;
            return { proposal: null, error: result.error, log_file: result.log_file };
          }
          await logOperation(resolveDataDir(), {
            operation: "analyse",
            input_summary: `${history.length} messages in conversation ${body.conversation_id}`,
            result: "ok",
            detail: `proposal ${result.proposal.proposal_id} with ${result.proposal.steps.length} steps`,
          });
          return { proposal: result.proposal };
        } catch (err) {
          await logOperation(resolveDataDir(), {
            operation: "analyse",
            input_summary: `${history.length} messages in conversation ${body.conversation_id}`,
            result: "error",
            detail: (err as Error).message,
          });
          throw toLLMProviderError(err);
        }
      },
      {
        body: t.Object({
          conversation_id: t.Optional(t.String({ minLength: 1 })),
          text: t.Optional(t.String({ minLength: 1 })),
          model: t.Optional(t.String({ minLength: 1 })),
        }),
      },
    )

    // --- Phase 4 §8 — POST /api/propose/execute --------------------------------
    // Accepts a judge-approved proposal and applies every step in order via the
    // mutation tools. Keeps applied steps on failure (no rollback), reports any
    // errors by step.
    .post(
      "/api/propose/execute",
      async ({ body, set }) => {
        const graph = options.graph;
        if (!graph) {
          set.status = 502;
          return { error: { code: "GRAPH_UNAVAILABLE", message: "Graph layer is not configured on this server" } };
        }
        const proposal = body.proposal as any;
        const applied: number[] = [];
        const errors: string[] = [];
        for (const step of proposal?.steps ?? []) {
          try {
            if (step.tool === "create_node") {
              const args = coerceCreateNodeArgs(step.args);
              if (!args) throw new Error("Invalid create_node args");
              await executeCreateNodeTool(args, graph, resolveDataDir());
            } else if (step.tool === "update_node") {
              const args = coerceUpdateNodeArgs(step.args);
              if (!args) throw new Error("Invalid update_node args");
              await executeUpdateNodeTool(args, graph, resolveDataDir());
            } else if (step.tool === "merge_nodes") {
              const args = coerceMergeNodesArgs(step.args);
              if (!args) throw new Error("Invalid merge_nodes args");
              await executeMergeNodesTool(args, graph, resolveDataDir());
            } else if (step.tool === "delete_node") {
              const args = coerceDeleteNodeArgs(step.args);
              if (!args) throw new Error("Invalid delete_node args");
              await executeDeleteNodeTool(args, graph, resolveDataDir());
            } else if (step.tool === "create_edge") {
              const args = coerceCreateEdgeArgs(step.args);
              if (!args) throw new Error("Invalid create_edge args");
              await executeCreateEdgeTool(args, graph, resolveDataDir());
            } else if (step.tool === "update_edge") {
              const args = coerceUpdateEdgeArgs(step.args);
              if (!args) throw new Error("Invalid update_edge args");
              await executeUpdateEdgeTool(args, graph, resolveDataDir());
            } else if (step.tool === "delete_edge") {
              const args = coerceDeleteEdgeArgs(step.args);
              if (!args) throw new Error("Invalid delete_edge args");
              await executeDeleteEdgeTool(args, graph, resolveDataDir());
            } else {
              throw new Error(`Unknown tool: ${step.tool}`);
            }
            applied.push(step.seq);
          } catch (err) {
            errors.push(`Step ${step.seq} (${step.tool}): ${err instanceof Error ? err.message : String(err)}`);
            break;
          }
        }
        await logOperation(resolveDataDir(), {
          operation: "propose_execute",
          input_summary: `proposal ${proposal?.proposal_id ?? "?"} ${proposal?.steps?.length ?? 0} steps`,
          result: errors.length === 0 ? "ok" : "error",
          detail: `applied ${applied.length} steps; errors: ${errors.join("; ")}`,
        });
        return { ok: errors.length === 0, applied: applied.length, errors: errors.length > 0 ? errors : undefined };
      },
      { body: t.Object({ proposal: t.Any() }) },
    )

    // --- Phase 3.6 — POST /api/graph/delete-node -------------------------------
    // Thin debug route mirroring /api/graph/search pattern: tool args in,
    // executeDeleteNodeTool out. 404 if node_id doesn't exist; 502 on write failure.
    .post(
      "/api/graph/delete-node",
      async ({ body, set }) => {
        const graph = options.graph;
        if (!graph) {
          set.status = 502;
          return {
            error: { code: "GRAPH_UNAVAILABLE", message: "Graph layer is not configured on this server" },
          };
        }
        const args = coerceDeleteNodeArgs(body);
        if (!args) {
          set.status = 400;
          return {
            error: { code: "VALIDATION_ERROR", message: "node_id is required" },
          };
        }
        try {
          const snapshot = await executeDeleteNodeTool(args, graph, resolveDataDir());
          return { deleted: true, snapshot };
        } catch (err) {
          if (err instanceof GraphError) {
            if ((err as any).code === "NOT_FOUND") {
              set.status = 404;
              return { error: { code: "NOT_FOUND", message: err.message } };
            }
            set.status = 502;
            return { error: { code: "GRAPH_UNAVAILABLE", message: err.message } };
          }
          throw err;
        }
      },
      { body: t.Object({ node_id: t.String({ minLength: 1 }) }) },
    )

    // --- Phase 3 §3 — Neo4j readiness, for the smoke test / ops -------------
    // Polled by the container smoke test alongside /api/health. Kept separate
    // from /api/health so its exact contract stays untouched.
    .get("/api/graph/ready", () => {
      const graph = options.graph;
      return {
        status: "ok",
        graph: graph ? (graph.isReady() ? "ready" : "connecting") : "unconfigured",
      };
    })

    // --- Static frontend (catch-all, registered last) -----------------------
    .get("/*", ({ path, set }) => serveFrontend(dist, path, set));

  return app;
}

/** Wrap any error from an LLM call as an LLMProviderError so the 502 path fires. */
function toLLMProviderError(err: unknown): LLMProviderError {
  if (err instanceof LLMProviderError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new LLMProviderError("LLM call failed", message);
}

function defaultFrontendDist(): string | null {
  return join(import.meta.dir, "..", "..", "frontend", "dist");
}

function serveFrontend(
  dist: string | null,
  path: string,
  set: { status?: number | string },
): Response | { error: { code: string; message: string } } {
  const notFound = () => {
    set.status = 404;
    return { error: { code: "NOT_FOUND", message: "Route not found" } };
  };
  if (!dist) return notFound();
  if (path.startsWith("/api/")) return notFound();

  const root = normalize(dist);
  const indexFile = join(root, "index.html");

  const rel = path === "/" ? "index.html" : path.replace(/^\/+/, "");
  const target = normalize(join(root, rel));
  if (target === root || target.startsWith(root + sep)) {
    if (existsSync(target) && statSync(target).isFile()) {
      return new Response(Bun.file(target));
    }
  }
  // SPA fallback: any unmatched route gets index.html (unless it's an /api path).
  if (existsSync(indexFile) && statSync(indexFile).isFile()) {
    return new Response(Bun.file(indexFile));
  }
  return notFound();
}