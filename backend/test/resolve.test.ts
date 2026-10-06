import { describe, expect, it } from "bun:test";
import { parseResolution, ResolutionValidationError } from "../src/graph/validate";
import { OpenRouterClient, type FetchLike } from "../src/llm/openrouter";
import { LLMProviderError, type CandidateSet, type ExtractionResult } from "../src/types";

/**
 * Phase 3 §7 + §9 — resolve() schema validation: malformed model output is
 * retried once with the stricter prompt, then rejected with a 502-style
 * LLMProviderError — never crashes, never writes anything malformed.
 */

const extraction: ExtractionResult = {
  conversation_id: "conv-1",
  extracted_at: "2026-09-23T00:00:00.000Z",
  raw_source_ref: "conversations/conv-1.json",
  summary: "Two people, one task.",
  tags: ["work"],
  nodes: [
    { name: "Ana", category: "person", confidence: 1, tags: ["work"] },
    { name: "José", category: "person", confidence: 1, tags: ["friend"] },
  ],
  edges: [{ relation: "needs_to_check", from: "Ana", to: "José", confidence: 1, attributes: {} }],
  mood_or_tone: null,
};

const candidates: CandidateSet = { node_candidates: [], edge_candidates: [] };

function validResolutionJson(): string {
  return JSON.stringify({
    nodes: [
      {
        extracted_name: "Ana",
        decision: "create",
        node_id: null,
        category: "person",
        tags: ["work"],
        candidates_considered: [],
        reason: "genuinely new person",
      },
      {
        extracted_name: "José",
        decision: "merge",
        node_id: "4:abc:5",
        category: "person",
        tags: ["friend"],
        candidates_considered: [{ node_id: "4:abc:5", name: "José García", score: 1 }],
        reason: "same person under a fuller name",
      },
    ],
    edges: [
      {
        extracted_relation: "needs_to_check",
        decision: "create",
        edge_id: null,
        relation_type: "needs_to_check",
        from: "Ana",
        to: "José",
        attributes: { status: "undone" },
        reason: null,
      },
    ],
  });
}

const completion = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("parseResolution — §7 schema rules", () => {
  it("normalizes a fully valid model body", () => {
    const body = parseResolution(JSON.parse(validResolutionJson()));
    expect(body.nodes).toHaveLength(2);
    expect(body.nodes[0].decision).toBe("create");
    expect(body.nodes[0].node_id).toBeNull();
    expect(body.nodes[1].decision).toBe("merge");
    expect(body.nodes[1].node_id).toBe("4:abc:5");
    expect(body.edges[0].relation_type).toBe("needs_to_check");
  });

  it("nulls node_id on create/pending_review even if the model sent one", () => {
    const body = parseResolution({
      nodes: [
        {
          extracted_name: "Ana",
          decision: "create",
          node_id: "4:abc:99",
          category: "person",
          tags: [],
          candidates_considered: [],
          reason: null,
        },
      ],
      edges: [],
    });
    expect(body.nodes[0].node_id).toBeNull();
  });

  it("rejects a merge without a node_id (would silently skip a write)", () => {
    expect(() =>
      parseResolution({
        nodes: [
          {
            extracted_name: "Ana",
            decision: "merge",
            node_id: null,
            category: "person",
            tags: [],
            candidates_considered: [],
            reason: null,
          },
        ],
        edges: [],
      }),
    ).toThrow(ResolutionValidationError);
  });

  it("rejects an edge whose from/to do not match any node name (verbatim copy rule)", () => {
    expect(() =>
      parseResolution({
        nodes: [
          {
            extracted_name: "Ana",
            decision: "create",
            node_id: null,
            category: "person",
            tags: [],
            candidates_considered: [],
            reason: null,
          },
        ],
        edges: [
          {
            extracted_relation: "r",
            decision: "create",
            edge_id: null,
            relation_type: "r",
            from: "Ghost",
            to: "Ana",
            attributes: {},
            reason: null,
          },
        ],
      }),
    ).toThrow(/does not match any/);
  });

  it("rejects a non-object root — never crashes", () => {
    for (const input of [undefined, null, 42, "x"]) {
      expect(() => parseResolution(input)).toThrow(ResolutionValidationError);
    }
  });

  it.each<unknown>([{ nodes: [] }, { edges: [] }])("rejects structural omission %p", (input) => {
    expect(() => parseResolution(input)).toThrow(ResolutionValidationError);
  });

  it("is lenient on enrichment: category/tags/candidates/reason/attributes default safely", () => {
    const body = parseResolution({
      nodes: [{ extracted_name: "Ana", decision: "create", node_id: null }],
      edges: [
        {
          extracted_relation: "r",
          decision: "create",
          edge_id: null,
          relation_type: "r",
          from: "Ana",
          to: "Ana",
          attributes: "nope",
        },
      ],
    });
    expect(body.nodes[0].category).toBe("");
    expect(body.nodes[0].tags).toEqual([]);
    expect(body.nodes[0].candidates_considered).toEqual([]);
    expect(body.nodes[0].reason).toBeNull();
    expect(body.edges[0].attributes).toEqual({});
  });

  it("rejects edges without a usable relation_type (the compiler needs it to write)", () => {
    expect(() =>
      parseResolution({
        nodes: [
          {
            extracted_name: "Ana",
            decision: "create",
            node_id: null,
            category: "",
            tags: [],
            candidates_considered: [],
            reason: null,
          },
        ],
        edges: [
          {
            extracted_relation: "r",
            decision: "create",
            edge_id: null,
            relation_type: "  ",
            from: "Ana",
            to: "Ana",
            attributes: {},
            reason: null,
          },
        ],
      }),
    ).toThrow(/relation_type/);
  });
});

describe("OpenRouterClient.resolve — §7 retry-once for malformed output", () => {
  it("sends extraction + candidates and returns the validated body on the first attempt", async () => {
    let userMessage: string | null = null;
    const llm = new OpenRouterClient({
      apiKey: "sk-test",
      model: "model",
      fetchImpl: (async (_url: unknown, init: unknown) => {
        const body = JSON.parse((init as RequestInit).body as string) as {
          messages: { role: string; content: string }[];
        };
        userMessage = body.messages.find((m) => m.role === "user")?.content ?? null;
        return completion(validResolutionJson());
      }) as unknown as FetchLike,
    });

    const out = await llm.resolve(extraction, candidates);
    expect(out.nodes).toHaveLength(2);
    expect(out.nodes[1].node_id).toBe("4:abc:5");

    const sent = JSON.parse(userMessage!) as { extraction: ExtractionResult; candidates: CandidateSet };
    expect(sent.extraction.conversation_id).toBe("conv-1");
    expect(sent.candidates).toEqual(candidates);
  });

  it("retries once with the stricter prompt when the first output is garbage", async () => {
    const systems: string[] = [];
    const llm = new OpenRouterClient({
      apiKey: "sk-test",
      model: "model",
      fetchImpl: (async (_url: unknown, init: unknown) => {
        const body = JSON.parse((init as RequestInit).body as string) as {
          messages: { role: string; content: string }[];
        };
        systems.push(body.messages[0].content);
        const content = body.messages[0].content.includes("RETRY ATTEMPT") ? validResolutionJson() : "definitely not json {";
        return completion(content);
      }) as unknown as FetchLike,
    });

    const out = await llm.resolve(extraction, candidates);
    expect(systems).toHaveLength(2);
    expect(systems[0]).not.toMatch(/RETRY ATTEMPT/);
    expect(systems[1]).toMatch(/RETRY ATTEMPT/);
    expect(out.nodes[0].decision).toBe("create");
    expect(out.nodes[1].decision).toBe("merge");
  });

  it("rejects with a 502-style LLMProviderError after two bad outputs (never writes malformed)", async () => {
    let calls = 0;
    const llm = new OpenRouterClient({
      apiKey: "sk-test",
      model: "model",
      fetchImpl: (async () => {
        calls++;
        return completion("still not json");
      }) as unknown as FetchLike,
    });

    await llm.resolve(extraction, candidates).catch((err: LLMProviderError) => {
      expect(err).toBeInstanceOf(LLMProviderError);
      expect(err.message).toMatch(/did not match the resolution schema after retry/);
      expect(calls).toBe(2);
    });
  });

  it("does NOT retry on transport/provider failures — those propagate immediately", async () => {
    let calls = 0;
    const llm = new OpenRouterClient({
      apiKey: "sk-test",
      model: "model",
      fetchImpl: (async () => {
        calls++;
        return new Response(JSON.stringify({ error: { message: "Context length exceeded" } }), { status: 400 });
      }) as unknown as FetchLike,
    });

    await llm.resolve(extraction, candidates).catch((err: LLMProviderError) => {
      expect(err.providerMessage).toBe("Context length exceeded");
      expect(calls).toBe(1);
    });
  });
});