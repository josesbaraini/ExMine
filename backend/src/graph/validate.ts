import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type {
  EdgeResolutionDecision,
  NodeResolutionDecision,
  ResolutionBody,
  ResolvedEdge,
  ResolvedNode,
} from "../types";

/**
 * Phase 3 §7 — resolution output validation + coercion, mirroring Phase 1's
 * parseExtraction (§6). The difference is deliberate: extraction drops
 * individually malformed entries, resolution REJECTS the whole output. A node
 * silently dropped from a resolution is a graph write silently skipped — the
 * one thing this phase must never do. So structural or entry-level breakage
 * throws ResolutionValidationError, the caller (OpenRouterClient.resolve)
 * retries once with a stricter prompt, then surfaces a 502 (§7 rules).
 */

export class ResolutionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResolutionValidationError";
  }
}

const NODE_DECISIONS: NodeResolutionDecision[] = ["create", "merge", "pending_review"];
const EDGE_DECISIONS: EdgeResolutionDecision[] = ["create", "update", "pending_review"];

const CandidateSchema = Type.Object({
  node_id: Type.String({ minLength: 1 }),
  name: Type.String(),
  score: Type.Number(),
});

const ResolvedNodeSchema = Type.Object({
  extracted_name: Type.String({ minLength: 1 }),
  decision: Type.Union([Type.Literal("create"), Type.Literal("merge"), Type.Literal("pending_review")]),
  node_id: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  category: Type.String(),
  tags: Type.Array(Type.String()),
  candidates_considered: Type.Array(CandidateSchema),
  reason: Type.Union([Type.String(), Type.Null()]),
});

const ResolvedEdgeSchema = Type.Object({
  extracted_relation: Type.String({ minLength: 1 }),
  decision: Type.Union([Type.Literal("create"), Type.Literal("update"), Type.Literal("pending_review")]),
  edge_id: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  relation_type: Type.String({ minLength: 1 }),
  from: Type.String({ minLength: 1 }),
  to: Type.String({ minLength: 1 }),
  attributes: Type.Record(Type.String(), Type.Unknown()),
  reason: Type.Union([Type.String(), Type.Null()]),
});

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function fail(message: string): never {
  throw new ResolutionValidationError(message);
}

/** Per-node tags / considered candidates / attributes are enrichment — lenient. */
function coerceTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const tags: string[] = [];
  for (const tag of raw) {
    if (typeof tag === "string" && tag.trim() !== "") tags.push(tag.trim());
  }
  return tags;
}

function coerceCandidates(raw: unknown): { node_id: string; name: string; score: number }[] {
  if (!Array.isArray(raw)) return [];
  const out: { node_id: string; name: string; score: number }[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const node_id = typeof item.node_id === "string" ? item.node_id : "";
    if (node_id.trim() === "") continue;
    const name = typeof item.name === "string" ? item.name : "";
    const score = typeof item.score === "number" && Number.isFinite(item.score) ? item.score : 0;
    out.push({ node_id: node_id.trim(), name, score });
  }
  return out;
}

function coerceAttributes(raw: unknown): Record<string, unknown> {
  return isRecord(raw) ? raw : {};
}

function optionalReason(raw: unknown): string | null {
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
}

function buildNode(raw: unknown): ResolvedNode {
  if (!isRecord(raw)) fail("each node entry must be a JSON object");

  const extractedName = raw.extracted_name;
  if (typeof extractedName !== "string" || extractedName.trim() === "") {
    fail("'nodes[].extracted_name' must be a non-empty string (copy it verbatim from the extraction)");
  }

  const decision = raw.decision;
  if (typeof decision !== "string" || !(NODE_DECISIONS as string[]).includes(decision)) {
    fail(`'nodes[].decision' must be one of create | merge | pending_review (got ${JSON.stringify(decision)})`);
  }

  // node_id is exclusively for `merge` — create/pending_review must not carry
  // one (the compiler MERGEs new nodes and never writes pending nodes).
  let nodeId: string | null = typeof raw.node_id === "string" && raw.node_id.trim() !== "" ? raw.node_id.trim() : null;
  if (decision === "merge") {
    if (!nodeId) fail("'nodes[].node_id' is required when decision is 'merge' — one of the candidates_considered ids");
  } else {
    nodeId = null;
  }

  const node: ResolvedNode = {
    extracted_name: extractedName.trim(),
    decision: decision as NodeResolutionDecision,
    node_id: nodeId,
    category: typeof raw.category === "string" ? raw.category.trim() : "",
    tags: coerceTags(raw.tags),
    candidates_considered: coerceCandidates(raw.candidates_considered),
    reason: optionalReason(raw.reason),
  };
  return node;
}

function buildEdge(raw: unknown, validNodeNames: Set<string>): ResolvedEdge {
  if (!isRecord(raw)) fail("each edge entry must be a JSON object");

  const extractedRelation = raw.extracted_relation;
  if (typeof extractedRelation !== "string" || extractedRelation.trim() === "") {
    fail("'edges[].extracted_relation' must be a non-empty string");
  }

  const decision = raw.decision;
  if (typeof decision !== "string" || !(EDGE_DECISIONS as string[]).includes(decision)) {
    fail(`'edges[].decision' must be one of create | update | pending_review (got ${JSON.stringify(decision)})`);
  }

  const relationType = raw.relation_type;
  if (typeof relationType !== "string" || relationType.trim() === "") {
    fail("'edges[].relation_type' must be a non-empty string");
  }

  const from = raw.from;
  if (typeof from !== "string" || from.trim() === "") fail("'edges[].from' must be a non-empty string");
  const to = raw.to;
  if (typeof to !== "string" || to.trim() === "") fail("'edges[].to' must be a non-empty string");

  // The compiler resolves from/to through the node resolutions by exact name;
  // an edge referencing a name the nodes list doesn't know would be silently
  // skipped — validate instead, so the model retries rather than guessing.
  if (!validNodeNames.has(from.trim())) {
    fail(`'edges[].from' (${JSON.stringify(from)}) does not match any 'nodes[].extracted_name' — copy names verbatim`);
  }
  if (!validNodeNames.has(to.trim())) {
    fail(`'edges[].to' (${JSON.stringify(to)}) does not match any 'nodes[].extracted_name' — copy names verbatim`);
  }

  return {
    extracted_relation: extractedRelation.trim(),
    decision: decision as EdgeResolutionDecision,
    edge_id: null, // always null this phase — the compiler MERGEs relationships
    relation_type: relationType.trim(),
    from: from.trim(),
    to: to.trim(),
    attributes: coerceAttributes(raw.attributes),
    reason: optionalReason(raw.reason),
  };
}

/**
 * Validate + normalize raw model output into a ResolutionBody.
 * - Strict on anything that determines a graph write (names, decisions,
 *   node_id for merge, edge endpoint references) — breaks → throw, never drop.
 * - Lenient on enrichment (category, tags, candidates_considered, attributes,
 *   reason) — defaults/null instead of failing.
 * - Throws only ResolutionValidationError. Never crashes.
 */
export function parseResolution(raw: unknown): ResolutionBody {
  if (!isRecord(raw)) fail("resolution output must be a JSON object");
  if (raw.nodes === undefined) fail("'nodes' is required");
  if (!Array.isArray(raw.nodes)) fail("'nodes' must be an array");
  if (raw.edges === undefined) fail("'edges' is required");
  if (!Array.isArray(raw.edges)) fail("'edges' must be an array");

  const nodes = raw.nodes.map(buildNode);
  const validNodeNames = new Set(nodes.map((n) => n.extracted_name));
  const edges = raw.edges.map((e) => buildEdge(e, validNodeNames));

  const body: ResolutionBody = { nodes, edges };
  if (!Value.Check(Type.Object({ nodes: Type.Array(ResolvedNodeSchema), edges: Type.Array(ResolvedEdgeSchema) }), body)) {
    fail("normalized resolution failed schema validation");
  }
  return body;
}