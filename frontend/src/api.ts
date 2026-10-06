/**
 * Shared API types + the fetch wrapper used by both the chat page (Phase 1)
 * and the diary page (Phase 2).
 */

export interface ExtractionNode {
  name: string;
  category: string;
  confidence: number;
  tags: string[];
}

export interface ExtractionEdge {
  relation: string;
  from: string;
  to: string;
  confidence: number;
  attributes: Record<string, unknown>;
}

export interface Extraction {
  conversation_id: string;
  extracted_at: string;
  summary: string;
  tags: string[];
  nodes: ExtractionNode[];
  edges: ExtractionEdge[];
  mood_or_tone: string | null;
  raw_source_ref: string;
}

/** Phase 2 §5.1 — one row of data/diary-entries.jsonl. */
export interface DiaryEntry {
  id: string;
  timestamp: string;
  text: string;
  extraction: Extraction | null;
  /** Present only when the extraction LLM call failed — the entry was still saved. */
  warning?: string;
}

// ---------------------------------------------------------------------------
// Phase 3 — graph layer. Shapes for POST /api/graph/link (specs/spec-phase-3 §5/§7).
// ---------------------------------------------------------------------------

export interface ResolutionNode {
  extracted_name: string;
  decision: "create" | "merge" | "pending_review";
  node_id: string | null;
  category: string;
  tags: string[];
  candidates_considered: { node_id: string; name: string; score: number }[];
  reason: string | null;
}

export interface ResolutionEdge {
  extracted_relation: string;
  decision: "create" | "update" | "pending_review";
  edge_id: string | null;
  relation_type: string;
  from: string;
  to: string;
  attributes: Record<string, unknown>;
  reason: string | null;
}

export interface Resolution {
  resolution_id: string;
  source_extraction_ref: string;
  resolved_at: string;
  nodes: ResolutionNode[];
  edges: ResolutionEdge[];
}

/** POST /api/graph/link response (§5): resolution + templated summary + audit file. */
export interface GraphLinkResponse {
  resolution: Resolution;
  summary: string;
  saved_to: { resolution_file: string };
}

export interface ErrorBody {
  error: { code: string; message: string };
}

/** API error carrying the backend's error code (NOT_FOUND, VALIDATION_ERROR, …). */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    /** Upstream provider detail when the backend provides it. */
    readonly providerMessage?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const e = (body as ErrorBody | null)?.error;
    const pm = (body as any)?.error?.providerMessage;
    throw new ApiError(e?.code ?? "UNKNOWN", e?.message ?? `HTTP ${res.status}`, res.status, typeof pm === "string" ? pm : undefined);
  }
  return body as T;
}

// ---------------------------------------------------------------------------
// Phase 4 — analyse / proposal.
// ---------------------------------------------------------------------------

export interface ProposalStep {
  seq: number;
  human_text: string;
  tool: string;
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

export interface AnalyseResponse {
  proposal: Proposal | null;
  error?: string;
  log_file?: string;
}