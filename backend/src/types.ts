/**
 * Shared types for the Jarvis backend. Nothing in here touches a framework,
 * a provider, or storage — these shapes are the contract between the chat
 * concern, the extraction concern, and the (future) Phase 2+ consumers.
 */

/** One message in a conversation transcript (the store's shape — what gets
 * persisted to conversations/*.json). Roles are deliberately narrow: the store
 * never holds system/tool plumbing. */
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  /** ISO8601 timestamp. */
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Phase 3.5 (§7): tool-calling contract. These are wire-level shapes for the
// chat() call — never persisted to the conversation store. Mirrors the
// OpenAI/OpenRouter function-calling convention; OpenRouterClient is the only
// module that maps them to/from the provider's exact JSON.
// ---------------------------------------------------------------------------

/** One function call the model requested. `id` is protocol-critical: the
 * follow-up tool-role result must echo it as `tool_call_id`. */
export interface ToolCall {
  id: string;
  name: string;
  /** The parsed JSON arguments object (arrives as a JSON string over the wire). */
  arguments: Record<string, unknown>;
  /**
   * Provider round-trip metadata we must echo back verbatim on the next turn
   * (Gemini 3.x attaches `thought_signature` to functionCall parts; dropping
   * it triggers a 400 on the following request). Populated by the provider
   * client, spread back in toGeminiContents. Unused for OpenRouter.
   */
  provider_meta?: Record<string, unknown>;
}

/** Generic OpenAI-style tool definition (OpenRouter's `tools` param). The
 * client forwards tools verbatim and never interprets what a tool means. */
export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    /** JSON Schema object describing the tool's parameters. */
    parameters: Record<string, unknown>;
  };
}

/** The result of chat(). Either a plain reply, or tool calls for the CALLER to
 * execute and re-call chat() with — the decision to loop lives in app.ts, not
 * in the provider client (Phase 3.5 §5: "one round trip max"). */
export interface ChatResult {
  reply?: string;
  tool_calls?: ToolCall[];
}

/** One message as the LLM sees it in chat() — wider than ChatMessage because
 * the tool round trip needs system/tool roles, `tool_calls` on assistant
 * messages, and `tool_call_id` on tool-role results. */
export interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Present on assistant messages that requested tools (Phase 3.5 §7). */
  tool_calls?: ToolCall[];
  /** Present on role:"tool" messages: echoes the id of the call being answered. */
  tool_call_id?: string;
}

/**
 * A node extracted from the transcript (§6, revised). `category` is an OPEN
 * string, not a closed enum — reconciling categories against a controlled
 * vocabulary is the graph layer's (Phase 3+4) job, downstream of extraction.
 */
export interface ExtractionNode {
  name: string;
  category: string;
  /** 0..1. Defaults to 1.0 when the model doesn't provide one (v1 simplification, §6). */
  confidence: number;
  /** Per-node search hooks for the downstream graph layer (§6). */
  tags: string[];
}

/**
 * A directed relationship between two nodes of the *same* extraction (§6,
 * revised). `relation` is an open string; `from`/`to` reference `nodes[].name`
 * values and are NOT resolved against any store here — that is downstream.
 */
export interface ExtractionEdge {
  relation: string;
  from: string;
  to: string;
  confidence: number;
  /** Free-form JSON object for contextual state (§6). */
  attributes: Record<string, unknown>;
}

/**
 * The model-produced body of an extraction — everything except the fields the
 * server enriches (conversation_id, extracted_at, raw_source_ref).
 *
 * Note: `action_items` is deliberately absent. Anything that would trigger a
 * real-world side effect is out of scope for extraction (deferred to a future
 * tool-integration phase); a plain to-do mentioned in text is just a node.
 */
export interface RawExtraction {
  summary: string;
  tags: string[];
  nodes: ExtractionNode[];
  edges: ExtractionEdge[];
  mood_or_tone: string | null;
}

/** Full extraction file shape (§6). */
export interface ExtractionResult extends RawExtraction {
  conversation_id: string;
  extracted_at: string;
  raw_source_ref: string;
}

/**
 * A single diary entry (Phase 2 §5.1). Append-only once saved.
 * `extraction` is null only when the extraction LLM call failed — in that case
 * a `warning` is present and the entry was still persisted (§6 error contract).
 */
export interface DiaryEntry {
  id: string; // uuid
  timestamp: string; // ISO 8601, set server-side on creation
  text: string;
  extraction: ExtractionResult | null;
  warning?: string;
}

/** Server-side facts an LLM client needs to complete an ExtractionResult. */
export interface ExtractionMeta {
  conversation_id: string;
  raw_source_ref: string;
}

// ---------------------------------------------------------------------------
// Phase 3 (§6/§7): graph layer contracts. These shapes are the contract
// between the deterministic context search, the resolver (LLM call #2), the
// query compiler, and the audit log. See specs/spec-phase-3.md.
// ---------------------------------------------------------------------------

/** One 1-hop neighborhood entry of a candidate match (§6). */
export interface NeighborhoodEntry {
  /** The semantic relation name from the edge's `relation` property
   * (e.g. "is_hiring"), falling back to the generic type ("RELATED"). */
  relation: string;
  direction: "in" | "out";
  other_node_id: string;
  other_name: string;
  /** Edge attributes as stored — a JSON string. Absent when the edge has none
   * or predates attributes. */
  attributes?: string;
  /** Neo4j elementId of this edge — required by update_edge/delete_edge. */
  edge_id?: string;
}

/** One candidate match for an extracted node (§6). */
export interface NodeCandidate {
  node_id: string;
  name: string;
  category: string;
  tags: string[];
  score: number;
  neighborhood: NeighborhoodEntry[];
}

/** One extracted node's candidate set (§6). */
export interface NodeCandidateSet {
  extracted_name: string;
  matches: NodeCandidate[];
}

/** One candidate match for an extracted relation (§6). */
export interface EdgeCandidate {
  relation_type: string;
  score: number;
}

/** One extracted relation's candidate set (§6). */
export interface EdgeCandidateSet {
  extracted_relation: string;
  matches: EdgeCandidate[];
}

/**
 * Everything the deterministic context search found (§6). `node_id` values are
 * Neo4j elementId strings (stable across restarts, unlike internal ids); the
 * spec's "uuid" wording is approximate — the graph's own identity is what the
 * resolver echoes back and the compiler matches on.
 */
export interface CandidateSet {
  node_candidates: NodeCandidateSet[];
  edge_candidates: EdgeCandidateSet[];
}

export type NodeResolutionDecision = "create" | "merge" | "pending_review";
export type EdgeResolutionDecision = "create" | "update" | "pending_review";

/** One resolved node (§7). node_id is non-null only for `merge`. */
export interface ResolvedNode {
  extracted_name: string;
  decision: NodeResolutionDecision;
  node_id: string | null;
  category: string;
  tags: string[];
  candidates_considered: { node_id: string; name: string; score: number }[];
  reason: string | null;
}

/** One resolved edge (§7). edge_id is always null in this phase — the compiler MERGEs. */
export interface ResolvedEdge {
  extracted_relation: string;
  decision: EdgeResolutionDecision;
  edge_id: string | null;
  relation_type: string;
  /** Extracted node names, verbatim — the compiler maps them to node ids via the node resolutions. */
  from: string;
  to: string;
  attributes: Record<string, unknown>;
  reason: string | null;
}

/**
 * The model-produced body of a resolution — everything the server enriches
 * (resolution_id, source_extraction_ref, resolved_at), mirroring how
 * RawExtraction relates to ExtractionResult.
 */
export interface ResolutionBody {
  nodes: ResolvedNode[];
  edges: ResolvedEdge[];
}

/** Full resolution / audit-log entry shape (§7). */
export interface ResolutionResult extends ResolutionBody {
  resolution_id: string; // uuid (server-enriched)
  source_extraction_ref: string;
  resolved_at: string; // ISO8601
}

/**
 * The LLM provider abstraction (§7). The only seam between chat/extraction/
 * resolution code and any concrete provider. A future AnthropicClient or
 * LocalModelClient implementing this interface must be a drop-in.
 *
 * Phase 3.5 (§7): chat() gains an optional `tools` array (forwarded verbatim
 * to the provider, never interpreted) and returns a ChatResult that may carry
 * tool_calls. extract() and resolve() are unchanged — they never see tools.
 */
export interface LLMClient {
  chat(messages: LLMMessage[], tools?: ToolDef[], model?: string): Promise<ChatResult>;
  extract(transcript: ChatMessage[], meta: ExtractionMeta, model?: string): Promise<ExtractionResult>;
  /** Phase 3 §7 — LLM call #2: decide what to do with each node/edge. */
  resolve(extraction: ExtractionResult, candidates: CandidateSet, model?: string): Promise<ResolutionBody>;
  /** Provider-specific model ids available for selection in the UI. */
  listModels(): Promise<string[]>;
}

/**
 * Error for any LLM-call failure. `providerMessage` carries the upstream
 * provider's own error text so the API can surface a 502 with it (§5).
 */
export class LLMProviderError extends Error {
  constructor(message: string, readonly providerMessage: string) {
    super(message);
    this.name = "LLMProviderError";
  }
}

// ---------------------------------------------------------------------------
// Phase 4 §5: proposal contract. The JSON body of the propose→judge loop that
// replaces the old extract→link pipeline for chat.
// ---------------------------------------------------------------------------

export interface ProposalStep {
  seq: number;
  human_text: string;
  tool:
    | "create_node"
    | "update_node"
    | "merge_nodes"
    | "delete_node"
    | "create_edge"
    | "update_edge"
    | "delete_edge";
  args: Record<string, unknown>;
}

export interface Proposal {
  proposal_id: string;
  created_at: string;
  human_text: string;
  steps: ProposalStep[];
  judge_approved: boolean;
  user_confirmed: boolean;
}

export interface JudgeResult {
  approved: boolean;
  reason?: string;
}