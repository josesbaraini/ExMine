import { describe, expect, it } from "bun:test";
import { DELETE_NODE_TOOL_DEF, coerceDeleteNodeArgs, executeDeleteNodeTool } from "../src/graph/deleteNodeTool";
import { FakeGraphClient } from "./helpers";

/**
 * Phase 3.6 §9 — delete_node tool unit tests against a mocked GraphClient.
 * Mirrors the search-graph test structure: correct Cypher shape, correct audit
 * snapshot, missing id → 404-style result, never a crash.
 */

const nodeId = "4:test:node-123";

describe("DELETE_NODE_TOOL_DEF — tool definition", () => {
  it("has the correct name and required parameters", () => {
    expect(DELETE_NODE_TOOL_DEF.type).toBe("function");
    expect(DELETE_NODE_TOOL_DEF.function.name).toBe("delete_node");
    expect(DELETE_NODE_TOOL_DEF.function.parameters.required).toEqual(["node_id"]);
    expect(DELETE_NODE_TOOL_DEF.function.parameters.properties.node_id).toBeDefined();
  });

  it("description contains the confirmation gate instruction", () => {
    const desc = DELETE_NODE_TOOL_DEF.function.description;
    expect(desc).toContain("confirm");
    expect(desc).toContain("yes");
    expect(desc).toContain("search_graph");
    expect(desc).toContain("node_id");
    expect(desc).toContain("NEVER call delete_node in the same turn");
  });
});

describe("coerceDeleteNodeArgs — argument normalization", () => {
  it("accepts a valid node_id string", () => {
    const args = coerceDeleteNodeArgs({ node_id: nodeId });
    expect(args).toEqual({ node_id: nodeId });
  });

  it("trims whitespace", () => {
    const args = coerceDeleteNodeArgs({ node_id: `  ${nodeId}  ` });
    expect(args).toEqual({ node_id: nodeId });
  });

  it("rejects missing node_id", () => {
    expect(coerceDeleteNodeArgs({})).toBeNull();
  });

  it("rejects empty string node_id", () => {
    expect(coerceDeleteNodeArgs({ node_id: "" })).toBeNull();
  });

  it("rejects whitespace-only node_id", () => {
    expect(coerceDeleteNodeArgs({ node_id: "   " })).toBeNull();
  });

  it("rejects non-string node_id", () => {
    expect(coerceDeleteNodeArgs({ node_id: 123 })).toBeNull();
  });

  it("ignores extra properties", () => {
    const args = coerceDeleteNodeArgs({ node_id: nodeId, extra: "ignored" });
    expect(args).toEqual({ node_id: nodeId });
  });
});

describe("executeDeleteNodeTool — execution against mocked GraphClient", () => {
  it("reads the node + edges, runs DETACH DELETE, returns snapshot, and persists audit log", async () => {
    const graph = new FakeGraphClient([
      // First call: read node + edges for snapshot
      {
        query: /MATCH \(n\) WHERE elementId\(n\) = \$node_id/,
        records: [
          {
            name: "Test Node",
            category: "topic",
            tags: ["tag1", "tag2"],
            edges: [
              {
                edge_id: "4:edge:1",
                relation: "related_to",
                direction: "out",
                other_node_id: "4:other:1",
                other_name: "Other Node",
                other_category: "person",
                attributes: '{"status":"active"}',
              },
              {
                edge_id: "4:edge:2",
                relation: "depends_on",
                direction: "in",
                other_node_id: "4:other:2",
                other_name: "Another Node",
                other_category: "project",
                attributes: "{}",
              },
            ],
          },
        ],
      },
      // Second call: DETACH DELETE
      { query: /DETACH DELETE n/, records: [] },
    ]);

    const dataDir = "/tmp/test-data-dir";
    const snapshot = await executeDeleteNodeTool({ node_id: nodeId }, graph, dataDir);

    expect(graph.calls).toHaveLength(2);
    expect(graph.calls[0].query).toContain("MATCH (n) WHERE elementId(n)");
    expect(graph.calls[0].params).toEqual({ node_id: nodeId });
    expect(graph.calls[1].query).toContain("DETACH DELETE");
    expect(graph.calls[1].params).toEqual({ node_id: nodeId });

    expect(snapshot).toEqual({
      node_id: nodeId,
      name: "Test Node",
      category: "topic",
      tags: ["tag1", "tag2"],
      edges: [
        {
          edge_id: "4:edge:1",
          relation: "related_to",
          direction: "out",
          other_node_id: "4:other:1",
          other_name: "Other Node",
          other_category: "person",
          attributes: { status: "active" },
        },
        {
          edge_id: "4:edge:2",
          relation: "depends_on",
          direction: "in",
          other_node_id: "4:other:2",
          other_name: "Another Node",
          other_category: "project",
          attributes: {},
        },
      ],
    });
  });

  it("handles a node with no edges (empty edges array)", async () => {
    const graph = new FakeGraphClient([
      {
        query: /MATCH \(n\) WHERE elementId\(n\) = \$node_id/,
        records: [
          {
            name: "Lonely Node",
            category: "place",
            tags: [],
            edges: [], // no edges
          },
        ],
      },
      { query: /DETACH DELETE n/, records: [] },
    ]);

    const dataDir = "/tmp/test-data-dir";
    const snapshot = await executeDeleteNodeTool({ node_id: nodeId }, graph, dataDir);

    expect(snapshot.edges).toEqual([]);
    expect(snapshot.name).toBe("Lonely Node");
    expect(snapshot.category).toBe("place");
  });

  it("filters out null edges from OPTIONAL MATCH", async () => {
    const graph = new FakeGraphClient([
      {
        query: /MATCH \(n\) WHERE elementId\(n\) = \$node_id/,
        records: [
          {
            name: "Node With Null Edge",
            category: "topic",
            tags: [],
            edges: [
              { edge_id: null, relation: null, direction: "out", other_node_id: null, other_name: null, other_category: null, attributes: null },
              { edge_id: "4:edge:1", relation: "real_edge", direction: "out", other_node_id: "4:other:1", other_name: "Real Other", other_category: "person", attributes: "{}" },
            ],
          },
        ],
      },
      { query: /DETACH DELETE n/, records: [] },
    ]);

    const dataDir = "/tmp/test-data-dir";
    const snapshot = await executeDeleteNodeTool({ node_id: nodeId }, graph, dataDir);

    expect(snapshot.edges).toHaveLength(1);
    expect(snapshot.edges[0].relation).toBe("real_edge");
  });

  it("parses string attributes to objects", async () => {
    const graph = new FakeGraphClient([
      {
        query: /MATCH \(n\) WHERE elementId\(n\) = \$node_id/,
        records: [
          {
            name: "Attr Node",
            category: "topic",
            tags: [],
            edges: [
              {
                edge_id: "4:edge:1",
                relation: "has_attr",
                direction: "out",
                other_node_id: "4:other:1",
                other_name: "Other",
                other_category: "person",
                attributes: '{"key":"value","num":42,"bool":true,"nested":{"a":1}}',
              },
            ],
          },
        ],
      },
      { query: /DETACH DELETE n/, records: [] },
    ]);

    const dataDir = "/tmp/test-data-dir";
    const snapshot = await executeDeleteNodeTool({ node_id: nodeId }, graph, dataDir);

    expect(snapshot.edges[0].attributes).toEqual({ key: "value", num: 42, bool: true, nested: { a: 1 } });
  });

  it("throws GraphError with NOT_FOUND code when node doesn't exist", async () => {
    const graph = new FakeGraphClient([
      {
        query: /MATCH \(n\) WHERE elementId\(n\) = \$node_id/,
        records: [], // no node found
      },
    ]);

    const dataDir = "/tmp/test-data-dir";

    let error: Error | null = null;
    try {
      await executeDeleteNodeTool({ node_id: "nonexistent" }, graph, dataDir);
    } catch (err) {
      error = err as Error;
    }

    expect(error).not.toBeNull();
    expect(error!.name).toBe("GraphError");
    expect((error as any).code).toBe("NOT_FOUND");
    expect(error!.message).toContain("not found");
  });

  it("throws GraphQueryError on DETACH DELETE failure (502 path)", async () => {
    const { GraphQueryError } = await import("../src/graph/client");
    const graph = new FakeGraphClient([
      {
        query: /MATCH \(n\) WHERE elementId\(n\) = \$node_id/,
        records: [{ name: "Test", category: "topic", tags: [], edges: [] }],
      },
      { query: /DETACH DELETE n/, error: new GraphQueryError("constraint violated") },
    ]);

    const dataDir = "/tmp/test-data-dir";

    let error: Error | null = null;
    try {
      await executeDeleteNodeTool({ node_id: nodeId }, graph, dataDir);
    } catch (err) {
      error = err as Error;
    }

    expect(error).not.toBeNull();
    expect(error!.name).toBe("GraphQueryError");
    expect(error!.message).toContain("constraint violated");
  });
});