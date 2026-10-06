# Jarvis — Phase 2: Diary / Daily Capture

Status: harness-ready.

## 1. Goal

Prove that the Phase 1 extraction pipeline generalizes from chat transcripts to freeform diary text. Nothing more.

**Definition of done for this phase:** I can open the diary page, write freeform text, hit save, and get back the same shape of extraction JSON that Phase 1 produces — persisted to disk, retrievable later.

## 2. Explicit non-goals (do NOT build these here)

These belong to later phases. If the harness starts doing any of this, stop it:
- No SQL / relational storage (that's Phase 3).
- No linking, no graph, no "Me" node (Phase 4).
- No new/forked extraction logic tuned specifically for diary text. Phase 2 calls Phase 1's extraction function unchanged. If it performs badly on diary text, **log the observation, don't fix it here.**
- No per-day grouping, no calendar UI, no "entries by date" — confirmed below, this is a single running journal.
- No auth, no multi-user.

## 3. Assumed prior state (Phase 1 recap)

- Backend: Bun + Elysia.
- Frontend: React (minimal).
- LLM calls go through OpenRouter, behind a provider-abstraction layer.
- Dockerized; "done" = tests pass AND container builds successfully.
- Host: Linux (Fedora 44 KDE).
- Phase 1 extraction is invoked on-demand (explicit action, not automatic/streaming) and writes structured JSON to a file.

## 4. Decisions made for Phase 2

- **Structure:** single running journal — no date boundaries, no "one entry per day." Entries are chronological blocks, each independently timestamped.
- **Where it lives:** same backend service as Phase 1 (new route), same React app (new page). Not a separate service.
- **Extraction trigger:** on-demand via explicit "Save" action — same pattern as Phase 1's "on demand," not autosave/debounce, not a separate end-of-day step. Saving the entry and extracting from it happen as one user-facing action.

## 5. Data contract

### 5.1 Diary entry (new)

```ts
interface DiaryEntry {
  id: string;            // uuid
  timestamp: string;     // ISO 8601, set server-side on creation
  text: string;           // raw freeform text as written
  extraction: ExtractionResult | null; // null only when extraction failed (see §6 error contract)
}
```

### 5.2 Extraction result (from Phase 1 §6, unchanged)

> **Revision note:** Phase 1's §6 extraction contract was revised during
> Phase 3+4 design — `entities[]` / `action_items[]` were replaced with
> `nodes[]` + `edges[]`, and `action_items` was removed from extraction
> entirely (deferred to a future tool-integration phase). Because phases are
> cumulative, this section reflects the revised shape. It changes **nothing**
> about Phase 2's responsibilities: Phase 2 still calls `extract()` unchanged,
> and the adapter + naming notes below still apply.

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
  "raw_source_ref": "path to the saved source file"
}
```

> `nodes[].category` and `edges[].relation` are open strings (no controlled
> vocabulary here — reconciling/canonicalizing them is the graph layer's job
> downstream), and there is deliberately **no `action_items`** in the schema.

Two things this reveals, both **naming**, not logic, so they don't violate "reuse extraction unchanged":

- `conversation_id` and `raw_source_ref` are populated by the *caller* (the route handler), not by `extract()` itself — `extract(transcript)` only takes a transcript, so it can't know these. For diary, the caller populates `conversation_id` with the diary entry's own `id`, and `raw_source_ref` with the path/line reference into `data/diary-entries.jsonl`. The field is named for chat but is generic in practice — leave the name as-is for this phase (renaming it means touching Phase 1 code, which is out of scope); flag it as a cheap rename for whenever Phase 3's schema gets revisited.
- `extract()` takes `Message[]`, not a bare string. Phase 2's adapter wraps the diary text as a single-message transcript: `[{ role: "user", content: text, timestamp: entry.timestamp }]`. This is the "thin adapter" mentioned below — it's the only new code touching the extraction path, and it doesn't modify `extract()` or its prompt.

## 6. API contract

Reuses Phase 1's server. New routes only:

```
POST /diary/entries
  body: { text: string }
  → 201 { entry: DiaryEntry }
  Behavior: persists entry, runs Phase 1's extraction function against `text`,
  attaches the result, persists again with extraction included, returns the full entry.
  Errors:
    400 if text is empty/whitespace-only
    502 if extraction call fails (persist the entry anyway with extraction: null,
        return it with a `warning` field — do not lose the user's writing because
        the LLM call failed)

GET /diary/entries
  → 200 { entries: DiaryEntry[] }   // chronological, oldest first
  No pagination in this phase (MVP, single user, assume small volume).

GET /diary/entries/:id
  → 200 { entry: DiaryEntry }
  → 404 if not found
```

No PUT/PATCH/DELETE in this phase — entries are append-only once extracted. If a mistake needs fixing, that's a manual file edit for now (MVP).

## 7. Storage

No DB yet (Phase 3 territory). Flat file, consistent with Phase 1's approach:

- Append-only JSONL file, one `DiaryEntry` per line: `data/diary-entries.jsonl`
- `POST /diary/entries` appends a line (or rewrites the file — implementer's call, but must survive a crash mid-write without corrupting prior entries; append-only-then-parse-per-line is the safer default).
- `GET` reads and parses the whole file. Fine at this scale.

## 8. Frontend

One new page, reachable from the existing app shell:
- A single large textarea for freeform entry.
- "Save" button — disabled while a save/extract call is in flight, shows a loading state.
- Below the textarea: a reverse-chronological (newest first is fine for *display*, even though storage/API order is oldest-first) list of past entries, each showing:
  - timestamp
  - the raw text (collapsible/truncated if long)
  - the extraction result, rendered readably (not raw JSON dump — but doesn't need to be fancy)
- If extraction failed for an entry (`warning` present), show that inline rather than silently.

No routing complexity needed — this can be a single component/page.

## 9. Test plan (for the harness)

**Unit**
- Extraction adapter: given raw diary text, calls the shared extraction function with correctly-shaped input.
- JSONL append/read: writing N entries then reading returns N entries in order; a malformed/partial last line doesn't crash the reader.

**Integration (API)**
- `POST /diary/entries` with valid text → 201, entry has id/timestamp/extraction populated, file on disk grows by one line.
- `POST /diary/entries` with empty text → 400, nothing written to disk.
- `POST /diary/entries` with extraction call mocked to fail → 502-or-similar per contract above, entry still persisted with `extraction: null` and a `warning`.
- `GET /diary/entries` after several posts → returns all of them, correct order, correct shape.
- `GET /diary/entries/:id` for a real id → 200; for a fake id → 404.

**Frontend (smoke, not exhaustive)**
- Typing text and clicking Save results in a new entry appearing in the list with its extraction shown.
- Save button is disabled during the in-flight request.
- A simulated extraction failure still shows the entry (with the warning), doesn't lose the user's text.

**End-to-end**
- Fresh container, write 3 entries across a "session," restart the container, `GET /diary/entries` still returns all 3 (persistence survives restart — proves the file-based storage actually works, not just in-memory).

## 10. Quality gates (must pass before this phase is "done")

1. All unit + integration tests above pass.
2. Docker image builds successfully (`docker build` clean, per Phase 1's precedent).
3. Manual smoke: write an entry through the actual UI, confirm it round-trips through a container restart.
4. `extract()` itself and its prompt are untouched **by Phase 2** — the only new code Phase 2 adds on the extraction path is the message-shaping adapter in §5.2. Grep/diff confirms this. (Note: since this spec was written, Phase 1's §6 contract was revised to `nodes`/`edges` — that change lives in Phase 1's code and prompts, not Phase 2's.)
5. `data/diary-entries.jsonl` is human-readable/inspectable (open it in a text editor, it makes sense) — this matters for MVP debuggability, not just automated tests.

## 11. Explicitly deferred / noted for later chats

- Diary text quality of extraction may differ from chat transcripts (longer, less turn-structured, more stream-of-consciousness) — if this phase surfaces that the shared extraction prompt needs diary-specific tuning, **note it, don't fix it here.** That's a Phase 3+ or a dedicated "extraction quality" chat.
- Multi-day/calendar views, search, editing entries — not this phase.