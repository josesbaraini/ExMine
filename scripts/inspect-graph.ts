#!/usr/bin/env bun
/**
 * Inspect the current Neo4j database state: nodes, edges, and recent
 * logs/failures. Usage: `bun scripts/inspect-graph.ts`.
 */

import { Neo4jGraphClient } from "../backend/src/graph/client";

const client = new Neo4jGraphClient();

async function main() {
  try {
    await client.connect();
    const nodes = await client.run(`MATCH (n:Entity) RETURN elementId(n) AS id, n.name AS name, n.category AS category, n.tags AS tags ORDER BY n.name`);
    console.log(`\n== Nodes (${nodes.records.length}) ==`);
    for (const r of nodes.records) {
      console.log(`  ${r.id} | ${r.name} | ${r.category} | tags: ${(r.tags || []).join(", ")}`);
    }

    const edges = await client.run(`
      MATCH (a:Entity)-[r:RELATED]->(b:Entity)
      RETURN elementId(r) AS edge_id, a.name AS from, r.relation AS relation, b.name AS to, r.attributes AS attributes
      ORDER BY a.name
    `);
    console.log(`\n== Edges (${edges.records.length}) ==`);
    for (const r of edges.records) {
      console.log(`  ${r.edge_id} | ${r.from} --[${r.relation}]--> ${r.to} | ${r.attributes}`);
    }

    const failures = await client.run(`MATCH (n) RETURN count(n) AS count`);
    console.log(`\nTotal nodes: ${failures.records[0]?.count ?? 0}`);
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
