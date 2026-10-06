Jarvis — Phase 3.5: Graph Retrieval for Chat

Status: implemented & verified. This spec reflects the phase as built and QA'd against a live Neo4j + OpenRouter stack — including every deviation from the original plan and why. Scope: the read path only. Extraction, resolution, and the query compiler (Phase 3+4) are unchanged; where their behavior interacts with this phase it is called out in §9.

> Superseded in part by [spec-phase-4.md](./spec-phase-4.md) (agentic writes) and [spec-phase-4.5.md](./spec-phase-4.5.md) (second provider + live gate). The `search_graph` tool itself is unchanged.

1. Goal

Phase 3+4 defined how extraction becomes graph writes. It never defined how a normal chat turn reads the graph back. Right now, if the user asks "what did I decide about the car repair" or "who's Ana," the chat model has no way to check Neo4j — it can only answer from the current conversation's context.

Definition of done for this phase (all verified): during an ordinary /api/chat turn with NO context in the conversation, the model decides on its own to call search_graph, gets real results back, and grounds its reply in them — including naming the semantic relation ("Ana is hiring Jev" for an is_hiring edge), not the generic edge type. It must never need the answer in the prompt, and never fabricate when the graph has nothing.

2. The mechanism

    Native LLM tool/function calling via OpenRouter's OpenAI-style tools param — not a bespoke "skill file" in the system prompt. Tool descriptions are the right size for this, so there is no token-budget problem to solve with lazy-loading.
    The system prompt gains exactly one slim line telling the model the tool exists and roughly when to use it. All detailed technique lives in the tool's own JSON-schema description, sent alongside the tool definition — not in the system prompt.
    Read-time search reuses Phase 3's searchContext() with targeted deviations recorded in §8 — every one of them a consequence of live QA, none of them touching the write path.
    No separate "reasoning pass" or extended-thinking step. Deciding whether to call a tool is native to instruction-tuned tool-calling models.
    OpenRouterClient stays domain-agnostic: it forwards a generic tools array and parses back generic tool_calls. It never knows what "search_graph" means.
    The tool's schema, description, and execution function live together in one module next to the existing graph code (searchGraphTool.ts) — not inside LLMClient, not inside the /api/chat route handler.

3. Verification record (last verified state)

    Unit: 156 pass / 0 fail (bun test), covering every read-path behavior below plus the full pre-existing suite.
    Integration: scripts/test-graph-chat.sh — 5 no-context questions against the rebuilt containerized stack with a REAL OpenRouter model (openai/gpt-4o-mini) and REAL Neo4j: PASS twice consecutively (stable, not flaky). The relationship question ("What is the relationship between Ana and Jev?") requires "hir" in the answer.
    Live model output (seeded graph: Ana -[is_hiring]-> Jev, Ana -[is_working_on]-> Kitchen Renovation):
        "Ana is hiring a person named Jev, who is a designer and a new hire."
        "What is the relationship between Ana and Jev?" → "Ana and Jev are colleagues, and there is a hiring relationship between them. Ana is currently hiring Jev, and this hiring status has been confirmed."
    The dev Neo4j fixture was reseeded after QA (wiping the junk "is related"/duplicate edges that the pre-fix read path had let into the graph) — see §10.

4. Architecture / Data Flow

[User message] --> POST /api/chat
                        |
                        v
              LLMClient.chat(messages, tools=[search_graph])   <- decision
                        |
             ---------------------------
             |                         |
      no tool call              tool_calls (1..n, all search_graph)
             |                         |
             v                         v
      returns reply         FOR EACH emitted call (bounded):
                            executeSearchGraphTool(args)
                                      |
                                      v
                            searchContext({tags, name_query})   <- Phase 3 (see §8)
                                      |
                                      v
                            matches + 1-hop neighborhood
                                      |
                                      v
                  append assistant echo (only answered calls) + one tool result per call
                                      |
                                      v
                         chat() again (up to MAX_TOOL_CALL_ROUNDS rounds)
                                      |
                              ---------------------
                              |                   |
                        tool_calls again    reply (or empty)
                              |                   |
                     round cap exceeded?    return reply
                              |                   |
                              v                   v
                           502 (LLM_PROVIDER_ERROR) — never an unbounded loop

Two new pieces, one extended, one amended:

    New module: search_graph tool definition + execution wrapper (§6).
    New route: POST /api/graph/search — thin read-only wrapper around searchContext() (§7).
    Extended: LLMClient.chat() gains an optional tools parameter and a tool_calls field on its response (§5).
    Amended by QA: the chat route's tool loop (originally "one round trip max") executes EVERY emitted call each round and allows up to 2 bounded rounds (§7) — a consequence of real model behavior.

5. System Prompt Change

Add one line to the existing chat system prompt. Nothing else changes.

    "You have a search_graph tool for retrieving stored notes about people, topics, projects, and past sessions. Call it when the user references something that might already be tracked."

This is the entire system-prompt footprint of this phase. It does not grow further even as the tool's own description gets more detailed.

6. Tool Contract (new)

New module backend/src/graph/searchGraphTool.ts — sits beside Phase 3's context-search module.

Tool definition (OpenRouter/OpenAI function-calling format), FINAL schema — tags is NOT required; the model itself decides between tags and name_query:

{
  "type": "function",
  "function": {
    "name": "search_graph",
    "description": "Search the personal knowledge graph for existing notes about a person, topic, or project. Prefer 2-5 tags over exact names — tags match more reliably than names, which vary in phrasing across mentions. Use name_query only when the user names someone or something specific. Explicit names are also accepted inside tags. If nothing matches, say so rather than guessing or inventing an answer.",
    "parameters": {
      "type": "object",
      "properties": {
        "tags": { "type": "array", "items": { "type": "string" } },
        "name_query": { "type": "string" }
      }
    }
  }
}

Execution function — wraps Phase 3's searchContext() with NO new search logic: the args become a synthetic one-node extraction (name = name_query ?? "", tags = the query tags, nodes = that single node, edges always empty) and searchContext runs its fixed Cypher:

async function executeSearchGraphTool(args: SearchGraphArgs, graph: GraphClient): Promise<CandidateSet> {
  return searchContext(extractionForSearch(args), graph);
}

Rules:

    This tool is read-only. It must never call the query compiler or write anything to Neo4j.
    Output shape is exactly searchContext()'s existing CandidateSet.node_candidates shape (Phase 3 §6) — no new schema to design or validate.
    If searchContext() returns zero matches, that's a valid result, not an error — the model is instructed (via the tool description) to say so rather than fabricate.

7. Chat Loop (as built — this is where the two live-QA bugs lived)

In the /api/chat handler, when the graph layer is configured:

    Decide: llm.chat(messages, [SEARCH_GRAPH_TOOL_DEF]).
    Bounded tool rounds: while the result carries tool_calls and the round counter < MAX_TOOL_CALL_ROUNDS (= 2):
        Execute EVERY emitted tool call (all are search_graph — the only tool offered), in parallel: executeSearchGraphTool(coerceSearchGraphArgs(call.arguments), graph). Bound at MAX_TOOL_CALLS_PER_TURN (= 4) calls per round; calls beyond the bound are simply not echoed.
        Append to messages: one assistant message — { role: "assistant", content: "", tool_calls: <exactly the executed calls> } — then ONE tool message per executed call with its own tool_call_id.
        chat() again.
    Reply-less guard: if the final result has no non-empty reply → throw LLMProviderError("Model returned no reply", "empty completion after the tool round trip") → 502. A stuck model never loops forever; the round cap makes this bounded. Tools are never offered on the next user turn after a 502 (nothing is persisted).
    No tool call: behave exactly as Phase 1 (§5 unchanged).

Why the loop works this way — the two live-QA failures that determined it:

    Bug: multiple tool_calls in one response (a live relationship question produced one search_graph per endpoint — Ana AND Jev). The original implementation executed only the first call but echoed ALL ids on the assistant message with a single tool result. OpenAI-family providers reject that as an unanswered tool call: HTTP 400 "Provider returned error". Fix: echo exactly the calls we answer, and answer every emitted call.
    Bug: the model does not always send both searches in the same round — observed live: it searches Ana, sees the result, THEN requests Jev in its second response. The original "one round trip max" turned that legitimate follow-up search into 502 "Model returned no reply — empty completion". Fix: allow up to 2 bounded tool rounds; only a still-looping model (a 3rd reply-less request) hits the guard.
    Wire detail: content must be "" on the assistant tool-calls message so the transport serializes it to null — content + tool_calls together is also rejected upstream (same 400 class).

API contract — POST /api/graph/search (new route)

Read-only. Exposes searchContext() to the chat tool-call loop (and directly, for debugging).

    Request: { "tags": ["string"], "name_query": "string (optional)" } — tags is OPTIONAL at the transport layer; the handler normalizes body.tags ?? [].
    Response: same shape as Phase 3's CandidateSet.node_candidates (§6 of that spec) — reused, not redefined.
    Errors: 400 if tags is empty (or absent) AND name_query is absent (nothing to search on); 502 if the graph read fails.

8. search.ts — the read-path deviations (each justified by live QA)

Phase 3's searchContext() is the shared read module for both write-time resolution and this read path. Four deviations were required to make the read path honest; each is documented in the code with its live-QA rationale. None affects Phase 1 extraction, the resolver's other inputs, or the compiler.

    Empty-name guard: name clauses (exact/substring/contains) apply only when $name <> ''. The old CONTAINS '' matched EVERY node, and with a name-less tag search the LIMIT could truncate away genuine tag matches. A name-less search now matches by tags alone; no name/tag evidence → score 0 → filtered out. Empty tags AND no name_query → zero matches, a VALID result the model is told to acknowledge.
    Name-in-tags WHERE branch: the model — despite the tool schema — frequently puts explicit entity names in tags ("Who is Ana?" arrives as {tags:["Ana"]}). Without a branch matching a query tag against stored NAMES, that search returned nothing and the assistant wrongly claimed the graph has no notes about Ana. Added: OR toLower(n.name) IN [t IN $tags | toLower(t)]. "A tag that names an entity IS that entity" is a faithful reading of the write-time match rules; it fires only when a tag coincides with a stored name, so it cannot broaden unrelated searches.
    nodeScore name-via-tag: +1 when a query tag exactly equals a stored name (scoring: +2 exact name, +1.0 name-contains/substring, +0.5 per overlapping tag, plus the name-via-tag +1). The +1 is half an exact-name match — enough to clear the score>0 filter, not enough to outrank a real name match. Restricted to exact tag==name equality only.
    Neighborhood projection — semantic relation + attributes: the 1-hop neighborhood now projects relation: coalesce(r.relation, type(r)) instead of relation: type(r), plus attributes: r.attributes. Every edge in this schema is stored under the generic type RELATED (the compiler's EDGE_MERGE_CYPHER), so type(r) is always "RELATED" and never carries meaning. The real relation lives in the edge's relation property (is_hiring, is_working_on). Hiding it made the read path answer "is related to a person" about KNOWN relations — and that vague phrasing, once in the conversation, was later extracted into junk "is related" edges. coalesce keeps "RELATED" only as a fallback for edges lacking the property. direction ('out'|'in') was already projected and remains. The edge attributes (a JSON string) are now included so the model sees the full edge picture ("status confirmed").
    NeighborhoodEntry type (types.ts): gains optional attributes?: string (absent when the edge has none). Nothing that consumes neighborhoods destructures it, so the addition is non-breaking.

9. Transport & observability

    OpenRouterClient.request(): bounded transport retry — exactly ONE retry on network errors and HTTP 408/429/5xx (isTransientStatus), via retries/retryDelayMs options. 4xx is NEVER retried (a payload bug would just fail twice; live 400s were payload bugs, not flakes — see §7). Stale "never retried" docstrings in extract()/resolve() were corrected. This decision REVERSED the earlier "no transport retry" plan after live QA showed transient upstream 5xx/429s killing otherwise-correct turns.
    Logging: LLMProviderError in the /api/chat onError path is logged via console.error ("[502] LLM provider error: <status> — <provider message>"). The original 400/502 failures were only diagnosable because this was added.
    The empty-reply guard message distinguishes "the model looped past the bounded rounds" from other provider failures.

10. Fixtures & harness

    scripts/graph-seed.sh — wipes and reseeds the dev graph:
        Ana -[is_hiring]-> Jev (attributes {"status":"confirmed"})
        Ana -[is_working_on]-> Kitchen Renovation (attributes {"status":"ongoing"})
        Node tags include query-matching terms (e.g. "hiring" on Jev, "colleague" on both), mirroring what write-time extraction would produce — the read path must find nodes the way the write path stores them.
    scripts/test-graph-chat.sh — end-to-end QA harness: rebuilds the stack, resets + seeds the graph, sanity-checks the read route by tags AND name_query, then asks 5 NO-CONTEXT questions and asserts each answer is grounded (requires the actual names/relation token in the reply):
        tag-path: "Who is the person Ana is hiring? I cannot remember anything about them." → ana/jev
        name-in-tags: "Who is Ana?" → ana, jev
        name-only: "Tell me about Jev." → jev
        relation: "What is the relationship between Ana and Jev?" → hir
        neighborhood: "What projects is Ana working on?" → ana, renovation
    scripts/probe-tool-call.ts — raw OpenRouter probe mirroring app.ts exactly (same messages, tools, bounded 2-round loop, per-call echoes) so model/tool behavior can be inspected without the server. The 400 and the split-round 502 were both diagnosed with it.

11. Test plan (as built)

Unit (bun test, 156 pass) — new coverage beyond the original plan:

    executeSearchGraphTool: passes name_query→name and tags through; empty name_query → tag-only search; a query TAG equal to a stored NAME finds that node and scores it >0 ("name-via-tag"); zero matches is a valid result.
    Request/route: search with tags+name_query → 200; name_query only (no tags) → 200 (tags optional); no tags AND no name_query → 400; graph failure → 502 GRAPH_UNAVAILABLE for both endpoints.
    Search module: neighborhood projection shape — query contains coalesce(r.relation, type(r)), direction, and r.attributes; the semantic relation AND attributes flow through coerce into the output unchanged.
    Chat loop: single tool call executed + result fed back + final reply returned (not the raw tool call); NO tool call → Phase 1 behavior, no graph call; zero-match flows through to the model's reply; graph failure inside the tool → 502 with nothing persisted; MULTIPLE tool calls → every call executed, assistant echo = exactly the answered calls, every tool_call_id resolved; SPLIT-ROUNDS → Ana in round 1, Jev in round 2, final reply after 3 chat calls; BOUNDED LOOP → a 3rd reply-less tool call is a 502, never a 4th chat call.
    OpenRouterClient: transient 429 then success (retried once); persistent 5xx after retry; 401 never retried; extract() keeps its schema (retry options don't leak); tool_calls parsed into the ChatResult wire shape.

Integration (scripts/test-graph-chat.sh): see §10 — the original plan's integration cases all run here against the containerized stack, plus the relation question the plan didn't anticipate.

12. Explicitly out of scope / known Phase 3+4 territory (unchanged)

    Any change to extraction, resolution, or the query compiler — untouched. In particular, the compiler's EDGE_MERGE_CYPHER semantics (MERGE (a)-[r:RELATED]->(b) SET r.relation = $relation_type) can still overwrite or duplicate the relation property of an existing same-direction edge when a later extraction re-encounters a pair. This phase fixed the CHAIN that created junk relations (opaque neighborhoods → vague chat phrasing → extraction of that phrasing → junk edges); retroactive cleanup of already-written junk is a manual reseed (graph-seed.sh) or a future Phase 3/4 hardening — deliberately not touched here.
    Chat writing to the graph mid-conversation — this phase is read-only; graph writes still only happen through the existing extract → resolve → compile pipeline.
    Diary page Q&A / retrieval (Phase 2 has no chat loop to attach a tool to).
    Multiple distinct tools or a general agent loop — one tool (search_graph), bounded to 2 tool rounds per turn, never an unbounded loop.
    A fallback path for models without tool-calling support — the configured model (openai/gpt-4o-mini) supports tools and the harness verifies it end-to-end; no heuristic fallback is built.
    Extended thinking / reasoning mode for tag selection quality.

13. Files touched (read path only)

    backend/src/graph/searchGraphTool.ts — tool def + executor (new).
    backend/src/app.ts — chat loop (bounded rounds, per-call echo, empty-reply guard), /api/graph/search route, tags optional, onError logging.
    backend/src/graph/search.ts — §8 deviations.
    backend/src/types.ts — NeighborhoodEntry.attributes (optional).
    backend/src/llm/openrouter.ts — bounded transport retry; corrected docstrings.
    backend/test/search-graph.test.ts, search.test.ts, openrouter.test.ts — §11 coverage.
    scripts/graph-seed.sh, scripts/test-graph-chat.sh, scripts/probe-tool-call.ts — fixtures + harness.
    README.md — QA harness documentation + API table row ({ tags?, name_query? }).