import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { diaryTextToTranscript } from "../src/diary/adapter";
import {
  appendDiaryEntry,
  diaryEntriesPath,
  readDiaryEntries,
  readDiaryEntry,
  updateDiaryEntry,
} from "../src/storage/diary";
import { NotFoundError, defaultDataDir, extractionPath, readExtraction } from "../src/storage/files";
import { LLMProviderError, type DiaryEntry } from "../src/types";
import { FakeLLMClient, ISO_RE, json } from "./helpers";

/**
 * Phase 2 §9 tests. NOTE: like routes.test.ts, exactly ONE Elysia instance per
 * test file (Elysia 1.4.x corrupts routes/onError when instantiated more than
 * once per process; `bun test` runs each file in its own process, so this
 * file's instance never meets routes.test.ts's).
 */

const llm = new FakeLLMClient();
let currentDataDir: string;
const app = createApp({ llm, dataDir: () => currentDataDir, frontendDist: null });

beforeEach(async () => {
  currentDataDir = await mkdtemp(join(tmpdir(), "jarvis-diary-test-"));
  llm.reset();
});

afterEach(async () => {
  await rm(currentDataDir, { recursive: true, force: true });
});

const api = (path: string, init?: RequestInit) =>
  app.handle(new Request(`http://localhost:3000${path}`, init));

const postEntry = (text: unknown) =>
  api("/api/diary/entries", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(typeof text === "string" ? { text } : text),
  });

const entrySample = (overrides: Partial<DiaryEntry> = {}): DiaryEntry => ({
  id: "11111111-1111-4111-8111-111111111111",
  timestamp: "2026-09-22T10:00:00.000Z",
  text: "First diary line.",
  extraction: null,
  ...overrides,
});

// ---------------------------------------------------------------------------
// §9 unit — extraction adapter (the thin adapter is the only new code on the
// extraction path; extract() and its prompts must stay untouched).
// ---------------------------------------------------------------------------

describe("diaryTextToTranscript (Phase 2 §5.2 adapter)", () => {
  it("wraps raw diary text as a single user message", () => {
    const transcript = diaryTextToTranscript("Long stream of consciousness", "2026-09-22T10:00:00.000Z");
    expect(transcript).toHaveLength(1);
    expect(transcript[0].role).toBe("user");
    expect(transcript[0].content).toBe("Long stream of consciousness");
    expect(transcript[0].timestamp).toBe("2026-09-22T10:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// §9 unit — JSONL append/read/update.
// ---------------------------------------------------------------------------

describe("diary JSONL storage (§7)", () => {
  it("readDiaryEntries returns [] for a missing file", async () => {
    expect(await readDiaryEntries(currentDataDir)).toEqual([]);
  });

  it("writing N entries then reading returns N in order (append order == chronological)", async () => {
    await appendDiaryEntry(currentDataDir, entrySample({ id: "a", text: "one" }));
    await appendDiaryEntry(currentDataDir, entrySample({ id: "b", text: "two" }));
    await appendDiaryEntry(currentDataDir, entrySample({ id: "c", text: "three" }));
    const entries = await readDiaryEntries(currentDataDir);
    expect(entries.map((e) => e.text)).toEqual(["one", "two", "three"]);
  });

  it("a malformed/partial last line does not crash the reader and is skipped", async () => {
    await appendDiaryEntry(currentDataDir, entrySample({ id: "ok" }));
    const file = diaryEntriesPath(currentDataDir);
    // Simulate a crash mid-append: the last line is truncated JSON.
    await appendFile(file, '{"id":"trunc","timestamp":"2026', "utf8");
    const entries = await readDiaryEntries(currentDataDir);
    expect(entries.map((e) => e.id)).toEqual(["ok"]);
  });

  it("readDiaryEntry returns the entry by id and throws NotFoundError otherwise", async () => {
    await appendDiaryEntry(currentDataDir, entrySample({ id: "find-me" }));
    const found = await readDiaryEntry(currentDataDir, "find-me");
    expect(found.id).toBe("find-me");
    await expect(readDiaryEntry(currentDataDir, "missing")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("updateDiaryEntry replaces the matching line in place, one line per entry", async () => {
    await appendDiaryEntry(currentDataDir, entrySample({ id: "x", text: "before" }));
    await updateDiaryEntry(currentDataDir, entrySample({ id: "x", text: "after", extraction: null }));
    const entries = await readDiaryEntries(currentDataDir);
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toBe("after");
    const raw = await readFile(diaryEntriesPath(currentDataDir), "utf8");
    expect(raw.trim().split("\n")).toHaveLength(1); // one line on disk, no dupes
  });

  it("updateDiaryEntry appends when the id is not on disk yet", async () => {
    await updateDiaryEntry(currentDataDir, entrySample({ id: "brand-new", text: "hi" }));
    expect(await readDiaryEntries(currentDataDir)).toHaveLength(1);
  });

  it("updateDiaryEntry preserves unrelated lines byte-for-byte", async () => {
    await appendDiaryEntry(currentDataDir, entrySample({ id: "a", text: "keep" }));
    await appendDiaryEntry(currentDataDir, entrySample({ id: "b", text: "update me" }));
    await updateDiaryEntry(currentDataDir, entrySample({ id: "b", text: "updated" }));
    const entries = await readDiaryEntries(currentDataDir);
    expect(entries.map((e) => e.text)).toEqual(["keep", "updated"]);
  });

  it("normalizes legacy (Phase 1) extraction rows on read: entities->nodes, no edges", async () => {
    // A real pre-Phase-2 row had `entities`/`action_items` and NO nodes/edges.
    const legacy = {
      id: "legacy-1",
      timestamp: "2026-09-01T00:00:00.000Z",
      text: "Old entry before nodes/edges existed",
      extraction: {
        summary: "old summary",
        tags: ["old", "tag"],
        mood_or_tone: "neutral",
        conversation_id: "legacy-1",
        extracted_at: "2026-09-01T00:00:00.000Z",
        raw_source_ref: "/old/path.json",
        entities: [{ name: "Rome", category: "place", confidence: 0.9, tags: ["travel"] }],
        action_items: ["book a flight"],
      },
    };
    await writeFile(diaryEntriesPath(currentDataDir), `${JSON.stringify(legacy)}\n`, "utf8");

    const entries = await readDiaryEntries(currentDataDir);
    expect(entries).toHaveLength(1);

    // The exact reads the diary UI makes must never see `undefined`:
    const ex = entries[0].extraction!;
    expect(ex.nodes.map((n) => n.name)).toEqual(["Rome"]);
    expect(ex.edges.length).toBe(0);
    expect(ex.tags.map((t) => t.toUpperCase())).toEqual(["OLD", "TAG"]);
    // entity fields survived the rename intact
    expect(ex.nodes[0]).toEqual({ name: "Rome", category: "place", confidence: 0.9, tags: ["travel"] });
    expect(ex.mood_or_tone).toBe("neutral");
  });

  it("normalizes a legacy extraction FILE through readExtraction (saved-conversation view)", async () => {
    const id = "legacy-abcd-1234";
    const legacy = {
      conversation_id: id,
      extracted_at: "2026-09-01T00:00:00.000Z",
      summary: "from before",
      tags: [],
      mood_or_tone: null,
      raw_source_ref: "/old/path.json",
      entities: [{ name: "Alice", category: "person" }],
    };
    await mkdir(join(currentDataDir, "extractions"), { recursive: true });
    await writeFile(extractionPath(currentDataDir, id), JSON.stringify(legacy), "utf8");

    const ex = await readExtraction(currentDataDir, id);
    expect(ex.nodes.map((n) => n.name)).toEqual(["Alice"]);
    expect(ex.nodes[0].category).toBe("person");
    expect(ex.edges).toEqual([]);
    expect(ex.summary).toBe("from before");
  });
});

// ---------------------------------------------------------------------------
// §9 integration — POST /api/diary/entries.
// ---------------------------------------------------------------------------

describe("POST /api/diary/entries", () => {
  it("201s with a full DiaryEntry and grows the file by exactly one line", async () => {
    const res = await postEntry("Went for a run along the river, felt great.");
    expect(res.status).toBe(201);
    const body = await json(res);
    const entry: DiaryEntry = body.entry;

    expect(entry.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(ISO_RE.test(entry.timestamp)).toBe(true);
    expect(entry.text).toBe("Went for a run along the river, felt great.");
    expect(entry.warning).toBeUndefined();
    const extraction = entry.extraction;
    expect(extraction).not.toBeNull();
    expect(extraction!.conversation_id).toBe(entry.id);
    // raw_source_ref points into the diary file (Phase 2 §5.2), a real path.
    expect(extraction!.raw_source_ref).toBe(diaryEntriesPath(currentDataDir));

    const raw = await readFile(diaryEntriesPath(currentDataDir), "utf8");
    expect(raw.trim().split("\n")).toHaveLength(1);
    // What's on disk matches what the API returned.
    const disk = JSON.parse(raw.trim()) as DiaryEntry;
    expect(disk.id).toBe(entry.id);
    expect(disk.extraction?.summary).toBe(extraction!.summary);
  });

  it("feeds Phase 1's extract() the adapter-shaped transcript (unchanged function)", async () => {
    const created = await json(await postEntry("Remember to water the plants."));
    const entryId: string = created.entry.id;
    const call = llm.extractCalls[0];
    expect(call.transcript).toHaveLength(1);
    expect(call.transcript[0].role).toBe("user");
    expect(call.transcript[0].content).toBe("Remember to water the plants.");
    expect(ISO_RE.test(call.transcript[0].timestamp)).toBe(true);
    // The meta reuses the chat-era names generically (§5.2): conversation_id is
    // the diary entry's own id, raw_source_ref is the jsonl path.
    expect(call.meta.conversation_id).toBe(entryId);
    expect(call.meta.raw_source_ref).toBe(diaryEntriesPath(currentDataDir));
  });

  it("400s on blank text and writes nothing to disk", async () => {
    const res = await postEntry("   ");
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe("VALIDATION_ERROR");
    expect(existsSync(diaryEntriesPath(currentDataDir))).toBe(false);
  });

  it("400s on a missing text field (concise validation error, no schema dump)", async () => {
    const res = await postEntry({});
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toMatch(/^Invalid body: \/text /);
    expect(body.error.message).not.toContain("expected");
  });

  it("when extraction fails: 201, entry persisted with extraction null + warning (no lost writing)", async () => {
    llm.setExtractFailure(new LLMProviderError("extract failed", "model refused to comply"));
    const res = await postEntry("This text must survive an LLM failure.");
    expect(res.status).toBe(201); // the entry WAS created — deviates from a literal 502, see app.ts comment
    const body = await json(res);
    const entry: DiaryEntry = body.entry;

    expect(entry.extraction).toBeNull();
    expect(entry.warning).toContain("Extraction failed");
    expect(entry.warning).toContain("model refused to comply");
    expect(entry.text).toBe("This text must survive an LLM failure.");

    // The entry (with the warning) is on disk, exactly one line.
    const raw = await readFile(diaryEntriesPath(currentDataDir), "utf8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(1);
    const disk = JSON.parse(lines[0]) as DiaryEntry;
    expect(disk.extraction).toBeNull();
    expect(disk.warning).toContain("Extraction failed");
  });

  it("a second post appends a second line (no duplication, append-only)", async () => {
    await postEntry("First");
    await postEntry("Second");
    const raw = await readFile(diaryEntriesPath(currentDataDir), "utf8");
    expect(raw.trim().split("\n")).toHaveLength(2);
    const entries = await readDiaryEntries(currentDataDir);
    expect(entries.map((e) => e.text)).toEqual(["First", "Second"]);
  });
});

// ---------------------------------------------------------------------------
// §9 integration — GET /api/diary/entries and GET /api/diary/entries/:id.
// ---------------------------------------------------------------------------

describe("GET /api/diary/entries", () => {
  it("returns all entries, oldest first, correct shape", async () => {
    for (const text of ["one", "two", "three"]) await postEntry(text);
    const res = await api("/api/diary/entries");
    expect(res.status).toBe(200);
    const body = await json(res);
    const entries: DiaryEntry[] = body.entries;
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.text)).toEqual(["one", "two", "three"]);
    for (const e of entries) {
      expect(e.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(ISO_RE.test(e.timestamp)).toBe(true);
      expect(e.extraction).not.toBeNull();
    }
  });

  it("returns [] when the diary is empty", async () => {
    const res = await api("/api/diary/entries");
    expect(res.status).toBe(200);
    expect((await json(res)).entries).toEqual([]);
  });

  it("GET serves legacy rows already normalized (nodes/edges/tags always arrays)", async () => {
    const legacy = {
      id: "legacy-1",
      timestamp: "2026-09-01T00:00:00.000Z",
      text: "Old entry",
      extraction: {
        summary: "old",
        tags: [],
        mood_or_tone: null,
        conversation_id: "legacy-1",
        extracted_at: "2026-09-01T00:00:00.000Z",
        raw_source_ref: "/old/path.json",
        entities: [{ name: "Rome", category: "place" }],
      },
    };
    await writeFile(diaryEntriesPath(currentDataDir), `${JSON.stringify(legacy)}\n`, "utf8");

    const res = await api("/api/diary/entries");
    expect(res.status).toBe(200);
    const body = await json(res);
    const entries: DiaryEntry[] = body.entries;
    expect(entries).toHaveLength(1);
    const ex = entries[0].extraction!;
    // The shape DiaryPage renders against — a regression here crashes the page.
    expect(ex.nodes.map((n) => n.name)).toEqual(["Rome"]);
    expect(ex.edges.length).toBe(0);
    expect(ex.tags).toEqual([]);
  });
});

describe("GET /api/diary/entries/:id", () => {
  it("returns the entry for a real id", async () => {
    const created = await json(await postEntry("Find me later"));
    const id: string = created.entry.id;
    const res = await api(`/api/diary/entries/${id}`);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.entry.id).toBe(id);
    expect(body.entry.text).toBe("Find me later");
  });

  it("404s for an unknown id", async () => {
    const res = await api("/api/diary/entries/00000000-0000-4000-8000-000000000000");
    expect(res.status).toBe(404);
    const body = await json(res);
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("rejects unsafe ids (path traversal)", async () => {
    const res = await api("/api/diary/entries/..%2F..%2Fetc%2Fpasswd");
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe("VALIDATION_ERROR");
  });
});

// ---------------------------------------------------------------------------
// §9 unit — data-dir resolution sanity (diary lives next to conversations/).
// ---------------------------------------------------------------------------

describe("diary storage location", () => {
  it("defaults to <repo>/data/diary-entries.jsonl (host-inspectable)", () => {
    // Simulate the container/default env shape: DATA_DIR is the override there.
    const dir = defaultDataDir();
    expect(diaryEntriesPath(dir)).toContain("data");
    expect(diaryEntriesPath(dir)).toEndWith("diary-entries.jsonl");
  });

  it("survives a reader across a simulated non-JSONL file entry without dying", async () => {
    // Belt-and-braces: a writeFile that clobbers the whole file (a non-jsonl
    // tool, e.g. a human editor) should not crash GETs.
    await writeFile(diaryEntriesPath(currentDataDir), "this is not jsonl at all\n", "utf8");
    const entries = await readDiaryEntries(currentDataDir);
    expect(entries).toEqual([]);
  });
});