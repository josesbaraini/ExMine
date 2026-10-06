 Jarvis — Phase 1 Spec: AI Chat with Save-and-Extract
 
Status: ready for implementation
Scope: **this phase only**. Do not build diary capture, SQL storage, graph layer, or Excalidraw integration here — those are later phases with their own specs.
 
> **Revision note:** §6 (Extraction Contract) was revised after Phase 1/2 shipped, during Phase 3+4 design. `entities[]` + `action_items[]` is replaced with separate `nodes[]` / `edges[]` lists, and `action_items` is removed from extraction entirely (deferred to a future tool-integration phase). See [spec-phase-3.md](./spec-phase-3.md) for why.

> **Where this ended up:** this phase is intact except for the extraction contract above. The write path built on it is described in [spec-phase-3.md](./spec-phase-3.md) → [3.5](./spec-phase-3.5.md) → [3.6](./spec-phase-3.6.md) → [4](./spec-phase-4.md) → [4.5](./spec-phase-4.5.md).
 
---
 
## 1. Goal
 
Prove out one thing: **can we reliably turn a free-form chat conversation into structured, useful data?**
 
Definition of done for this phase:
1. User can have a chat conversation with an AI in a browser.
2. On demand (button) or at end of conversation, the system runs an "extraction" pass and writes a structured JSON file to disk.
3. Everything ships as a container that builds and runs cleanly on the target host (see §2).
4. The extraction is inspected manually and judged "good enough to be useful" — this is a qualitative gate, see §7.
 
No database. No graph. No auth. Single user.
 
---
 
## 2. Stack & Target Environment
 
| Layer | Choice | Why |
|---|---|---|
| Backend | Bun + Elysia (TypeScript) | Fast, single runtime for server + tests, built-in TypeBox schema validation fits the strict extraction contract in §5 |
| Frontend | React (Vite, no meta-framework) | Minimal React, no build complexity beyond Vite defaults |
| LLM access | OpenRouter, via an internal abstraction (see §6) | Single API key/endpoint today; swappable later without touching chat/extraction code |
| Storage | Flat JSON files on disk (`./data/conversations/*.json`, `./data/extractions/*.json`) | This phase is about extraction quality, not persistence architecture |
| Packaging | Docker (single image, see §3) | Required deliverable — this phase isn't "done" until it's containerized |
| Host | Linux (Fedora 44 KDE) — Docker runs on this machine, not inside anything else | Affects file permissions on bind mounts, line endings, and means no Windows-path assumptions anywhere in code or scripts |
 
The backend framework choice is not sacred, but Bun + Elysia is now the pick — no need to revisit unless it hits a wall. The hard requirement regardless of implementation: **it must satisfy §5 (API contract) and §6 (LLM abstraction) exactly**, so later phases can be built against those contracts.
 
---
 
## 3. Docker Requirements
 
This phase's "done" includes a working container, not just passing tests locally.
 
**Image:** single multi-stage Dockerfile:
- Stage 1 (`build`): `oven/bun` base, install deps, build the Vite frontend (`bun run build` in `frontend/`), install/build backend.
- Stage 2 (`runtime`): slim `oven/bun` base, copy backend source + built frontend `dist/` from stage 1. Elysia serves the API under `/api/*` and the built frontend as static files under `/` — **one container, one process**, no separate nginx service for this phase.
 
**docker-compose.yml** (dev + "run it for real" convenience):
- Single service, built from the Dockerfile above.
- Port mapping, e.g. `3000:3000`.
- Bind mount `./data:/app/data` so extraction/conversation JSON survives container restarts and is inspectable from the host.
- `env_file: .env` for `OPENROUTER_API_KEY` / `OPENROUTER_MODEL`.
 
**Linux host gotcha to handle explicitly** (this is a real footgun on Fedora/any Linux Docker host, not optional polish):
- If the container process runs as root (Docker default) and writes into the `./data` bind mount, the files come out root-owned on the host, which then blocks the host user from touching them without `sudo`.
- Fix: set a non-root `USER` in the Dockerfile, or accept `UID`/`GID` as build args / compose environment and `chown` the data dir at container start, matching the host user's UID. Pick either approach, but **do not ship a container that writes root-owned files into a host bind mount** — that's a fail on the Docker quality gate below, not a nitpick.
 
**Health check:**
- Add `GET /api/health` → `{ "status": "ok" }`, used both by a Docker `HEALTHCHECK` instruction and by the smoke test in §7.
 
---
 
## 4. Architecture / Data Flow
 
```
[React chat UI] --HTTP--> [Elysia backend] --HTTP--> [OpenRouter] --> (any model)
        |                        |
        |                        v
        |                 [LLMClient abstraction]
        |                        |
        v                        v
  (renders replies)      writes conversation.json
                          on "extract" call:
                          LLMClient.extract() --> writes extraction.json
```
 
Two independent concerns inside the backend, kept in separate modules:
- **Chat concern**: hold conversation state, send/receive messages.
- **Extraction concern**: takes a transcript (list of messages) in, returns structured JSON out. Must not care where the transcript came from — this is what lets Phase 2 (diary) reuse it against non-chat text.
 
---
 
## 5. API Contract
 
REST, JSON in/out. No auth (single user, runs on the host or LAN, not exposed publicly).
 
### `GET /api/health`
`{ "status": "ok" }` — used by Docker healthcheck and smoke test.
 
### `POST /api/chat`
Send a message, get the assistant's reply. Backend holds conversation history server-side keyed by `conversation_id` (in-memory is fine for this phase; not persisted until saved).
 
**Request:**
```json
{
  "conversation_id": "uuid-or-null-to-start-new",
  "message": "string"
}
```
 
**Response:**
```json
{
  "conversation_id": "uuid",
  "reply": "string",
  "messages": [
    { "role": "user|assistant", "content": "string", "timestamp": "ISO8601" }
  ]
}
```
 
### `POST /api/conversations/:id/extract`
Runs extraction against the full transcript so far. Writes both the transcript and the extraction to disk. Calling twice overwrites the extraction file, doesn't duplicate.
 
**Response:**
```json
{
  "conversation_id": "uuid",
  "extraction": { /* see §6 schema */ },
  "saved_to": {
    "conversation_file": "./data/conversations/{id}.json",
    "extraction_file": "./data/extractions/{id}.json"
  }
}
```
 
### `GET /api/conversations/:id`
Fetch a saved conversation + its extraction (if it exists). Used for a bare "review past extractions" list — no styling requirement.
 
### Error contract (applies to all endpoints)
```json
{ "error": { "code": "string", "message": "string" } }
```
HTTP status codes: 400 (bad input), 404 (unknown conversation_id), 502 (LLM provider failure), 500 (unexpected). Every LLM call failure must surface a 502 with the provider's error message attached, not a generic 500.
 
---
 
## 6. Extraction Contract
 
This is the core deliverable of Phase 1.
 
```
extract(transcript: Message[]) -> ExtractionResult
```
 
**Output schema:**
```json
{
  "conversation_id": "uuid",
  "extracted_at": "ISO8601",
  "summary": "string, 1-3 sentences",
  "tags": ["string"],
  "mood_or_tone": "string or null",
  "nodes": [
    {
      "name": "string",
      "category": "string",
      "confidence": 0.0,
      "tags": ["string"]
    }
  ],
  "edges": [
    {
      "relation": "string",
      "from": "string",
      "to": "string",
      "confidence": 0.0,
      "attributes": {}
    }
  ],
  "raw_source_ref": "path to the saved conversation.json"
}
```
 
Rules:
- Storage-agnostic on purpose — extraction code has zero imports from any future storage layer. `extract()` reports what it saw in the text; it does not know about, query, or write to any graph.
- `nodes[].category` is an **open string**, not a closed enum — no coercion-to-`other` logic here. Reconciling categories against a controlled vocabulary (fuzzy-match-and-reuse vs. mint-new) is the graph layer's (Phase 3+4) job, downstream of extraction.
- `nodes[].tags` are per-node search hooks (separate from the message-level `tags[]`) — they exist to help the downstream graph layer search for context/candidates, extraction itself does nothing with them.
- `edges[].relation` is likewise an open string (e.g. `"needs_to_check"`, `"is_sister_of"`) — canonicalized downstream, not here.
- `edges[].from` / `edges[].to` reference `nodes[].name` values from the *same* extraction. `extract()` does not resolve these against any existing store — that resolution is downstream.
- `edges[].attributes` is a free-form JSON object for contextual state the model picks up (e.g. `{"status": "done"}`). Not schema-constrained beyond being valid JSON.
- **No `action_items`.** Anything that would trigger a real-world side effect (calendar entry, alarm, a search-and-notify job) is out of scope for extraction — that's a future tool-integration phase with its own contract and its own job-queue design, not part of this schema. A plain to-do mentioned in text (no side effect, e.g. "check my hiking boots") is just a `node` with a fitting `category`, not an action item.
- `confidence`: if the model doesn't naturally produce one, hardcode `1.0` for v1 — flagged as a known simplification, not faked precision.
- Validate the model's JSON output against a schema (Elysia's built-in TypeBox, or Zod if that's a better fit for the harness) before writing to disk. On validation failure, retry once with a stricter "return only valid JSON matching this schema" instruction; on second failure, return a 502-style error rather than writing malformed data.
 
---
 
## 7. LLM Provider Abstraction
 
```typescript
interface LLMClient {
  chat(messages: Message[]): Promise<string>;
  extract(transcript: Message[]): Promise<ExtractionResult>;
}
 
class OpenRouterClient implements LLMClient {
  // concrete implementation using OpenRouter's API
}
```
 
Requirements:
- Model name and API key come from environment variables (`OPENROUTER_API_KEY`, `OPENROUTER_MODEL`), never hardcoded.
- Nothing outside this module imports anything OpenRouter-specific. Chat and extraction code call `.chat()` / `.extract()` and know nothing else.
- This is the seam for later swapping providers — a future `AnthropicClient` or `LocalModelClient` implementing the same interface should be a drop-in. Keep it a single constructor choice, not a plugin registry — one user doesn't need that.
 
---
 
## 8. Test Plan
 
### Unit tests (`bun test`)
- `LLMClient` interface tested against a **fake/mock implementation**, not the real API.
- Extraction schema validation: malformed model output (missing fields, wrong types, an edge whose `from`/`to` isn't a string) → coerced or rejected per §6 rules, never crashes.
 
### Integration tests (real OpenRouter call, run manually/on-demand — costs tokens, not part of default `bun test` run)
- Full round trip: send 2-3 turns of a realistic conversation → call extract → assert the JSON matches schema and contains at least one non-empty node/tag.
- Error path: invalid API key → confirm 502 with provider error message surfaced.
 
### Container smoke test (required — this is the Docker quality gate)
A script (`./scripts/smoke-test.sh` or similar) that:
1. `docker compose up -d --build`
2. Polls `GET /api/health` until `200 ok` or timeout
3. Checks that a file written into `./data` during a test extraction is owned by the host user, not root (catches the permissions gotcha in §3)
4. `docker compose down`
 
The harness is not "done" until this script passes, in addition to `bun test`.
 
### Manual QA checklist (the qualitative gate from §1 — human judgment, can't be automated by the harness)
- [ ] Have 3 real conversations of different kinds (planning something, venting/journaling-style, technical Q&A).
- [ ] Run extraction on each.
- [ ] For each, answer: *would I actually find this extraction useful if I saw it in six months with no memory of the conversation?* If "no" for 2+ of the 3, the schema or prompt needs revision before moving to Phase 2 — this is the actual exit criterion for Phase 1, not just "the code runs."
 
---
 
## 9. Quality Gates
 
- [ ] All endpoints in §5 implemented and match request/response shapes exactly (contract tests, not just "it works when I click it").
- [ ] No LLM-provider-specific code outside `OpenRouterClient`.
- [ ] No extraction-specific code assumes the transcript came from a chat UI — this is what lets Phase 2 reuse it.
- [ ] Every LLM call has a timeout and a surfaced error path; no unhandled exceptions bubble to a raw stack trace in the HTTP response.
- [ ] `.env.example` committed with the two required variables, real `.env` gitignored.
- [ ] `docker build` succeeds; `docker compose up` serves the app end-to-end (frontend + API from one container).
- [ ] Bind-mounted `./data` files are host-user-owned, not root-owned (see §3).
- [ ] `bun test` passes.
- [ ] Smoke test script (§8) passes.
- [ ] README with: how to run in dev (without Docker), how to build/run the container, how to run tests + smoke test, how to run the manual QA checklist.
- [ ] Manual QA checklist in §8 actually run and its answers recorded, not skipped.
 
---
 
## 10. Explicitly Out of Scope for This Phase
 
- Diary page (Phase 2)
- Any SQL/database persistence — superseded; storage is now a real graph DB (Phase 3+4 combined)
- Graph browsing/linking, node/edge resolution against existing data (Phase 3+4)
- Tool-integration actions (calendar, alarms, search-and-notify) — a future phase, not yet scoped
- Excalidraw (later phase)
- Auth, multi-user, remote/public deployment, mobile, orchestration beyond a single `docker-compose.yml` (no k8s, no reverse proxy) — not designed against at all yet
 
