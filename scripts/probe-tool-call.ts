/**
 * Diagnostic probe: calls OpenRouter EXACTLY like the backend's /api/chat does
 * (same messages + tools) and prints the raw response, so we can see whether
 * the model decides to call search_graph at all. Not part of the test suite —
 * run manually:
 *
 *   bun scripts/probe-tool-call.ts "Do you know who Jev is?"
 *
 * If choices[0].message.tool_calls is present → the model knows about the tool
 * and wants to search. If it's missing and content is a shrug, the tool call
 * never fired — the failure is on the model/messages side, not the server.
 */
import { SEARCH_GRAPH_TOOL_DEF, executeSearchGraphTool, coerceSearchGraphArgs } from "../backend/src/graph/searchGraphTool";
import { OpenRouterClient } from "../backend/src/llm/openrouter";
import { Neo4jGraphClient } from "../backend/src/graph/client";
import type { ChatResult, LLMMessage } from "../backend/src/types";

const question = process.argv[2] ?? "Do you know who Jev is?";
const CHAT_SEARCH_GRAPH_LINE =
  "You have a search_graph tool for retrieving stored notes about people, topics, projects, and past sessions. Call it when the user references something that might already be tracked.";

const llm = new OpenRouterClient();
// The backend parses NEO4J_AUTH (user/pass) from .env; replicate that here so
// the probe talks to the SAME Neo4j the compose stack uses.
function neo4jCredentialsFromEnv(): { user: string; password: string } {
  const auth = process.env.NEO4J_AUTH;
  if (auth) {
    const slash = auth.indexOf("/");
    if (slash > 0) return { user: auth.slice(0, slash), password: auth.slice(slash + 1) };
  }
  return { user: process.env.NEO4J_USER ?? "neo4j", password: process.env.NEO4J_PASSWORD ?? "" };
}
const creds = neo4jCredentialsFromEnv();
const graph = new Neo4jGraphClient({ uri: process.env.NEO4J_URI ?? "bolt://127.0.0.1:7687", ...creds });

await graph.connect();

// First round: the model decides whether to search.
const first = await llm.chat(
  [
    { role: "system", content: CHAT_SEARCH_GRAPH_LINE },
    { role: "user", content: question },
  ],
  [SEARCH_GRAPH_TOOL_DEF],
);
console.log("--- round 1 ---");
console.log(JSON.stringify(first, null, 2));

// Subsequent rounds: execute EVERY tool call the model emitted (all
// search_graph), feed one result back per call, and re-chat — up to the same
// 2-round bound app.ts uses, so diagnostics match the server. (A relationship
// question was observed to fire one search per endpoint, and to SPLIT them
// across rounds: search Ana, see the result, then search Jev.)
let round: ChatResult = first;
const toolMessages: LLMMessage[] = [];
for (let r = 0; r < 2; r++) {
  if (!round.tool_calls?.length) break;
  const calls = round.tool_calls;
  console.log(
    "\n--- executing tool calls:",
    calls.map((c) => `${c.name} ${JSON.stringify(c.arguments)}`).join(" | "),
    "---",
  );
  const candidateSets = await Promise.all(
    calls.map((call) => executeSearchGraphTool(coerceSearchGraphArgs(call.arguments), graph)),
  );
  calls.forEach((call, i) =>
    console.log(`\n--- result for ${call.id} ---\n` + JSON.stringify(candidateSets[i], null, 2).slice(0, 2500)),
  );
  toolMessages.push(
    // Echo ONLY the calls we executed (and content "" → null on the wire):
    // the model sometimes emits several tool_calls, and echoing ids we never
    // answer makes the provider reject the conversation (400).
    { role: "assistant", content: "", tool_calls: calls },
    ...calls.flatMap((call, i) => [
      { role: "tool" as const, content: JSON.stringify(candidateSets[i]), tool_call_id: call.id },
    ]),
  );
  round = await llm.chat(
    [
      { role: "system", content: CHAT_SEARCH_GRAPH_LINE },
      { role: "user", content: question },
      ...toolMessages,
    ],
    [SEARCH_GRAPH_TOOL_DEF],
  );
  console.log(`\n--- round ${r + 2} ---`);
  console.log(JSON.stringify(round, null, 2));
}
if (first.tool_calls?.length) {
  console.log("\n(above: final result after the tool rounds)");
} else {
  console.log("\nNO TOOL CALL — the model answered without searching. Reply was:");
  console.log(first.reply ?? "(empty)");
}

await graph.close();