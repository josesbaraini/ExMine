import { describe, expect, it, beforeEach } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runAnalyse } from "../src/graph/propose";
import { FakeGraphClient, FakeLLMClient } from "./helpers";
import type { ChatMessage } from "../src/types";

/**
 * Phase 4 §12 — unit tests for the propose→judge loop.
 * FakeLLMClient scripts the judge (approve/reject), FakeGraphClient returns
 * scripted evidence. No real Neo4j, no real OpenRouter.
 */

const chat: ChatMessage[] = [
  { role: "user", content: "Ana is hiring Jev", timestamp: new Date().toISOString() },
  { role: "assistant", content: "Noted!", timestamp: new Date().toISOString() },
];

function tempDir(): string {
  const dir = join(tmpdir(), `exmine-propose-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  require("node:fs").mkdirSync(dir, { recursive: true });
  return dir;
}

describe("runAnalyse — propose→judge loop", () => {
  let llm: FakeLLMClient;
  let graph: FakeGraphClient;
  let dataDir: string;

  beforeEach(() => {
    llm = new FakeLLMClient();
    graph = new FakeGraphClient();
    dataDir = tempDir();
    // searchContext needs at least some records for it to not crash on empty
    graph.setScript([{ records: [] }]);
  });

  it("returns ok:true when the judge approves on the first try", async () => {
    llm.setChatScript([
      {
        reply: JSON.stringify({
          human_text: "Create a person node Jev and link Ana → hires → Jev.",
          steps: [
            { seq: 1, human_text: "Create node Jev (person)", tool: "create_node", args: { name: "Jev", category: "person", tags: [] } },
            { seq: 2, human_text: "Link Ana to Jev", tool: "create_edge", args: { from_node_id: "4:t:1", to_node_id: "4:t:2", relation: "is_hiring", attributes: {} } },
          ],
        }),
      },
      { reply: JSON.stringify({ approved: true, reason: null }) },
    ]);

    const result = await runAnalyse(chat, llm, graph, dataDir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.proposal.judge_approved).toBe(true);
      expect(result.proposal.user_confirmed).toBe(false);
      expect(result.proposal.steps).toHaveLength(2);
    }
  });

  it("retries with judge reason when the judge rejects, succeeds on second fix", async () => {
    llm.setChatScript([
      { reply: JSON.stringify({ human_text: "Create Jev", steps: [{ seq: 1, human_text: "Create Jev", tool: "create_node", args: { name: "Jev", category: "person" } }] }) },
      { reply: JSON.stringify({ approved: false, reason: "Node name not found in chat" }) },
      { reply: JSON.stringify({ human_text: "Create Jev with correct evidence", steps: [{ seq: 1, human_text: "Create Jev", tool: "create_node", args: { name: "Jev", category: "person" } }] }) },
      { reply: JSON.stringify({ approved: true, reason: null }) },
    ]);

    const result = await runAnalyse(chat, llm, graph, dataDir);
    expect(result.ok).toBe(true);
    expect(llm.chatCalls.length).toBe(4); // 2 proposals × (propose + judge)
    // Second proposal call should carry the judge reason
    const proposalCall = llm.chatCalls[2];
    const judgeFeedback = proposalCall.find((m) => m.content.includes("previous_judge_feedback"));
    expect(judgeFeedback).toBeDefined();
  });

  it("writes a log file and returns ok:false after 9 rejections (3 fixes × 3 rounds)", async () => {
    for (let i = 0; i < 9; i++) {
      llm.chatCalls.length = 0;
      llm.setChatScript([
        { reply: JSON.stringify({ human_text: "bad", steps: [] }) },
        { reply: JSON.stringify({ approved: false, reason: "Always reject" }) },
      ]);
      // Can't easily reuse across rounds without a loop; instead use one LLM that always rejects
      break;
    }

    // Force always-reject judge by repeatedly consuming the script via a custom llm
    const alwaysRejectLlm = new FakeLLMClient();
    alwaysRejectLlm.setChatScript([
      { reply: JSON.stringify({ human_text: "bad", steps: [] }) },
      { reply: JSON.stringify({ approved: false, reason: "Always reject" }) },
    ]);

    // Need enough script entries for 3 rounds × 3 fixes × 2 calls = 18
    alwaysRejectLlm.setChatScript(
      Array.from({ length: 18 }, () => ({ reply: JSON.stringify({ approved: false, reason: "Always reject" }) })),
    );

    const result = await runAnalyse(chat, alwaysRejectLlm, graph, dataDir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("9 tries");
      expect(result.log_file).toContain("proposal-failures");
    }
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("survives extract() failure — falls back to stub and still proposes", async () => {
    const llm2 = new FakeLLMClient({ extractFailure: new Error("model refused") });
    llm2.setChatScript([
      { reply: JSON.stringify({ human_text: "Create Jev", steps: [{ seq: 1, human_text: "Create Jev", tool: "create_node", args: { name: "Jev", category: "person" } }] }) },
      { reply: JSON.stringify({ approved: true, reason: null }) },
    ]);
    const result = await runAnalyse(chat, llm2, graph, dataDir);
    expect(result.ok).toBe(true);
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("threads the same model override through extract/proposer/judge", async () => {
    llm.setChatScript([
      { reply: JSON.stringify({ human_text: "Create Jev", steps: [{ seq: 1, human_text: "Create Jev", tool: "create_node", args: { name: "Jev", category: "person" } }] }) },
      { reply: JSON.stringify({ approved: true, reason: null }) },
    ]);
    const result = await runAnalyse(chat, llm, graph, dataDir, "gemini-3.5-flash-lite");
    expect(result.ok).toBe(true);
    expect(llm.chatModels.length).toBe(2);
    expect(llm.chatModels.every((m) => m === "gemini-3.5-flash-lite")).toBe(true);
    expect(llm.extractModels.every((m) => m === "gemini-3.5-flash-lite")).toBe(true);
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("rejects proposals with invalid JSON from the proposer", async () => {
    llm.setChatScript([
      { reply: "NOT JSON AT ALL" },
      { reply: JSON.stringify({ approved: false, reason: "Proposer returned garbage" }) },
    ]);
    const result = await runAnalyse(chat, llm, graph, dataDir);
    // deterministic check fails first, judge never called
    expect(result.ok).toBe(false);
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("rejects proposals with wrong step schema", async () => {
    llm.setChatScript([
      { reply: JSON.stringify({ human_text: "bad", steps: [{ seq: 2, human_text: "", tool: "wrong_tool", args: null }] }) },
      { reply: JSON.stringify({ approved: false, reason: "Bad schema" }) },
    ]);
    const result = await runAnalyse(chat, llm, graph, dataDir);
    expect(result.ok).toBe(false);
    rmSync(dataDir, { recursive: true, force: true });
  });
});
