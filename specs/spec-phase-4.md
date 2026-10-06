# Jarvis — Phase 4 Spec: Agentic Graph Writes with Proposal + Judge

Status: implemented. This document is the plan as written before the work;
[spec-phase-4.5.md](./spec-phase-4.5.md) covers everything added afterwards
(second LLM provider, UI model selector, live verification gate) and records the
one place the build came out simpler than planned here (§8 → 4.5 §7).

## 1. Goal

Make the chat agent capable and safe:
* Knows its purpose via a real system prompt (not just 2 tool one-liners).
* Writes to the graph only when asked + whole-proposal confirmed. `search_graph` stays free (no confirm).
* Replaces fire-and-forget `extract -> link` with: **analyse -> propose -> judge -> user confirm -> execute tools in sequence**.
* No super-tool. One step = one tool call. Old `extract()` becomes a sub-tool of analyse.

Definition of done: user clicks Save/Remember in chat -> sees human-readable proposal (steps) -> says yes -> steps execute 1:1 via tools -> any judge/exec failure never half-shows or silently writes.

## 2. Non-goals

* No auto-write without ask. No per-step checkboxes (whole-proposal yes/no only).
* No rollback of applied steps (keep-applied + report on mid-exec fail).
* No change to `searchGraphTool` read path, no vector/embeddings, no auth/multi-user.

## 3. Architecture / Data Flow

```
[User chats] --(clicks Save/Remember)--> POST /api/analyse { conversation_id }
    |
    v
  gather: chat history + searchContext evidence (tags + name_query sweep)
    |
    v
  LLM call A: PROPOSER (injected proposal-system-prompt, ephemeral)
    -> Proposal { human_text, steps[] }
    |
    v
  deterministic check per step (schema, node_id exists, from/to resolve, no dangling)
    |
    v
  LLM call B: JUDGE (own prompt) -> { approved: bool, reason?: string }
    | reject -> back to A with reason (max 3 fixes per analysis)
    | 3 fixes fail -> discard round, fresh analysis from zero (max 3 analyses = 9 proposals)
    | all fail -> write log file + user message "something didn't work, nothing changed"
    |
    v (approved)
  return Proposal to frontend, render human_text + steps, wait for whole yes/no
    |
    v (yes)
  chat agent executes steps in order, 1:1 step->tool call
    | tool fail -> stop, keep applied, report which steps applied/failed
    | exec error -> judge for minimal fix of remaining steps, skipping applied (max 2 fixes)
    | if fixes fail -> summarize applied + ask permission to retry
```

## 4. System Prompts

* `buildChatSystemPrompt(graphConfigured: bool)`: identity (Jarvis, single-user knowledge assistant), capabilities, grounding (search before claim, never invent), tool rules (search free; writers only after explicit ask + confirmed proposal).
* `buildProposalSystemPrompt()`: used only inside `/analyse`. Input = chat + search evidence. Output = ONLY Proposal JSON. Rules: copy names verbatim, prefer merge over duplicate create, emit delete only with explicit chat evidence, each step needs `human_text` + frozen `tool` + `args`.
* `buildJudgeSystemPrompt()`: input = chat + evidence + proposal. Output = `{ approved, reason }`. Reject on: hallucinated entity, wrong merge target, missing evidence, dangling ref, delete without evidence, ungrounded relation.

## 5. Proposal Contract (new)

```ts
interface ProposalStep {
  seq: number;                 // execution order, 1..n
  human_text: string;          // "Create node Ana (person) ..."
  tool: "create_node" | "update_node" | "merge_nodes"
      | "delete_node" | "create_edge" | "update_edge" | "delete_edge";
  args: Record<string, unknown>; // frozen tool args, validated
}
interface Proposal {
  proposal_id: string;         // uuid
  created_at: string;
  human_text: string;          // 2-5 sentences for user
  steps: ProposalStep[];
}
```

* Strict 1:1: executor may not re-plan or re-resolve `node_id`. Args frozen at proposal time.
* Empty steps = valid ("nothing to change") -> shown as such, no writes.

## 6. Analyse Route + Legacy handling

* New: `POST /api/analyse { conversation_id }` — the only exposed trigger (frontend button).
* Old `POST /conversations/:id/extract` + `POST /graph/link` handlers stay **in code only, not advertised**: no frontend button, no README API-table row, no new callers. `extract()` itself stays as internal helper for the proposer (`runExtraction`) + optional `extract_tool`.
* Legacy tag convention: any kept-but-hidden code gets:
  ```ts
  // ^legacy^ — kept for internal/debug use, not exposed in UI/docs. Do not add callers.
  ...code...
  // ^legacy^
  ```
  And `README.md` gains a `## Legacy code` section listing each tagged site as `file:line` + what it is + why kept. Line numbers recorded at write time.

## 7. Judge + Retry (3x3 rule)

* Inner: `propose(reason?) -> det-check -> judge`. Judge reject with `reason` feeds next propose. Max 3 proposals per analysis round.
* Outer: after 3 rejects, discard round's proposals + reasons, re-run gather + propose from zero. Max 3 rounds (9 proposals total).
* Final fail: write `./data/proposal-failures/{proposal_id}.json` (or timestamped) containing: chat slice, evidence, all proposals + judge reasons. Return `200 { proposal: null, error: "analysis failed...", log_file }` so frontend shows message, not a crash. Nothing written to graph.
* Success: only judge-approved proposal reaches user.

## 8. Execution (SHOULD work — judge-fix + continue + alert)

* Confirmed steps execute 1:1 in `seq` order. Expected to succeed (already judge-passed).
* On tool failure at step k:
  1. Keep applied steps 1..k-1 (no rollback).
  2. Send `{ failed_step, tool error, applied_ids }` to **judge** (not full re-propose). Judge returns minimal fix for steps k..n, with already-applied work excluded (no redo).
  3. Det-check + judge-approve the fix, then **continue automatically**.
  4. User gets one alert: `"Step k (X) failed (reason), fixed and continued — applied: [...], remaining: [...]"`. Fix loop bounded: max 2 judge-fixes per exec, then stop + report.
  5. If 2 exec-fixes fail -> summarize applied changes and ask user permission to retry from that point.
  6. All of it appended to mutation audit log.

## 9. Confirmation (locked)

* Whole-proposal `yes` / `no` in chat (or button). No partial.
* Writers never fire before `yes` in history. Prompt-gate + code-gate: executor requires `proposal_id` with `judge_approved=true` + `user_confirmed=true` flags (server-side memory or proposal file). Model can't skip.
* `search_graph` exempt.

## 10. Tools (reuse, don't batch)

Existing: `search_graph`, `delete_node`. New writers needed (each own module like `searchGraphTool.ts`): `create_node`, `update_node`, `merge_nodes`, `create_edge`, `update_edge`, `delete_edge` (or minimal subset to start: create/update/delete node + create edge?).
* Each: `TOOL_DEF` + `coerceArgs` + `executeXTool`. Deterministic Cypher, audit log (extend `resolutions/` or `deletions/` pattern -> `mutations/{id}.json`?).
* **Important:** every neighborhood entry now carries `edge_id` (projected in `search.ts` as `elementId(r)`, coerced in `coerceNeighborhood()`). The agent MUST include it when calling `update_edge`/`delete_edge` — the tool descriptions note that search_graph results include it.
* Executor loop: for each confirmed step in `seq` order: `coerce -> execute -> collect result`. Cap e.g. 10 steps/proposal. On first failure: stop, return `{ applied: [...], failed_step, error }`. Keep applied (no rollback).

## 11. Frontend

* Chat header/footer: `Analyse & Propose` button (replaces old extract button) -> calls `/api/analyse` -> renders `human_text` + ordered step list + each step's tool args -> **Confirm** / **Discard** buttons (confirm path can later trigger step execution).
* Exec progress: show applied steps as they complete; on fail show applied vs failed.
* Error alert banner when judge-fix kicks in during exec.

## 12. Observability / logs

* Every significant operation appends to `data/logs/operations.jsonl` as a JSON line: `{timestamp, operation, input_summary, result, detail}`.
* Chat sends, analyse calls, and every mutation tool execution (create_node, update_node, merge_nodes, create_edge, update_edge, delete_edge) are logged with the full args and result detail.
* The log is detailed enough to later answer: when did it happen, which tool, exact args, which node/edge was created/updated/deleted, and what the graph returned.

## 12. Tests / QA

**Unit (new in Phase 4):**
* `backend/test/propose.test.ts` — runAnalyse loop: first-try approval, reject→fix→approve, 9-rejection exhaustion → log file + `ok:false`, invalid proposal JSON, wrong step schema.
* `backend/test/mutation-tools.test.ts` — every writer tool: correct coercion (accept/reject), exact Cypher shape, params pass-through, no-op on empty update, merge detach-delete, edge create/update/delete.

**Integration (new in Phase 4):**
* `backend/test/analyse-route.test.ts` — POST /api/analyse: 502 graph unconfigured, 404 unknown id, success path (fake proposal + judge approve → `{ proposal }`), failure path (9 forced rejections → `{ proposal: null, error, log_file }`).

**Existing QA to keep green:**
* Manual: seed graph, chat "Ana hired Jev", click Remember → proposal creates Jev + edge; ambiguous Ana → `pending_review` or judge reject with reason; delete case requires explicit ask.

## 13. Files (proposed)

* `backend/src/llm/prompts.ts`: + `buildChatSystemPrompt`, `buildProposalSystemPrompt`, `buildJudgeSystemPrompt`.
* `backend/src/graph/propose.ts`: proposer + det-check + judge loop + log writer.
* `backend/src/graph/tools/createNodeTool.ts`, `updateNodeTool.ts`, `mergeNodesTool.ts`, `edgeTools.ts` (or one `mutationTools.ts` if small).
* `backend/src/app.ts`: `POST /api/analyse`, chat system prompt swap, exec loop for confirmed proposal.
* `backend/test/propose.test.ts`, `judge-retry.test.ts`, `analyse.test.ts`.

## 14. Quality Gates (must pass before this phase is "done")

- [ ] All unit + integration tests pass (`bun test`).
- [ ] `docker compose up` brings up backend + Neo4j; bind-mounted `./data/proposal-failures` files are host-user-owned.
- [ ] Manual chat QA: Save/Remember -> proposal renders -> confirm -> steps execute -> graph state verified in Neo4j Browser.
- [ ] Judge reject loop works (simulated bad proposal -> reason -> fixed -> approved).
- [ ] Exec failure -> judge fix -> continue -> alert shown -> applied kept.
- [ ] 9-proposal total fail -> log file written, user message shown, nothing in graph.
- [ ] Legacy routes still work internally but unadvertised; README legacy section accurate.
- [ ] No changes to extraction, resolution, compiler, or search modules — verified by grep/diff.