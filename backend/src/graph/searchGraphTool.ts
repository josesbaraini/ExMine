/**
 * Phase 3.5 §5 — the `search_graph` tool: JSON-schema definition + execution
 * wrapper. Lives beside Phase 3's context-search module, NOT inside LLMClient
 * or the chat route (§2: OpenRouterClient stays domain-agnostic; it must never
 * learn what "search_graph" means).
 *
 * The actual search is Phase 3's searchContext() — reused UNCHANGED, no new
 * search logic (§2). Its signature is (extraction, graph), built for write-time
 * resolution where a full extraction already exists; the tool contract is
 * ({ tags, name_query? }). This module is the adapter between the two: it
 * builds a synthetic one-node ExtractionResult so nothing in search.ts (or the
 * Phase 3/4 extract → resolve → compile pipeline) is touched — the promise that
 * this phase is read-only over Phase 3+4 stays literally true.
 *
 * Read-only by construction: the only graph access is searchContext(), which
 * only ever runs parameterized READ Cypher (§5: "must never call the query
 * compiler or write anything to Neo4j").
 */

import type { CandidateSet, ExtractionResult, ToolDef } from "../types";
import type { GraphClient } from "./client";
import { searchContext } from "./search";

/** Tool definition in OpenRouter/OpenAI function-calling format (§5). */
export const SEARCH_GRAPH_TOOL_DEF: ToolDef = {
  type: "function",
  function: {
    name: "search_graph",
    description:
      "Search the personal knowledge graph for existing notes about a person, topic, or project. Provide 2-5 tags describing what to find; when the user names a specific person, topic, or project, include that exact name in name_query — but names placed in tags are also matched against stored names, so either way is fine. Neighborhood entries include edge_id (use it for update_edge/delete_edge). If nothing matches, say so rather than guessing or inventing an answer.",
    parameters: {
      type: "object",
      properties: {
        tags: { type: "array", items: { type: "string" } },
        name_query: { type: "string" },
      },
    },
  },
};

/** The tool-call argument contract (§5). */
export interface SearchGraphArgs {
  tags: string[];
  name_query?: string;
}

/**
 * Normalize the model's (untrusted) raw arguments into SearchGraphArgs.
 * Defensive: a non-string tag or a blank name_query is junk, not an error —
 * junk simply yields no search hooks, and zero matches is a VALID result
 * (§5: "the model is instructed to say so rather than fabricate").
 */
export function coerceSearchGraphArgs(raw: Record<string, unknown>): SearchGraphArgs {
  const tags = Array.isArray(raw.tags)
    ? raw.tags
        .filter((t): t is string => typeof t === "string")
        .map((t) => t.trim())
        .filter((t) => t !== "")
    : [];
  const nameQuery =
    typeof raw.name_query === "string" && raw.name_query.trim() !== "" ? raw.name_query.trim() : undefined;
  return nameQuery === undefined ? { tags } : { tags, name_query: nameQuery };
}

/**
 * Execute one search_graph tool call (§5). Wraps Phase 3's searchContext()
 * with NO new search logic: the args become a synthetic one-node extraction
 * (name = name_query ?? "", tags = the query tags) and searchContext runs its
 * fixed Cypher against the graph. Output is searchContext()'s existing
 * CandidateSet — no new schema to design or validate.
 *
 * Name-less behavior (the common read case): the extraction node's name is ""
 * and search.ts's NODE_SEARCH_CYPHER only applies its name clauses when
 * $name <> '' (a guard added after Phase 3.5 QA: with an empty name the old
 * `CONTAINS ''` matched EVERY node and the LIMIT could truncate away genuine
 * tag matches). So a name-less search matches by tags alone — and since the
 * model often puts explicit names in tags, search.ts also matches a query tag
 * against stored NAMES ("Who is Ana?" arrives as tags:["Ana"] and must find
 * the Ana node). search.ts's score>0 filter still drops any candidate with no
 * name/tag evidence. Empty tags AND no name_query → zero matches, which is a
 * VALID result (§5: the model is told to say so rather than fabricate).
 *
 * Neighborhood entries carry the edge's SEMANTIC relation name, direction,
 * and attributes (see search.ts) — so the model can answer "what is the
 * relation between X and Y" instead of the generic "is related to".
 */
export async function executeSearchGraphTool(
  args: SearchGraphArgs,
  graph: GraphClient,
): Promise<CandidateSet> {
  return searchContext(extractionForSearch(args), graph);
}

/** The synthetic one-node extraction that adapts the tool contract to
 * searchContext()'s write-time signature. Edges are always empty: relation
 * lookup only makes sense when a real extraction produced edges (the read path
 * answers "what exists", not "what relations are typable"). */
function extractionForSearch(args: SearchGraphArgs): ExtractionResult {
  return {
    conversation_id: "search_graph_tool",
    extracted_at: new Date().toISOString(),
    raw_source_ref: "search_graph tool call (read-only)",
    summary: "",
    tags: args.tags,
    nodes: [
      {
        name: args.name_query ?? "",
        category: "topic",
        confidence: 1,
        tags: args.tags,
      },
    ],
    edges: [],
    mood_or_tone: null,
  };
}
