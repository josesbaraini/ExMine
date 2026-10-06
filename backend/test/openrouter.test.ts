import { afterEach, describe, expect, it } from "bun:test";
import { LLMProviderError, type ChatMessage, type ToolDef } from "../src/types";
import { OpenRouterClient, type FetchLike } from "../src/llm/openrouter";
import { danglingEdgeViolations, parseExtraction } from "../src/llm/validate";

const KEY = "sk-test-key";
const MODEL = "openai/gpt-4o-mini";

function transcript(overrides: Partial<ChatMessage>[] = []): ChatMessage[] {
  const base: ChatMessage[] = [
    { role: "user", content: "Plan my vacation", timestamp: "2026-01-01T00:00:00Z" },
    { role: "assistant", content: "Where to?", timestamp: "2026-01-01T00:00:01Z" },
  ];
  return base.map((m, i) => ({ ...m, ...overrides[i] }));
}

function validModelJson() {
  return JSON.stringify({
    summary: "Vacation planning.",
    tags: ["travel", "summer"],
    nodes: [
      { name: "Trip", category: "event", confidence: 0.9, tags: ["vacation"] },
      { name: "Rome", category: "place", confidence: 0.9, tags: ["destination"] },
    ],
    edges: [{ relation: "destination_of", from: "Trip", to: "Rome", confidence: 0.8, attributes: { booked: false } }],
    mood_or_tone: "optimistic",
  });
}

function fakeFetch(status: number, bodyObj: unknown): FetchLike {
  return (async () =>
    new Response(JSON.stringify(bodyObj), { status, headers: { "content-type": "application/json" } })) as unknown as FetchLike;
}

describe("OpenRouterClient", () => {
  afterEach(() => {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_MODEL;
  });

  it("throws at construction when no API key is available", () => {
    expect(() => new OpenRouterClient({ apiKey: "" })).toThrow(/OPENROUTER_API_KEY/);
  });

  it("reads env vars for key and model", async () => {
    process.env.OPENROUTER_API_KEY = "env-key";
    process.env.OPENROUTER_MODEL = "env/model";
    let seen: any = null;
    const client = new OpenRouterClient({
      fetchImpl: (async (_url: any, init: any) => {
        seen = JSON.parse(init.body as string);
        return new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }] }), { status: 200 });
      }) as unknown as FetchLike,
    });
    await client.chat(transcript());
    expect(seen.model).toBe("env/model");
    expect(seen.messages).toHaveLength(2);
  });

  it("chat() forwards messages and returns the model content", async () => {
    let captured: { url: string; headers: Record<string, string>; body: any } | null = null;
    const client = new OpenRouterClient({
      apiKey: KEY,
      model: MODEL,
      fetchImpl: (async (url: any, init: any) => {
        captured = { url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) };
        return new Response(JSON.stringify({ choices: [{ message: { content: "Sure, Rome in July." } }] }), {
          status: 200,
        });
      }) as unknown as FetchLike,
    });

    const result = await client.chat(transcript());
    expect(result.reply).toBe("Sure, Rome in July.");
    expect(captured!.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(captured!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(captured!.body.messages[0]).toEqual({ role: "user", content: "Plan my vacation" });
  });

  it("chat() forwards tools verbatim when provided and omits the key otherwise", async () => {
    const tools: ToolDef[] = [
      {
        type: "function",
        function: { name: "search_graph", description: "Search.", parameters: { type: "object", properties: {} } },
      },
    ];
    let captured: any[] = [];
    const client = new OpenRouterClient({
      apiKey: KEY,
      fetchImpl: (async (_url: any, init: any) => {
        captured.push(JSON.parse(init.body as string));
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
      }) as unknown as FetchLike,
    });

    await client.chat([{ role: "user", content: "hi" }], tools);
    // The client never interprets WHAT the tool does — it is passed through byte-for-byte.
    expect(captured[0].tools).toEqual(tools);
    expect(JSON.stringify(captured[0].tools)).toContain("search_graph");

    await client.chat([{ role: "user", content: "hi" }]);
    expect(captured[1].tools).toBeUndefined();
  });

  it("chat() parses function tool_calls out of the response generically", async () => {
    const client = new OpenRouterClient({
      apiKey: KEY,
      fetchImpl: fakeFetch(200, {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                { id: "call_abc", type: "function", function: { name: "search_graph", arguments: '{"tags":["car","repair"]}' } },
              ],
            },
          },
        ],
      }),
    });
    const result = await client.chat([{ role: "user", content: "remember my car" }]);
    expect(result.reply).toBeUndefined();
    expect(result.tool_calls).toEqual([{ id: "call_abc", name: "search_graph", arguments: { tags: ["car", "repair"] } }]);
  });

  it("chat() sends the tool round-trip wire shape: assistant tool_calls + tool result with matching tool_call_id", async () => {
    let captured: any = null;
    const client = new OpenRouterClient({
      apiKey: KEY,
      fetchImpl: (async (_url: any, init: any) => {
        captured = JSON.parse(init.body as string);
        return new Response(JSON.stringify({ choices: [{ message: { content: "done" } }] }), { status: 200 });
      }) as unknown as FetchLike,
    });
    await client.chat([
      { role: "user", content: "hi" },
      { role: "assistant", content: "", tool_calls: [{ id: "call_abc", name: "search_graph", arguments: { tags: ["x"] } }] },
      { role: "tool", content: "{\"matches\":[]}", tool_call_id: "call_abc" },
    ]);
    const messages = captured.messages as any[];
    expect(messages[0]).toEqual({ role: "user", content: "hi" });
    // Assistant tool_calls message: content becomes null on the wire, args JSON-serialized.
    expect(messages[1]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_abc", type: "function", function: { name: "search_graph", arguments: '{"tags":["x"]}' } }],
    });
    expect(messages[2]).toEqual({ role: "tool", content: '{"matches":[]}', tool_call_id: "call_abc" });
  });

  it("chat() maps an empty completion WITH no tool_calls to LLMProviderError", async () => {
    const client = new OpenRouterClient({
      apiKey: KEY,
      fetchImpl: fakeFetch(200, { choices: [{ message: { content: null } }] }),
    });
    await expect(client.chat([{ role: "user", content: "hi" }])).rejects.toThrow(LLMProviderError);
  });

  it("chat() rejects unparseable tool_call arguments as LLMProviderError", async () => {
    const client = new OpenRouterClient({
      apiKey: KEY,
      fetchImpl: fakeFetch(200, {
        choices: [
          {
            message: {
              tool_calls: [{ id: "call_1", type: "function", function: { name: "search_graph", arguments: "{not json" } }],
            },
          },
        ],
      }),
    });
    await client.chat([{ role: "user", content: "hi" }]).catch((err: LLMProviderError) => {
      expect(err).toBeInstanceOf(LLMProviderError);
      expect(err.message).toMatch(/not valid JSON/);
    });
  });

  it("surfaces a 4xx provider error message as LLMProviderError", async () => {
    const client = new OpenRouterClient({
      apiKey: KEY,
      fetchImpl: fakeFetch(401, { error: { message: "Invalid API key" } }),
    });
    await expect(client.chat(transcript())).rejects.toThrow(LLMProviderError);
    await client.chat(transcript()).catch((err: LLMProviderError) => {
      expect(err.providerMessage).toBe("Invalid API key");
    });
  });

  it("maps network failures / timeouts to LLMProviderError with the failure detail", async () => {
    const client = new OpenRouterClient({
      apiKey: KEY,
      retryDelayMs: 0,
      fetchImpl: (async () => {
        throw new Error("connect ECONNREFUSED");
      }) as unknown as FetchLike,
    });
    await client.chat(transcript()).catch((err: LLMProviderError) => {
      expect(err).toBeInstanceOf(LLMProviderError);
      expect(err.message).toMatch(/failed or timed out/);
      expect(err.providerMessage).toContain("ECONNREFUSED");
    });
  });

  it("extract() accepts fenced JSON on the first attempt (no retry)", async () => {
    let calls = 0;
    const client = new OpenRouterClient({
      apiKey: KEY,
      fetchImpl: (async () => {
        calls++;
        return new Response(JSON.stringify({ choices: [{ message: { content: "```json\n" + validModelJson() + "\n```" } }] }), {
          status: 200,
        });
      }) as unknown as FetchLike,
    });
    const out = await client.extract(transcript(), { conversation_id: "abc", raw_source_ref: "./data/conversations/abc.json" });
    expect(calls).toBe(1);
    expect(out.conversation_id).toBe("abc");
    expect(out.raw_source_ref).toBe("./data/conversations/abc.json");
    expect(out.nodes.map((n) => n.name)).toEqual(["Trip", "Rome"]);
  });

  it("extract() retries once with the stricter prompt when the first output is garbage", async () => {
    const systems: string[] = [];
    const client = new OpenRouterClient({
      apiKey: KEY,
      fetchImpl: (async (_url: any, init: any) => {
        const body = JSON.parse(init.body as string);
        systems.push(body.messages[0].content);
        const content = body.messages[0].content.includes("RETRY ATTEMPT") ? validModelJson() : "this is not json";
        return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
      }) as unknown as FetchLike,
    });
    const out = await client.extract(transcript(), { conversation_id: "abc", raw_source_ref: "x" });
    expect(systems).toHaveLength(2);
    expect(systems[0]).not.toMatch(/RETRY ATTEMPT/);
    expect(systems[1]).toMatch(/RETRY ATTEMPT/);
    expect(out.summary).toBe("Vacation planning.");
  });

  it("extract() fails with a 502-style LLMProviderError after two bad outputs", async () => {
    let calls = 0;
    const client = new OpenRouterClient({
      apiKey: KEY,
      fetchImpl: (async () => {
        calls++;
        return new Response(JSON.stringify({ choices: [{ message: { content: "still not json" } }] }), { status: 200 });
      }) as unknown as FetchLike,
    });
    await client.extract(transcript(), { conversation_id: "abc", raw_source_ref: "x" }).catch((err: LLMProviderError) => {
      expect(err).toBeInstanceOf(LLMProviderError);
      expect(err.message).toMatch(/did not match the extraction schema after retry/);
      expect(calls).toBe(2);
    });
  });

  it("retries transient provider failures once, then succeeds (chat round trip)", async () => {
    let calls = 0;
    const client = new OpenRouterClient({
      apiKey: KEY,
      retryDelayMs: 0,
      fetchImpl: (async () => {
        calls++;
        if (calls === 1) {
          return new Response(JSON.stringify({ error: { message: "Provider returned error" } }), { status: 503 });
        }
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
      }) as unknown as FetchLike,
    });
    const result = await client.chat(transcript());
    expect(result.reply).toBe("ok");
    expect(calls).toBe(2);
  });

  it("persistent 5xx surfaces as LLMProviderError after the bounded retry", async () => {
    let calls = 0;
    const client = new OpenRouterClient({
      apiKey: KEY,
      retryDelayMs: 0,
      fetchImpl: (async () => {
        calls++;
        return new Response(JSON.stringify({ error: { message: "Provider returned error" } }), { status: 503 });
      }) as unknown as FetchLike,
    });
    await client.chat(transcript()).catch((err: LLMProviderError) => {
      expect(err).toBeInstanceOf(LLMProviderError);
      expect(err.providerMessage).toBe("Provider returned error");
      expect(calls).toBe(2); // original attempt + one retry, then give up
    });
  });

  it("extract() enjoys the same transport retry without losing its schema-retry loop", async () => {
    let calls = 0;
    const client = new OpenRouterClient({
      apiKey: KEY,
      retryDelayMs: 0,
      fetchImpl: (async () => {
        calls++;
        if (calls === 1) {
          return new Response(JSON.stringify({ error: { message: "Rate limited" } }), { status: 429 });
        }
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "```json\n" + validModelJson() + "\n```" } }] }),
          { status: 200 },
        );
      }) as unknown as FetchLike,
    });
    const out = await client.extract(transcript(), { conversation_id: "abc", raw_source_ref: "x" });
    expect(calls).toBe(2);
    expect(out.nodes.map((n) => n.name)).toEqual(["Trip", "Rome"]);
  });

  it("does NOT retry client errors (401) — a retry cannot fix a bad key", async () => {
    let calls = 0;
    const client = new OpenRouterClient({
      apiKey: KEY,
      retryDelayMs: 0,
      fetchImpl: (async () => {
        calls++;
        return new Response(JSON.stringify({ error: { message: "Invalid API key" } }), { status: 401 });
      }) as unknown as FetchLike,
    });
    await client.chat(transcript()).catch((err: LLMProviderError) => {
      expect(err).toBeInstanceOf(LLMProviderError);
      expect(err.providerMessage).toBe("Invalid API key");
      expect(calls).toBe(1); // 4xx is deterministic — retrying is pointless
    });
  });

  it("extract() coerces model output per §6 (open categories, confidence clamp, attributes fallback)", async () => {
    const client = new OpenRouterClient({
      apiKey: KEY,
      fetchImpl: fakeFetch(200, {
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: "S.",
                tags: ["a"],
                nodes: [
                  { name: "Mystery", category: "vibe", confidence: 99, tags: ["x", "  ", 3] },
                  { name: "NoCat" }, // no category -> dropped, never "other"-ed
                ],
                edges: [
                  { relation: "links", from: "Mystery", to: "Mystery", confidence: 2, attributes: "nope" },
                  { relation: "solo", from: "Mystery", to: "Mystery" },
                ],
                mood_or_tone: null,
              }),
            },
          },
        ],
      }),
    });
    const out = await client.extract(transcript(), { conversation_id: "abc", raw_source_ref: "x" });
    expect(out.nodes).toHaveLength(1);
    expect(out.nodes[0].category).toBe("vibe"); // open string, unchanged
    expect(out.nodes[0].confidence).toBe(1); // 99 clamped to 1
    expect(out.nodes[0].tags).toEqual(["x"]); // non-string/blank per-node tags filtered
    expect(out.edges).toHaveLength(2);
    expect(out.edges[0].attributes).toEqual({}); // non-object attributes collapse to {}
    expect(out.edges[0].confidence).toBe(1); // 2 clamped to 1
  });
});

// --- Dangling-edge retry (B + C + drop-fallback) ---
describe("extract() — dangling-edge retry with specific feedback", () => {
  afterEach(() => {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_MODEL;
  });

  const danglingModelJson = JSON.stringify({
    summary: "Tiro de guerra chat.",
    tags: ["military", "brazil"],
    nodes: [{ name: "tiro de guerra", category: "place", confidence: 0.9, tags: ["brazil"] }],
    edges: [{ relation: "is_location_for", from: "tiro de guerra", to: "mandatory military service", confidence: 0.8, attributes: {} }],
    mood_or_tone: "informative",
  });

  const fixedModelJson = JSON.stringify({
    summary: "Tiro de guerra chat.",
    tags: ["military", "brazil"],
    nodes: [
      { name: "tiro de guerra", category: "place", confidence: 0.9, tags: ["brazil"] },
      { name: "mandatory military service", category: "topic", confidence: 0.8, tags: ["brazil"] },
    ],
    edges: [{ relation: "is_location_for", from: "tiro de guerra", to: "mandatory military service", confidence: 0.8, attributes: {} }],
    mood_or_tone: "informative",
  });

  const stillDanglingModelJson = JSON.stringify({
    summary: "Tiro de guerra chat.",
    tags: ["military", "brazil"],
    nodes: [{ name: "tiro de guerra", category: "place", confidence: 0.9, tags: ["brazil"] }],
    edges: [{ relation: "is_location_for", from: "tiro de guerra", to: "mandatory military service", confidence: 0.8, attributes: {} }],
    mood_or_tone: "informative",
  });

  it("retries once with specific dangling-edge feedback and SUCCEEDS when the model adds the missing node (edge SAVED)", async () => {
    const systems: string[] = [];
    let attempt = 0;
    const client = new OpenRouterClient({
      apiKey: KEY,
      fetchImpl: (async (_url: any, init: any) => {
        const body = JSON.parse(init.body as string);
        systems.push(body.messages[0].content);
        attempt++;
        const content = attempt === 1 ? danglingModelJson : fixedModelJson;
        return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
      }) as unknown as FetchLike,
    });

    const out = await client.extract(transcript(), { conversation_id: "abc", raw_source_ref: "x" });

    expect(attempt).toBe(2);
    expect(systems).toHaveLength(2);
    expect(systems[0]).not.toMatch(/RETRY ATTEMPT/); // first attempt: standard system prompt
    expect(systems[1]).toMatch(/RETRY ATTEMPT/); // second attempt: retry prompt
    expect(systems[1]).toContain("Specific problems the validator found"); // feedback block present
    expect(systems[1]).toContain("edges[0].to"); // specific violation mentioned
    expect(systems[1]).toContain("mandatory military service"); // the dangling name
    expect(systems[1]).toContain("copy names verbatim");

    // The edge should be SAVED because the model fixed it by adding the missing node
    expect(out.nodes.map((n) => n.name)).toEqual(["tiro de guerra", "mandatory military service"]);
    expect(out.edges.map((e) => e.relation)).toEqual(["is_location_for"]);
    expect(out.edges[0].from).toBe("tiro de guerra");
    expect(out.edges[0].to).toBe("mandatory military service");
  });

  it("falls back to dropping the dangling edge when the retry STILL dangles (no 502)", async () => {
    let attempt = 0;
    const client = new OpenRouterClient({
      apiKey: KEY,
      fetchImpl: (async () => {
        attempt++;
        return new Response(JSON.stringify({ choices: [{ message: { content: stillDanglingModelJson } }] }), { status: 200 });
      }) as unknown as FetchLike,
    });

    const out = await client.extract(transcript(), { conversation_id: "abc", raw_source_ref: "x" });

    expect(attempt).toBe(2);
    // parseExtraction drop-fallback: the dangling edge is silently dropped
    expect(out.nodes.map((n) => n.name)).toEqual(["tiro de guerra"]);
    expect(out.edges).toHaveLength(0); // edge dropped, not a 502
  });

  it("preserves structural-failure retry behavior: 502 after two bad JSON outputs", async () => {
    let calls = 0;
    const client = new OpenRouterClient({
      apiKey: KEY,
      fetchImpl: (async () => {
        calls++;
        return new Response(JSON.stringify({ choices: [{ message: { content: "still not json" } }] }), { status: 200 });
      }) as unknown as FetchLike,
    });
    await client.extract(transcript(), { conversation_id: "abc", raw_source_ref: "x" }).catch((err: LLMProviderError) => {
      expect(err).toBeInstanceOf(LLMProviderError);
      expect(err.message).toMatch(/did not match the extraction schema after retry/);
      expect(calls).toBe(2);
    });
  });
});