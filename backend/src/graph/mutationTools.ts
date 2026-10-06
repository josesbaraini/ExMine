/**
 * Phase 4 §10 — graph mutation tools. Same pattern as searchGraphTool.ts and
 * deleteNodeTool.ts: ToolDef + coerce args + execute. Each uses deterministic
 * parameterized Cypher; nothing touches the LLM client.
 */

import type { ToolDef } from "../types";
import type { GraphClient } from "./client";
import { logOperation } from "../storage/opLogger";

// ---------------------------------------------------------------------------
// create_node
// ---------------------------------------------------------------------------

export const CREATE_NODE_TOOL_DEF: ToolDef = {
  type: "function",
  function: {
    name: "create_node",
    description: "Create a new node in the knowledge graph with the given name, category, and optional tags.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Node name" },
        category: { type: "string", description: "Node category (e.g. person, project, topic)" },
        tags: { type: "array", items: { type: "string" } },
        attributes: { type: "object", additionalProperties: true, description: "Optional contextual attributes, stored as JSON" },
      },
      required: ["name", "category"],
    },
  },
};

export interface CreateNodeArgs {
  name: string;
  category: string;
  tags?: string[];
  attributes?: Record<string, unknown>;
}

export function coerceCreateNodeArgs(raw: Record<string, unknown>): CreateNodeArgs | null {
  const name = typeof raw.name === "string" && raw.name.trim() !== "" ? raw.name.trim() : undefined;
  const category = typeof raw.category === "string" && raw.category.trim() !== "" ? raw.category.trim() : undefined;
  if (!name || !category) return null;
  const tags = Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === "string").map((t) => t.trim()).filter((t) => t !== "") : [];
  const attributes = typeof raw.attributes === "object" && raw.attributes !== null ? raw.attributes as Record<string, unknown> : undefined;
  return attributes !== undefined ? { name, category, tags, attributes } : { name, category, tags };
}

export async function executeCreateNodeTool(args: CreateNodeArgs, graph: GraphClient, dataDir?: string): Promise<{ node_id: string; name: string; category: string }> {
  const result = await graph.run(
    `CREATE (n:Entity { name: $name, category: $category, tags: $tags, attributes: $attributes }) RETURN elementId(n) AS node_id, n.name AS name, n.category AS category`,
    { name: args.name, category: args.category, tags: args.tags ?? [], attributes: args.attributes ? JSON.stringify(args.attributes) : "{}" },
  );
  const record = result.records[0];
  if (dataDir) {
    await logOperation(dataDir, {
      operation: "create_node",
      input_summary: `name=${args.name} category=${args.category}`,
      result: "ok",
      detail: JSON.stringify({ args, returned: record }),
    });
  }
  return { node_id: record.node_id as string, name: record.name as string, category: record.category as string };
}

// ---------------------------------------------------------------------------
// update_node
// ---------------------------------------------------------------------------

export const UPDATE_NODE_TOOL_DEF: ToolDef = {
  type: "function",
  function: {
    name: "update_node",
    description: "Update an existing node's category, tags, or other attributes by node_id.",
    parameters: {
      type: "object",
      properties: {
        node_id: { type: "string", description: "Neo4j elementId of the node to update" },
        name: { type: "string", description: "New name (optional)" },
        category: { type: "string", description: "New category (optional)" },
        tags: { type: "array", items: { type: "string" } },
        attributes: { type: "object", additionalProperties: true, description: "Optional contextual attributes, stored as JSON" },
      },
      required: ["node_id"],
    },
  },
};

export interface UpdateNodeArgs {
  node_id: string;
  name?: string;
  category?: string;
  tags?: string[];
  attributes?: Record<string, unknown>;
}

export function coerceUpdateNodeArgs(raw: Record<string, unknown>): UpdateNodeArgs | null {
  const nodeId = typeof raw.node_id === "string" && raw.node_id.trim() !== "" ? raw.node_id.trim() : undefined;
  if (!nodeId) return null;
  const name = typeof raw.name === "string" && raw.name.trim() !== "" ? raw.name.trim() : undefined;
  const category = typeof raw.category === "string" && raw.category.trim() !== "" ? raw.category.trim() : undefined;
  const tags = Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === "string").map((t) => t.trim()).filter((t) => t !== "") : undefined;
  const attributes = typeof raw.attributes === "object" && raw.attributes !== null ? raw.attributes as Record<string, unknown> : undefined;
  const out: UpdateNodeArgs = { node_id: nodeId };
  if (name) out.name = name;
  if (category) out.category = category;
  if (tags) out.tags = tags;
  if (attributes) out.attributes = attributes;
  return out;
}

export async function executeUpdateNodeTool(args: UpdateNodeArgs, graph: GraphClient, dataDir?: string): Promise<{ updated: boolean; node_id: string }> {
  const sets: string[] = [];
  const params: Record<string, unknown> = { node_id: args.node_id };
  if (args.name !== undefined) { sets.push("n.name = $name"); params.name = args.name; }
  if (args.category !== undefined) { sets.push("n.category = $category"); params.category = args.category; }
  if (args.tags !== undefined) { sets.push("n.tags = $tags"); params.tags = args.tags; }
  if (args.attributes !== undefined) { sets.push("n.attributes = $attributes"); params.attributes = JSON.stringify(args.attributes); }
  if (sets.length === 0) {
    if (dataDir) await logOperation(dataDir, { operation: "update_node", input_summary: `node_id=${args.node_id}`, result: "ok", detail: "no fields to update" });
    return { updated: false, node_id: args.node_id };
  }
  await graph.run(
    `MATCH (n) WHERE elementId(n) = $node_id SET ${sets.join(", ")} RETURN n`,
    params,
  );
  if (dataDir) {
    await logOperation(dataDir, {
      operation: "update_node",
      input_summary: `node_id=${args.node_id}`,
      result: "ok",
      detail: JSON.stringify({ args, sets }),
    });
  }
  return { updated: true, node_id: args.node_id };
}

// ---------------------------------------------------------------------------
// merge_nodes
// ---------------------------------------------------------------------------

export const MERGE_NODES_TOOL_DEF: ToolDef = {
  type: "function",
  function: {
    name: "merge_nodes",
    description: "Merge two nodes into one by moving all relationships from the source node to the target node, then deleting the source node.",
    parameters: {
      type: "object",
      properties: {
        source_node_id: { type: "string", description: "Node to merge INTO the target (will be deleted)" },
        target_node_id: { type: "string", description: "Node that remains after the merge" },
      },
      required: ["source_node_id", "target_node_id"],
    },
  },
};

export interface MergeNodesArgs {
  source_node_id: string;
  target_node_id: string;
}

export function coerceMergeNodesArgs(raw: Record<string, unknown>): MergeNodesArgs | null {
  const source = typeof raw.source_node_id === "string" && raw.source_node_id.trim() !== "" ? raw.source_node_id.trim() : undefined;
  const target = typeof raw.target_node_id === "string" && raw.target_node_id.trim() !== "" ? raw.target_node_id.trim() : undefined;
  if (!source || !target) return null;
  return { source_node_id: source, target_node_id: target };
}

export async function executeMergeNodesTool(args: MergeNodesArgs, graph: GraphClient, dataDir?: string): Promise<{ merged: boolean; target_node_id: string }> {
  // Move relationships from source to target, then delete source.
  await graph.run(
    `MATCH (s) WHERE elementId(s) = $source_id MATCH (t) WHERE elementId(t) = $target_id
     OPTIONAL MATCH (s)-[r]->(other)
     FOREACH (_ in CASE WHEN r IS NOT NULL THEN [1] ELSE [] END |
       CREATE (t)-[nr:RELATED]->(other)
       SET nr.relation = r.relation, nr.attributes = r.attributes
     )
     WITH s, t
     OPTIONAL MATCH (other)-[r2]->(s)
     FOREACH (_ in CASE WHEN r2 IS NOT NULL THEN [1] ELSE [] END |
       CREATE (other)-[nr2:RELATED]->(t)
       SET nr2.relation = r2.relation, nr2.attributes = r2.attributes
     )
     DETACH DELETE s`,
    { source_id: args.source_node_id, target_id: args.target_node_id },
  );
  if (dataDir) {
    await logOperation(dataDir, {
      operation: "merge_nodes",
      input_summary: `source=${args.source_node_id} target=${args.target_node_id}`,
      result: "ok",
      detail: JSON.stringify(args),
    });
  }
  return { merged: true, target_node_id: args.target_node_id };
}

// ---------------------------------------------------------------------------
// create_edge
// ---------------------------------------------------------------------------

export const CREATE_EDGE_TOOL_DEF: ToolDef = {
  type: "function",
  function: {
    name: "create_edge",
    description: "Create a directed relationship between two nodes.",
    parameters: {
      type: "object",
      properties: {
        from_node_id: { type: "string" },
        to_node_id: { type: "string" },
        from: { type: "string", description: "Source node NAME — resolved to an ID at execution time. Use this (with `to`) when linking nodes created in the same proposal, since their IDs do not exist at propose time." },
        to: { type: "string", description: "Target node NAME — resolved to an ID at execution time." },
        relation: { type: "string", description: "Semantic relation label, e.g. is_hiring" },
        attributes: { type: "object", additionalProperties: true },
      },
      required: ["relation"],
    },
  },
};

export interface CreateEdgeArgs {
  from_node_id?: string;
  to_node_id?: string;
  from?: string;
  to?: string;
  relation: string;
  attributes?: Record<string, unknown>;
}

export function coerceCreateEdgeArgs(raw: Record<string, unknown>): CreateEdgeArgs | null {
  const relation = typeof raw.relation === "string" && raw.relation.trim() !== "" ? raw.relation.trim() : undefined;
  if (!relation) return null;
  const fromId = typeof raw.from_node_id === "string" && raw.from_node_id.trim() !== "" ? raw.from_node_id.trim() : undefined;
  const toId = typeof raw.to_node_id === "string" && raw.to_node_id.trim() !== "" ? raw.to_node_id.trim() : undefined;
  const fromName = typeof raw.from === "string" && raw.from.trim() !== "" ? raw.from.trim() : undefined;
  const toName = typeof raw.to === "string" && raw.to.trim() !== "" ? raw.to.trim() : undefined;
  if ((!fromId && !fromName) || (!toId && !toName)) return null;
  const attributes = typeof raw.attributes === "object" && raw.attributes !== null ? (raw.attributes as Record<string, unknown>) : undefined;
  const out: CreateEdgeArgs = { relation };
  if (fromId) out.from_node_id = fromId;
  if (toId) out.to_node_id = toId;
  if (fromName) out.from = fromName;
  if (toName) out.to = toName;
  if (attributes) out.attributes = attributes;
  return out;
}

export async function executeCreateEdgeTool(args: CreateEdgeArgs, graph: GraphClient, dataDir?: string): Promise<{ created: boolean; edge_id: string }> {
  let fromId = args.from_node_id;
  let toId = args.to_node_id;

  if (!fromId && args.from) {
    const rows = (await graph.run(`MATCH (n:Entity) WHERE toLower(n.name) = toLower($name) RETURN elementId(n) AS node_id LIMIT 2`, { name: args.from })).records;
    if (rows.length === 0) throw new Error(`create_edge: node named "${args.from}" not found`);
    if (rows.length > 1) throw new Error(`create_edge: node name "${args.from}" is ambiguous (${rows.length} matches) — use from_node_id from search_graph`);
    fromId = rows[0].node_id as string;
  }
  if (!toId && args.to) {
    const rows = (await graph.run(`MATCH (n:Entity) WHERE toLower(n.name) = toLower($name) RETURN elementId(n) AS node_id LIMIT 2`, { name: args.to })).records;
    if (rows.length === 0) throw new Error(`create_edge: node named "${args.to}" not found`);
    if (rows.length > 1) throw new Error(`create_edge: node name "${args.to}" is ambiguous (${rows.length} matches) — use to_node_id from search_graph`);
    toId = rows[0].node_id as string;
  }
  if (!fromId || !toId) throw new Error("create_edge: could not resolve both endpoints");

  const result = await graph.run(
    `MATCH (a), (b) WHERE elementId(a) = $from_id AND elementId(b) = $to_id
     CREATE (a)-[r:RELATED]->(b) SET r.relation = $relation, r.attributes = $attributes
     RETURN elementId(r) AS edge_id`,
    { from_id: fromId, to_id: toId, relation: args.relation, attributes: args.attributes ? JSON.stringify(args.attributes) : "{}" },
  );
  const edgeId = (result.records[0]?.edge_id as string) ?? "";
  if (dataDir) {
    await logOperation(dataDir, {
      operation: "create_edge",
      input_summary: `${fromId} -> ${toId} : ${args.relation} (resolved from ${args.from ?? fromId} -> ${args.to ?? toId})`,
      result: "ok",
      detail: JSON.stringify({ args, resolved: { fromId, toId }, edge_id: edgeId }),
    });
  }
  return { created: true, edge_id: edgeId };
}

// ---------------------------------------------------------------------------
// update_edge
// ---------------------------------------------------------------------------

export const UPDATE_EDGE_TOOL_DEF: ToolDef = {
  type: "function",
  function: {
    name: "update_edge",
    description: "Update an existing edge's relation label or attributes.",
    parameters: {
      type: "object",
      properties: {
        edge_id: { type: "string", description: "Neo4j elementId of the edge" },
        relation: { type: "string", description: "New relation label" },
        attributes: { type: "object", additionalProperties: true },
      },
      required: ["edge_id"],
    },
  },
};

export interface UpdateEdgeArgs {
  edge_id: string;
  relation?: string;
  attributes?: Record<string, unknown>;
}

export function coerceUpdateEdgeArgs(raw: Record<string, unknown>): UpdateEdgeArgs | null {
  const edgeId = typeof raw.edge_id === "string" && raw.edge_id.trim() !== "" ? raw.edge_id.trim() : undefined;
  if (!edgeId) return null;
  const relation = typeof raw.relation === "string" && raw.relation.trim() !== "" ? raw.relation.trim() : undefined;
  const attributes = typeof raw.attributes === "object" && raw.attributes !== null ? (raw.attributes as Record<string, unknown>) : undefined;
  return { edge_id: edgeId, ...(relation ? { relation } : {}), ...(attributes ? { attributes } : {}) };
}

export async function executeUpdateEdgeTool(args: UpdateEdgeArgs, graph: GraphClient, dataDir?: string): Promise<{ updated: boolean; edge_id: string }> {
  const sets: string[] = [];
  const params: Record<string, unknown> = { edge_id: args.edge_id };
  if (args.relation !== undefined) { sets.push("r.relation = $relation"); params.relation = args.relation; }
  if (args.attributes !== undefined) { sets.push("r.attributes = $attributes"); params.attributes = JSON.stringify(args.attributes); }
  if (sets.length === 0) {
    if (dataDir) await logOperation(dataDir, { operation: "update_edge", input_summary: `edge_id=${args.edge_id}`, result: "ok", detail: "no fields to update" });
    return { updated: false, edge_id: args.edge_id };
  }
  await graph.run(
    `MATCH ()-[r]->() WHERE elementId(r) = $edge_id SET ${sets.join(", ")} RETURN r`,
    params,
  );
  if (dataDir) {
    await logOperation(dataDir, {
      operation: "update_edge",
      input_summary: `edge_id=${args.edge_id}`,
      result: "ok",
      detail: JSON.stringify({ args, sets }),
    });
  }
  return { updated: true, edge_id: args.edge_id };
}

// ---------------------------------------------------------------------------
// delete_edge
// ---------------------------------------------------------------------------

export const DELETE_EDGE_TOOL_DEF: ToolDef = {
  type: "function",
  function: {
    name: "delete_edge",
    description: "Delete a specific relationship by its elementId.",
    parameters: {
      type: "object",
      properties: {
        edge_id: { type: "string", description: "Neo4j elementId of the edge to delete" },
      },
      required: ["edge_id"],
    },
  },
};

export interface DeleteEdgeArgs {
  edge_id: string;
}

export function coerceDeleteEdgeArgs(raw: Record<string, unknown>): DeleteEdgeArgs | null {
  const edgeId = typeof raw.edge_id === "string" && raw.edge_id.trim() !== "" ? raw.edge_id.trim() : undefined;
  return edgeId ? { edge_id: edgeId } : null;
}

export async function executeDeleteEdgeTool(args: DeleteEdgeArgs, graph: GraphClient, dataDir?: string): Promise<{ deleted: boolean; edge_id: string }> {
  await graph.run(`MATCH ()-[r]->() WHERE elementId(r) = $edge_id DELETE r`, { edge_id: args.edge_id });
  if (dataDir) {
    await logOperation(dataDir, {
      operation: "delete_edge",
      input_summary: `edge_id=${args.edge_id}`,
      result: "ok",
      detail: JSON.stringify(args),
    });
  }
  return { deleted: true, edge_id: args.edge_id };
}
