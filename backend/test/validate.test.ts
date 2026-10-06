import { describe, expect, it } from "bun:test";
import { ExtractionValidationError, parseExtraction, danglingEdgeViolations } from "../src/llm/validate";
import type { ExtractionEdge, ExtractionNode } from "../src/types";

/**
 * §6 (revised) tests. The contract now produces `nodes[]` + `edges[]` with
 * OPEN-string categories/relations and NO action_items. The old
 * entities/action_items shape is gone entirely.
 */

const modelInput = (overrides: Record<string, unknown> = {}) => ({
  summary: "We planned the kitchen remodel.",
  tags: ["home", "kitchen"],
  nodes: [
    { name: "Ana", category: "person", confidence: 0.9, tags: ["contractor"] },
    { name: "Remodel", category: "project", confidence: 0.8, tags: [] },
    { name: "Kitchen", category: "place", confidence: 0.8, tags: [] },
  ] as ExtractionNode[],
  edges: [
    { relation: "hired_by", from: "Ana", to: "Remodel", confidence: 0.7, attributes: { status: "quote" } },
    { relation: "mentions", from: "Remodel", to: "Kitchen", confidence: 1, attributes: {} },
  ] as ExtractionEdge[],
  mood_or_tone: "excited",
  ...overrides,
});

describe("parseExtraction — happy path", () => {
  it("passes through a fully valid output unchanged", () => {
    const input = modelInput();
    const out = parseExtraction(input);
    expect(out.summary).toBe(input.summary);
    expect(out.nodes).toEqual(input.nodes);
    expect(out.edges).toEqual(input.edges);
    expect(out.tags).toEqual(input.tags);
    expect(out.mood_or_tone).toBe("excited");
  });

  it("defaults missing collections and mood", () => {
    const out = parseExtraction({ summary: "Hi" });
    expect(out.nodes).toEqual([]);
    expect(out.edges).toEqual([]);
    expect(out.tags).toEqual([]);
    expect(out.mood_or_tone).toBeNull();
  });

  it("ignores unknown extra fields the model added", () => {
    const out = parseExtraction(modelInput({ extra_stuff: 123, bingo: ["x"], action_items: [{ text: "ignore me" }] }));
    expect(out.summary).toBe("We planned the kitchen remodel.");
    // §6 revision: action_items is gone from the contract — a stray field is
    // treated as just another unknown extra, not surfaced anywhere.
    expect("action_items" in out).toBe(false);
  });
});

describe("parseExtraction — §6 coercion rules", () => {
  it("keeps an open-string node category unchanged (§6: no coercion-to-other)", () => {
    const out = parseExtraction(
      modelInput({ nodes: [{ name: "Mystery", category: "vibe", confidence: 1, tags: [] }] }),
    );
    expect(out.nodes[0].category).toBe("vibe");
  });

  it("keeps all open categories, including ones outside any familiar list", () => {
    const out = parseExtraction(
      modelInput({
        nodes: [
          { name: "A", category: "banana", confidence: 1, tags: [] },
          { name: "B", category: "idea", confidence: 1, tags: [] },
          { name: "C", category: "person", confidence: 1, tags: [] },
        ],
      }),
    );
    expect(out.nodes.map((n) => n.category)).toEqual(["banana", "idea", "person"]);
  });

  it("hardcodes 1.0 for a missing confidence (v1 simplification)", () => {
    const out = parseExtraction(modelInput({ nodes: [{ name: "X", category: "topic", tags: [] }] }));
    expect(out.nodes[0].confidence).toBe(1.0);
  });

  it("parses string confidence and clamps out-of-range numbers", () => {
    const out = parseExtraction(
      modelInput({ nodes: [{ name: "X", category: "topic", confidence: "0.5", tags: [] }] }),
    );
    expect(out.nodes[0].confidence).toBe(0.5);
    const out2 = parseExtraction(
      modelInput({ nodes: [{ name: "X", category: "topic", confidence: 42, tags: [] }] }),
    );
    expect(out2.nodes[0].confidence).toBe(1);
  });

  it("filters per-node tags to non-empty strings and defaults to []", () => {
    const out = parseExtraction(
      modelInput({ nodes: [{ name: "X", category: "topic", confidence: 1, tags: ["keep", "  ", 3, null] }] }),
    );
    expect(out.nodes[0].tags).toEqual(["keep"]);
    const out2 = parseExtraction(modelInput({ nodes: [{ name: "Y", category: "topic", confidence: 1 }] }));
    expect(out2.nodes[0].tags).toEqual([]);
  });

  it("collapses invalid edge attributes to {} and keeps valid objects", () => {
    const out = parseExtraction(
      modelInput({
        nodes: [
          { name: "A", category: "topic", confidence: 1, tags: [] },
          { name: "B", category: "topic", confidence: 1, tags: [] },
          { name: "C", category: "topic", confidence: 1, tags: [] },
          { name: "D", category: "topic", confidence: 1, tags: [] },
          { name: "E", category: "topic", confidence: 1, tags: [] },
        ],
        edges: [
          { relation: "r1", from: "A", to: "B", confidence: 1, attributes: "nope" },
          { relation: "r2", from: "A", to: "C", confidence: 1, attributes: [1, 2] },
          { relation: "r3", from: "A", to: "D", confidence: 1 },
          { relation: "r4", from: "A", to: "E", confidence: 1, attributes: { status: "done" } },
        ],
      }),
    );
    expect(out.edges.map((e) => e.attributes)).toEqual([{}, {}, {}, { status: "done" }]);
  });

  it("clamps edge confidence and defaults missing confidence to 1.0", () => {
    const out = parseExtraction(
      modelInput({
        nodes: [
          { name: "A", category: "topic", confidence: 1, tags: [] },
          { name: "B", category: "topic", confidence: 1, tags: [] },
          { name: "C", category: "topic", confidence: 1, tags: [] },
        ],
        edges: [{ relation: "x", from: "A", to: "B", confidence: 5 }, { relation: "y", from: "A", to: "C" }],
      }),
    );
    expect(out.edges[0].confidence).toBe(1);
    expect(out.edges[1].confidence).toBe(1);
  });

  it("drops individual malformed nodes/edges but keeps the rest", () => {
    const out = parseExtraction(
      modelInput({
        nodes: [
          { name: "Good", category: "topic", confidence: 1, tags: [] },
          { name: "A", category: "topic", confidence: 1, tags: [] },
          { name: "B", category: "topic", confidence: 1, tags: [] },
          {},
          { category: "person", confidence: 1, tags: [] },
          { name: "  ", category: "place", confidence: 1, tags: [] },
          { name: "NoCat" }, // name yes, category no -> dropped, never "other"-ed
          42,
        ],
        edges: [
          { relation: "keep", from: "Good", to: "A", confidence: 1, attributes: {} },
          { relation: "keep2", from: "A", to: "B", confidence: 1, attributes: {} },
          { from: "A", to: "B", confidence: 1, attributes: {} }, // no relation
          { relation: "x", to: "B", confidence: 1, attributes: {} }, // no from
          { relation: "x", from: "A", confidence: 1, attributes: {} }, // no to
          null,
          "string edge",
        ],
      }),
    );
    expect(out.nodes.map((n) => n.name)).toEqual(["Good", "A", "B"]);
    expect(out.edges.map((e) => e.relation)).toEqual(["keep", "keep2"]);
  });

  it("drops dangling edges whose from/to do not match any node name (drop-fallback mirrors graph/validate.ts)", () => {
    const out = parseExtraction(
      modelInput({
        nodes: [{ name: "Real", category: "topic", confidence: 1, tags: [] }],
        edges: [
          { relation: "keep", from: "Real", to: "Real", confidence: 1, attributes: {} },
          { relation: "drop-from", from: "Ghost", to: "Real", confidence: 1, attributes: {} },
          { relation: "drop-to", from: "Real", to: "Nowhere", confidence: 1, attributes: {} },
          { relation: "drop-both", from: "Ghost", to: "Nowhere", confidence: 1, attributes: {} },
        ],
      }),
    );
    expect(out.edges.map((e) => e.relation)).toEqual(["keep"]);
  });

  it("dangling-edge drop is case-sensitive and trimmed exact (mirrors graph/validate.ts predicate)", () => {
    const out = parseExtraction({
      summary: "Case sensitivity test",
      nodes: [{ name: "Ana", category: "person", confidence: 1, tags: [] }],
      edges: [
        { relation: "r1", from: "ana", to: "Ana", confidence: 1, attributes: {} }, // from lowercase -> drop
        { relation: "r2", from: "Ana ", to: "Ana", confidence: 1, attributes: {} }, // from trailing space -> kept (trimmed)
        { relation: "r3", from: "Ana", to: "Ana ", confidence: 1, attributes: {} }, // to trailing space -> kept (trimmed)
        { relation: "r4", from: " Ana", to: "Ana", confidence: 1, attributes: {} }, // from leading space -> kept (trimmed)
      ],
    });
    expect(out.edges.map((e) => e.relation)).toEqual(["r2", "r3", "r4"]);
  });
});

describe("parseExtraction — rejection, never crashes", () => {
  it.each([
    ["non-object root number", 42],
    ["string root", "hello"],
    ["null root", null],
    ["array root", []],
    ["empty object", {}],
    ["missing summary", { nodes: [] }],
    ["non-string summary", { summary: 42 }],
    ["blank summary", { summary: "   " }],
    ["nodes not array", { summary: "x", nodes: {} }],
    ["edges not array", { summary: "x", edges: "y" }],
    ["tags not array", { summary: "x", tags: 42 }],
  ] as const)("%s -> ExtractionValidationError", (_label, input) => {
    expect(() => parseExtraction(input)).toThrow(ExtractionValidationError);
  });

  it("never throws anything other than ExtractionValidationError, even on hostile input", () => {
    const nasty = [
      42, "x", null, undefined, true, [],
      { summary: 42 }, { summary: "" }, { summary: {} },
      { nodes: {} }, { nodes: [{}, []] },
      { edges: {} }, { edges: "nope" },
      { tags: 42 }, { mood_or_tone: 7 },
      {
        summary: "ok",
        nodes: [{ name: 5, category: [], confidence: NaN, tags: {} }],
        edges: [{ relation: 7, from: undefined, to: [], confidence: NaN, attributes: new Map([["a", "b"]]) }],
        tags: [{}, 3],
        action_items: "ignored",
      },
      new Map([["a", "b"]]),
    ];
    for (const input of nasty) {
      let threwOtherThanExpected = false;
      try {
        parseExtraction(input);
      } catch (err) {
        if (!(err instanceof ExtractionValidationError)) threwOtherThanExpected = true;
      }
      expect(threwOtherThanExpected).toBe(false);
    }
  });
});

describe("danglingEdgeViolations", () => {
  it("returns empty array for valid extraction with no dangling edges", () => {
    const input = {
      summary: "Test",
      nodes: [{ name: "A", category: "topic", confidence: 1, tags: [] }],
      edges: [{ relation: "r", from: "A", to: "A", confidence: 1, attributes: {} }],
    };
    expect(danglingEdgeViolations(input)).toEqual([]);
  });

  it("detects dangling 'from' endpoint", () => {
    const input = {
      summary: "Test",
      nodes: [{ name: "A", category: "topic", confidence: 1, tags: [] }],
      edges: [{ relation: "r", from: "Ghost", to: "A", confidence: 1, attributes: {} }],
    };
    const violations = danglingEdgeViolations(input);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("edges[0].from");
    expect(violations[0]).toContain("Ghost");
    expect(violations[0]).toContain("copy names verbatim");
  });

  it("detects dangling 'to' endpoint", () => {
    const input = {
      summary: "Test",
      nodes: [{ name: "A", category: "topic", confidence: 1, tags: [] }],
      edges: [{ relation: "r", from: "A", to: "Nowhere", confidence: 1, attributes: {} }],
    };
    const violations = danglingEdgeViolations(input);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("edges[0].to");
    expect(violations[0]).toContain("Nowhere");
  });

  it("detects both dangling endpoints on the same edge", () => {
    const input = {
      summary: "Test",
      nodes: [{ name: "A", category: "topic", confidence: 1, tags: [] }],
      edges: [{ relation: "r", from: "Ghost", to: "Nowhere", confidence: 1, attributes: {} }],
    };
    const violations = danglingEdgeViolations(input);
    expect(violations).toHaveLength(2);
  });

  it("reports violations with correct edge index for multiple edges", () => {
    const input = {
      summary: "Test",
      nodes: [{ name: "A", category: "topic", confidence: 1, tags: [] }],
      edges: [
        { relation: "r1", from: "A", to: "A", confidence: 1, attributes: {} },
        { relation: "r2", from: "Ghost", to: "A", confidence: 1, attributes: {} },
        { relation: "r3", from: "A", to: "Nowhere", confidence: 1, attributes: {} },
      ],
    };
    const violations = danglingEdgeViolations(input);
    expect(violations).toHaveLength(2);
    expect(violations[0]).toContain("edges[1].from");
    expect(violations[1]).toContain("edges[2].to");
  });

  it("handles malformed/missing nodes/edges gracefully (no crashes)", () => {
    expect(danglingEdgeViolations(null)).toEqual([]);
    expect(danglingEdgeViolations("string")).toEqual([]);
    expect(danglingEdgeViolations({ summary: "x" })).toEqual([]);
    expect(danglingEdgeViolations({ summary: "x", nodes: "not array" })).toEqual([]);
    expect(danglingEdgeViolations({ summary: "x", edges: "not array" })).toEqual([]);
    expect(danglingEdgeViolations({ summary: "x", nodes: [{ name: 42 }], edges: [{}] })).toEqual([]);
  });
});