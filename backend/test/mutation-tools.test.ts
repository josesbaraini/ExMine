import { describe, expect, it } from "bun:test";
import {
  CREATE_NODE_TOOL_DEF,
  coerceCreateNodeArgs,
  executeCreateNodeTool,
  UPDATE_NODE_TOOL_DEF,
  coerceUpdateNodeArgs,
  executeUpdateNodeTool,
  MERGE_NODES_TOOL_DEF,
  coerceMergeNodesArgs,
  executeMergeNodesTool,
  CREATE_EDGE_TOOL_DEF,
  coerceCreateEdgeArgs,
  executeCreateEdgeTool,
  UPDATE_EDGE_TOOL_DEF,
  coerceUpdateEdgeArgs,
  executeUpdateEdgeTool,
  DELETE_EDGE_TOOL_DEF,
  coerceDeleteEdgeArgs,
  executeDeleteEdgeTool,
} from "../src/graph/mutationTools";
import { FakeGraphClient } from "./helpers";

/**
 * Phase 4 §12 — unit tests for every mutation tool: correct Cypher shape,
 * correct coercion, no crash on bad input.
 */

describe("create_node", () => {
  it("coerces valid args", () => {
    expect(coerceCreateNodeArgs({ name: "Ana", category: "person", tags: ["hiring"] })).toEqual({ name: "Ana", category: "person", tags: ["hiring"] });
  });
  it("rejects missing name", () => {
    expect(coerceCreateNodeArgs({ category: "person" })).toBeNull();
  });
  it("rejects missing category", () => {
    expect(coerceCreateNodeArgs({ name: "Ana" })).toBeNull();
  });
  it("executes CREATE with correct params", async () => {
    const graph = new FakeGraphClient([{ records: [{ node_id: "4:t:1", name: "Ana", category: "person" }] }]);
    const result = await executeCreateNodeTool({ name: "Ana", category: "person", tags: [] }, graph);
    expect(result.node_id).toBe("4:t:1");
    expect(graph.calls[0].query).toContain("CREATE (n:Entity");
    expect(graph.calls[0].params).toEqual({ name: "Ana", category: "person", tags: [], attributes: "{}" });
  });
});

describe("update_node", () => {
  it("coerces args with only node_id", () => {
    expect(coerceUpdateNodeArgs({ node_id: "4:t:1" })).toEqual({ node_id: "4:t:1" });
  });
  it("coerces full args", () => {
    expect(coerceUpdateNodeArgs({ node_id: "4:t:1", name: "Ana", category: "person", tags: ["x"] })).toEqual({ node_id: "4:t:1", name: "Ana", category: "person", tags: ["x"] });
  });
  it("rejects missing node_id", () => {
    expect(coerceUpdateNodeArgs({ name: "Ana" })).toBeNull();
  });
  it("returns updated:false when no sets provided", async () => {
    const graph = new FakeGraphClient();
    const result = await executeUpdateNodeTool({ node_id: "4:t:1" }, graph);
    expect(result.updated).toBe(false);
    expect(graph.calls).toHaveLength(0);
  });
  it("executes SET for provided fields only", async () => {
    const graph = new FakeGraphClient();
    await executeUpdateNodeTool({ node_id: "4:t:1", name: "Ana", tags: ["x"] }, graph);
    expect(graph.calls[0].query).toContain("SET n.name = $name, n.tags = $tags");
    expect(graph.calls[0].params).toEqual({ node_id: "4:t:1", name: "Ana", tags: ["x"] });
  });
});

describe("merge_nodes", () => {
  it("coerces valid args", () => {
    expect(coerceMergeNodesArgs({ source_node_id: "4:t:1", target_node_id: "4:t:2" })).toEqual({ source_node_id: "4:t:1", target_node_id: "4:t:2" });
  });
  it("rejects missing target", () => {
    expect(coerceMergeNodesArgs({ source_node_id: "4:t:1" })).toBeNull();
  });
  it("executes detach delete on source", async () => {
    const graph = new FakeGraphClient();
    await executeMergeNodesTool({ source_node_id: "4:t:1", target_node_id: "4:t:2" }, graph);
    expect(graph.calls[0].query).toContain("DETACH DELETE s");
    expect(graph.calls[0].params).toEqual({ source_id: "4:t:1", target_id: "4:t:2" });
  });
});

describe("create_edge", () => {
  it("coerces valid args", () => {
    expect(coerceCreateEdgeArgs({ from_node_id: "4:t:1", to_node_id: "4:t:2", relation: "is_hiring", attributes: { status: "confirmed" } })).toEqual({ from_node_id: "4:t:1", to_node_id: "4:t:2", relation: "is_hiring", attributes: { status: "confirmed" } });
  });
  it("coerces name-based args (from/to) for same-proposal links", () => {
    expect(coerceCreateEdgeArgs({ from: "user", to: "Taekwondo training", relation: "practices" })).toEqual({ from: "user", to: "Taekwondo training", relation: "practices" });
  });
  it("rejects missing relation", () => {
    expect(coerceCreateEdgeArgs({ from_node_id: "4:t:1", to_node_id: "4:t:2" })).toBeNull();
  });
  it("rejects when neither ids nor names are provided", () => {
    expect(coerceCreateEdgeArgs({ relation: "practices" })).toBeNull();
  });
  it("executes CREATE RELATED edge", async () => {
    const graph = new FakeGraphClient([{ records: [{ edge_id: "4:e:1" }] }]);
    await executeCreateEdgeTool({ from_node_id: "4:t:1", to_node_id: "4:t:2", relation: "is_hiring", attributes: {} }, graph);
    expect(graph.calls[0].query).toContain("CREATE (a)-[r:RELATED]->(b)");
    expect(graph.calls[0].params).toEqual({ from_id: "4:t:1", to_id: "4:t:2", relation: "is_hiring", attributes: "{}" });
  });
  it("resolves names to IDs before CREATE", async () => {
    const graph = new FakeGraphClient();
    graph.setScript([
      { records: [{ node_id: "4:t:1" }] }, // first name resolution
      { records: [{ node_id: "4:t:2" }] }, // second name resolution
      { records: [{ edge_id: "4:e:9" }] }, // CREATE
    ]);
    const out = await executeCreateEdgeTool({ from: "user", to: "Taekwondo training", relation: "practices" }, graph);
    expect(out.edge_id).toBe("4:e:9");
    expect(graph.calls[0].query).toContain("MATCH (n:Entity)");
    expect(graph.calls[2].query).toContain("CREATE (a)-[r:RELATED]->(b)");
    expect(graph.calls[2].params).toMatchObject({ from_id: "4:t:1", to_id: "4:t:2" });
  });
  it("fails cleanly on ambiguous name (does not guess)", async () => {
    const graph = new FakeGraphClient();
    graph.setScript([{ records: [{ node_id: "4:t:1" }, { node_id: "4:t:2" }] }]);
    await expect(executeCreateEdgeTool({ from: "user", to: "x", relation: "practices" }, graph)).rejects.toThrow(/ambiguous/);
  });
});

describe("update_edge", () => {
  it("coerces valid args", () => {
    expect(coerceUpdateEdgeArgs({ edge_id: "4:e:1", relation: "is_hiring", attributes: {} })).toEqual({ edge_id: "4:e:1", relation: "is_hiring", attributes: {} });
  });
  it("rejects missing edge_id", () => {
    expect(coerceUpdateEdgeArgs({ relation: "is_hiring" })).toBeNull();
  });
  it("returns updated:false when no sets provided", async () => {
    const graph = new FakeGraphClient();
    const result = await executeUpdateEdgeTool({ edge_id: "4:e:1" }, graph);
    expect(result.updated).toBe(false);
  });
  it("executes SET for provided fields", async () => {
    const graph = new FakeGraphClient();
    await executeUpdateEdgeTool({ edge_id: "4:e:1", relation: "is_working_on" }, graph);
    expect(graph.calls[0].query).toContain("SET r.relation = $relation");
    expect(graph.calls[0].params).toEqual({ edge_id: "4:e:1", relation: "is_working_on" });
  });
});

describe("delete_edge", () => {
  it("coerces valid args", () => {
    expect(coerceDeleteEdgeArgs({ edge_id: "4:e:1" })).toEqual({ edge_id: "4:e:1" });
  });
  it("rejects missing edge_id", () => {
    expect(coerceDeleteEdgeArgs({})).toBeNull();
  });
  it("executes DELETE", async () => {
    const graph = new FakeGraphClient();
    await executeDeleteEdgeTool({ edge_id: "4:e:1" }, graph);
    expect(graph.calls[0].query).toContain("DELETE r");
  });
});
