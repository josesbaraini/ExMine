import { describe, expect, it } from "bun:test";
import { createApp } from "../src/app";
import { FakeGraphClient, FakeLLMClient, ISO_RE, json } from "./helpers";

/**
 * Phase 4 §12 — integration test for POST /api/analyse.
 * Graph + LLM are faked; the route is real.
 */

describe("POST /api/analyse", () => {
  it("returns 502 when graph is unconfigured", async () => {
    const app = createApp({ llm: new FakeLLMClient() });
    const res = await app.handle(
      new Request("http://localhost/api/analyse", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversation_id: "any" }),
      }),
    );
    expect(res.status).toBe(502);
    expect((await json(res)).error.code).toBe("GRAPH_UNAVAILABLE");
  });

  it("returns 404 for unknown conversation_id", async () => {
    const graph = new FakeGraphClient();
    const app = createApp({ llm: new FakeLLMClient(), graph });
    const res = await app.handle(
      new Request("http://localhost/api/analyse", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversation_id: "unknown-id" }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("returns a judge-approved proposal on success", async () => {
    const graph = new FakeGraphClient([{ records: [] }]);
    const llm = new FakeLLMClient();
    llm.setChatScript([
      {
        reply: JSON.stringify({
          human_text: "Create Jev as a new person and link Ana → is_hiring → Jev.",
          steps: [
            { seq: 1, human_text: "Create node Jev", tool: "create_node", args: { name: "Jev", category: "person", tags: [] } },
            { seq: 2, human_text: "Create edge Ana → Jev", tool: "create_edge", args: { from_node_id: "4:t:1", to_node_id: "4:t:2", relation: "is_hiring" } },
          ],
        }),
      },
      { reply: JSON.stringify({ approved: true, reason: null }) },
    ]);

    const app = createApp({ llm, graph });

    // Prime the conversation store — this consumes one chat response from the fake.
    const chatRes = await app.handle(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversation_id: null, message: "Ana hired Jev" }),
      }),
    );
    const chatBody = await json(chatRes);
    const conversationId = chatBody.conversation_id;

    // NOW script the propose→judge responses (prime call already consumed the first one).
    llm.setChatScript([
      {
        reply: JSON.stringify({
          human_text: "Create Jev as a new person and link Ana → is_hiring → Jev.",
          steps: [
            { seq: 1, human_text: "Create node Jev", tool: "create_node", args: { name: "Jev", category: "person", tags: [] } },
            { seq: 2, human_text: "Create edge Ana → Jev", tool: "create_edge", args: { from_node_id: "4:t:1", to_node_id: "4:t:2", relation: "is_hiring" } },
          ],
        }),
      },
      { reply: JSON.stringify({ approved: true, reason: null }) },
    ]);

    const res = await app.handle(
      new Request("http://localhost/api/analyse", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversation_id: conversationId }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.proposal).toBeDefined();
    expect(body.proposal.judge_approved).toBe(true);
    expect(body.proposal.steps).toHaveLength(2);
    expect(body.proposal.human_text).toContain("Jev");
    expect(ISO_RE.test(body.proposal.created_at)).toBe(true);
  });

  it("returns a failure payload after 9 rejected proposals", async () => {
    const graph = new FakeGraphClient([{ records: [] }]);
    const llm = new FakeLLMClient();
    // Always reject: 18 chat calls needed for 3 rounds × 3 fixes × (propose + judge)
    llm.setChatScript(
      Array.from({ length: 18 }, () => ({ reply: JSON.stringify({ approved: false, reason: "Force fail" }) })),
    );

    const app = createApp({ llm, graph });
    const chatRes = await app.handle(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversation_id: null, message: "hello" }),
      }),
    );
    const { conversation_id } = await json(chatRes);

    const res = await app.handle(
      new Request("http://localhost/api/analyse", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversation_id }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.proposal).toBeNull();
    expect(body.error).toContain("9 tries");
    expect(body.log_file).toContain("proposal-failures");
  });
});
