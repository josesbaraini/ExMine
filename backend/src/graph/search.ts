/**
 * Phase 3 §6 — deterministic context search. Pure code: a fixed set of Cypher
 * query shapes whose parameters change per call. NO LLM in this step — that is
 * the hard rule (spec §4/§6). Scores are a simple deterministic function
 * (name similarity + tag overlap); they hand the resolver evidence, they are
 * never a decision on their own.
 *
 * Rules honored here (spec §6):
 * - match strategies: (a) exact/fuzzy name match, (b) tag overlap, and for
 *   every matched candidate its **1-hop neighborhood only** (hard bound on
 *   traversal).
 * - node identity throughout is Neo4j's elementId.
 */

import type {
  CandidateSet,
  EdgeCandidate,
  EdgeCandidateSet,
  ExtractionResult,
  NeighborhoodEntry,
  NodeCandidate,
  NodeCandidateSet,
} from "../types";
import { GraphClient } from "./client";

const MAX_CANDIDATES_PER_NODE = 5;
const MAX_MATCHES_PER_NODE = 5;
const MAX_MATCHES_PER_EDGE = 5;

/**
 * One fixed shape for node lookup; only ($name, $tags, $max_candidates)
 * change. Case-insensitive name match OR tag overlap; the 1-hop neighborhood
 * is collected per candidate in the same query. NULL entries (from the
 * OPTIONAL MATCH on lonely nodes) are filtered out in the projection.
 *
 * The $name <> "" guard matters: a query with NO name (the read path's
 * `search_graph` with only tags) would otherwise hit `CONTAINS ""`, which is
 * true for every row — making the WHERE match ALL nodes and letting the
 * `LIMIT $max_candidates` truncate the pool to an arbitrary set BEFORE the
 * tag overlap even runs (a real-graph miss, seen in Phase 3.5 QA). With the
 * guard, a name-less search matches by tags alone. Write-time callers always
 * pass a non-empty name (parseExtraction requires one), so their behavior is
 * unchanged.
 *
 * The third OR branch (a query tag equal to a stored NAME) exists because the
 * read path's model — despite the tool schema — frequently puts explicit
 * entity names in `tags` instead of `name_query` (observed live: "Who is
 * Ana?" arrives as `{tags:["Ana"]}`). Without this branch such a search
 * matches nothing and the assistant wrongly claims the graph has no notes
 * about Ana. "A tag that names an entity IS that entity" is a faithful read
 * of the write-time rules (name match OR tag overlap); it only fires when a
 * tag coincides with a stored name, so it cannot broaden unrelated searches.
 *
 * The neighborhood projection carries the edge's SEMANTIC relation
 * (`r.relation`, e.g. "is_hiring") rather than the generic type (`type(r)` is
 * always "RELATED" in this schema — the compiler stores every edge under that
 * fixed type). Exposing the bare type made the read path answer "is related
 * to" about known relations and planted vague phrasing that later extractions
 * turned into junk edges. `coalesce` keeps "RELATED" only as a fallback for
 * edges lacking the property. Direction and attributes are included so the
 * model has the full edge picture.
 */
const NODE_SEARCH_CYPHER = `
MATCH (n:Entity)
WHERE ($name <> '' AND (
    toLower(n.name) = toLower($name)
 OR toLower(n.name) CONTAINS toLower($name)
 OR toLower($name) CONTAINS toLower(n.name)
   ))
 OR any(t IN $tags WHERE toLower(t) IN [nt IN n.tags | toLower(nt)])
 OR toLower(n.name) IN [t IN $tags | toLower(t)]
WITH n LIMIT $max_candidates
OPTIONAL MATCH (n)-[r]-(neighbor)
WITH n,
     collect(DISTINCT CASE
       WHEN r IS NULL THEN null
       ELSE {
         relation: coalesce(r.relation, type(r)),
         direction: CASE WHEN startNode(r) = n THEN 'out' ELSE 'in' END,
         other_node_id: toString(elementId(CASE WHEN startNode(r) = n THEN endNode(r) ELSE startNode(r) END)),
         other_name: CASE WHEN startNode(r) = n THEN endNode(r).name ELSE startNode(r).name END,
         attributes: r.attributes,
         edge_id: toString(elementId(r))
       }
     END) AS raw_neighborhood
RETURN toString(elementId(n)) AS node_id,
       n.name AS name,
       n.category AS category,
       n.tags AS tags,
       [x IN raw_neighborhood WHERE x IS NOT NULL] AS neighborhood
ORDER BY name
`;

/**
 * One fixed shape for relation-type lookup. All edges are stored under the
 * generic `RELATED` type with the open-string relation on the `relation`
 * property (see compiler.ts), so candidate relation types come from that
 * property, not from `db.relationTypes()`.
 */
const EDGE_RELATION_CYPHER = `
MATCH ()-[r:RELATED]->()
WHERE toLower(r.relation) CONTAINS toLower($relation)
   OR toLower($relation) CONTAINS toLower(r.relation)
RETURN DISTINCT r.relation AS relation_type
ORDER BY relation_type
`;

export async function searchContext(extraction: ExtractionResult, graph: GraphClient): Promise<CandidateSet> {
  const nodeCandidates: NodeCandidateSet[] = [];
  for (const node of extraction.nodes) {
    nodeCandidates.push(await searchNodes(node.name, node.tags, graph));
  }

  const edgeCandidates: EdgeCandidateSet[] = [];
  for (const edge of extraction.edges) {
    edgeCandidates.push(await searchRelations(edge.relation, graph));
  }

  return { node_candidates: nodeCandidates, edge_candidates: edgeCandidates };
}

async function searchNodes(name: string, tags: string[], graph: GraphClient): Promise<NodeCandidateSet> {
  const { records } = await graph.run(NODE_SEARCH_CYPHER, {
    name,
    tags,
    max_candidates: MAX_CANDIDATES_PER_NODE,
  });

  const matches: NodeCandidate[] = [];
  for (const record of records) {
    const candidate: NodeCandidate = {
      node_id: typeof record.node_id === "string" ? record.node_id : "",
      name: typeof record.name === "string" ? record.name : "",
      category: typeof record.category === "string" ? record.category : "",
      tags: toTagArray(record.tags),
      neighborhood: coerceNeighborhood(record.neighborhood),
      score: 0,
    };
    if (!candidate.node_id || !candidate.name) continue;
    const score = nodeScore({ name, tags }, candidate);
    if (score > 0) matches.push({ ...candidate, score });
  }

  matches.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return { extracted_name: name, matches: matches.slice(0, MAX_MATCHES_PER_NODE) };
}

async function searchRelations(relation: string, graph: GraphClient): Promise<EdgeCandidateSet> {
  const { records } = await graph.run(EDGE_RELATION_CYPHER, { relation });

  const matches: EdgeCandidate[] = [];
  for (const record of records) {
    const relationType = typeof record.relation_type === "string" ? record.relation_type : "";
    if (!relationType) continue;
    const score = edgeScore(relation, relationType);
    if (score > 0) matches.push({ relation_type: relationType, score });
  }

  matches.sort((a, b) => b.score - a.score || a.relation_type.localeCompare(b.relation_type));
  return { extracted_relation: relation, matches: matches.slice(0, MAX_MATCHES_PER_EDGE) };
}

// ---------------------------------------------------------------------------
// Deterministic scoring (§6): exact name 2.0, substring 1.0, tag overlap +0.5
// each (case-insensitive). Never a final decision — evidence for the resolver.
// ---------------------------------------------------------------------------

function normalize(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, " ");
}

function nameScore(extracted: string, candidate: string): number {
  const a = normalize(extracted);
  const b = normalize(candidate);
  if (a === "" || b === "") return 0;
  if (a === b) return 2;
  if (a.includes(b) || b.includes(a)) return 1;
  return 0;
}

function tagOverlap(extracted: string[], candidate: string[]): number {
  const set = new Set(extracted.map(normalize).filter((t) => t !== ""));
  return candidate.filter((t) => set.has(normalize(t))).length;
}

function nodeScore(extracted: { name: string; tags: string[] }, candidate: { name: string; tags: string[] }): number {
  // A query tag that equals the candidate's NAME is scored as half an exact
  // name match (+1). This is what keeps the read path's score>0 filter from
  // discarding a node found via `name IN tags` (WHERE above) — otherwise the
  // filter would reject exactly the match the new WHERE branch produced.
  const nameViaTag =
    candidate.name !== "" && extracted.tags.some((t) => normalize(t) === normalize(candidate.name)) ? 1 : 0;
  return nameScore(extracted.name, candidate.name) + 0.5 * tagOverlap(extracted.tags, candidate.tags) + nameViaTag;
}

function edgeScore(extracted: string, candidate: string): number {
  return nameScore(extracted, candidate);
}

// ---------------------------------------------------------------------------
// Coercion of DB rows (already plain-JS after GraphClient; be defensive anyway)
// ---------------------------------------------------------------------------

function toTagArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((t) => (typeof t === "string" ? t : String(t))).filter((t) => t !== "");
}

function coerceNeighborhood(raw: unknown): NeighborhoodEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: NeighborhoodEntry[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const o = item as Record<string, unknown>;
    const relation = typeof o.relation === "string" ? o.relation : "";
    const direction = o.direction === "in" ? "in" : "out";
    const other_node_id = typeof o.other_node_id === "string" ? o.other_node_id : "";
    const other_name = typeof o.other_name === "string" ? o.other_name : "";
    if (!relation || !other_node_id) continue;
    const entry: NeighborhoodEntry = { relation, direction, other_node_id, other_name };
    if (typeof o.attributes === "string") entry.attributes = o.attributes;
    if (typeof o.edge_id === "string") entry.edge_id = o.edge_id;
    out.push(entry);
  }
  return out;
}