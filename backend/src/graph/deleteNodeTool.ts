/**
 * Phase 3.6 — Node Deletion Tool: JSON-schema definition + execution
 * wrapper. Lives beside searchGraphTool.ts — same separation of concerns
 * as Phase 3.5.
 *
 * Read-only until execution: the tool definition and description tell the
 * model to confirm before calling; executeDeleteNodeTool performs the
 * actual DETACH DELETE and persists an audit snapshot.
 */

import { randomUUID } from "node:crypto";
import type { GraphClient, GraphError } from "./client";
import type { ToolDef } from "../types";
import { saveDeletion, type DeletionSnapshot } from "../storage/deletions";

/** Tool definition in OpenRouter/OpenAI function-calling format. */
export const DELETE_NODE_TOOL_DEF: ToolDef = {
  type: "function",
  function: {
    name: "delete_node",
    description:
      "Permanently delete a node and ALL its edges from the knowledge graph. " +
      "BEFORE calling this tool, you MUST:\n" +
      "1. Use search_graph to find the node and confirm its identity (node_id, name, category).\n" +
      "2. Explicitly tell the user: \"I will delete node <node_id> (<name>, <category>) and its <N> edges. Confirm with 'yes' to proceed.\"\n" +
      "3. Wait for the user to reply with an explicit confirmation (e.g. \"yes\", \"confirm\", \"delete it\").\n" +
      "NEVER call delete_node in the same turn you first identify the target — the confirmation must appear in the conversation history.\n" +
      "The deletion is logged to an append-only audit file so it can be manually recovered if needed.",
    parameters: {
      type: "object",
      properties: {
        node_id: { type: "string", description: "The Neo4j elementId of the node to delete (from search_graph results)." },
      },
      required: ["node_id"],
      additionalProperties: false,
    },
  },
};

/** The tool-call argument contract. */
export interface DeleteNodeArgs {
  node_id: string;
}

/**
 * Normalize the model's (untrusted) raw arguments into DeleteNodeArgs.
 * Returns null if the arguments are invalid (missing/invalid node_id).
 */
export function coerceDeleteNodeArgs(raw: Record<string, unknown>): DeleteNodeArgs | null {
  const nodeId = typeof raw.node_id === "string" && raw.node_id.trim() !== "" ? raw.node_id.trim() : undefined;
  return nodeId ? { node_id: nodeId } : null;
}

/**
 * Snapshot of a node and its edges for the audit log.
 */
export interface DeleteNodeSnapshot {
  node_id: string;
  name: string;
  category: string;
  tags: string[];
  edges: Array<{
    edge_id: string;
    relation: string;
    direction: "out" | "in";
    other_node_id: string;
    other_name: string;
    other_category: string;
    attributes: Record<string, unknown>;
  }>;
}

/**
 * Execute one delete_node tool call.
 * 1. Reads the node + all its edges (for the audit snapshot).
 * 2. Runs DETACH DELETE to remove the node and its edges (no cascade).
 * 3. Persists the snapshot to the deletion audit log.
 *
 * Returns the snapshot for the model's tool result message.
 * Throws GraphError with "NOT_FOUND" code if node doesn't exist (404).
 * Throws GraphError for Neo4j write failures (502).
 */
export async function executeDeleteNodeTool(
  args: DeleteNodeArgs,
  graph: GraphClient,
  dataDir: string,
): Promise<DeleteNodeSnapshot> {
  const nodeId = args.node_id;

  // Step 1: Read the node and its edges for the audit snapshot
  const nodeQuery = `
    MATCH (n) WHERE elementId(n) = $node_id
    OPTIONAL MATCH (n)-[r]-(other)
    RETURN
      n.name AS name,
      n.category AS category,
      n.tags AS tags,
      collect({
        edge_id: elementId(r),
        relation: r.relation,
        direction: CASE WHEN (n)-[r]->() THEN 'out' ELSE 'in' END,
        other_node_id: elementId(other),
        other_name: other.name,
        other_category: other.category,
        attributes: r.attributes
      }) AS edges
  `;

  const nodeResult = await graph.run(nodeQuery, { node_id: nodeId });
  if (nodeResult.records.length === 0) {
    const err = new Error(`Node ${nodeId} not found`) as GraphError;
    err.name = "GraphError";
    // Use a custom property to signal 404 vs 502
    (err as any).code = "NOT_FOUND";
    throw err;
  }

  const record = nodeResult.records[0];
  const name = record.name as string;
  const category = record.category as string;
  const tags = (record.tags as string[]) ?? [];
  const edges = (record.edges as any[]) ?? [];

  // Filter out null edges (from OPTIONAL MATCH when no edges exist)
  const validEdges = edges.filter((e) => e.edge_id !== null && e.relation !== null);

  const snapshot: DeleteNodeSnapshot = {
    node_id: nodeId,
    name,
    category,
    tags,
    edges: validEdges.map((e) => ({
      edge_id: e.edge_id,
      relation: e.relation,
      direction: e.direction,
      other_node_id: e.other_node_id,
      other_name: e.other_name,
      other_category: e.other_category,
      attributes: typeof e.attributes === "string" ? JSON.parse(e.attributes) : (e.attributes ?? {}),
    })),
  };

  // Step 2: DETACH DELETE - removes the node and ALL its relationships (no cascade to neighbors)
  const deleteQuery = `MATCH (n) WHERE elementId(n) = $node_id DETACH DELETE n`;
  await graph.run(deleteQuery, { node_id: nodeId });

  // Step 3: Persist audit log
  const deletionRecord: DeletionSnapshot = {
    deletion_id: randomUUID(),
    deleted_at: new Date().toISOString(),
    ...snapshot,
  };
  await saveDeletion(dataDir, deletionRecord);

  return snapshot;
}