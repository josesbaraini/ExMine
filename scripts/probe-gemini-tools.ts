#!/usr/bin/env bun
/**
 * Live smoke test for Gemini tool-calling. Sends ONE tiny generateContent
 * request with ALL 8 tool declarations (sanitized exactly like the app does)
 * and asks the model to call search_graph. This is the only way to prove the
 * mapping against Google's real validator — fakes can't catch "Unknown name
 * additionalProperties" class errors (ledger #4).
 *
 * Usage:  bun scripts/probe-gemini-tools.ts
 * Env:    GEMINISTUDIO_API_KEY (required), GEMINI_MODEL (optional)
 * Exit 0 = 200 + functionCall round-trip observed. Non-zero = diagnosis printed.
 */

import { GeminiClient } from "../backend/src/llm/gemini";
import { SEARCH_GRAPH_TOOL_DEF } from "../backend/src/graph/searchGraphTool";
import { DELETE_NODE_TOOL_DEF } from "../backend/src/graph/deleteNodeTool";
import {
  CREATE_NODE_TOOL_DEF,
  UPDATE_NODE_TOOL_DEF,
  MERGE_NODES_TOOL_DEF,
  CREATE_EDGE_TOOL_DEF,
  UPDATE_EDGE_TOOL_DEF,
  DELETE_EDGE_TOOL_DEF,
} from "../backend/src/graph/mutationTools";

const ALL = [
  SEARCH_GRAPH_TOOL_DEF,
  DELETE_NODE_TOOL_DEF,
  CREATE_NODE_TOOL_DEF,
  UPDATE_NODE_TOOL_DEF,
  MERGE_NODES_TOOL_DEF,
  CREATE_EDGE_TOOL_DEF,
  UPDATE_EDGE_TOOL_DEF,
  DELETE_EDGE_TOOL_DEF,
];

async function main() {
  if (!process.env.GEMINISTUDIO_API_KEY) {
    console.error("GEMINISTUDIO_API_KEY is not set — aborting live probe.");
    process.exit(1);
  }
  const client = new GeminiClient();
  console.log("[probe] sending one generateContent with all 8 tool declarations...");
  const result = await client.chat(
    [{ role: "user", content: "Use the search_graph tool to look up who Ana is. Do not answer from memory." }],
    ALL,
  );
  console.log("[probe] reply:", result.reply ?? "(none)");
  console.log("[probe] tool_calls:", JSON.stringify(result.tool_calls ?? [], null, 2));
  if (!result.tool_calls || result.tool_calls.length === 0) {
    console.error("[probe] FAIL — no functionCall returned; tool schema may have been rejected or ignored.");
    process.exit(2);
  }
  const ok = result.tool_calls.every((tc) => ALL.some((t) => t.function.name === tc.name));
  console.log(ok ? "[probe] PASS — functionCall round-trip works." : "[probe] FAIL — unexpected tool name.");
  process.exit(ok ? 0 : 3);
}

main().catch((err) => {
  console.error("[probe] ERROR:", err instanceof Error ? err.message : String(err));
  process.exit(4);
});
