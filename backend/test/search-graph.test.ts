import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { GraphQueryError } from "../src/graph/client";
import {
  SEARCH_GRAPH_TOOL_DEF,
  coerceSearchGraphArgs,
  executeSearchGraphTool,
} from "../src/graph/searchGraphTool";
import { DELETE_NODE_TOOL_DEF } from "../src/graph/deleteNodeTool";
import { FakeGraphClient, FakeLLMClient, json } from "./helpers";

/**
 * Phase 3.5 §5/§8 — the search_graph tool and both extended endpoints:
 *   - executeSearchGraphTool: the adapter that bridges ({tags, name_query?})
 *     to Phase 3's (extraction, graph) signature without touching search.ts.
 *   - POST /api/graph/search: 200 CandidateSet / 400 nothing-to-search-on /
 *     502 graph failure.
 *   - POST /api/chat: bounded tool-call execution (up to 2 search rounds) that
 *     feeds results back and still keeps Phase 1 behavior for tool-less turns.
 * One Elysia app per file (existing suite rule).
 */

const graph = new FakeGraphClient();
const llm = new FakeLLMClient();
let currentDataDir: string;
const app = createApp({ llm, graph, dataDir: () => currentDataDir, frontendDist: null });

beforeEach(async () => {
  currentDataDir = await mkdtemp(join(tmpdir(), "jarvis-search-test-"));
  llm.reset();
  graph.reset();
});

afterEach(async () => {
  await rm(currentDataDir, { recursive: true, force: true });
});

const api = (path: string, init?: RequestInit) =>
  app.handle(new Request(`http://localhost:3000${path}`, init));

const post = (path: string, body: unknown) =>
  api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const postChat = (body: unknown) => post("/api/chat", body);

describe("executeSearchGraphTool", () => {
  it("calls searchContext with correctly-shaped input: name_query becomes the name, tags pass through", async () => {
    graph.setScript([{ query: /MATCH \(n:Entity\)/, records: [] }]);

    const out = await executeSearchGraphTool({ tags: ["car", "repair"], name_query: "the mechanic" }, graph);

    expect(graph.calls).toHaveLength(1);
    expect(graph.calls[0].params.name).toBe("the mechanic");
    expect(graph.calls[0].params.tags).toEqual(["car", "repair"]);
    // searchContext's CandidateSet shape, vertex candidates only (read path
    // never searches relations — the synthetic extraction has no edges).
    expect(out.node_candidates).toHaveLength(1);
    expect(out.edge_candidates).toEqual([]);
  });

  it("empty name_query: a tag-only search still returns only genuinely matching nodes", async () => {
    // A name-less search carries NO name evidence, so matching is purely by
    // tag overlap. Force the score>0 filter to separate real matches from
    // name-less junk — verified here rather than trusted by inspection (this
    // is the QA case that found the read path's `CONTAINS ''` bug).
    graph.setScript([
      {
        query: /MATCH \(n:Entity\)/,
        records: [
          { node_id: "a", name: "Unrelated Thing", category: "topic", tags: ["other"], neighborhood: [] },
          { node_id: "b", name: "Ana", category: "person", tags: ["car", "repair"], neighborhood: [] },
          { node_id: "c", name: "Another Topic", category: "topic", tags: ["junk"], neighborhood: [] },
        ],
      },
    ]);

    const out = await executeSearchGraphTool({ tags: ["car", "repair"] }, graph);

    expect(graph.calls[0].params.name).toBe("");
    const matches = out.node_candidates[0].matches;
    expect(matches).toHaveLength(1);
    expect(matches[0].name).toBe("Ana");
    expect(matches[0].score).toBe(1); // 0.5 × 2 overlapping tags ("car", "repair")
  });

  it("a query TAG equal to a stored NAME matches that node (models put names in tags)", async () => {
    // Live-observed behavior: "Who is Ana?" arrives as {tags:["Ana"]} rather
    // than {name_query:"Ana"} — the previous read path returned ZERO matches
    // and the assistant claimed the graph had no notes about Ana while Ana
    // was right there. The search must find the node NAMED Ana via the tag,
    // AND score it >0 (otherwise the score filter discards exactly the match
    // the name-via-tag WHERE branch produced).
    graph.setScript([
      {
        query: /MATCH \(n:Entity\)/,
        records: [
          { node_id: "a", name: "Ana", category: "person", tags: ["colleague", "friend"], neighborhood: [] },
          { node_id: "b", name: "Jev", category: "person", tags: ["designer"], neighborhood: [] },
        ],
      },
    ]);

    const out = await executeSearchGraphTool({ tags: ["Ana"] }, graph);

    const matches = out.node_candidates[0].matches;
    expect(matches).toHaveLength(1);
    expect(matches[0].name).toBe("Ana");
    expect(matches[0].score).toBe(1); // name-via-tag is scored as half an exact name match
  });

  it("treats zero matches as a valid result, not an error", async () => {
    graph.setScript([{ query: /MATCH \(n:Entity\)/, records: [] }]);

    const out = await executeSearchGraphTool({ tags: ["does-not-exist"] }, graph);

    expect(out.node_candidates[0].matches).toEqual([]);
    expect(out.edge_candidates).toEqual([]);
  });
});

describe("coerceSearchGraphArgs", () => {
  it("filters junk, trims, and drops a blank name_query", () => {
    expect(
      coerceSearchGraphArgs({ tags: ["car", 42, "  repair  ", "", null], name_query: "   " }),
    ).toEqual({ tags: ["car", "repair"] });
  });

  it("returns a tag-less search when nothing usable is present (zero-match path, not an error)", () => {
    expect(coerceSearchGraphArgs({ tags: "nope" })).toEqual({ tags: [] });
  });
});

describe("POST /api/graph/search — the read-only route", () => {
  it("200 with Phase 3 CandidateSet shape when tags match existing data", async () => {
    graph.setScript([
      {
        query: /MATCH \(n:Entity\)/,
        records: [
          {
            node_id: "4:t:1",
            name: "Ana",
            category: "person",
            tags: ["car", "repair", "mechanic"],
            neighborhood: [
              { relation: "mentions", direction: "out", other_node_id: "4:t:2", other_name: "The Garage" },
            ],
          },
        ],
      },
    ]);

    const res = await post("/api/graph/search", { tags: ["car"], name_query: "Ana" });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.node_candidates).toHaveLength(1);
    const match = body.node_candidates[0].matches[0];
    expect(match.name).toBe("Ana");
    expect(match.neighborhood).toHaveLength(1);
    expect(body.edge_candidates).toEqual([]);
  });

  it("200 for a name-only search (tags omitted) — mirrors the tool contract", async () => {
    graph.setScript([
      {
        query: /MATCH \(n:Entity\)/,
        records: [{ node_id: "4:t:1", name: "Ana", category: "person", tags: ["colleague"], neighborhood: [] }],
      },
    ]);
    const res = await post("/api/graph/search", { name_query: "Ana" });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.node_candidates[0].matches[0].name).toBe("Ana");
    expect(graph.calls).toHaveLength(1);
  });

  it("400 when tags is empty AND name_query is absent (nothing to search on)", async () => {
    const res = await post("/api/graph/search", { tags: [] });
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toMatch(/Nothing to search on/);
    expect(graph.calls).toHaveLength(0);
  });

  it("502 GRAPH_UNAVAILABLE when the graph read fails", async () => {
    graph.setFailure(new GraphQueryError("Neo4j unreachable: broken pipe"));
    const res = await post("/api/graph/search", { tags: ["car"] });
    expect(res.status).toBe(502);
    const body = await json(res);
    expect(body.error.code).toBe("GRAPH_UNAVAILABLE");
    expect(body.error.message).toContain("broken pipe");
  });
});

describe("POST /api/chat — the search_graph tool-call loop", () => {
  it("executes the tool, feeds the result back, and returns the FINAL reply (not the raw tool call)", async () => {
    llm.setChatScript([
      { tool_calls: [{ id: "call_1", name: "search_graph", arguments: { tags: ["car", "repair"] } }] },
      { reply: "You decided to take the car to Ana's garage on Friday." },
    ]);
    graph.setScript([
      {
        query: /MATCH \(n:Entity\)/,
        records: [{ node_id: "4:t:7", name: "Ana", category: "person", tags: ["car", "repair"], neighborhood: [] }],
      },
    ]);

    const res = await postChat({ conversation_id: null, message: "What did I decide about the car repair?" });
    expect(res.status).toBe(200);
    const body = await json(res);

    expect(body.reply).toBe("You decided to take the car to Ana's garage on Friday.");

    // Two LLM calls: one that decided to search, one that answered with the result.
    expect(llm.chatCalls).toHaveLength(2);
    // Round 1 carried the tool defs (all writers + search) and the system prompt.
    expect(llm.toolsCalls[0]).toEqual(expect.arrayContaining([SEARCH_GRAPH_TOOL_DEF, DELETE_NODE_TOOL_DEF]));
    expect(llm.chatCalls[0][0]).toEqual({ role: "system", content: expect.stringContaining("You are Jarvis") });
    // The store keeps only the real conversation — the synthetic system/tool
    // plumbing is never persisted.
    expect(body.messages).toHaveLength(2);
    expect(body.messages.map((m: any) => m.role)).toEqual(["user", "assistant"]);

    // Round 2 wire shape: assistant tool_calls echoed + tool result with the
    // matching tool_call_id, carrying the ACTUAL search output.
    const assistantMsg = llm.chatCalls[1][llm.chatCalls[1].length - 2];
    expect(assistantMsg.role).toBe("assistant");
    expect((assistantMsg as any).tool_calls?.[0].id).toBe("call_1");
    const toolMsg = llm.chatCalls[1][llm.chatCalls[1].length - 1];
    expect(toolMsg.role).toBe("tool");
    expect((toolMsg as any).tool_call_id).toBe("call_1");
    const searchPayload = JSON.parse(toolMsg.content);
    expect(searchPayload.node_candidates[0].matches[0].name).toBe("Ana");
    // The search actually ran against the graph.
    expect(graph.calls).toHaveLength(1);
  });

  it("executes EVERY tool call the model emits and answers each — multi-call re-requesting was 502ing before", async () => {
    // Live failure: a relationship question made the model fire one search per
    // endpoint (Ana AND Jev). Answering only the first left the other
    // unfetched, the model re-requested it in round 2 instead of replying,
    // and the reply-less guard 502'd. Each emitted call must run and be
    // echoed+answered so the wire has no unanswered tool call (a 400 class
    // the provider rejects, encountered live).
    llm.setChatScript([
      {
        tool_calls: [
          { id: "call_a", name: "search_graph", arguments: { name_query: "Ana" } },
          { id: "call_b", name: "search_graph", arguments: { name_query: "Jev" } },
        ],
      },
      { reply: "Ana is hiring Jev." },
    ]);
    graph.setScript([
      {
        query: /MATCH \(n:Entity\)/,
        records: [{ node_id: "4:t:1", name: "Ana", category: "person", tags: ["colleague"], neighborhood: [] }],
      },
      {
        query: /MATCH \(n:Entity\)/,
        records: [{ node_id: "4:t:2", name: "Jev", category: "person", tags: ["designer"], neighborhood: [] }],
      },
    ]);

    const res = await postChat({ conversation_id: null, message: "What is the relationship between Ana and Jev?" });
    expect(res.status).toBe(200);
    expect((await json(res)).reply).toBe("Ana is hiring Jev.");

    // Both searches ran, each against its own endpoint.
    expect(graph.calls).toHaveLength(2);
    expect(graph.calls.map((c) => c.params.name).sort()).toEqual(["Ana", "Jev"]);

    // Round 2 echoes BOTH calls and answers each with a tool message whose
    // tool_call_id matches — every echoed call is resolved.
    const round2 = llm.chatCalls[1];
    const assistantMsg = round2.find((m) => m.role === "assistant" && (m as any).tool_calls);
    expect((assistantMsg as any).tool_calls.map((c: any) => c.id)).toEqual(["call_a", "call_b"]);
    const toolMsgs = round2.filter((m) => m.role === "tool");
    expect(toolMsgs.map((m) => (m as any).tool_call_id).sort()).toEqual(["call_a", "call_b"]);
  });

  it("lets the model split its searches across rounds (Ana in round 1, Jev in round 2) instead of 502ing", async () => {
    // Live-observed: the model does not always fire both endpoint searches in
    // round 1 — it searched Ana, saw the result, THEN asked for Jev. That
    // legitimate second search must be answered (round 2), and only the final
    // reply is returned. Before the bounded loop this 502'd every time.
    llm.setChatScript([
      { tool_calls: [{ id: "call_1", name: "search_graph", arguments: { name_query: "Ana" } }] },
      { tool_calls: [{ id: "call_2", name: "search_graph", arguments: { name_query: "Jev" } }] },
      { reply: "Ana is hiring Jev — the hire is confirmed." },
    ]);
    graph.setScript([
      {
        query: /MATCH \(n:Entity\)/,
        records: [{ node_id: "4:t:1", name: "Ana", category: "person", tags: ["colleague"], neighborhood: [] }],
      },
      {
        query: /MATCH \(n:Entity\)/,
        records: [{ node_id: "4:t:2", name: "Jev", category: "person", tags: ["designer"], neighborhood: [] }],
      },
    ]);

    const res = await postChat({ conversation_id: null, message: "What is the relationship between Ana and Jev?" });
    expect(res.status).toBe(200);
    expect((await json(res)).reply).toBe("Ana is hiring Jev — the hire is confirmed.");

    expect(llm.chatCalls).toHaveLength(3); // decision + round 1 + round 2
    expect(graph.calls).toHaveLength(2);
    expect(graph.calls.map((c) => c.params.name).sort()).toEqual(["Ana", "Jev"]);
  });

  it("behaves exactly as Phase 1 when the model returns no tool call (no search runs)", async () => {
    llm.setChatScript([{ reply: "I'd need to remember that — give me a moment." }]);

    const res = await postChat({ conversation_id: null, message: "hello" });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.reply).toBe("I'd need to remember that — give me a moment.");
    expect(llm.chatCalls).toHaveLength(1);
    expect(graph.calls).toHaveLength(0);
    expect(body.messages).toHaveLength(2);
  });

  it("lets a zero-match search flow through to the model's final reply", async () => {
    llm.setChatScript([
      { tool_calls: [{ id: "call_1", name: "search_graph", arguments: { tags: ["elastic-bands"] } }] },
      { reply: "I don't have anything stored about elastic bands." },
    ]);
    graph.setScript([{ query: /MATCH \(n:Entity\)/, records: [] }]);

    const res = await postChat({ conversation_id: null, message: "Do I track elastic bands?" });
    expect(res.status).toBe(200);
    expect((await json(res)).reply).toBe("I don't have anything stored about elastic bands.");
    expect(graph.calls).toHaveLength(1);
  });

  it("502s with GRAPH_UNAVAILABLE and persists nothing when the tool's read fails", async () => {
    llm.setChatScript([{ tool_calls: [{ id: "call_1", name: "search_graph", arguments: { tags: ["car"] } }] }]);
    graph.setFailure(new GraphQueryError("Neo4j unreachable: dead socket"));

    const res = await postChat({ conversation_id: null, message: "What about the car?" });
    expect(res.status).toBe(502);
    const body = await json(res);
    expect(body.error.code).toBe("GRAPH_UNAVAILABLE");
    expect(body.error.message).toContain("dead socket");
    // The failed turn commits nothing — retrying won't duplicate the message.
    expect(JSON.stringify(body)).not.toContain("conversation_id");
  });

  it("bounded tool rounds: a reply-less tool call after the allowed rounds is a 502, never an unbounded loop", async () => {
    // The model may legitimately split its searches across round 1, 2, and 3
    // (live: search Ana, then Jev, then another), so up to MAX_TOOL_CALL_ROUNDS
    // rounds execute and get answered. Only a STILL-looping model — a fourth
    // reply-less tool call — trips the empty-reply guard.
    llm.setChatScript([
      { tool_calls: [{ id: "call_1", name: "search_graph", arguments: { tags: ["x"] } }] },
      { tool_calls: [{ id: "call_2", name: "search_graph", arguments: { tags: ["y"] } }] },
      { tool_calls: [{ id: "call_3", name: "search_graph", arguments: { tags: ["z"] } }] },
      { tool_calls: [{ id: "call_4", name: "search_graph", arguments: { tags: ["w"] } }] }, // still not replying
    ]);
    graph.setScript([{ query: /MATCH \(n:Entity\)/, records: [] }]);

    const res = await postChat({ conversation_id: null, message: "hi" });
    expect(res.status).toBe(502);
    const body = await json(res);
    expect(body.error.code).toBe("LLM_PROVIDER_ERROR");
    expect(body.error.message).toBe("empty completion after the tool round trip");
    expect(llm.chatCalls).toHaveLength(4); // 1 decision + 3 allowed rounds, never a 5th
    expect(graph.calls).toHaveLength(3); // each allowed round executed its search
  });
});