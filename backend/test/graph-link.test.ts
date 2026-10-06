import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { GraphQueryError } from "../src/graph/client";
import { LLMProviderError, type ResolutionBody } from "../src/types";
import { FakeGraphClient, FakeLLMClient, ISO_RE, json } from "./helpers";

/**
 * Phase 3 §5/§9 — POST /api/graph/link contract: 200 with resolution +
 * templated summary + audit file path; 400 malformed extraction; 502 when the
 * resolve LLM call OR any Neo4j access fails (surfaced with the underlying
 * error); the audit entry is persisted BEFORE any graph write. One Elysia app
 * per file (existing suite rule).
 */

const graph = new FakeGraphClient();
const llm = new FakeLLMClient();
let currentDataDir: string;
const app = createApp({ llm, graph, dataDir: () => currentDataDir, frontendDist: null });

beforeEach(async () => {
  currentDataDir = await mkdtemp(join(tmpdir(), "jarvis-graph-test-"));
  llm.reset();
  graph.reset();
});

afterEach(async () => {
  await rm(currentDataDir, { recursive: true, force: true });
});

const api = (path: string, init?: RequestInit) =>
  app.handle(new Request(`http://localhost:3000${path}`, init));

function link(body: unknown) {
  return api("/api/graph/link", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** A full ExtractionResult-shaped payload — must pass Elysia AND parseExtraction. */
function extractionPayload() {
  return {
    conversation_id: "conv-1",
    extracted_at: "2026-09-23T00:00:00.000Z",
    summary: "Two people, one task.",
    tags: ["work"],
    nodes: [
      { name: "Ana", category: "person", confidence: 1, tags: ["work"] },
      { name: "José", category: "person", confidence: 1, tags: [] },
    ],
    edges: [{ relation: "needs_to_check", from: "Ana", to: "José", confidence: 1, attributes: { status: "undone" } }],
    mood_or_tone: null,
    raw_source_ref: "conversations/conv-1.json",
  };
}

describe("POST /api/graph/link — happy path", () => {
  it("runs search → resolve → audit-persist → compile and returns the §5 contract", async () => {
    graph.setScript([
      { query: /MATCH \(n:Entity\)/, records: [] }, // Ana
      { query: /MATCH \(n:Entity\)/, records: [] }, // José
      { query: /RELATED/, records: [] }, // edge relation
      { query: "MERGE (n:Entity", records: [{ node_id: "4:t:1" }] }, // Ana create
      { query: "MERGE (n:Entity", records: [{ node_id: "4:t:2" }] }, // José create
      { query: "MATCH (a) WHERE elementId(a)", records: [{ edge_id: "4:t:3" }] }, // edge
    ]);

    const res = await link({ extraction: extractionPayload() });
    expect(res.status).toBe(200);
    const body = await json(res);

    // §5 response shape.
    expect(body.resolution.resolution_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.resolution.source_extraction_ref).toBe("conversations/conv-1.json");
    expect(ISO_RE.test(body.resolution.resolved_at)).toBe(true);
    expect(body.resolution.nodes.map((n: any) => n.extracted_name)).toEqual(["Ana", "José"]);
    expect(body.saved_to.resolution_file).toBe(
      join(currentDataDir, "resolutions", `${body.resolution.resolution_id}.json`),
    );

    // Templated (non-LLM) summary.
    expect(body.summary).toContain("Added Ana as a new person node.");
    expect(body.summary).toContain("Linked Ana →needs_to_check→ José (status: undone).");

    // Audit entry is on disk and complete.
    expect(existsSync(body.saved_to.resolution_file)).toBe(true);
    const onDisk = JSON.parse(await readFile(body.saved_to.resolution_file, "utf8"));
    expect(onDisk.resolution_id).toBe(body.resolution.resolution_id);

    // The pipeline order: all context searches happened before the resolve call,
    // and the resolve call carried the candidate sets the search produced.
    expect(llm.resolveCalls).toHaveLength(1);
    expect(llm.resolveCalls[0].candidates.node_candidates).toHaveLength(2);
    expect(graph.calls).toHaveLength(6);
  });

  it("persists the audit entry even when every decision is pending_review (no writes)", async () => {
    const pendingBody: ResolutionBody = {
      nodes: [
        {
          extracted_name: "Ana",
          decision: "pending_review",
          node_id: null,
          category: "person",
          tags: ["work"],
          candidates_considered: [{ node_id: "4:t:9", name: "Ana", score: 2 }],
          reason: "two equally likely matches",
        },
        {
          extracted_name: "José",
          decision: "pending_review",
          node_id: null,
          category: "person",
          tags: [],
          candidates_considered: [],
          reason: "no clear candidate",
        },
      ],
      edges: [
        {
          extracted_relation: "needs_to_check",
          decision: "pending_review",
          edge_id: null,
          relation_type: "needs_to_check",
          from: "Ana",
          to: "José",
          attributes: {},
          reason: "held with its endpoints",
        },
      ],
    };
    llm.setResolveOverride(pendingBody);
    graph.setScript([
      { query: /MATCH \(n:Entity\)/, records: [] },
      { query: /MATCH \(n:Entity\)/, records: [] },
      { query: /RELATED/, records: [] },
    ]);

    const res = await link({ extraction: extractionPayload() });
    expect(res.status).toBe(200);
    const body = await json(res);

    // §11: pending_review items are logged, never written, never silently guessed.
    expect(body.summary).toContain("Held Ana for review (not written).");
    expect(body.summary).toContain("Held José for review (not written).");
    expect(body.summary).not.toContain("Added");
    expect(body.summary).not.toContain("Linked");
    // No graph writes at all: only the three context-search queries ran.
    expect(graph.calls).toHaveLength(3);
    expect(graph.calls.every((c) => c.query.includes("MATCH"))).toBe(true);
    // §11: pending_review still gets a complete audit entry.
    expect(existsSync(body.saved_to.resolution_file)).toBe(true);
  });

  it("builds the deterministic empty-summary message for an all-pending resolution with no items", async () => {
    llm.setResolveOverride({ nodes: [], edges: [] });
    graph.setScript([
      { query: /MATCH \(n:Entity\)/, records: [] },
      { query: /MATCH \(n:Entity\)/, records: [] },
      { query: /RELATED/, records: [] },
    ]);

    const res = await link({ extraction: extractionPayload() });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.summary).toBe("Nothing written — every item was held for review.");
    expect(graph.calls).toHaveLength(3);
  });
});

describe("POST /api/graph/link — errors", () => {
  it("400s when the extraction body is malformed (Elysia validation)", async () => {
    const res = await link({});
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe("VALIDATION_ERROR");
    expect(llm.resolveCalls).toHaveLength(0);
  });

  it("400s when the extraction is structurally invalid (empty summary)", async () => {
    const payload = extractionPayload();
    payload.summary = "";
    const res = await link({ extraction: payload });
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toMatch(/^Invalid extraction: /);
  });

  it("502s with a human-friendly message when the resolve LLM call fails", async () => {
    graph.setScript([
      { query: /MATCH \(n:Entity\)/, records: [] },
      { query: /MATCH \(n:Entity\)/, records: [] },
      { query: /RELATED/, records: [] },
    ]);
    llm.setResolveFailure(new LLMProviderError("resolve failed", "model went off the rails"));

    const res = await link({ extraction: extractionPayload() });
    expect(res.status).toBe(502);
    const body = await json(res);
    expect(body.error.code).toBe("LLM_PROVIDER_ERROR");
    expect(body.error.message).toContain("Graph link skipped — the extraction was saved to disk safely");
    // Nothing was persisted and nothing was written.
    const dir = join(currentDataDir, "resolutions");
    expect(await readdir(dir).catch(() => [])).toEqual([]);
  });

  it("502s with the underlying error when the context search fails", async () => {
    graph.setScript([]);
    graph.setFailure(new GraphQueryError("Invalid Cypher: expected 'RETURN'"));

    const res = await link({ extraction: extractionPayload() });
    expect(res.status).toBe(502);
    const body = await json(res);
    expect(body.error.code).toBe("GRAPH_UNAVAILABLE");
    expect(body.error.message).toContain("Invalid Cypher");
    // Underlying error surfaced, no stack trace leaked.
    expect(JSON.stringify(body)).not.toMatch(/at .+\.ts:\d+/i);
    expect(JSON.stringify(body)).not.toContain("node_modules");
  });

  it("persists the audit entry BEFORE a graph write — a write failure still leaves the log (502)", async () => {
    graph.setScript([
      { query: /MATCH \(n:Entity\)/, records: [] },
      { query: /MATCH \(n:Entity\)/, records: [] },
      { query: /RELATED/, records: [] },
      { query: "MERGE (n:Entity", error: new GraphQueryError("constraint violated") },
    ]);

    const res = await link({ extraction: extractionPayload() });
    expect(res.status).toBe(502);
    const body = await json(res);
    expect(body.error.code).toBe("GRAPH_UNAVAILABLE");

    // The invariant holds: nothing is lost even though the write failed — the
    // resolution was persisted before compile() was attempted.
    const files = await readdir(join(currentDataDir, "resolutions"));
    expect(files).toHaveLength(1);
    const onDisk = JSON.parse(await readFile(join(currentDataDir, "resolutions", files[0]), "utf8"));
    expect(onDisk.nodes).toHaveLength(2);
  });
});

describe("GET /api/graph/ready", () => {
  it("reports ready when connected", async () => {
    graph.setReady(true);
    const res = await api("/api/graph/ready");
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ status: "ok", graph: "ready" });
  });

  it("reports connecting while the retry loop is still looking for Neo4j", async () => {
    graph.setReady(false);
    const res = await api("/api/graph/ready");
    expect(await json(res)).toEqual({ status: "ok", graph: "connecting" });
  });

  it("does not disturb the exact /api/health contract", async () => {
    const res = await api("/api/health");
    expect(await json(res)).toEqual({ status: "ok" });
  });
});