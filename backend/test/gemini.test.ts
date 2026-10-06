import { describe, expect, it } from "bun:test";
import { GeminiClient, sanitizeSchemaForGemini, type FetchLike } from "../src/llm/gemini";
import { SEARCH_GRAPH_TOOL_DEF } from "../src/graph/searchGraphTool";
import { DELETE_NODE_TOOL_DEF } from "../src/graph/deleteNodeTool";
import {
  CREATE_NODE_TOOL_DEF,
  UPDATE_NODE_TOOL_DEF,
  MERGE_NODES_TOOL_DEF,
  CREATE_EDGE_TOOL_DEF,
  UPDATE_EDGE_TOOL_DEF,
  DELETE_EDGE_TOOL_DEF,
} from "../src/graph/mutationTools";

/**
 * Unit tests for the Gemini adapter mirror the OpenRouter client suite:
 * tools forwarded as functionDeclarations, functionCall parsed to ToolCall[],
 * retry behavior, and empty-completion mapping.
 *
 * Plus ledger #4 guards: the outgoing tool payload must be Gemini-safe
 * (no `additionalProperties`), proven by capturing the actual fetch body.
 */

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

function fakeFetchOk(json: unknown): FetchLike {
  return async () => new Response(JSON.stringify(json), { status: 200, headers: { "content-type": "application/json" } });
}

describe("GeminiClient", () => {
  it("chat() returns the model text part", async () => {
    const client = new GeminiClient({ apiKey: "k", fetchImpl: fakeFetchOk({ candidates: [{ content: { parts: [{ text: "hello" }] } }] }) });
    const res = await client.chat([{ role: "user", content: "hi" }]);
    expect(res.reply).toBe("hello");
  });

  it("chat() parses functionCall parts into tool_calls", async () => {
    const client = new GeminiClient({
      apiKey: "k",
      fetchImpl: fakeFetchOk({
        candidates: [{ content: { parts: [{ functionCall: { name: "search_graph", args: { tags: ["Ana"] } } }] } }],
      }),
    });
    const res = await client.chat([{ role: "user", content: "who is Ana?" }]);
    expect(res.tool_calls).toHaveLength(1);
    expect(res.tool_calls?.[0].name).toBe("search_graph");
    expect(res.tool_calls?.[0].arguments).toEqual({ tags: ["Ana"] });
  });

  it("chat() throws on empty completion", async () => {
    const client = new GeminiClient({ apiKey: "k", fetchImpl: fakeFetchOk({ candidates: [{ content: { parts: [] } }] }) });
    await expect(client.chat([{ role: "user", content: "hi" }])).rejects.toThrow(/empty completion/);
  });

  it("extract() retries once when first output is not JSON", async () => {
    let calls = 0;
    const client = new GeminiClient({
      apiKey: "k",
      fetchImpl: async () => {
        calls++;
        const text = calls === 1 ? "not json" : JSON.stringify({ summary: "s", tags: [], nodes: [], edges: [], mood_or_tone: null });
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { status: 200 });
      },
    });
    const res = await client.extract([{ role: "user", content: "x", timestamp: "" }], { conversation_id: "c", raw_source_ref: "r" });
    expect(res.conversation_id).toBe("c");
    expect(calls).toBe(2);
  });

  it("resolve() returns a validated body", async () => {
    const client = new GeminiClient({
      apiKey: "k",
      fetchImpl: fakeFetchOk({
        candidates: [{ content: { parts: [{ text: JSON.stringify({ nodes: [], edges: [] }) }] } }],
      }),
    });
    const out = await client.resolve({ summary: "", tags: [], nodes: [], edges: [], mood_or_tone: null, conversation_id: "c", extracted_at: "", raw_source_ref: "" }, { node_candidates: [], edge_candidates: [] });
    expect(out.nodes).toEqual([]);
  });

  it("sends Gemini-safe tool schemas — no additionalProperties anywhere (captures fetch body)", async () => {
    let sentBody: any = null;
    const capturingFetch: FetchLike = async (_url, init) => {
      sentBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }), { status: 200 });
    };
    const client = new GeminiClient({ apiKey: "k", fetchImpl: capturingFetch });
    await client.chat([{ role: "user", content: "hi" }], ALL_TOOL_DEFS);

    const declarations = sentBody.tools?.[0]?.functionDeclarations;
    expect(Array.isArray(declarations)).toBe(true);
    expect(declarations).toHaveLength(ALL_TOOL_DEFS.length);
    // No banned key may appear anywhere in the serialized tool block.
    expect(JSON.stringify(sentBody.tools)).not.toContain("additionalProperties");
    // And the shape that Gemini needs survived.
    for (const d of declarations) {
      expect(d.parameters.type).toBe("object");
      expect(typeof d.parameters.properties).toBe("object");
    }
  });

  it("sanitizeSchemaForGemini strips banned keys recursively, keeps the rest", () => {
    const dirty = {
      type: "object",
      additionalProperties: false,
      $schema: "http://json-schema.org/draft-07/schema#",
      properties: {
        attributes: {
          type: "object",
          additionalProperties: true,
          properties: { note: { type: "string", default: "-" } },
        },
      },
      required: ["attributes"],
    };
    const clean = sanitizeSchemaForGemini(dirty);
    expect(clean.additionalProperties).toBeUndefined();
    expect((clean as any).$schema).toBeUndefined();
    const attrs = (clean.properties as any).attributes;
    expect(attrs.additionalProperties).toBeUndefined();
    expect(attrs.properties.note).toEqual({ type: "string" });
    expect(clean.required).toEqual(["attributes"]);
  });

  it("listModels() offers only allowlisted ids that the key can see", async () => {
    let requestedUrl = "";
    const liveFetch: FetchLike = async (input) => {
      requestedUrl = typeof input === "string" ? input : input instanceof URL ? input.href : (input as any).url;
      return new Response(JSON.stringify({
        models: [
          // Present but NOT allowlisted — image models, retired family,
          // 503-ing flagships, non-flash modalities, tool-less gemma.
          { name: "models/nano-banana-pro-preview" },
          { name: "models/gemini-2.5-flash-lite" },
          { name: "models/gemini-flash-latest" },
          { name: "models/gemini-3.7-flash" },
          { name: "models/gemini-3.8-flash" },
          { name: "models/gemini-3.5-transcribe" },
          { name: "models/gemma-4-26b-a4b-it" },
          // Allowlisted and visible — order comes from the allowlist.
          { name: "models/gemini-3.6-flash" },
          { name: "models/gemini-3.5-flash-lite" },
        ],
      }), { status: 200 });
    };
    const client = new GeminiClient({ apiKey: "k", fetchImpl: liveFetch });
    const list = await client.listModels();
    expect(requestedUrl).toContain("/v1beta/models?key=k");
    // Only the two allowlisted-and-visible ids, in reliability order.
    expect(list).toEqual(["gemini-3.5-flash-lite", "gemini-3.6-flash"]);
    // Explicitly: nothing unlisted ever escapes.
    expect(list).not.toContain("nano-banana-pro-preview");
    expect(list).not.toContain("gemini-2.5-flash-lite");
  });

  it("listModels() returns the full allowlist when the endpoint fails", async () => {
    const failing: FetchLike = async () => new Response("boom", { status: 500 });
    const client = new GeminiClient({ apiKey: "k", fetchImpl: failing });
    const list = await client.listModels();
    expect(list).toEqual(["gemini-3.5-flash-lite", "gemini-flash-lite-latest", "gemini-3.5-flash", "gemini-3.6-flash"]);
  });

  it("listModels() returns the allowlist when none of it is visible on the key", async () => {
    const otherKey: FetchLike = async () =>
      new Response(JSON.stringify({ models: [{ name: "models/nano-banana-pro-preview" }] }), { status: 200 });
    const client = new GeminiClient({ apiKey: "k", fetchImpl: otherKey });
    const list = await client.listModels();
    expect(list.length).toBeGreaterThan(0);
    expect(list).not.toContain("nano-banana-pro-preview");
  });

  it("round-trips thought_signature back on the follow-up turn (ledger #6)", async () => {
    const sentBodies: any[] = [];
    let turn = 0;
    // Turn 1: Gemini asks for a tool and attaches a thought_signature.
    // Turn 2: we feed the echo back the way app.ts does after executing it.
    const twoTurnFetch: FetchLike = async (_url, init) => {
      sentBodies.push(JSON.parse(init?.body as string));
      turn++;
      if (turn === 1) {
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      functionCall: { name: "search_graph", args: { tags: ["Ana"] } },
                      thoughtSignature: "sig-abc-123",
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "Ana is my sister." }] } }] }), { status: 200 });
    };

    const client = new GeminiClient({ apiKey: "k", fetchImpl: twoTurnFetch });
    const first = await client.chat([{ role: "user", content: "who is Ana?" }], ALL_TOOL_DEFS);
    expect(first.tool_calls).toHaveLength(1);

    // Exactly what the chat route does after running the tool.
    await client.chat(
      [
        { role: "user", content: "who is Ana?" },
        { role: "assistant", content: "", tool_calls: first.tool_calls! },
        { role: "tool", content: JSON.stringify({ result: [] }), tool_call_id: first.tool_calls![0].id },
      ],
      ALL_TOOL_DEFS,
    );

    expect(sentBodies).toHaveLength(2);
    const modelParts = sentBodies[1].contents.find((c: any) => c.role === "model")?.parts ?? [];
    expect(modelParts).toHaveLength(1);
    expect(modelParts[0].functionCall.name).toBe("search_graph");
    expect(modelParts[0].functionCall.args).toEqual({ tags: ["Ana"] });
    // The signature must survive — without it Gemini 400s on this turn.
    expect(modelParts[0].thought_signature).toBe("sig-abc-123");
  });

  it("accepts snake_case thought_signature from the wire too", async () => {
    const client = new GeminiClient({
      apiKey: "k",
      fetchImpl: fakeFetchOk({
        candidates: [
          { content: { parts: [{ functionCall: { name: "search_graph", args: {} }, thought_signature: "sig-snake" }] } },
        ],
      }),
    });
    const res = await client.chat([{ role: "user", content: "x" }], ALL_TOOL_DEFS);
    expect(res.tool_calls?.[0].provider_meta).toEqual({ thought_signature: "sig-snake" });
  });

  it("surfaces Gemini's 400 payload verbatim as LLMProviderError", async () => {
    const failing: FetchLike = async () =>
      new Response(JSON.stringify({ error: { message: 'Invalid JSON payload received. Unknown name "additionalProperties" ...' } }), { status: 400 });
    const client = new GeminiClient({ apiKey: "k", fetchImpl: failing });
    try {
      await client.chat([{ role: "user", content: "hi" }], ALL_TOOL_DEFS);
      expect.unreachable("should have thrown");
    } catch (err: any) {
      expect(err.message).toContain("400");
      expect(err.providerMessage).toContain("additionalProperties");
    }
  });
});
