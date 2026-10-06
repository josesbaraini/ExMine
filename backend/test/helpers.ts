import type {
  CandidateSet,
  ChatMessage,
  ChatResult,
  ExtractionMeta,
  ExtractionResult,
  LLMClient,
  LLMMessage,
  ResolutionBody,
  ToolDef,
} from "../src/types";
import type { GraphClient, GraphParams } from "../src/graph/client";

/**
 * Phase 3 §9 — deterministic stand-in for the GraphClient seam: scripted
 * responses, recorded calls, and swap-able failure/readiness per test. The
 * compiler test (§9's "most valuable test") and the /api/graph/link contract
 * test both run against this, no real Neo4j needed.
 */
export interface ScriptedGraphCall {
  /** Optional guard: only satisfied when the call's query matches (substring or RegExp). */
  query?: string | RegExp;
  records?: Record<string, unknown>[];
  error?: Error;
}

export class FakeGraphClient implements GraphClient {
  calls: { query: string; params: GraphParams }[] = [];
  ready = true;
  private script: ScriptedGraphCall[] = [];
  private failWith?: Error;

  constructor(script: ScriptedGraphCall[] = []) {
    this.script = script;
  }

  setScript(script: ScriptedGraphCall[]): this {
    this.script = script.map((s) => ({ ...s }));
    return this;
  }

  setReady(ready: boolean): this {
    this.ready = ready;
    return this;
  }

  /** Position-independent failure: every run after this throws the given error. */
  setFailure(error: Error | undefined): this {
    this.failWith = error;
    return this;
  }

  reset(): this {
    this.calls = [];
    this.script = [];
    this.failWith = undefined;
    this.ready = true;
    return this;
  }

  async run(query: string, params: GraphParams = {}): Promise<{ records: Record<string, unknown>[] }> {
    this.calls.push({ query, params });
    if (this.failWith) throw this.failWith;
    const entry = this.consumeScriptEntry(query);
    if (entry?.error) throw entry.error;
    return { records: entry?.records ?? [] };
  }

  isReady(): boolean {
    return this.ready;
  }

  async connect(): Promise<void> {
    this.ready = true;
  }

  async close(): Promise<void> {
    this.ready = false;
  }

  private consumeScriptEntry(query: string): ScriptedGraphCall | undefined {
    // Prefer the first entry whose guard matches; fall back to FIFO so an
    // unmatched entry can't stall the pipeline.
    const idx = this.script.findIndex((e) => this.matches(e.query, query));
    const entry = idx >= 0 ? this.script[idx] : this.script.shift();
    if (idx >= 0) this.script.splice(idx, 1);
    return entry;
  }

  private matches(guard: string | RegExp | undefined, query: string): boolean {
    if (guard === undefined) return true;
    if (guard instanceof RegExp) return guard.test(query);
    return query.includes(guard);
  }
}

export interface FakeLLMClientOptions {
  reply?: string;
  extractionOverride?: Partial<ExtractionResult> | null;
  chatFailure?: Error;
  extractFailure?: Error;
  resolveFailure?: Error;
  resolveOverride?: ResolutionBody | null;
}

/**
 * Deterministic stand-in for the LLM provider (§8: "LLMClient interface tested
 * against a fake/mock implementation, not the real API"). Records every call,
 * and is fully mutable so one instance can serve a whole test file while the
 * suite swaps behavior per test (Elysia 1.4.x is not safe to instantiate
 * multiple times per process).
 */
export class FakeLLMClient implements LLMClient {
  chatCalls: LLMMessage[][] = [];
  /** The tools argument (or undefined) each chat() call was made with. */
  toolsCalls: (ToolDef[] | undefined)[] = [];
  extractCalls: { transcript: ChatMessage[]; meta: ExtractionMeta }[] = [];
  resolveCalls: { extraction: ExtractionResult; candidates: CandidateSet }[] = [];
  chatModels: (string | undefined)[] = [];
  extractModels: (string | undefined)[] = [];

  private reply: string;
  private extractionOverride: Partial<ExtractionResult> | null;
  private chatFailure?: Error;
  private extractFailure?: Error;
  private resolveFailure?: Error;
  private resolveOverride: ResolutionBody | null;
  private chatScript: ChatResult[] = [];

  constructor(options: FakeLLMClientOptions = {}) {
    this.reply = options.reply ?? "This is a fake assistant reply.";
    this.extractionOverride = options.extractionOverride ?? null;
    this.chatFailure = options.chatFailure;
    this.extractFailure = options.extractFailure;
    this.resolveFailure = options.resolveFailure;
    this.resolveOverride = options.resolveOverride ?? null;
  }

  get currentReply(): string {
    return this.reply;
  }

  setReply(reply: string): this {
    this.reply = reply;
    return this;
  }

  /**
   * Scripted chat() responses, consumed in order — for the Phase 3.5 tool-call
   * loop (first a tool_calls result, then the final reply). When the script is
   * exhausted, chat() falls back to { reply }.
   */
  setChatScript(script: ChatResult[]): this {
    this.chatScript = script;
    return this;
  }

  setExtractionOverride(override: Partial<ExtractionResult> | null): this {
    this.extractionOverride = override;
    return this;
  }

  setChatFailure(error: Error | undefined): this {
    this.chatFailure = error;
    return this;
  }

  setExtractFailure(error: Error | undefined): this {
    this.extractFailure = error;
    return this;
  }

  setResolveFailure(error: Error | undefined): this {
    this.resolveFailure = error;
    return this;
  }

  setResolveOverride(override: ResolutionBody | null): this {
    this.resolveOverride = override;
    return this;
  }

  reset(): void {
    this.chatCalls = [];
    this.toolsCalls = [];
    this.extractCalls = [];
    this.resolveCalls = [];
    this.extractionOverride = null;
    this.chatFailure = undefined;
    this.extractFailure = undefined;
    this.resolveFailure = undefined;
    this.resolveOverride = null;
    this.chatScript = [];
    this.chatModels = [];
    this.extractModels = [];
  }

  async chat(messages: LLMMessage[], tools?: ToolDef[], model?: string): Promise<ChatResult> {
    this.chatCalls.push(messages);
    this.toolsCalls.push(tools);
    this.chatModels = this.chatModels ?? [];
    this.chatModels.push(model);
    if (this.chatFailure) throw this.chatFailure;
    if (this.chatScript.length > 0) return this.chatScript.shift()!;
    return { reply: this.reply };
  }

  async extract(transcript: ChatMessage[], meta: ExtractionMeta, model?: string): Promise<ExtractionResult> {
    this.extractCalls.push({ transcript, meta });
    this.extractModels = this.extractModels ?? [];
    this.extractModels.push(model);
    if (this.extractFailure) throw this.extractFailure;
    return {
      conversation_id: meta.conversation_id,
      extracted_at: new Date().toISOString(),
      raw_source_ref: meta.raw_source_ref,
      summary: "A fake summary of the conversation.",
      tags: ["fake"],
      nodes: [{ name: "Fake Node", category: "topic", confidence: 1, tags: [] }],
      edges: [{ relation: "mentions", from: "Fake Node", to: "Fake Node", confidence: 1, attributes: {} }],
      mood_or_tone: null,
      ...this.extractionOverride,
    };
  }

  async listModels(): Promise<string[]> {
    return ["fake-model"];
  }

  async resolve(extraction: ExtractionResult, candidates: CandidateSet, model?: string): Promise<ResolutionBody> {
    this.resolveCalls.push({ extraction, candidates });
    if (this.resolveFailure) throw this.resolveFailure;
    if (this.resolveOverride) return this.resolveOverride;
    // Default deterministic behavior: treat everything as new.
    return {
      nodes: extraction.nodes.map((n) => ({
        extracted_name: n.name,
        decision: "create",
        node_id: null,
        category: n.category,
        tags: n.tags,
        candidates_considered: [],
        reason: "Fake resolver: no graph context exercised in this test.",
      })),
      edges: extraction.edges.map((e) => ({
        extracted_relation: e.relation,
        decision: "create",
        edge_id: null,
        relation_type: e.relation,
        from: e.from,
        to: e.to,
        attributes: e.attributes,
        reason: "Fake resolver: no graph context exercised in this test.",
      })),
    };
  }
}

export const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

export async function json(res: Response): Promise<any> {
  return (await res.json()) as any;
}