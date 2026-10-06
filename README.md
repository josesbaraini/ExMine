# Jarvis — a single-user knowledge agent

A chat + diary app that turns what you say into **durable, queryable graph
data**, with a real system prompt, tool use, and a propose → judge → confirm →
execute pipeline that never writes to your graph without asking first.

Everything here was built phase by phase from a spec. The specs live in
[`specs/`](./specs/) — read them only when you want the *why* behind a decision;
this README is the *what*.

---

## How the project evolved

| Phase | What it added | Spec |
|---|---|---|
| **1** | Chat + an on-demand **extraction** pass that turns a conversation into structured JSON on disk. Proved the core question: *can free-form chat become useful structured data?* | [`specs/spec-phase-1.md`](./specs/spec-phase-1.md) |
| **2** | A **diary** surface. Same extraction function, unchanged, pointed at freeform text. Proved the pipeline generalizes beyond chat. | [`specs/spec-phase-2.md`](./specs/spec-phase-2.md) |
| **3** | The **graph layer**: Neo4j as a compose service, deterministic context search → an LLM *resolve* pass → a per-resolution **audit log** → a deterministic query compiler that writes to the graph. Ambiguity is flagged (`pending_review`), never silently guessed. | [`specs/spec-phase-3.md`](./specs/spec-phase-3.md) |
| **3.5** | The **read path**: native tool-calling, so an ordinary chat turn can decide on its own to call `search_graph` and ground its answer in the graph. | [`specs/spec-phase-3.5.md`](./specs/spec-phase-3.5.md) |
| **3.6** | **Node deletion**: `delete_node(node_id)` with an audit snapshot, so a hallucinated entity or a bad merge is recoverable. | [`specs/spec-phase-3.6.md`](./specs/spec-phase-3.6.md) |
| **4** | **Agentic writes**: a real system prompt, six writer tools, and `analyse → propose → judge → user confirm → execute in sequence`. Writes require an explicit ask *and* whole-proposal confirmation; `search_graph` stays free. Max 3 fixes × 3 rounds, then an honest HTTP 200 failure with a log file and nothing written. | [`specs/spec-phase-4.md`](./specs/spec-phase-4.md) |
| **4.5** | **Provider portability + live verification**: a second provider (Google AI Studio) behind the same `LLMClient` seam, a model selector in the UI, and a **live gate** that replays real request sequences — because every provider-shaped failure we hit was invisible to fake-fetch tests. | [`specs/spec-phase-4.5.md`](./specs/spec-phase-4.5.md) |

The Phase 4 → 4.5 split is deliberate: Phase 4's contract is exactly as
specified, and 4.5 is strictly the work that wasn't in any spec. It also
records the one place Phase 4 was built *simpler* than specified (the
exec-failure judge-fix loop — see 4.5 §7).

**Supporting docs**

| Doc | What it holds |
|---|---|
| [`docs/error-ledger.md`](./docs/error-ledger.md) | The error ledger. Every execution failure that reached the user, with root cause, fix, and the test that guards it. Entries 1–7. |
| [`docs/archive/AUDIT-2026-09-22.md`](./docs/archive/AUDIT-2026-09-22.md) | A pre-Phase-1 bug audit, kept for history. Superseded by the ledger. |

---

## Layout

```
specs/      one markdown spec per phase — the design record, read on demand
docs/       error ledger + archived audits
backend/    Bun + Elysia (TypeScript) — REST API, LLM clients, validation,
            diary store, graph pipeline, proposal/judge loop
frontend/   React + Vite — chat + diary UI (built once, served by the backend)
data/       conversations/, extractions/, diary-entries.jsonl,
            resolutions/ (audit log), proposal-failures/, logs/operations.jsonl,
            neo4j/{data,logs}/
scripts/    dev.sh, smoke-test.sh, test-gemini-live.ts, inspect-graph.ts,
            wipe-local.ts, and the live probes
Dockerfile / docker-compose.yml — backend container + Neo4j service
```

### Graph modules (`backend/src/graph/`)

Independent pieces, the same seam-driven instinct as Phase 1's
chat/extraction split:

- `client.ts` — **GraphClient**: the ONLY module allowed to know the Neo4j
  driver exists. Connect (with bounded retry), run parameterized Cypher, return
  plain-JS rows. No business logic.
- `search.ts` — **Context search**: pure code, fixed query shapes, only
  parameters change. Scores are deterministic (name match + tag overlap), never
  a decision on their own (spec §6).
- `resolver.ts` — **Resolver**: calls `LLMClient.resolve()` (LLM call #2),
  validates it, and persists it as the audit entry **before anything reaches
  the graph**.
- `compiler.ts` — **Query compiler**: the determinism boundary. Reads ONLY a
  `ResolutionResult` — zero imports from extraction/LLM modules (spec §8/§10) —
  and turns it into MERGE/SET mutations plus a templated (non-LLM) summary.
- `searchGraphTool.ts`, `deleteNodeTool.ts`, `mutationTools.ts` — the **tool**
  layer: `TOOL_DEF` + `coerceArgs` + `executeXTool`, each in its own module next
  to the graph code. Never inside `LLMClient`, never inside a route handler.
- `propose.ts` — **proposer → judge loop**: gathers evidence, generates a
  proposal, runs a deterministic per-step check, judges it, retries 3×3, and
  writes a failure log rather than lying when it can't converge.

## What it does

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | `{"status":"ok"}` — Docker healthcheck + smoke test |
| `GET /api/models` | The model ids offered by the active provider (a tested allowlist for Gemini) |
| `POST /api/chat` | Send a message, get the reply. History held in-memory per `conversation_id` |
| `POST /api/analyse` | **The write trigger.** `{ conversation_id }` or `{ text }` → gather evidence → propose → judge → returns a judge-approved `proposal` (or HTTP 200 with `proposal: null` + a reason + `log_file`). Writes nothing. |
| `POST /api/propose/execute` | Applies a **confirmed** proposal, one step = one tool call, in `seq` order. Keeps applied steps on failure and reports `{ ok, applied, errors }`. |
| `GET /api/conversations/:id` | Fetch a saved conversation + its extraction |
| `POST /api/diary/entries` | Save a freeform entry **and** extract from it (one action). → `201 { entry }` |
| `GET /api/diary/entries` | All entries, chronological (oldest first) |
| `GET /api/diary/entries/:id` | One entry, or 404 |
| `POST /api/graph/search` | Read-only search for tool calls + debugging: `{ tags?, name_query? }` (at least one) → `CandidateSet` |
| `POST /api/graph/delete-node` | Thin debug route for `delete_node` outside chat (Phase 3.6) |
| `GET /api/graph/ready` | Graph readiness for ops/smoke test: `{status:"ok", graph:"ready\|connecting\|unconfigured"}` |

`POST /api/chat`, `/api/analyse` and `/api/diary/entries` all accept an optional
`model` that overrides the env default for **every** LLM call in that request.

All failures return `{"error":{"code":...,"message":...}}` — 400 bad input,
404 unknown id, **502 LLM provider failure with the provider's own message**
(or 502 `GRAPH_UNAVAILABLE` with the underlying Neo4j error for
`/api/graph/link` and `/api/graph/search`), 500 unexpected.

### The write pipeline

Phase 4 replaced fire-and-forget `extract → link` with an explicit chain, so a
graph write is always something you saw and agreed to:

```
you ask to save  →  POST /api/analyse
                     gather: chat history + searchContext evidence
                     propose  → deterministic per-step check  →  judge
                     reject → reason → revise   (3 fixes per round, 3 rounds)
                     gives up → log file + honest HTTP 200, nothing written
                  →  you see the steps and press Accept & Execute / Discard
                  →  POST /api/propose/execute
                     one step = one tool call, in seq order
                     a failure keeps what applied and stops, reporting which
```

`search_graph` is exempt — reading the graph never needs confirmation. The six
writer tools (`create_node`, `update_node`, `merge_nodes`, `delete_node`,
`create_edge`, `update_edge`, `delete_edge`) only run after your explicit ask
*and* a confirmed proposal. There is no super-tool and no batch step: one step
is one tool call, with its args frozen at proposal time.

### Legacy: `POST /api/graph/link`

Kept in code, not exposed — see [Legacy code](#legacy-code). It takes an
already-produced `ExtractionResult` (spec §5) and runs the Phase 3 pipeline:

1. **Context search** (deterministic, NO LLM — exact/fuzzy name match, tag
   overlap, 1-hop neighborhood only).
2. **`LLMClient.resolve()`** (LLM call #2) — decides per node/edge:
   `create` / `merge` / `update` / `pending_review`, retrying once on
   malformed output per §7.
3. **Audit persist** — the full resolution is written append-only to
   `./data/resolutions/{resolution_id}.json`. **Nothing reaches the graph
   without this entry** (§7/§10 invariant).
4. **Query compiler** — deterministic MERGE writes + templated summary
   (e.g. *“Added Ana as a new person node. Linked hiking boots →
   needs_to_check → José (undone).”*).

`pending_review` items are logged but **never written** (spec §11 — no special
handling, never a silent guess).

## Requirements

- [Bun](https://bun.sh) ≥ 1.2 (only runtime — no node needed)
- An LLM key — **either** [OpenRouter](https://openrouter.ai) **or**
  [Google AI Studio](https://aistudio.google.com/apikey). Both sit behind the
  same `LLMClient` interface; pick one with `LLM_PROVIDER`.
- Docker with Compose v2 (Fedora: `sudo dnf install docker-compose-plugin`)
- The `neo4j:5-community` image (auto-pulled by compose)

---

## Running in dev (no Docker)

```bash
cp .env.example .env      # add your LLM key (OpenRouter or Google AI Studio)
bun install --cwd backend
bun install --cwd frontend
./scripts/dev.sh          # backend :3000, frontend :5173
```

Open http://localhost:5173 — Vite proxies `/api` to the backend. The header
has **Chat** and **Diary** tabs; both have an **Analyse & Propose** action and
a model dropdown.

`./scripts/dev.sh` also runs the live provider gate (`bun run test:live`) before
starting Vite — it's the check that catches real API errors, which `bun test`
structurally cannot.

Or run the pieces separately: `npm run dev:backend` / `dev:frontend`.

In plain dev the graph route 502s ("Graph layer is not configured on this
server") unless you point `NEO4J_URI` at a running Neo4j — chat/extract/diary
keep working regardless.

## Building & running the container (the whole stack, one command)

```bash
cp .env.example .env      # add your LLM key (OpenRouter or Google AI Studio)
docker compose up -d --build
# open http://localhost:3000
```

`docker compose up` brings up **backend + Neo4j together** (spec §3) — the
backend reaches Neo4j at `bolt://neo4j:7687` (service name as hostname, not
localhost). Neo4j Browser is at http://localhost:7474 (default credentials are
`NEO4J_AUTH` from `.env`, default `neo4j/jarvis-dev-password`).

**No exported env vars are needed** — `USER_ID`/`GROUP_ID` (and `NEO4J_AUTH`)
are read from `.env`, so plain `docker compose up` behaves identically to the
smoke test. If your UID isn't 1000, set `USER_ID`/`GROUP_ID` in `.env` to
`id -u` / `id -g`.

**How to know it's actually working** — both services self-report health:

```bash
docker compose ps                 # both containers show "(healthy)"
curl http://localhost:3000/api/graph/ready   # {"status":"ok","graph":"ready"}
curl http://localhost:3000/api/health        # {"status":"ok"}
```

- Neo4j's healthcheck is a real Bolt round-trip (`cypher-shell ... RETURN 1`)
  using the same `NEO4J_AUTH` the backend uses — "healthy" means queryable,
  not merely booted.
- jarvis starts **only after** Neo4j is healthy (`depends_on:
  condition: service_healthy`), so `/api/graph/ready` answers `"ready"` right
  away instead of racing Neo4j's startup (the old 502-until-ready window).
- Ports are published on the host: `3000` (app/API), `7474` (Neo4j Browser),
  `7687` (Bolt). `docker compose port <service> <port>` confirms them.

`./data` is bind-mounted so conversations/extractions/diary entries/resolutions
survive restarts, and `./data/neo4j/{data,logs}` are Neo4j's own bind mounts.

**Permissions (the §3 gotchas):**

1. **The `./data/neo4j/{data,logs}` folders must exist on the host before the
   first `docker compose up`** — the Neo4j image fails to start otherwise.
   They're committed (`.gitkeep`) and `scripts/smoke-test.sh` re-checks them.
2. The container process runs as a non-root user built from `USER_ID`/`GROUP_ID`
   (default 1000:1000, passed automatically by the smoke test). The `neo4j`
   service runs with `user: "${USER_ID:-1000}:${GROUP_ID:-1000}"` too — so the
   bind-mounted Neo4j data/logs stay **host-user-owned**, not root-owned
   (spec §3/§10). If your UID differs, build with
   `docker compose build --build-arg USER_ID=$(id -u) --build-arg GROUP_ID=$(id -g)`
   (and the neo4j `user:` follows `$USER_ID` automatically).
3. `depends_on` only starts the Neo4j *container* — the backend's GraphClient
   has its own connect-with-retry, and `/api/graph/link` 502s until Neo4j is
   actually queryable.
4. **SELinux hosts (Fedora): the bind mounts use `:z`, not `:Z`.** `:Z` labels a
   bind with a private per-container MCS category (`s0:cN,cN`) that changes
   whenever the container is recreated, and Docker does not re-label a source
   that already carries a container label — the stale categories then
   SELinux-deny every store write ("Permission denied" / "Could not append
   transaction to log"). `:z` uses the flat shared `s0` label, which survives
   any number of recreates. Harmless on non-SELinux hosts.

## Tests

```bash
bun test          # unit + contract tests (fake LLM + fake graph driver, no network, no tokens)
bun run test:live # LIVE provider gate — real requests, no fakes (needs GEMINISTUDIO_API_KEY)
bun run test:all  # both, in order
bun run typecheck
```

### The live gate: why there are two test suites

`bun test` proves our code paths *execute*. It can never produce a provider
error, because a fake fetch never validates anything. Every 4xx-class failure
that actually reached production lives on the other side of a real HTTP call:
Gemini's `additionalProperties` 400 (ledger #4), the `thought_signature` 400
(ledger #6), retired-model 404s (ledger #7). A fake cannot trip any of them.

`scripts/test-gemini-live.ts` replays the *exact* sequences the app makes,
through the real `GeminiClient`:

1. **model listing** — fails when `GEMINI_MODEL` is not in the live list, or
   the list is empty. Catches dead-model 404s before a chat ever runs.
2. **tool round trip** — `chat()` with all 8 tool defs → real `functionCall` →
   the tool result echoed back as a **second** `chat()` call, the way
   `/api/chat` does. This second turn is the only place the thought_signature
   bug lived; a single-shot probe cannot see it.
3. **extraction** — a real structured extraction with the production prompt,
   checked for `speaker`/`author`/`narrator` node leakage.
4. **running app** — `POST /api/chat` then `POST /api/analyse` against a live
   backend, asserting a usable reply and a judge-approved proposal or an honest
   HTTP 200 reason. Never a 502, never a literal `"null"`. Skips if no server.

Exit codes: `0` pass · `1` real defect · `2` provider weather (429/503, rerun
later) · `3` skipped (no key / no server). It runs automatically in
`./scripts/dev.sh` and never executes graph writes, so it won't pollute your
data.

Phase 1/2 files: `backend/test/routes.test.ts` (§5 contract),
`backend/test/diary.test.ts` (adapter, JSONL, diary routes),
`backend/test/openrouter.test.ts` + `validate.test.ts` (LLM client + extraction
schema).

**Phase 3 files:**
- `backend/test/graph-client.test.ts` — GraphClient against a **fake driver**:
  query/params pass-through, `Integer`/`Node`/`Relationship` unwrapping,
  error mapping (connectivity → `GraphUnavailableError`,
  statement rejection → `GraphQueryError`), bounded retry.
- `backend/test/search.test.ts` — context search with a mocked graph:
  deterministic scoring, fixed query shapes, 1-hop neighborhood, shape.
- `backend/test/compiler.test.ts` — **the most valuable test in the phase**
  (spec §9): a fixed `ResolutionResult` fixture produces exactly the expected
  mutation calls + the templated summary. No LLM, no DB. Also asserts the
  §10 module-boundary gate (compiler imports nothing from extraction/LLM).
- `backend/test/resolve.test.ts` — `parseResolution` rules (strict on
  write-determining fields, lenient on enrichment) and `OpenRouterClient.resolve`
  retry-once via a fake fetch.
- `backend/test/graph-link.test.ts` — the `/api/graph/link` contract: 200 with
  `{resolution, summary, saved_to}`, 400 malformed, 502 on LLM resolve failure
  and on Neo4j failure (underlying error surfaced), and the **audit-before-write**
  invariant (a write failure still leaves the resolution log entry).

**Phase 4 / 4.5 files:**
- `backend/test/propose.test.ts` — the propose → judge loop: approval first try,
  reject → fix → approve, model override threading into every LLM call, extract
  failure degrading to a stub, wrong step schema rejected, 9-rejection exhaustion
  → log file + `ok:false`.
- `backend/test/mutation-tools.test.ts` — every writer tool's coercion (accept and
  reject), exact Cypher shape, name→ID resolution for `create_edge`, ambiguity
  failing loudly instead of guessing.
- `backend/test/analyse-route.test.ts` — `POST /api/analyse`: success, 404 unknown
  id, 502 graph unconfigured, and the exhausted-analysis failure payload.
- `backend/test/gemini.test.ts` — schema sanitization (captures the real fetch
  body), `thought_signature` round-trip across two turns, provider 400 surfaced
  verbatim, model allowlist.
- `backend/test/frontend-serving.test.ts` — the static catch-all must never
  swallow an `/api/*` route.

Integration tests against the real provider **and** real Neo4j (via
docker-compose) are manual and token-costing — the live gate covers the provider
side, and the Phase 3.5 graph Q&A loop has a one-command harness:

```bash
./scripts/test-graph-chat.sh   # rebuild → reset+seed graph → no-context chat Q&A must read the DB
./scripts/graph-seed.sh        # clear + seed the fixture graph (Ana → is_hiring → Jev, …)
bun scripts/probe-tool-call.ts # direct OpenRouter probe: does the model call search_graph?
bun scripts/inspect-graph.ts   # what is actually in Neo4j right now
bun scripts/wipe-local.ts      # clear conversations, extractions, resolutions, diary, logs
```

`test-graph-chat.sh` is the check that catches the "the model says 'I don't
know'" regression: fresh `/api/chat` turns with **no history** whose only
answerable source is the graph. It covers BOTH read shapes that broke in web-app
QA — tag-overlap questions ("Who is the person Ana is hiring?") and **name-based
questions** ("Who is Ana?", "Tell me about Jev."), where the model typically
sends the name as a tag (`{tags:["Ana"]}`) and the old search returned nothing,
so the assistant claimed the graph had no notes about Ana while Ana was right
there. Each question passes only if the reply is grounded in what the graph
returned and never shrugs "I couldn't find...". It resets the database first, so
it is repeatable.

## Container smoke test (Docker quality gate)

```bash
./scripts/smoke-test.sh
```

1. Ensures `./data/neo4j/{data,logs}` exist and are host-user-owned (§3)
2. `docker compose up -d --build` — whole stack, one command, with no helper
   env vars (uid comes from `.env`, exactly like plain `up`)
3. Asserts the host ports are **published** (`docker compose port` for
   `jarvis:3000`, `neo4j:7687`, `neo4j:7474`) — catches "nothing to test on"
   regressions
4. Polls `/api/health` **and** `/api/graph/ready` (proves the backend reached
   Neo4j — `depends_on` alone is not readiness)
5. (with a key in `.env`) real chat + extract, writes **3 diary entries**,
   restarts the container, and verifies all 3 survived
6. Verifies every file **and dir** in `./data` — including Neo4j's own
   data/logs files — is **host-owned, not root-owned**
7. `docker compose down`

## Manual QA (Phase 1–4 exit criteria)

**Phase 1 (chat)** — run 3 real conversations of different kinds, extract
each, and ask: *“Would I find this extraction useful in six months, with no
memory of the conversation?”*

1. **Planning something** — e.g. “Plan a weekend trip to the coast.”
   - [ ] extraction useful? (yes/no) — notes:
2. **Venting / journaling-style** — e.g. “I’m overwhelmed by work…”
   - [ ] extraction useful? (yes/no) — notes:
3. **Technical Q&A** — e.g. “How do I write a retry loop in TypeScript?”
   - [ ] extraction useful? (yes/no) — notes:

**Phase 2 (diary)** — write 3 freeform diary entries through the UI (a short
bullet-y planning entry, a longer stream-of-consciousness entry, a factual
“what I did today” entry). For each:
- [ ] entry appears in the list with its extraction rendered (not raw JSON)
- [ ] restart the container; entries and extractions are still there
- [ ] extraction useful? (yes/no) — notes:

**Phase 3 (graph, real Neo4j + real LLM)** — run 2–3 real extractions
containing a genuinely ambiguous entity (e.g. two different “Ana”s in
different contexts), then:
- [ ] full round trip: extract → `/api/graph/link` → verify graph state with a
      direct Cypher read in Neo4j Browser (or `cypher-shell`)
- [ ] merge path: run the same entity twice with matching context → confirm no
      duplicate node, existing one updated
- [ ] ambiguous path: two candidates with close scores, no clear winner →
      confirm `pending_review`, never a silent guess
- [ ] read back `data/resolutions/*.json` for each — *would the `reason` field
      help you understand why six months from now?* If not, the resolve prompt
      needs revision (separate from this phase's structural build, per spec §9)
- [ ] confirm `./data/neo4j` files are host-user-owned after real Neo4j writes

**Phase 4 (proposal → judge → confirm → execute)** — the loop that matters most,
because it is the one that writes:

- [ ] chat “Ana hired Jev”, press **Analyse & Propose** → you see `human_text`
      plus an ordered step list *before* anything happens
- [ ] press **Discard** → confirm the graph is unchanged
- [ ] press **Accept & Execute** → confirm the steps applied 1:1, in order, with
      no extra writes; verify in Neo4j Browser
- [ ] delete case → confirm the proposal only contains a delete when the chat
      explicitly asked for one
- [ ] force a judge rejection → confirm the reason reaches you and a revision
      follows, rather than a silent write
- [ ] read `data/proposal-failures/*.json` after an exhausted analysis: the chat
      slice, the evidence, and every proposal with its rejection reason

## Environment

| Variable | Required | Default | Notes |
|---|---|---|---|
| `LLM_PROVIDER` | no | `openrouter` | `openrouter` or `gemini` — switches the client in `backend/src/index.ts` |
| `OPENROUTER_API_KEY` | if `LLM_PROVIDER=openrouter` | — | fails fast at startup if missing |
| `OPENROUTER_MODEL` | no | `openai/gpt-4o-mini` | any OpenRouter model id |
| `GEMINISTUDIO_API_KEY` | if `LLM_PROVIDER=gemini` | — | Google AI Studio key |
| `GEMINI_MODEL` | no | `gemini-3.5-flash-lite` | must be one of the allowlisted ids in `/api/models` |
| `PORT` | no | `3000` | backend / container port |
| `DATA_DIR` | no | `<repo>/data` | container sets `/app/data` |
| `NEO4J_AUTH` | no | `neo4j/jarvis-dev-password` | `user/password`, used by BOTH the compose `neo4j` service and the backend (min 8 chars) |
| `NEO4J_URI` | no | `bolt://neo4j:7687` | backend override (dev without compose) |
| `NEO4J_USER` / `NEO4J_PASSWORD` | no | parsed from `NEO4J_AUTH` | fallback pair if `NEO4J_AUTH` is absent |

`.env` is gitignored; `.env.example` is the committed template.

## Design notes & deliberate deviations

### Phase 4 / 4.5

- **One step = one tool call, and args are frozen at proposal time.** The
  executor may not re-plan or re-resolve a `node_id`. Anything else makes the
  thing you approved and the thing that ran diverge.
- **No rollback.** A mid-execution failure keeps what applied and stops,
  reporting applied vs failed. Rolling back would mean un-merging a node, which
  is harder to reason about than an honest partial result — the proposal log
  says exactly what happened.
- **Phase 4 §8's judge-fix-on-exec-failure loop was deliberately not built.**
  `/api/propose/execute` stops and reports instead. Rationale and the conditions
  for revisiting: [`specs/spec-phase-4.5.md`](./specs/spec-phase-4.5.md) §7.
- **`create_edge` takes names (`from`/`to`), not IDs.** Edges often link nodes
  created in the *same* proposal, whose `elementId`s don't exist yet at propose
  time — a forward reference an ID-only contract could never express. Names are
  resolved at execution; an ambiguous or missing name fails that step rather
  than guessing which one you meant.
- **Evidence gathering never kills the analyse pipeline.** `gatherEvidence()`
  wraps the extraction call so a failure degrades to a stub rather than 502ing —
  the proposer can still work from the chat alone, and the judge still guards
  quality.
- **A failed analysis returns HTTP 200, not 5xx.** "The agent couldn't converge"
  is a real outcome with a real answer (a log file and nothing written), not a
  transport failure. The frontend shows a message instead of a crash.
- **Gemini tool schemas are sanitized; OpenRouter's are forwarded verbatim.**
  Gemini's `functionDeclarations` is a *subset* of JSON Schema and rejects
  `additionalProperties`. One set of tool definitions, sanitized per provider —
  never forked per provider.
- **`ToolCall.provider_meta` exists for provider round-trip data.** Gemini
  attaches `thought_signature` to `functionCall` parts and 400s the next turn if
  it isn't echoed back verbatim. The provider seam is not just requests, it's
  whatever the provider insists you send back.
- **The model list is an allowlist, intersected with the live listing.** Google
  advertises ~44 `generateContent` models, most unusable here (`nano-banana-*`
  is image-only, the whole `gemini-2.5` family 404s for new keys, several
  flagships 503 under demand). A blocklist regex leaked the next id nobody had
  met yet; an allowlist can't. Extend it only with ids that pass the live gate.
- **Two test suites on purpose.** `bun test` uses fake fetches and proves our
  code paths *execute*. It cannot produce a provider error, because a fake never
  validates anything — all three real 4xx failures we hit were invisible to it.
  `bun run test:live` makes the actual calls.

### Phases 1–3

- **`extract()` is reused unchanged by Phase 2/3.** The only new code on the
  extraction path is `backend/src/diary/adapter.ts` (`diaryTextToTranscript`).
  The graph pipeline consumes the *output* of `extract()` — it never touches
  the transcript or the LLM's extraction call (spec §4).
- **Graph schema modeling** (documented in `compiler.ts`): categories and
  relation types are OPEN strings from the LLM, and open strings can't be
  Cypher labels/types (`"daily standup notes"` is not a valid label). So every
  node is labeled `Entity` with `category` as a property, and every relation is
  typed `RELATED` with the open string on a `relation` property. Node identity
  is Neo4j's `elementId` (the spec's “uuid” wording is approximate — the
  graph's own identity is what the resolver echoes back and the compiler
  matches on).
- **Audit-first ordering is the phase's invariant** (§7/§10): the resolution
  is persisted to `./data/resolutions/` (append-only, refuses overwrites)
  *before* any graph write. Nothing reaches the graph without a corresponding
  audit entry — a write failure 502s but never loses the record of the
  decision.
- **`pending_review` gets no special handling** (spec §11): logged, never
  written, never guessed. If real usage shows it firing often, that's the
  signal to revisit — not something to design against upfront.
- **`resolve()` validation is strict-end-to-end** (differs from extraction's
  drop-individually strategy, deliberately): one malformed resolution response
  is retried once with a stricter prompt, then a 502 — a silently dropped node
  from a resolution would be a graph write silently skipped.
- **The compiler is the determinism boundary** (§8/§10): it reads only a
  `ResolutionResult` and produces fixed MERGE/SET statements plus a templated
  summary. Upgrading the summary to LLM phrasing later is a cheap swap, not an
  architecture change.
- **`conversation_id` is a chat-era name, reused generically** (§5.2): for
  diary entries the route populates it with the entry's own `id` and
  `raw_source_ref` with the path to `diary-entries.jsonl`.
- **Diary storage is append-only JSONL** (`data/diary-entries.jsonl`, one
  `DiaryEntry` per line). Appends use O_APPEND; the POST flow persists the
  entry first, runs extraction, then updates that line in place (tmp + rename)
  — a crash or an LLM failure never loses the user's writing.
- **Status code on diary extraction failure is 201, not 502** (deviation from
  a literal reading of §6's “502 if extraction call fails”): the entry *was*
  persisted, and an error status would make the frontend's api() helper
  discard the body. The failure is surfaced via `entry.warning` (persisted on
  disk too). The `/api/graph/link` route, by contrast, genuinely 502s on LLM
  or Neo4j failure — nothing was written, and the audit log (if reached)
  keeps its record.
- **One backend process at a time.** `backend/src/index.ts` refuses to start
  when the port is already bound (split-brain guard from the Phase 1 audit).
- **GraphClient connects in the background with a bounded retry loop.** Dev
  mode without Neo4j must keep chat/extract/diary working — `/api/graph/link`
  just 502s until the graph is reachable (spec §3).

## Handoff notes for later phases

- **The exec-failure judge-fix loop** (Phase 4 §8) is the one specified behavior
  not built. Build it as its own phase with its own ledger rows — see
  [`spec-phase-4.5.md`](./specs/spec-phase-4.5.md) §7 for the reasoning.
- **`conversation_id` → generic `source_id`** rename; DiaryEntry's `extraction`
  becoming a reference rather than an inline copy.
- **Graph-browsing UI** beyond Neo4j Browser.
- **Embedding/vector similarity** if plain tag+name matching proves too coarse
  (spec §12).
- **Tuning extract/resolve/proposal prompts for precision** — a real, separate
  need flagged in spec §9's manual QA.
- **Diary extraction quality:** stream-of-consciousness entries may expose
  prompt gaps (length, lack of turns, mood/no-op nodes). Logged as future-work
  per §11 — do not patch retroactively.
- **Chat history is in-memory only.** `docker compose up` wipes it. Persistence
  was never in scope.
- **Operational debts:** a live Gemini key was pasted into chat at least once —
  rotate it if this machine or that conversation is ever shared. The folder is
  still not a git repo, so there is no history if something gets lost.

## Legacy code

Kept in the codebase, tagged `^legacy^` at the call site, deliberately **not**
exposed in the UI or the API table. Do not add callers — the Phase 4 pipeline
replaced them.

| Location | What | Why kept |
|---|---|---|
| `backend/src/app.ts:432` | `POST /api/conversations/:id/extract` | Phase 1/2 extraction endpoint; still the debug way to re-extract a stored conversation |
| `backend/src/app.ts:605` | `POST /api/graph/link` | Phase 3 graph pipeline, run directly against an existing extraction |

`extract()` itself is **not** legacy — it survives as the evidence-gathering
sub-call inside `/api/analyse`.

## Out of scope (explicitly, [spec-phase-2](./specs/spec-phase-2.md) §11 + [spec-phase-3](./specs/spec-phase-3.md) §12)

SQL/database storage beyond the graph, “Me” node wiring, Excalidraw,
graph-browsing UI in-app, tool-integration actions (`action_items`),
calendar/alarm/search-and-notify, per-day diary grouping, editing entries,
auth, multi-user, remote/public deployment. If implementation surfaces a
“we'll also need X later” item, it belongs in the handoff — not built now.