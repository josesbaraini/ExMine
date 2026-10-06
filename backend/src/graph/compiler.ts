import type { GraphParams, GraphClient } from "./client";
import type { ResolutionResult } from "../types";

/**
 * Phase 3 §8 — Query compiler. THE determinism boundary of this phase: it
 * reads ONLY a `ResolutionResult`, has zero imports from the extraction or
 * LLM modules, and zero knowledge of transcripts/conversations. This is what
 * makes graph writes testable with a fixture and no model or real DB
 * (spec §4/§8 and the §10 gate "checkable by grep/diff").
 *
 * Decisions → writes:
 * - node `create`  → MERGE a node on its name (exact), set category/tags.
 * - node `merge`   → no new node; match the resolved `node_id`, merge
 *                   category/tags onto the existing node.
 * - edge `create` / `update` → MERGE the relationship between the resolved
 *                   node ids, SET relation + attributes.
 * - `pending_review` → NO graph write (spec §11 — it exists only in the audit
 *                   log). Edges whose endpoints weren't written are skipped
 *                   and called out in the summary.
 *
 * Modeling decision (documented): categories and relation types are OPEN
 * strings from the LLM, so they cannot be Cypher labels/types (those must be
 * `[A-Za-z_][A-Za-z0-9_]*`, and `"daily standup notes"` is not). Every node is
 * labeled `Entity` with `category` as a property; every relation is typed
 * `RELATED` with the open string on a `relation` property. The context search
 * and compiler agree on this shape.
 */

export const NODE_CREATE_CYPHER = `
MERGE (n:Entity { name: $name })
SET n.category = CASE WHEN n.category IS NULL OR n.category = '' THEN $category ELSE n.category END
SET n.tags = [t IN $tags WHERE NOT t IN coalesce(n.tags, [])] + coalesce(n.tags, [])
RETURN toString(elementId(n)) AS node_id
`;

export const NODE_MERGE_CYPHER = `
MATCH (n) WHERE elementId(n) = $node_id
SET n.category = CASE WHEN n.category IS NULL OR n.category = '' THEN $category ELSE n.category END
SET n.tags = [t IN $tags WHERE NOT t IN coalesce(n.tags, [])] + coalesce(n.tags, [])
RETURN toString(elementId(n)) AS node_id
`;

export const EDGE_MERGE_CYPHER = `
MATCH (a) WHERE elementId(a) = $from_id
MATCH (b) WHERE elementId(b) = $to_id
MERGE (a)-[r:RELATED]->(b)
SET r.relation = $relation_type, r.attributes = $attributes
RETURN toString(elementId(r)) AS edge_id
`;

export function stringifyAttributes(attributes: Record<string, unknown>): string {
  // Neo4j property values must be primitives or arrays of primitives — maps
  // are rejected at the server. Edge attributes are arbitrary JSON from the
  // LLM, so they are stored as one JSON string on the relationship; readers
  // of the graph JSON.parse() it. The summary still renders the object form.
  return JSON.stringify(attributes);
}

export interface WriteCall {
  query: string;
  params: GraphParams;
}

export interface CompileResult {
  /** Templated, non-LLM summary built from the decisions (§8). */
  summary: string;
  /** Every mutation call made this pass, for observability and tests. */
  writes: WriteCall[];
}

/**
 * Apply a resolution's decisions to the graph and build the templated summary.
 * Throws GraphError on any write failure (the audit entry is already on disk
 * by the time this runs — nothing is lost).
 */
export async function compile(resolution: ResolutionResult, graph: GraphClient): Promise<CompileResult> {
  const writes: WriteCall[] = [];
  const nameToId = new Map<string, string>();
  const nodeParts: string[] = [];

  for (const node of resolution.nodes) {
    switch (node.decision) {
      case "create": {
        const params = { name: node.extracted_name, category: node.category, tags: node.tags };
        writes.push({ query: NODE_CREATE_CYPHER, params });
        const res = await graph.run(NODE_CREATE_CYPHER, params);
        const id = firstString(res.records, "node_id");
        if (id) nameToId.set(node.extracted_name, id);
        nodeParts.push(`Added ${node.extracted_name} as a new ${node.category || "uncategorised"} node.`);
        break;
      }
      case "merge": {
        if (!node.node_id) break; // validation guarantees this, but stay defensive
        const params = { node_id: node.node_id, category: node.category, tags: node.tags };
        writes.push({ query: NODE_MERGE_CYPHER, params });
        const res = await graph.run(NODE_MERGE_CYPHER, params);
        const id = firstString(res.records, "node_id");
        if (id) nameToId.set(node.extracted_name, id);
        nodeParts.push(`Merged ${node.extracted_name} into the existing ${node.category || "uncategorised"} node.`);
        break;
      }
      case "pending_review":
        nodeParts.push(`Held ${node.extracted_name} for review (not written).`);
        break;
    }
  }

  const edgeParts: string[] = [];
  for (const edge of resolution.edges) {
    if (edge.decision === "pending_review") {
      edgeParts.push(`Held ${edge.from} →${edge.relation_type}→ ${edge.to} for review (not written).`);
      continue;
    }
    const fromId = nameToId.get(edge.from);
    const toId = nameToId.get(edge.to);
    if (!fromId || !toId) {
      edgeParts.push(`Skipped linking ${edge.from} →${edge.relation_type}→ ${edge.to} (an endpoint is held for review).`);
      continue;
    }
    const params = {
      from_id: fromId,
      to_id: toId,
      relation_type: edge.relation_type,
      attributes: stringifyAttributes(edge.attributes),
    };
    writes.push({ query: EDGE_MERGE_CYPHER, params });
    await graph.run(EDGE_MERGE_CYPHER, params);
    const verb = edge.decision === "update" ? "Updated" : "Linked";
    edgeParts.push(`${verb} ${edge.from} →${edge.relation_type}→ ${edge.to}${renderAttributes(edge.attributes)}.`);
  }

  const summary = [...nodeParts, ...edgeParts].length
    ? [...nodeParts, ...edgeParts].join(" ")
    : "Nothing written — every item was held for review.";

  return { summary, writes };
}

function firstString(records: Record<string, unknown>[], key: string): string | null {
  for (const record of records) {
    const value = record[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return null;
}

/** Deterministic rendering of edge attributes for the summary — sorted keys. */
function renderAttributes(attributes: Record<string, unknown>): string {
  const keys = Object.keys(attributes).sort();
  if (keys.length === 0) return "";
  return ` (${keys.map((k) => `${k}: ${simpleValue(attributes[k])}`).join(", ")})`;
}

function simpleValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "null";
  return JSON.stringify(value);
}