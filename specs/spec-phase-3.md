# Jarvis — Phase 3+4 Spec: Graph-Based Knowledge Layer

Status: ready for implementation
Scope: **this phase only**. Excalidraw integration, tool-integration actions (calendar/alarm/search+notify), and a graph-browsing UI beyond Neo4j Browser are later phases.

---

## 1. Goal

Turn the extraction JSON that Phase 1/2 already produce into durable, queryable graph data — replacing flat-file storage for nodes/edges — with every write auditable and every ambiguous case flagged, never silently guessed.

Definition of done for this phase:
1. Backend connects to Neo4j (running as a service inside the project's existing `docker-compose.yml`).
2. Given an `ExtractionResult` (from Phase 1's `extract()`, unchanged), the system runs a deterministic tag/name-based context search, resolves ambiguity via a second LLM call, compiles a deterministic write, and applies it to the graph.
3. Every resolution — whatever it decided — is logged to disk as an audit trail, alongside a templated (non-LLM) human-readable summary.
4. `docker compose up` brings up backend + Neo4j together, one command, matching Phase 1's "one command, real system" bar.

---

## 2. Stack Additions

| Layer | Choice | Why |
|---|---|---|
| Graph DB | Neo4j Community Edition, as a service in the existing `docker-compose.yml` | Real graph DB from day one — no SQL-simulate-then-migrate throwaway work |
| Backend ↔ DB | Official Neo4j JS/Bun driver, wrapped in a `GraphClient` abstraction | Same swappable-seam philosophy as Phase 1's `LLMClient` — nothing outside this module imports the Neo4j driver directly |
| LLM abstraction | `LLMClient` gains a third method: `resolve(extraction, candidates): Promise<ResolutionResult>` | The new resolution step; sits alongside `chat()` and `extract()` on the same interface |

---

## 3. Docker Requirements

- Neo4j is added as a **new service in the existing `docker-compose.yml`** — not a standalone `docker run`. Backend and Neo4j share the compose network.
- Backend reaches it at `bolt://neo4j:7687` (the service name as hostname) — not `localhost`.
- Bind mounts: `./data/neo4j/data` and `./data/neo4j/logs`. **These folders must exist on the host before the first `docker compose up`** — Neo4j's image fails to start otherwise. Same class of "document the Linux gotcha explicitly" as Phase 1 §3's root-owned-files issue, not optional polish.
- `depends_on` alone doesn't guarantee Neo4j is *ready* (only that its container has started) — `GraphClient` needs its own connect-with-retry on startup, since Neo4j takes longer to become queryable than the backend container takes to boot.
- `.env.example` gains Neo4j credentials (e.g. `NEO4J_AUTH=neo4j/<password>`), alongside the existing `OPENROUTER_API_KEY` / `OPENROUTER_MODEL`.

---

## 4. Architecture / Data Flow

```
[Phase 1/2 extract() — unchanged]
        |
        v
  ExtractionResult (nodes[], edges[], tags[])
        |
        v
[Context Search] --- deterministic, parameterized Cypher, NO LLM ---> Neo4j
        |
        v
  CandidateSet (per node/edge: matches + 1-hop neighborhood + score)
        |
        v
[LLMClient.resolve(extraction, candidates)]  <-- LLM call #2
        |
        v
  ResolutionResult (create / merge / pending_review, per node & edge)
        |
        v
[Query Compiler] --- deterministic, NO LLM --- reads ONLY the ResolutionResult ---> Neo4j
        |
        v
  Audit log entry (full resolution, persisted) + templated summary message
```

Four modules, kept independent (same instinct as Phase 1's chat/extraction split):
- **`GraphClient`** — raw driver wrapper: connect, run parameterized Cypher. No business logic, no knowledge of nodes/edges/extraction as concepts.
- **Context search** — pure code. Fixed query shapes only; parameters change, queries don't.
- **Resolver** — calls `LLMClient.resolve()`, validates output against schema, persists it.
- **Query compiler** — pure code. Takes *only* a `ResolutionResult` as input — no access to the original extraction, no access to the LLM. This boundary is what keeps graph writes deterministic and unit-testable without a real database or a real model.

---

## 5. API Contract

Reuses the Phase 1/2 server. New route only:

### `POST /api/graph/link`
Deliberately source-agnostic — same principle as `extract()` not caring whether text came from chat or diary. Takes an already-produced extraction, runs the full pipeline, returns the result.

**Request:**
```json
{ "extraction": { /* ExtractionResult, from Phase 1 §6 */ } }
```

**Response:**
```json
{
  "resolution": { /* ResolutionResult, see §7 */ },
  "summary": "string — templated, human-readable",
  "saved_to": {
    "resolution_file": "./data/resolutions/{resolution_id}.json"
  }
}
```

**Errors:** `400` malformed extraction input; `502` if either LLM call (`resolve()`) or Neo4j write fails — surfaced with the underlying error, not swallowed; `500` unexpected.

The frontend triggers this right after `/extract` succeeds, so from the user's side it's still one "Save" click — same one-user-facing-action pattern as Phase 2 — even though it's two backend calls under the hood, kept separate for testability.

---

## 6. Context Search Contract (new)

```
searchContext(extraction: ExtractionResult) -> CandidateSet
```
Pure code. Deterministic, parameterized Cypher only. **No LLM involved in this step** — it's a fixed, small set of query shapes; only the parameters (names, tags) change per call.

**Output schema:**
```json
{
  "node_candidates": [
    {
      "extracted_name": "string",
      "matches": [
        {
          "node_id": "uuid",
          "name": "string",
          "category": "string",
          "tags": ["string"],
          "score": 0.0,
          "neighborhood": [
            { "relation": "string", "direction": "in|out", "other_node_id": "uuid", "other_name": "string" }
          ]
        }
      ]
    }
  ],
  "edge_candidates": [
    { "extracted_relation": "string", "matches": [ { "relation_type": "string", "score": 0.0 } ] }
  ]
}
```

Rules:
- Fixed match strategies only: (a) exact/fuzzy name match against existing node names, (b) tag-overlap scoring against `nodes[].tags`, (c) for each matched candidate, its **immediate (1-hop) neighborhood only** — this is the hard bound against unbounded graph traversal discussed earlier in this project.
- `score` is a simple deterministic function (tag-overlap count + name similarity) — good enough to hand to the resolver, not meant to be a final decision on its own.
- Plain string/tag matching is the v1 approach. If it turns out to miss real matches (different phrasing, same meaning), embedding-based similarity is a noted future upgrade — not built in this phase.

---

## 7. Resolution Contract (new — `LLMClient.resolve()`)

```
resolve(extraction: ExtractionResult, candidates: CandidateSet) -> ResolutionResult
```
LLM call #2. Takes the raw extraction plus everything the context search found; decides what to do with each node and edge.

**Output schema:**
```json
{
  "resolution_id": "uuid",
  "source_extraction_ref": "string",
  "resolved_at": "ISO8601",
  "nodes": [
    {
      "extracted_name": "string",
      "decision": "create | merge | pending_review",
      "node_id": "uuid or null",
      "category": "string",
      "tags": ["string"],
      "candidates_considered": [ { "node_id": "uuid", "name": "string", "score": 0.0 } ],
      "reason": "string or null"
    }
  ],
  "edges": [
    {
      "extracted_relation": "string",
      "decision": "create | update | pending_review",
      "edge_id": "uuid or null",
      "relation_type": "string",
      "from": "string",
      "to": "string",
      "attributes": {},
      "reason": "string or null"
    }
  ]
}
```

Rules:
- Validated against schema the same way `extract()` is (Phase 1 §6): retry once on malformed output, then a 502-style error rather than writing anything malformed.
- `candidates_considered` and `reason` exist for the audit trail — the query compiler in §8 never reads them, only `decision` and the resolved ids/types.
- Every resolution is persisted, append-only, to `./data/resolutions/{resolution_id}.json` — this is the audit log. Nothing reaches the graph without a corresponding entry here.

---

## 8. Query Compiler Contract (new)

```
compile(resolution: ResolutionResult) -> void   // applies writes via GraphClient
```
Pure code. **Zero LLM. Zero knowledge of the original extraction, transcript, or conversation** — reads only the `ResolutionResult`. This boundary is deliberate: it's what makes graph writes deterministic and testable with a fixture, no model or real DB required for that test.

- `decision: create` (node) → `MERGE` on name, `SET category`/`tags`.
- `decision: merge` (node) → resolves to the existing `node_id`; no new node — new tags/context get merged onto the existing node.
- `decision: create` / `update` (edge) → `MERGE` the relationship between the resolved node ids, `SET attributes`.
- `decision: pending_review` → **no graph write.** It stays in the resolution log (§7) for manual review only — no special handling (e.g. flagged duplicates) is built for v1. The expectation is that a well-tuned context search + resolve step should rarely produce this in practice; if it turns out to happen often once the MVP is running, that's the signal to revisit this decision, not something to design against upfront.
- After writing, the compiler builds the **templated** (non-LLM) summary string from the resolution's decisions — e.g. *"Added Ana as a new person node. Linked hiking boots → needs_to_check → José (undone)."* Upgrading this to an LLM-phrased message later is a cheap swap, not an architecture change — deliberately not built that way now.

---

## 9. Test Plan

### Unit tests (`bun test`)
- `GraphClient` tested against a fake/mock driver — query-shape correctness, not a real Neo4j.
- Context search: given a mocked `GraphClient` response, correct scoring and shape.
- **Query compiler**: given a fixed `ResolutionResult` fixture, produces the expected mutation calls. This is the most valuable test in the phase — fully deterministic, no LLM or real DB needed.
- `resolve()` schema validation: malformed model output → retried once, then rejected per §7 rules, never crashes.

### Integration tests (real Neo4j, via docker-compose; real LLM calls run manually/on-demand, same convention as Phase 1 §8)
- Full round trip: extraction in → `/api/graph/link` → verify the resulting graph state with a direct Cypher read.
- Merge path: run the same entity twice with matching context → confirm no duplicate node, existing one updated.
- Ambiguous path: two candidates with similar scores, no clear winner → confirm `pending_review`, never a silent guess.

### Container smoke test (extends Phase 1 §8's script)
1. `docker compose up -d --build` (now brings up backend + Neo4j)
2. Poll both `GET /api/health` and Neo4j's readiness until healthy or timeout
3. Confirm bind-mounted `./data/neo4j` files are host-user-owned, not root-owned (same class of check as Phase 1 §3)
4. `docker compose down`

### Manual QA checklist
- [ ] Run 2-3 real extractions containing a genuinely ambiguous entity (e.g. two different "Ana"s in different contexts).
- [ ] Read back the resolution log for each — would the `reason` field actually help you understand *why* six months from now? If not, the resolve prompt needs revision — separate from this phase's structural build, but worth noting when it comes up.

---

## 10. Quality Gates

- [ ] `POST /api/graph/link` matches the contract in §5 exactly.
- [ ] No Neo4j-specific code outside `GraphClient`.
- [ ] Query compiler has zero imports from the extraction or LLM modules — reads only `ResolutionResult` (this is checkable by grep/diff, same spirit as Phase 2 §10's "extract() is untouched" gate).
- [ ] Neo4j is a service inside the existing `docker-compose.yml`; `docker compose up` brings up the whole stack in one command.
- [ ] Bind-mounted Neo4j data/logs are host-user-owned, not root-owned.
- [ ] `.env.example` updated with the new Neo4j variables.
- [ ] Every resolution, regardless of decision, is logged — nothing is written to the graph without a corresponding audit entry.
- [ ] `bun test` passes; container smoke test passes.
- [ ] Manual QA checklist actually run, answers recorded.

---

## 11. `pending_review` Handling — Decided

Resolved: **no special handling for v1.** A `pending_review` node or edge gets no graph write at all — it exists only in the resolution log (§7). The reasoning: in a properly tuned context search + resolve step, this case should be rare, so building dedicated handling (flagged duplicates, a review queue UI, etc.) now would be speculative work for an edge case that may barely occur. Once the MVP is running and real usage shows how often this actually comes up, that's the point to revisit — not before.

---

## 12. Explicitly Out of Scope for This Phase

- Excalidraw integration (Phase 5).
- Tool-integration actions (calendar, alarm, search-and-notify) via `action_items` — a future phase with its own job-queue design; extraction already excludes `action_items` entirely (see Phase 1 §6 revision).
- A graph-browsing/visualization UI beyond what Neo4j Browser gives for free — real in-app browsing is part of the project's larger vision, but nothing in this phase's scope asked for it; it gets its own future chat.
- LLM-driven query generation of any kind — context search and the query compiler are both deterministic code, by design.
- Embedding/vector-based similarity search — tag-string matching only for v1; noted as a future upgrade if plain matching proves too coarse.
- Tuning the extraction/resolution prompts for precision — a real, separate need you've flagged, but its own iteration loop, not blocked by this phase's structural build.
