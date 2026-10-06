# Jarvis — Phase 4.5 Spec: Provider Portability + Live Verification

Status: implemented & verified. This spec covers the work done **during and after
Phase 4 that was not in `spec-phase-4.md`**. Phase 4 itself was implemented as
specified — everything it asked for is in the code. This document exists so the
boundary stays honest: if it is here, it was a deviation, an addition, or a
hardening pass driven by real failures.

Scope: the LLM provider seam and how we prove it works against a real endpoint.
Nothing here changes the propose → judge → confirm → execute contract, the
extraction contract, or the graph write path.

---

## 1. Goal

Phase 4 shipped against OpenRouter and its fake-fetch test suite. That suite can
prove our code paths *execute*, but it can never produce a provider error,
because a fake fetch never validates anything. Two consequences, both learned
the hard way:

1. **The provider seam was theoretical.** `LLMClient` was written to be
   swappable, but no second implementation existed and nothing forced the
   contract to be provider-neutral in practice.
2. **Every real 4xx class failure lived on the far side of an HTTP call.** The
   `additionalProperties` 400 (ledger #4), the `thought_signature` 400
   (ledger #6), and the retired-model 404 (ledger #7) are all invisible to a
   fake. The suite stayed green through all three.

Definition of done: a second provider (Google AI Studio / Gemini) works
end-to-end, and a live gate replays the exact request sequences the app makes —
so the next provider-shaped failure is caught by a script instead of by the user.

---

## 2. Decisions

* **Provider seam via `LLMClient`, not a new abstraction.** `index.ts` switches
  on `LLM_PROVIDER` (`openrouter` | `gemini`). Nothing outside
  `backend/src/llm/gemini.ts` imports a Gemini type or endpoint — the same rule
  the Neo4j driver follows (`graph-client.ts` is the only importer).
* **Gemini tool schemas are sanitized, OpenRouter's are forwarded verbatim.**
  Gemini's `functionDeclarations` is a *subset* of JSON Schema; `additionalProperties`,
  `$schema`, `$ref`, `default` and friends are rejected with a 400.
  `sanitizeSchemaForGemini()` strips them recursively instead of forking the
  tool definitions per provider.
* **Model selection is a per-call argument, not a constructor setting.** Every
  `LLMClient` method takes an optional trailing `model?: string`, threaded from
  the request body. Env is the default, the UI dropdown overrides it per request.
* **The model list is an allowlist, not a filter.** Google lists ~44
  `generateContent` models on a fresh key, most of which can only fail here
  (`nano-banana-*` is image-only; the whole `gemini-2.5` family 404s "no longer
  available to new users"; several flagships 503 under demand). A blocklist
  regex leaked the next unanticipated id — an allowlist cannot.
* **Provider metadata must round-trip.** `ToolCall` carries an opaque
  `provider_meta` bag. Gemini attaches `thought_signature` to `functionCall`
  parts and 400s the next turn if it is not echoed back verbatim. This is the
  seam's real lesson: provider contracts extend past the request.

---

## 3. What was added

### 3.1 Gemini provider (`backend/src/llm/gemini.ts`)

* `GeminiClient implements LLMClient` — `chat()`, `extract()`, `resolve()`,
  `listModels()`, same interface, same validate → retry → error-mapping
  philosophy as `OpenRouterClient`.
* `sanitizeSchemaForGemini()` — recursive schema stripper for `functionDeclarations`.
* `TESTED_MODELS` allowlist + live `GET /v1beta/models` intersection. Ordering
  puts the lite tier first because it answers reliably under load.
* `ToolCall.provider_meta` round-trip (`thought_signature`), accepting both
  camelCase and snake_case from the wire.
* Empty-completion detection → `LLMProviderError`, never a silent empty reply.

### 3.2 Model selection in the UI

* `GET /api/models` → the allowlisted list.
* `<select>` on both the Chat and Diary pages, persisted in
  `localStorage["jarvis.selectedModel"]`, with a "Default model" empty option.
* `POST /api/chat`, `POST /api/analyse`, `POST /api/diary/entries` accept an
  optional `model` and thread it into **every** LLM call in that request,
  including the chat tool-loop follow-up and the analyse gather/propose/judge
  trio. Missing this was ledger #5 — the user picked 3.5 and the error named a
  2.5, because analyse silently ran on the env default.

### 3.3 Live verification gate (`scripts/test-gemini-live.ts`)

The second quality gate, run beside `bun test` and automatically by
`./scripts/dev.sh`:

| Leg | What only a real call can prove |
|---|---|
| model listing | `GEMINI_MODEL` is in the live list; dead ids are caught before a chat runs |
| **tool round trip** | `chat()` with all 8 tools → real `functionCall` → the result **echoed back as a second `chat()`**. This second turn is the only place ledger #6 lived; a single-shot probe cannot see it |
| extraction | A real structured extraction with the production prompt, incl. no `speaker`/`author`/`narrator` node leakage |
| running app | `POST /api/chat` + `POST /api/analyse` against a live backend — never a 502, never a literal `"null"` |

Exit codes are meaningful, not decorative: `0` pass · `1` real defect ·
`2` provider weather (429/503 — rerun later) · `3` skipped (no key / no server).
It never executes graph writes, so it cannot pollute real data.

### 3.4 Ops tooling (`scripts/`)

| Script | Purpose |
|---|---|
| `inspect-graph.ts` | Dump Neo4j nodes/edges with counts — "what is actually in there?" |
| `wipe-local.ts` | Clear conversations, extractions, resolutions, diary, logs |
| `probe-gemini-tools.ts` | One-shot live tool-schema probe (superseded by the live gate's leg 2, kept because it isolates schema rejection from loop logic) |

### 3.5 Error ledger (`docs/error-ledger.md`)

Every execution failure ships with (a) a root-cause row and (b) a guarding
test. Entries 1–7 to date. The rule that made it work: **a row is added before
the fix lands**, so a fix without a diagnosis is visible in review.

---

## 4. Provider-portability rules (for the next provider)

1. Only `llm/<provider>.ts` may know a provider endpoint, model id, or error shape.
2. Tool schemas are declared once, in provider-neutral JSON Schema, and
   sanitized per provider. Never fork a `TOOL_DEF` per provider.
3. Anything the provider attaches to a response that must be echoed back is a
   round-trip concern → `ToolCall.provider_meta`, spread onto the outgoing part.
4. Transport retries are bounded; validation retries are separate and also bounded.
5. A provider that needs a "list models" endpoint gets an **allowlist**
   intersected with the live listing — never a raw pass-through, never a regex
   blocklist.

---

## 5. Quality gates

- [x] `bun test` green (236 pass / 0 fail).
- [x] `bun scripts/test-gemini-live.ts` green end-to-end, all four legs, exit 0.
- [x] `/api/models` returns only allowlisted ids: `gemini-3.5-flash-lite`,
      `gemini-flash-lite-latest`, `gemini-3.5-flash`, `gemini-3.6-flash`.
- [x] Selecting any offered model in the UI actually uses it for every LLM call
      in the request (ledger #5 regression test).
- [x] Both containers healthy after `docker compose up -d --build`.
- [x] Ledger rows 1–7 each name a root cause and a guarding test.

---

## 6. Explicitly out of scope

* No streaming, no token accounting, no cost tracking.
* No provider failover mid-request (the live gate *reports* weather; it does not
  silently retry on a different model).
* No embeddings or vector search.
* No per-user model preferences — still `localStorage`, single user by design.

## 7. One Phase 4 deviation, recorded here so it isn't lost

Phase 4 §8 specified an **exec-failure judge-fix loop**: on a tool failure at
step *k*, send `{ failed_step, error, applied_ids }` back to the judge, take a
minimal fix for the remaining steps, re-check it, and continue automatically
(bounded at 2 fixes).

What is built is deliberately simpler: `/api/propose/execute` applies steps in
`seq` order, **keeps whatever applied, stops at the first failure, and reports
`{ ok, applied, errors }`**. No judge call on the exec path.

The reasoning: a judge-fix loop on the write path needs its own ledger, its own
failure reporting, and its own "was the fix actually right?" test — and the
failure modes it would paper over (a bad `node_id`, a name that no longer
resolves) are *better* surfaced to the user than silently repaired. The cost is
that a proposal that fails at step 4 of 6 leaves the user to re-trigger.

If this is ever built, it belongs in a future phase with its own spec and its
own ledger rows.
