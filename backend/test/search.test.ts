import { describe, expect, it } from "bun:test";
import { searchContext } from "../src/graph/search";
import type { ExtractionResult } from "../src/types";
import { FakeGraphClient } from "./helpers";

/**
 * Phase 3 §9 — context search against a mocked GraphClient: fixed query
 * shapes (only params change), deterministic scoring, 1-hop neighborhood, and
 * shape of the CandidateSet handed to the resolver.
 */

const extraction: ExtractionResult = {
  conversation_id: "conv-1",
  extracted_at: "2026-09-23T00:00:00.000Z",
  raw_source_ref: "conversations/conv-1.json",
  summary: "Two people, one mention.",
  tags: ["test"],
  nodes: [
    { name: "Ana", category: "person", confidence: 1, tags: ["work", "client"] },
    { name: "José", category: "person", confidence: 1, tags: [] },
  ],
  edges: [{ relation: "mentions", from: "Ana", to: "José", confidence: 1, attributes: {} }],
  mood_or_tone: null,
};

describe("searchContext", () => {
  it("scores exact/substring/tag matches deterministically and keeps the 1-hop neighborhood", async () => {
    const graph = new FakeGraphClient([
      // First node query ("Ana"): exact name + tag overlap → 2.0 + 0.5.
      {
        query: /MATCH \(n:Entity\)/,
        records: [
          {
            node_id: "4:test:1",
            name: "Ana",
            category: "person",
            tags: ["work", "colleague"],
            neighborhood: [
              {
                relation: "works_with",
                direction: "out",
                other_node_id: "4:test:9",
                other_name: "Sara",
                attributes: '{"status":"confirmed"}',
              },
            ],
          },
          // Substring name match → 1.0, no tag overlap.
          { node_id: "4:test:2", name: "Ana García", category: "person", tags: ["colleague"], neighborhood: [] },
          // No name, no tag overlap → score 0 → dropped.
          { node_id: "4:test:3", name: "Hiking Boots", category: "item", tags: [], neighborhood: [] },
        ],
      },
      // Second node query ("José"): no candidates.
      { query: /MATCH \(n:Entity\)/, records: [] },
      // Edge relation query ("mentions"): exact match only; the zero-score relation is dropped.
      { query: /RELATED/, records: [{ relation_type: "mentions" }, { relation_type: "is_sister_of" }] },
    ]);

    const result = await searchContext(extraction, graph);

    const ana = result.node_candidates[0];
    expect(ana.extracted_name).toBe("Ana");
    expect(ana.matches.map((m) => ({ name: m.name, score: m.score }))).toEqual([
      { name: "Ana", score: 2.5 },
      { name: "Ana García", score: 1 },
    ]);
    expect(ana.matches[0].neighborhood).toEqual([
      {
        relation: "works_with",
        direction: "out",
        other_node_id: "4:test:9",
        other_name: "Sara",
        attributes: '{"status":"confirmed"}',
      },
    ]);

    const jose = result.node_candidates[1];
    expect(jose.extracted_name).toBe("José");
    expect(jose.matches).toEqual([]);

    expect(result.edge_candidates).toEqual([
      { extracted_relation: "mentions", matches: [{ relation_type: "mentions", score: 2 }] },
    ]);
  });

  it("uses fixed query shapes — only parameters change between calls", async () => {
    const graph = new FakeGraphClient([]); // empty graph → no matches anywhere
    await searchContext(extraction, graph);

    const nodeCall = graph.calls[0];
    const edgeCall = graph.calls[2];

    // Fixed shape, parameterized: no string interpolation of the name.
    expect(nodeCall.query).toMatch(/MATCH \(n:Entity\)/);
    expect(nodeCall.query).toContain("$name");
    expect(nodeCall.query).toContain("$tags");
    expect(nodeCall.query).toContain("$max_candidates");
    expect(nodeCall.query).toContain("OPTIONAL MATCH (n)-[r]-(neighbor)");
    expect(nodeCall.query).not.toContain('"Ana"');
    // The neighborhood projection carries the SEMANTIC relation (r.relation)
    // with the generic type only as fallback, plus direction + attributes —
    // this is what lets the model name a relation instead of "is related".
    expect(nodeCall.query).toContain("coalesce(r.relation, type(r))");
    expect(nodeCall.query).toContain("direction:");
    expect(nodeCall.query).toContain("r.attributes");

    expect(nodeCall.params).toEqual({ name: "Ana", tags: ["work", "client"], max_candidates: 5 });
    expect(graph.calls[1].params.name).toBe("José");
    expect(graph.calls[1].params.tags).toEqual([]);

    expect(edgeCall.query).toMatch(/MATCH \(\)-\s*\[r:RELATED\]->\(\)/);
    expect(edgeCall.query).toContain("$relation");
    expect(edgeCall.params).toEqual({ relation: "mentions" });
  });

  it("matches names case-insensitively and scores tag-only overlap", async () => {
    const graph = new FakeGraphClient([
      { records: [{ node_id: "4:test:1", name: "ana", category: "person", tags: ["work"], neighborhood: [] }] },
      { records: [] },
      { records: [] },
    ]);
    const result = await searchContext(extraction, graph);
    // "ana" vs "Ana" → exact after normalization → 2.0; "work" tag overlap → +0.5.
    expect(result.node_candidates[0].matches[0].score).toBe(2.5);
  });

  it("drops malformed rows defensively (no node_id / no name)", async () => {
    const graph = new FakeGraphClient([
      {
        records: [
          { node_id: "", name: "Ghost", category: "person", tags: [], neighborhood: [] },
          { node_id: "4:test:1", name: "", category: "person", tags: [], neighborhood: [] },
          { node_id: "4:test:2", name: "Ana", category: "person", tags: [], neighborhood: [] },
        ],
      },
      { records: [] },
      { records: [] },
    ]);
    const result = await searchContext(extraction, graph);
    expect(result.node_candidates[0].matches.map((m) => m.name)).toEqual(["Ana"]);
  });

  it("returns empty candidate sets on an empty graph", async () => {
    const graph = new FakeGraphClient([]);
    const result = await searchContext(extraction, graph);
    expect(result.node_candidates).toHaveLength(2);
    expect(result.edge_candidates).toHaveLength(1);
    expect(result.node_candidates.every((n) => n.matches.length === 0)).toBe(true);
    expect(result.edge_candidates[0].matches).toEqual([]);
  });
});