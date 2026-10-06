import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { NODE_CREATE_CYPHER, NODE_MERGE_CYPHER, EDGE_MERGE_CYPHER, compile } from "../src/graph/compiler";
import type { ResolutionResult } from "../src/types";
import { FakeGraphClient } from "./helpers";

/**
 * Phase 3 §9 — query compiler tested with a fixed ResolutionResult fixture.
 * This is the phase's most valuable test: fully deterministic, no LLM and no
 * real DB involved. It asserts the exact mutation calls the compiler makes
 * and the templated (non-LLM) summary it builds.
 */

const resolution: ResolutionResult = {
  resolution_id: "res-fx-1",
  source_extraction_ref: "conversations/abc.json",
  resolved_at: "2026-09-23T00:00:00.000Z",
  nodes: [
    {
      extracted_name: "Ana",
      decision: "create",
      node_id: null,
      category: "person",
      tags: ["work"],
      candidates_considered: [],
      reason: null,
    },
    {
      extracted_name: "José",
      decision: "merge",
      node_id: "4:abc:5",
      category: "person",
      tags: ["friend"],
      candidates_considered: [{ node_id: "4:abc:5", name: "José García", score: 1 }],
      reason: "same person under a fuller name",
    },
    {
      extracted_name: "Ambiguous Topic",
      decision: "pending_review",
      node_id: null,
      category: "topic",
      tags: [],
      candidates_considered: [
        { node_id: "4:abc:7", name: "Ambiguous Topic", score: 2 },
        { node_id: "4:abc:8", name: "Ambiguous Topic II", score: 1.5 },
      ],
      reason: "two equally likely matches — held for review rather than guessed",
    },
  ],
  edges: [
    {
      extracted_relation: "needs_to_check",
      decision: "create",
      edge_id: null,
      relation_type: "needs_to_check",
      from: "Ana",
      to: "José",
      attributes: { status: "undone" },
      reason: null,
    },
    {
      extracted_relation: "maybe_related",
      decision: "pending_review",
      edge_id: null,
      relation_type: "maybe_related",
      from: "Ana",
      to: "Ambiguous Topic",
      attributes: {},
      reason: "held — ambiguous which relationship this refers to",
    },
  ],
};

describe("compile — deterministic writes from a ResolutionResult", () => {
  it("turns create/merge/pending decisions into exactly the expected mutations", async () => {
    const graph = new FakeGraphClient([
      { query: NODE_CREATE_CYPHER, records: [{ node_id: "4:abc:100" }] },
      { query: NODE_MERGE_CYPHER, records: [{ node_id: "4:abc:5" }] },
      { query: EDGE_MERGE_CYPHER, records: [{ edge_id: "4:abc:200" }] },
    ]);

    const { summary, writes } = await compile(resolution, graph);

    expect(graph.calls).toEqual([
      { query: NODE_CREATE_CYPHER, params: { name: "Ana", category: "person", tags: ["work"] } },
      { query: NODE_MERGE_CYPHER, params: { node_id: "4:abc:5", category: "person", tags: ["friend"] } },
      {
        query: EDGE_MERGE_CYPHER,
        params: { from_id: "4:abc:100", to_id: "4:abc:5", relation_type: "needs_to_check", attributes: '{"status":"undone"}' },
      },
    ]);

    // The writes array mirrors the mutations, for observability.
    expect(writes).toEqual(graph.calls);

    expect(summary).toBe(
      "Added Ana as a new person node. " +
        "Merged José into the existing person node. " +
        "Held Ambiguous Topic for review (not written). " +
        "Linked Ana →needs_to_check→ José (status: undone). " +
        "Held Ana →maybe_related→ Ambiguous Topic for review (not written).",
    );
  });

  it("writes nothing for an empty resolution and says so plainly", async () => {
    const held: ResolutionResult = { ...resolution, nodes: [], edges: [] };
    const graph = new FakeGraphClient([]);
    const { summary, writes } = await compile(held, graph);
    expect(writes).toEqual([]);
    expect(graph.calls).toEqual([]);
    expect(summary).toBe("Nothing written — every item was held for review.");
  });

  it("skips an edge whose endpoint is held for review (never a dangling write)", async () => {
    const heldEndpoint: ResolutionResult = {
      ...resolution,
      nodes: [
        resolution.nodes[0], // Ana → create, gets an id
        {
          extracted_name: "Ambiguous Topic",
          decision: "pending_review",
          node_id: null,
          category: "topic",
          tags: [],
          candidates_considered: [],
          reason: "held",
        },
      ],
      edges: [
        {
          extracted_relation: "needs_to_check",
          decision: "create",
          edge_id: null,
          relation_type: "needs_to_check",
          from: "Ana",
          to: "Ambiguous Topic",
          attributes: {},
          reason: null,
        },
      ],
    };
    const graph = new FakeGraphClient([
      { query: NODE_CREATE_CYPHER, records: [{ node_id: "4:abc:100" }] },
    ]);
    const { summary, writes } = await compile(heldEndpoint, graph);
    expect(graph.calls).toEqual([
      { query: NODE_CREATE_CYPHER, params: { name: "Ana", category: "person", tags: ["work"] } },
    ]);
    expect(writes).toHaveLength(1); // node only — the edge was skipped
    expect(summary).toContain("Skipped linking Ana →needs_to_check→ Ambiguous Topic (an endpoint is held for review).");
  });

  it("merges tags onto an existing node without creating a new one", async () => {
    const mergeOnly: ResolutionResult = {
      ...resolution,
      nodes: [
        { ...resolution.nodes[1], extracted_name: "Ana", node_id: "4:abc:5" }, // Ana → merge
      ],
      edges: [],
    };
    const graph = new FakeGraphClient([{ query: NODE_MERGE_CYPHER, records: [{ node_id: "4:abc:5" }] }]);
    const { summary, writes } = await compile(mergeOnly, graph);
    expect(graph.calls).toEqual([
      { query: NODE_MERGE_CYPHER, params: { node_id: "4:abc:5", category: "person", tags: ["friend"] } },
    ]);
    expect(writes).toHaveLength(1);
    expect(summary).toBe("Merged Ana into the existing person node.");
  });

  it("uses the write verb for updated edges and renders sorted attributes deterministically", async () => {
    const updated: ResolutionResult = {
      ...resolution,
      nodes: [resolution.nodes[0], resolution.nodes[1]], // both endpoints resolved
      edges: [
        {
          ...resolution.edges[0],
          decision: "update",
          attributes: { zeta: 1, alpha: "x" },
        },
      ],
    };
    const graph = new FakeGraphClient([
      { query: NODE_CREATE_CYPHER, records: [{ node_id: "4:abc:100" }] },
      { query: NODE_MERGE_CYPHER, records: [{ node_id: "4:abc:5" }] },
      { query: EDGE_MERGE_CYPHER, records: [{ edge_id: "4:abc:200" }] },
    ]);
    const { summary } = await compile(updated, graph);
    // Sorted keys, not insertion order — deterministic output.
    expect(summary).toContain("Updated Ana →needs_to_check→ José (alpha: x, zeta: 1).");
  });
});

describe("compile — §10 module-boundary gate", () => {
  it("imports nothing from the extraction, LLM, or storage modules (reads only ResolutionResult)", async () => {
    const source = await readFile(join(import.meta.dir, "../src/graph/compiler.ts"), "utf8");
    // The gate is about imports — check every import statement, not doc words.
    const importLines = source.split("\n").filter((l) => l.startsWith("import "));
    expect(importLines.length).toBeGreaterThan(0);
    for (const line of importLines) {
      expect(line).not.toMatch(/\/llm|\/storage|\/diary/);
      expect(line).not.toMatch(/\/extract/);
    }
    expect(importLines.join("\n")).toMatch(/\.\.\/types/); // reads the ResolutionResult type
    expect(source).not.toContain("extraction.nodes["); // never reaches behind ResolutionResult
  });
});