#!/usr/bin/env bun
/**
 * Wipe all local Phase 3+4 data: graph nodes/edges, conversations,
 * extractions, diary entries, resolutions, deletions, proposal-failures,
 * and the operations log. Keeps .gitkeep files and Neo4j data dirs.
 * Usage: `bun scripts/wipe-local.ts`.
 */

import { join } from "node:path";
import { rm } from "node:fs/promises";
import { Neo4jGraphClient } from "../backend/src/graph/client";

const DATA_DIR = process.env.DATA_DIR ?? join(import.meta.dir, "..", "data");

async function main() {
  // 1. Cypher wipe
  const graph = new Neo4jGraphClient();
  try {
    await graph.connect();
    await graph.run("MATCH (n) DETACH DELETE n");
    console.log("[wipe] graph wiped");
  } catch (err) {
    console.warn("[wipe] graph wipe failed (may not be connected):", (err as Error).message);
  } finally {
    await graph.close();
  }

  // 2. Disk dirs
  const targets = [
    "conversations",
    "extractions",
    "resolutions",
    "deletions",
    "proposal-failures",
    "logs",
  ];
  for (const dir of targets) {
    const full = join(DATA_DIR, dir);
    try {
      await rm(full, { recursive: true, force: true });
      console.log(`[wipe] removed ${dir}/`);
    } catch {
      /* ignore */
    }
  }

  // 3. Diary JSONL
  try {
    await rm(join(DATA_DIR, "diary-entries.jsonl"), { force: true });
    console.log("[wipe] removed diary-entries.jsonl");
  } catch {
    /* ignore */
  }

  console.log("[wipe] done — restart the backend to clear in-memory conversations");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
