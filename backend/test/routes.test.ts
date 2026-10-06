import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { LLMProviderError } from "../src/types";
import { FakeLLMClient, ISO_RE, json } from "./helpers";

/**
 * Contract tests for §5. NOTE: Elysia 1.4.x behaves badly when more than one
 * Elysia instance is created per process (routes can stop matching, onError
 * codes corrupt). So this file creates exactly ONE app (created once at module
 * load) and swaps behavior per test through the mutable FakeLLMClient and a
 * lazy dataDir resolver.
 */

const llm = new FakeLLMClient();
let currentDataDir: string;
const app = createApp({ llm, dataDir: () => currentDataDir, frontendDist: null });

beforeEach(async () => {
  currentDataDir = await mkdtemp(join(tmpdir(), "jarvis-test-"));
  llm.reset();
});

afterEach(async () => {
  await rm(currentDataDir, { recursive: true, force: true });
});

const api = (path: string, init?: RequestInit) =>
  app.handle(new Request(`http://localhost:3000${path}`, init));

const postChat = (body: unknown) =>
  api("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("GET /api/health", () => {
  it("returns 200 ok", async () => {
    const res = await api("/api/health");
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ status: "ok" });
  });
});

/** A full ExtractionResult-shaped payload for the graph link route. */
function graphExtractionPayload() {
  return {
    conversation_id: "conv-1",
    extracted_at: "2026-09-23T00:00:00.000Z",
    summary: "One node, one edge.",
    tags: ["work"],
    nodes: [{ name: "Ana", category: "person", confidence: 1, tags: [] }],
    edges: [{ relation: "mentions", from: "Ana", to: "Ana", confidence: 1, attributes: {} }],
    mood_or_tone: null,
    raw_source_ref: "conversations/conv-1.json",
  };
}

describe("POST /api/graph/link — graph layer not configured", () => {
  // This file's app is intentionally created without a graph client (§2 seam).
  it("502s with GRAPH_UNAVAILABLE even for a valid extraction payload", async () => {
    const res = await api("/api/graph/link", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ extraction: graphExtractionPayload() }),
    });
    expect(res.status).toBe(502);
    const body = await json(res);
    expect(body.error.code).toBe("GRAPH_UNAVAILABLE");
    expect(body.error.message).toMatch(/not configured/);
  });

  it("reports the graph as unconfigured on /api/graph/ready", async () => {
    const res = await api("/api/graph/ready");
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ status: "ok", graph: "unconfigured" });
  });

  it("502s with GRAPH_UNAVAILABLE on /api/graph/search", async () => {
    const res = await api("/api/graph/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tags: ["car"] }),
    });
    expect(res.status).toBe(502);
    const body = await json(res);
    expect(body.error.code).toBe("GRAPH_UNAVAILABLE");
    expect(body.error.message).toMatch(/not configured/);
  });

  it("does not offer the search tool (but sends the Phase 4 base system prompt) when the graph layer is unconfigured", async () => {
    await postChat({ conversation_id: null, message: "What did I decide about the car repair?" });
    // Phase 4: tool is offered only when a graph exists — dev mode
    // without Neo4j keeps Phase 1 chat behavior for tools, but the
    // base identity system prompt is always present.
    expect(llm.toolsCalls).toHaveLength(1);
    expect(llm.toolsCalls[0]).toBeUndefined();
    expect(llm.chatCalls[0][0].role).toBe("system");
    expect(llm.chatCalls[0][0].content).toContain("You are Jarvis");
  });
});

describe("POST /api/chat", () => {
  it("starts a new conversation when conversation_id is null", async () => {
    const res = await postChat({ conversation_id: null, message: "Hello!" });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.conversation_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.reply).toBe(llm.currentReply);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe("user");
    expect(body.messages[0].content).toBe("Hello!");
    expect(body.messages[1].role).toBe("assistant");
    expect(ISO_RE.test(body.messages[0].timestamp)).toBe(true);
    expect(ISO_RE.test(body.messages[1].timestamp)).toBe(true);
    expect(llm.chatCalls).toHaveLength(1);
  });

  it("continues an existing conversation (server-side history)", async () => {
    const first = await json(await postChat({ conversation_id: null, message: "One" }));
    const second = await json(await postChat({ conversation_id: first.conversation_id, message: "Two" }));
    expect(second.messages).toHaveLength(4);
    expect(second.messages.map((m: any) => m.content)).toEqual(["One", "This is a fake assistant reply.", "Two", "This is a fake assistant reply."]);
    // The LLM saw the full history up to and including the new user message.
    expect(llm.chatCalls[1].map((m) => m.content)).toEqual([
      expect.stringContaining("You are Jarvis"),
      "One",
      "This is a fake assistant reply.",
      "Two",
    ]);
  });

  it("400s on a missing message", async () => {
    const res = await postChat({ conversation_id: null });
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe("VALIDATION_ERROR");
  });

  it("400s on whitespace-only message", async () => {
    const res = await postChat({ conversation_id: null, message: "   " });
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("404s on an unknown conversation_id", async () => {
    const res = await postChat({ conversation_id: "00000000-0000-4000-8000-000000000000", message: "hi" });
    expect(res.status).toBe(404);
    expect((await json(res)).error.code).toBe("UNKNOWN_CONVERSATION");
  });

  it("never leaks a raw stack trace into the response body", async () => {
    llm.setChatFailure(new LLMProviderError("call failed", "Rate limited by provider"));
    const res = await postChat({ conversation_id: null, message: "Hi" });
    expect(res.status).toBe(502);
    const body = await json(res);
    expect(body.error.code).toBe("LLM_PROVIDER_ERROR");
    expect(body.error.message).toContain("Rate limited by provider");
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/at .+\.ts:\d+/i);
    expect(text).not.toContain("node_modules");
  });

  it("does not append the user message when the LLM call fails (no dupes on retry)", async () => {
    const first = await json(await postChat({ conversation_id: null, message: "One" }));

    // Turn 2 fails with a provider error (502).
    llm.setChatFailure(new LLMProviderError("call failed", "provider down"));
    const failed = await postChat({ conversation_id: first.conversation_id, message: "Two" });
    expect(failed.status).toBe(502);

    // The failed message must NOT be in the store — retrying with the same
    // message produces exactly one "Two", not a duplicate.
    llm.setChatFailure(undefined);
    const retry = await json(await postChat({ conversation_id: first.conversation_id, message: "Two" }));
    expect(retry.messages).toHaveLength(4);
    expect(retry.messages.map((m: any) => m.content)).toEqual([
      "One",
      "This is a fake assistant reply.",
      "Two",
      "This is a fake assistant reply.",
    ]);
  });

  it("keeps validation error messages concise (no schema dump)", async () => {
    const res = await postChat({ conversation_id: null, message: 42 as unknown as string });
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error.code).toBe("VALIDATION_ERROR");
    // Human-readable, points at the offending field, and does NOT serialize the
    // whole TypeBox schema (old behavior leaked `expected` and raw JSON).
    expect(body.error.message).toMatch(/^Invalid body: \/message /);
    expect(body.error.message.length).toBeLessThan(200);
    expect(body.error.message).not.toContain("expected");
    expect(body.error.message).not.toContain("{");
  });
});

describe("POST /api/conversations/:id/extract", () => {
  async function startConversation(messages: string[]): Promise<string> {
    let id: string | null = null;
    for (const message of messages) {
      const body = await json(await postChat({ conversation_id: id, message }));
      id = body.conversation_id;
    }
    return id!;
  }

  it("writes conversation + extraction files and returns saved_to", async () => {
    const id = await startConversation(["Plan the deck build", "When can you start?"]);
    const res = await api(`/api/conversations/${id}/extract`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.conversation_id).toBe(id);
    // saved_to / raw_source_ref must point at the REAL files (resolved against
    // the data dir), not a hard-coded ./data that may not exist from the cwd.
    expect(body.saved_to.conversation_file).toBe(join(currentDataDir, "conversations", `${id}.json`));
    expect(body.saved_to.extraction_file).toBe(join(currentDataDir, "extractions", `${id}.json`));
    expect(body.extraction.summary).toBe("A fake summary of the conversation.");
    expect(body.extraction.conversation_id).toBe(id);
    expect(body.extraction.raw_source_ref).toBe(join(currentDataDir, "conversations", `${id}.json`));
    expect(existsSync(body.saved_to.conversation_file)).toBe(true);
    expect(existsSync(body.saved_to.extraction_file)).toBe(true);
    expect(ISO_RE.test(body.extraction.extracted_at)).toBe(true);

    const conv = JSON.parse(await readFile(join(currentDataDir, "conversations", `${id}.json`), "utf8"));
    expect(conv.messages).toHaveLength(4);
    const ext = JSON.parse(await readFile(join(currentDataDir, "extractions", `${id}.json`), "utf8"));
    expect(ext.summary).toBe("A fake summary of the conversation.");
    // The LLM client got the transcript, not a storage path.
    expect(llm.extractCalls[0].transcript.map((m) => m.content)).toEqual([
      "Plan the deck build",
      "This is a fake assistant reply.",
      "When can you start?",
      "This is a fake assistant reply.",
    ]);
  });

  it("writes files that are parseable, pretty-printed JSON (host-inspectable)", async () => {
    const id = await startConversation(["One message"]);
    await api(`/api/conversations/${id}/extract`, { method: "POST" });
    const convRaw = await readFile(join(currentDataDir, "conversations", `${id}.json`), "utf8");
    expect(convRaw.split("\n").length).toBeGreaterThan(3); // pretty-printed
    expect(() => JSON.parse(convRaw)).not.toThrow();
  });

  it("overwrites rather than duplicates when called twice", async () => {
    const id = await startConversation(["One message"]);
    await api(`/api/conversations/${id}/extract`, { method: "POST" });
    await api(`/api/conversations/${id}/extract`, { method: "POST" });
    const convFiles = await readdir(join(currentDataDir, "conversations"));
    const extFiles = await readdir(join(currentDataDir, "extractions"));
    expect(convFiles.filter((f) => f.endsWith(".json"))).toEqual([`${id}.json`]);
    expect(extFiles.filter((f) => f.endsWith(".json"))).toEqual([`${id}.json`]);
    // No temp files left behind.
    expect(convFiles.some((f) => f.endsWith(".tmp"))).toBe(false);
    expect(extFiles.some((f) => f.endsWith(".tmp"))).toBe(false);
  });

  it("404s for an unknown conversation", async () => {
    const res = await api("/api/conversations/00000000-0000-4000-8000-000000000000/extract", { method: "POST" });
    expect(res.status).toBe(404);
    expect((await json(res)).error.code).toBe("UNKNOWN_CONVERSATION");
  });

  it("rejects unsafe ids (path traversal)", async () => {
    const res = await api("/api/conversations/..%2F..%2Fetc%2Fpasswd/extract", { method: "POST" });
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe("VALIDATION_ERROR");
  });

  it("surfaces extraction LLM failures as 502 with user-friendly message", async () => {
    const id = await startConversation(["hello"]);
    // Simulate a provider error (e.g., model refusal) - providerMessage IS user-friendly here
    llm.setExtractFailure(new LLMProviderError("extract failed", "model refused to comply"));
    const res = await api(`/api/conversations/${id}/extract`, { method: "POST" });
    expect(res.status).toBe(502);
    const body = await json(res);
    expect(body.error.message).toBe("extract failed");
    expect(body.error.providerMessage).toBe("model refused to comply");
  });

  it("surfaces schema validation failure after retry with user-friendly message (not raw validation error)", async () => {
    const id = await startConversation(["hello"]);
    // Simulate what happens when model outputs invalid JSON twice:
    // extract() retries once, then throws LLMProviderError with user-friendly message
    // and providerMessage = raw validation error
    llm.setExtractFailure(
      new LLMProviderError(
        "Model output did not match the extraction schema after retry",
        "model output is not valid JSON",
      ),
    );
    const res = await api(`/api/conversations/${id}/extract`, { method: "POST" });
    expect(res.status).toBe(502);
    const body = await json(res);
    // Main message should be user-friendly, NOT the raw validation error
    expect(body.error.message).toBe("Model output did not match the extraction schema after retry");
    // Raw validation error should be in providerMessage for debugging
    expect(body.error.providerMessage).toBe("model output is not valid JSON");
  });

  it("writes no files when the extraction fails (no orphaned conversations)", async () => {
    const id = await startConversation(["hello"]);
    llm.setExtractFailure(new LLMProviderError("extract failed", "model refused to comply"));
    const res = await api(`/api/conversations/${id}/extract`, { method: "POST" });
    expect(res.status).toBe(502);
    // The transcript must not be on disk without its extraction — this is the
    // invariant that previously produced orphaned conversations/*.json files.
    expect(existsSync(join(currentDataDir, "conversations", `${id}.json`))).toBe(false);
    expect(existsSync(join(currentDataDir, "extractions", `${id}.json`))).toBe(false);
    const convDir = join(currentDataDir, "conversations");
    const entries = await readdir(convDir).catch(() => [] as string[]);
    expect(entries.filter((f) => f.endsWith(".json"))).toEqual([]);
  });
});

describe("GET /api/conversations/:id", () => {
  it("returns the saved conversation plus its extraction", async () => {
    const body = await json(await postChat({ conversation_id: null, message: "remember this" }));
    const id = body.conversation_id;
    await api(`/api/conversations/${id}/extract`, { method: "POST" });

    const res = await api(`/api/conversations/${id}`);
    expect(res.status).toBe(200);
    const got = await json(res);
    expect(got.conversation.conversation_id).toBe(id);
    expect(got.conversation.messages).toHaveLength(2);
    expect(got.extraction.conversation_id).toBe(id);
  });

  it("returns extraction: null for a saved conversation that was never extracted", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    await mkdir(join(currentDataDir, "conversations"), { recursive: true });
    await writeFile(
      join(currentDataDir, "conversations", `${id}.json`),
      JSON.stringify({ conversation_id: id, messages: [{ role: "user", content: "hello", timestamp: new Date().toISOString() }] }),
    );
    const res = await api(`/api/conversations/${id}`);
    expect(res.status).toBe(200);
    const got = await json(res);
    expect(got.extraction).toBeNull();
  });

  it("404s for an unknown id", async () => {
    const res = await api("/api/conversations/00000000-0000-4000-8000-000000000000");
    expect(res.status).toBe(404);
    expect((await json(res)).error.code).toBe("NOT_FOUND");
  });
});

describe("error contract", () => {
  it("returns the contract shape for unknown API routes", async () => {
    const res = await api("/api/nope");
    expect(res.status).toBe(404);
    const body = await json(res);
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.message).toBe("Route not found");
  });

  it("returns 500 contract shape when storage throws something unexpected", async () => {
    // Point the (lazy) data dir at a path that can't be a directory.
    const broken = join(currentDataDir, "i-am-a-file");
    await writeFile(broken, "x");
    currentDataDir = broken;

    const first = await json(await postChat({ conversation_id: null, message: "hi" }));
    const res = await api(`/api/conversations/${first.conversation_id}/extract`, { method: "POST" });
    expect(res.status).toBe(500);
    const body = await json(res);
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(body.error.message).toBe("Unexpected server error");
    // No raw exception text leaks into the response.
    expect(JSON.stringify(body)).not.toMatch(/ENOTDIR|EACCES/);
  });
});