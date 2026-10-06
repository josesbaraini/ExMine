import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  type ExtractionEdge,
  type ExtractionNode,
  type RawExtraction,
} from "../types";

/**
 * Extraction output validation + coercion (§6, revised).
 *
 * Strategy: leniently normalize the model's raw JSON into the RawExtraction
 * shape, applying the explicit coercion rules from the spec, then run a strict
 * TypeBox check on the result. Structurally broken output throws
 * ExtractionValidationError — it never crashes, and the caller (OpenRouterClient)
 * retries once before surfacing a 502 (§5).
 *
 * §6 revision notes that changed behavior vs the old entities/action_items
 * schema:
 * - `nodes[].category` is an OPEN string. There is deliberately no
 *   coercion-to-other here: a node without a usable category is dropped, it is
 *   never given an invented one (reconciling categories is Phase 3+4's job).
 * - `action_items` is gone. The schema no longer has it, so we do not even
 *   look at a stray `action_items` field the model might send (it's "ignored
 *   unknown extra fields" territory, per the old behavior for extras).
 * - `edges[].attributes` is free-form JSON; anything that isn't a plain object
 *   collapses to {} rather than failing the whole extraction.
 */
export type { RawExtraction };
export class ExtractionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtractionValidationError";
  }
}

const NodeSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  category: Type.String({ minLength: 1 }),
  confidence: Type.Number({ minimum: 0, maximum: 1 }),
  tags: Type.Array(Type.String()),
});

const EdgeSchema = Type.Object({
  relation: Type.String({ minLength: 1 }),
  from: Type.String({ minLength: 1 }),
  to: Type.String({ minLength: 1 }),
  confidence: Type.Number({ minimum: 0, maximum: 1 }),
  attributes: Type.Record(Type.String(), Type.Unknown()),
});

/** Strict final gate: after coercion the output must fully satisfy this. */
const RawExtractionSchema = Type.Object({
  summary: Type.String(),
  tags: Type.Array(Type.String()),
  nodes: Type.Array(NodeSchema),
  edges: Type.Array(EdgeSchema),
  mood_or_tone: Type.Union([Type.String(), Type.Null()]),
});

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/**
 * §6: "confidence: if the model doesn't naturally produce one, hardcode 1.0
 * for v1". Also coerces numeric strings and clamps out-of-range numbers.
 */
function coerceConfidence(x: unknown): number {
  const n = typeof x === "number" ? x : typeof x === "string" ? Number(x) : NaN;
  if (Number.isFinite(n)) return Math.min(1, Math.max(0, n));
  return 1.0;
}

/** Per-node tags are search hooks — lenient: filter to non-empty strings. */
function coerceTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const tags: string[] = [];
  for (const tag of raw) {
    if (typeof tag === "string" && tag.trim() !== "") tags.push(tag.trim());
  }
  return tags;
}

/**
 * Build a node. Returns undefined for entries without a usable name or
 * category — §6 says category is an open string with NO coercion-to-other, so
 * we drop the entry instead of minting a category for it.
 */
function buildNode(raw: unknown): ExtractionNode | undefined {
  if (!isRecord(raw)) return undefined;
  const name = raw.name;
  if (typeof name !== "string" || name.trim() === "") return undefined;
  const category = raw.category;
  if (typeof category !== "string" || category.trim() === "") return undefined;
  return {
    name: name.trim(),
    category: category.trim(),
    confidence: coerceConfidence(raw.confidence),
    tags: coerceTags(raw.tags),
  };
}

/**
 * Build an edge. Returns undefined unless relation/from/to are all usable
 * strings. `attributes` is free-form JSON — non-object values collapse to {}
 * rather than failing the extraction.
 */
function buildEdge(raw: unknown): ExtractionEdge | undefined {
  if (!isRecord(raw)) return undefined;
  const relation = raw.relation;
  const from = raw.from;
  const to = raw.to;
  if (typeof relation !== "string" || relation.trim() === "") return undefined;
  if (typeof from !== "string" || from.trim() === "") return undefined;
  if (typeof to !== "string" || to.trim() === "") return undefined;
  return {
    relation: relation.trim(),
    from: from.trim(),
    to: to.trim(),
    confidence: coerceConfidence(raw.confidence),
    attributes: isRecord(raw.attributes) ? raw.attributes : {},
  };
}

/**
 * Normalize + validate raw model output into a RawExtraction.
 *
 * - Coerces per §6: missing confidence -> 1.0, invalid attributes -> {},
 *   missing collections -> [], per-node tags filtered to non-empty strings.
 * - Nodes/edges reference names only; from/to are NOT resolved against the
 *   nodes list here — that resolution is downstream (Phase 3+4).
 * - Drops individual malformed node/edge entries rather than failing the whole
 *   extraction.
 * - Drops dangling edges whose "from" or "to" does not match any node's
 *   "name" (case-sensitive, trimmed exact match — mirrors graph/validate.ts).
 * - Throws ExtractionValidationError for structurally invalid output
 *   (non-object root, missing/empty summary, collections that aren't arrays).
 * - Never throws anything else.
 */
export function parseExtraction(raw: unknown): RawExtraction {
  if (!isRecord(raw)) {
    throw new ExtractionValidationError("extraction output must be a JSON object");
  }

  const summary = raw.summary;
  if (typeof summary !== "string" || summary.trim() === "") {
    throw new ExtractionValidationError("'summary' must be a non-empty string");
  }

  const nodes: ExtractionNode[] = [];
  if (raw.nodes !== undefined) {
    if (!Array.isArray(raw.nodes)) {
      throw new ExtractionValidationError("'nodes' must be an array");
    }
    for (const n of raw.nodes) {
      const node = buildNode(n);
      if (node) nodes.push(node);
    }
  }

  // Build a set of valid node names (trimmed) for dangling-edge detection.
  // Must match graph/validate.ts exactly: case-sensitive, trimmed, exact.
  const validNodeNames = new Set(nodes.map((n) => n.name.trim()));

  const edges: ExtractionEdge[] = [];
  if (raw.edges !== undefined) {
    if (!Array.isArray(raw.edges)) {
      throw new ExtractionValidationError("'edges' must be an array");
    }
    for (const e of raw.edges) {
      const edge = buildEdge(e);
      if (edge) {
        // Drop dangling edges: both endpoints must exist in the nodes list.
        // Uses the SAME predicate as graph/validate.ts (validNodeNames.has(endpoint.trim())).
        const fromValid = validNodeNames.has(edge.from.trim());
        const toValid = validNodeNames.has(edge.to.trim());
        if (fromValid && toValid) {
          edges.push(edge);
        }
        // Silently drop — extraction never hard-fails on dangling edges.
      }
    }
  }

  const tags: string[] = [];
  if (raw.tags !== undefined) {
    if (!Array.isArray(raw.tags)) {
      throw new ExtractionValidationError("'tags' must be an array");
    }
    for (const tag of raw.tags) {
      if (typeof tag === "string" && tag.trim() !== "") tags.push(tag.trim());
    }
  }

  const mood = raw.mood_or_tone;
  const moodOrTone = typeof mood === "string" && mood.trim() !== "" ? mood.trim() : null;

  const result: RawExtraction = {
    summary: summary.trim(),
    tags,
    nodes,
    edges,
    mood_or_tone: moodOrTone,
  };

  if (!Value.Check(RawExtractionSchema, result)) {
    throw new ExtractionValidationError("normalized extraction failed schema validation");
  }
  return result;
}

/**
 * Returns a list of dangling-edge violation messages for the given raw extraction.
 * Each message matches the exact phrasing used by graph/validate.ts so the
 * model can be fed specific feedback. Does NOT throw — returns empty array
 * when there are no violations.
 */
export function danglingEdgeViolations(raw: unknown): string[] {
  if (!isRecord(raw)) return [];

  // Collect valid node names from the raw input (mirrors parseExtraction logic).
  const nodeNames = new Set<string>();
  if (Array.isArray(raw.nodes)) {
    for (const n of raw.nodes) {
      if (isRecord(n)) {
        const name = n.name;
        if (typeof name === "string" && name.trim() !== "") {
          nodeNames.add(name.trim());
        }
      }
    }
  }

  const violations: string[] = [];
  if (Array.isArray(raw.edges)) {
    for (const [idx, e] of raw.edges.entries()) {
      if (!isRecord(e)) continue;
      const from = e.from;
      const to = e.to;
      if (typeof from === "string" && from.trim() !== "" && !nodeNames.has(from.trim())) {
        violations.push(`'edges[${idx}].from' (${JSON.stringify(from)}) does not match any 'nodes[].name' — copy names verbatim`);
      }
      if (typeof to === "string" && to.trim() !== "" && !nodeNames.has(to.trim())) {
        violations.push(`'edges[${idx}].to' (${JSON.stringify(to)}) does not match any 'nodes[].name' — copy names verbatim`);
      }
    }
  }
  return violations;
}