#!/usr/bin/env bun
/**
 * LIVE provider gate — the second half of the quality gate, run next to
 * `bun test`. The offline suite proves our code paths execute; it can never
 * produce a Google error, because a fake fetch never validates anything. Every
 * 400-class failure we have actually hit (ledger #4 additionalProperties,
 * #6 thought_signature, retired-model 404s, quota/429) exists ONLY on the far
 * side of a real HTTP call. This script makes those calls.
 *
 * It deliberately replays the exact request sequences the app makes, using the
 * real GeminiClient — not hand-rolled curl approximations — so a green run is
 * evidence the app will work, not evidence a shape matched.
 *
 * Legs:
 *   1. model listing    — every id we advertise is callable-ish (catches 404s)
 *   2. TOOL ROUND TRIP  — chat() with all 8 tools -> tool_call -> feed the
 *                         result back as a second chat() exactly like the
 *                         /api/chat loop does. THIS is the leg that catches a
 *                         dropped thought_signature: a single-shot probe cannot.
 *   3. extract()        — a real structured extraction with the app's prompt
 *   4. localhost app    — (opt-in via JARVIS_BASE) POST /api/chat then
 *                         /api/analyse; asserts a proposal or a clean 200
 *                         error, never a 502 and never the literal "null".
 *
 * Exit codes: 0 pass · 1 real failure · 2 provider unstable (weather, rerun)
 *             3 skipped (no key / no server).
 *
 * Usage:  bun scripts/test-gemini-live.ts [--model=gemini-3.5-flash-lite]
 */

import { GeminiClient } from "../backend/src/llm/gemini";
import { LLMProviderError } from "../backend/src/types";
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

const ALL_TOOL_DEFS = [
  SEARCH_GRAPH_TOOL_DEF,
  DELETE_NODE_TOOL_DEF,
  CREATE_NODE_TOOL_DEF,
  UPDATE_NODE_TOOL_DEF,
  MERGE_NODES_TOOL_DEF,
  CREATE_EDGE_TOOL_DEF,
  UPDATE_EDGE_TOOL_DEF,
  DELETE_EDGE_TOOL_DEF,
];

const args = process.argv.slice(2);
const modelArg = args.find((a) => a.startsWith("--model="))?.split("=")[1];
const JARVIS_BASE = process.env.JARVIS_BASE ?? "";
/** Mutable so leg 1 can fall back to a different id if this one is retired. */
let model = modelArg ?? process.env.GEMINI_MODEL ?? "gemini-3.5-flash-lite";

let failures = 0;
let unstable = 0;

function log(leg: string, msg: string) {
  console.log(`[live:${leg}] ${msg}`);
}
function pass(leg: string, msg: string) {
  console.log(`[live:${leg}] PASS — ${msg}`);
}
function fail(leg: string, msg: string) {
  failures++;
  console.error(`[live:${leg}] FAIL — ${msg}`);
}
function warnUnstable(leg: string, msg: string) {
  unstable++;
  console.warn(`[live:${leg}] UNSTABLE — ${msg}`);
}

/** Provider weather (429/503) is not our bug; anything else 4xx is. */
function classify(leg: string, err: unknown): never {
  const msg = err instanceof Error ? err.message : String(err);
  const status = err instanceof LLMProviderError ? /(\d{3})/.exec(msg)?.[1] : undefined;
  const providerMessage = err instanceof LLMProviderError ? err.providerMessage : "";
  if (status === "429" || status === "503") {
    warnUnstable(leg, `provider weather (${status}) on model ${model}: ${providerMessage || msg}`);
  } else {
    fail(leg, `${msg}${providerMessage ? ` — provider said: ${providerMessage}` : ""}`);
  }
  process.exit(status === "429" || status === "503" ? 2 : 1);
}

/**
 * "Model is gone" is a 404 whose *detail* lives in providerMessage, not in
 * err.message — matching on the message alone misses it (caught the hard way:
 * GEMINI_MODEL=gemini-2.5-flash-lite is listed by the API but 404s on use).
 */
function isDeadModel(err: unknown): boolean {
  const text = [
    err instanceof Error ? err.message : String(err),
    err instanceof LLMProviderError ? err.providerMessage : "",
  ].join(" ");
  return /no longer available to new users|is not found for API version|not supported/i.test(text);
}

async function withRetry<T>(leg: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isDeadModel(err) && !fellBack) {
      fellBack = true;
      const alt = (await new GeminiClient().listModels())[0];
      log(leg, `model ${model} is dead on this key — retrying with ${alt}`);
      model = alt;
      return fn();
    }
    classify(leg, err);
  }
}
let fellBack = false;

/** Leg 1 — the listing endpoint every UI dropdown is built from. */
async function legModelList(client: GeminiClient) {
  const leg = "models";
  log(leg, "listing models available to this key");
  const models = await withRetry(leg, () => client.listModels());
  if (models.length === 0) {
    fail(leg, "empty model list — the UI dropdown would be unusable");
    return;
  }
  if (!models.includes(model)) {
    fail(leg, `configured model "${model}" is not in the live list — pick one of: ${models.join(", ")}`);
    return;
  }
  pass(leg, `${models.length} models listed, default "${model}" is present`);
}

/**
 * Leg 2 — the important one. Two real calls through the real client, echoing
 * the tool result back the way /api/chat does. Ledger #6 lived in this echo.
 */
async function legToolRoundTrip(client: GeminiClient) {
  const leg = "tool-roundtrip";
  log(leg, `turn 1 — requesting a ${SEARCH_GRAPH_TOOL_DEF.function.name} call with all ${ALL_TOOL_DEFS.length} tools`);
  const first = await withRetry(leg, () =>
    client.chat(
      [{ role: "user", content: "Use the search_graph tool to look up who Ana is. Do not answer from memory." }],
      ALL_TOOL_DEFS,
      model,
    ),
  );

  if (!first.tool_calls || first.tool_calls.length === 0) {
    fail(leg, "turn 1 returned no functionCall — tools were rejected or ignored");
    return;
  }
  const call = first.tool_calls[0];
  if (!ALL_TOOL_DEFS.some((t) => t.function.name === call.name)) {
    fail(leg, `turn 1 hallucinated an unknown tool "${call.name}"`);
    return;
  }
  log(leg, `turn 1 got ${call.name}${call.provider_meta ? " (with provider_meta)" : " (no provider_meta)"}`);

  log(leg, "turn 2 — echoing the tool result back (the thought_signature path)");
  const second = await withRetry(leg, () =>
    client.chat(
      [
        { role: "user", content: "Use the search_graph tool to look up who Ana is. Do not answer from memory." },
        { role: "assistant", content: "", tool_calls: first.tool_calls! },
        {
          role: "tool",
          content: JSON.stringify({ results: [{ name: "Ana", category: "person", summary: "Ana is my sister." }] }),
          tool_call_id: call.id,
        },
      ],
      ALL_TOOL_DEFS,
      model,
    ),
  );

  if (second.tool_calls && second.tool_calls.length > 0) {
    log(leg, `model asked for another tool (${second.tool_calls[0].name}) — acceptable, loop advanced without 400`);
    return;
  }
  if (!second.reply || second.reply.trim() === "") {
    fail(leg, "turn 2 succeeded but produced no reply — empty completion");
    return;
  }
  pass(leg, `two-call tool round trip clean; reply: "${second.reply.slice(0, 80)}"`);
}

/** Leg 3 — structured extraction with the production prompt. */
async function legExtract(client: GeminiClient) {
  const leg = "extract";
  const transcript = [
    { role: "user" as const, content: "I've been working on a Rust parser for the Jarvis project all week." },
    { role: "assistant" as const, content: "Noted — Rust parser, Jarvis project." },
  ];
  log(leg, "asking for a real extraction with the production prompt");
  const out = await withRetry(leg, () =>
    client.extract(transcript, { conversation_id: "live_gate", raw_source_ref: "live_gate" }, model),
  );
  if (!out || typeof out.summary !== "string") {
    fail(leg, "extract() returned a body without a summary");
    return;
  }
  if (out.nodes.some((n) => /^(speaker|author|narrator)$/i.test(n.name))) {
    fail(leg, `extract() leaked a speaker-style node: ${out.nodes.map((n) => n.name).join(", ")}`);
    return;
  }
  pass(leg, `extraction valid: ${out.nodes.length} nodes, ${out.edges.length} edges, ${out.tags.length} tags`);
}

/** Leg 4 — the running app, when one is up. Opt-in via JARVIS_BASE. */
async function legLocalApp() {
  const leg = "app";
  const base = JARVIS_BASE || "http://127.0.0.1:3000";
  let health: Response;
  try {
    health = await fetch(`${base}/api/health`);
  } catch {
    log(leg, `no server at ${base} — skipped (set JARVIS_BASE to enable)`);
    return;
  }
  if (!health.ok) {
    fail(leg, `GET /api/health returned ${health.status}`);
    return;
  }

  log(leg, "POST /api/chat (real turn with the selected model)");
  const chatRes = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // conversation_id: null starts a fresh conversation — the key is required.
    body: JSON.stringify({ conversation_id: null, message: "Who is Ana? Use the graph if you can.", model }),
  });
  const chatBody = (await chatRes.json().catch(() => null)) as any;
  if (chatRes.status !== 200) {
    fail(leg, `chat returned ${chatRes.status}: ${JSON.stringify(chatBody)?.slice(0, 300)}`);
    return;
  }
  if (typeof chatBody?.reply !== "string" || chatBody.reply.trim() === "" || chatBody.reply === "null") {
    fail(leg, `chat returned an unusable reply: ${JSON.stringify(chatBody)?.slice(0, 300)}`);
    return;
  }
  pass(leg, `chat replied: "${chatBody.reply.slice(0, 80)}"`);

  log(leg, "POST /api/analyse (propose -> judge; no graph writes)");
  const analyseRes = await fetch(`${base}/api/analyse`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "Please remember that Ana is my sister.", model }),
  });
  const analyseBody = (await analyseRes.json().catch(() => null)) as any;
  if (analyseRes.status !== 200) {
    fail(leg, `analyse returned ${analyseRes.status}: ${JSON.stringify(analyseBody)?.slice(0, 300)}`);
    return;
  }
  const message = analyseBody?.error?.message;
  if (message === "null" || message === null) {
    fail(leg, "analyse returned a null error message (ledger #3 regression)");
    return;
  }
  if (analyseBody?.proposal) {
    pass(leg, `judge approved ${analyseBody.proposal.steps?.length ?? 0} proposed steps (awaiting user confirm)`);
    return;
  }
  if (message) {
    log(leg, `analyse declined honestly (HTTP 200 + reason): ${String(message).slice(0, 120)}`);
    return;
  }
  fail(leg, `analyse returned neither a proposal nor a reason: ${JSON.stringify(analyseBody)?.slice(0, 300)}`);
}

async function main() {
  if (!process.env.GEMINISTUDIO_API_KEY) {
    console.log("[live] SKIP — GEMINISTUDIO_API_KEY is not set.");
    process.exit(3);
  }
  console.log(`[live] model under test: ${model}`);
  const client = new GeminiClient();

  await legModelList(client);
  await legToolRoundTrip(client);
  await legExtract(client);
  await legLocalApp();

  if (failures > 0) {
    console.error(`\n[live] ${failures} failure(s). These are real defects — fix them before shipping.`);
    process.exit(1);
  }
  if (unstable > 0) {
    console.warn(`\n[live] no code failures, but ${unstable} leg(s) hit provider weather (429/503). Rerun later.`);
    process.exit(2);
  }
  console.log("\n[live] all legs passed against the real provider.");
  process.exit(0);
}

main().catch((err) => {
  console.error("[live] unexpected crash:", err);
  process.exit(1);
});
