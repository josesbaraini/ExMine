import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DiaryEntry } from "../types";
import { NotFoundError } from "./files";
import { normalizeExtraction } from "./normalize";

/**
 * Phase 2 §7 storage: a single append-only JSONL file, one DiaryEntry per
 * line, at <dataDir>/diary-entries.jsonl.
 *
 * - Append order == chronological order, so reading the file top-to-bottom
 *   yields `entries` oldest-first (the §6 GET contract) with no sorting.
 * - Appends use O_APPEND (POSIX-atomic for short writes); a crash mid-append
 *   can only truncate the LAST line, which the reader tolerates by skipping
 *   malformed lines — it never crashes on them (§9).
 * - POST updates its own line in place (tmp + rename, same pattern as the
 *   Phase 1 JSON writes) so the file stays one-entry-per-line and
 *   human-readable (§10), and a crash leaves at worst an entry with
 *   `extraction: null`, never a corrupt file.
 *
 * Single-user assumption: the read-modify-write in updateEntry is not
 * concurrency-safe. Phase 1 has the same property with its in-memory store;
 * a locked/fenced write belongs to Phase 3 storage.
 */

/** Absolute on-disk path of the diary file. */
export function diaryEntriesPath(dataDir: string): string {
  return join(dataDir, "diary-entries.jsonl");
}

/** Append a line. Returns the absolute path written. */
export async function appendDiaryEntry(dataDir: string, entry: DiaryEntry): Promise<string> {
  const file = diaryEntriesPath(dataDir);
  await mkdir(dataDir, { recursive: true });
  await appendFile(file, `${JSON.stringify(entry)}\n`, "utf8");
  return file;
}

/**
 * Replace the line whose id matches (in-place, atomic via tmp + rename) or
 * append the entry if no such line exists. Other lines are preserved
 * byte-for-byte. Returns the absolute path written.
 */
export async function updateDiaryEntry(dataDir: string, entry: DiaryEntry): Promise<string> {
  const file = diaryEntriesPath(dataDir);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") raw = "";
    else throw err;
  }

  const lines = raw.split("\n");
  let replaced = false;
  const next = lines.map((line) => {
    if (line.trim() === "" || replaced) return line;
    try {
      const parsed = JSON.parse(line) as { id?: unknown };
      if (parsed.id === entry.id) {
        replaced = true;
        return JSON.stringify(entry);
      }
      return line;
    } catch {
      return line; // preserve malformed lines, don't destroy data on disk
    }
  });
  if (!replaced) next.push(JSON.stringify(entry));

  const body = next.filter((l) => l.trim() !== "").join("\n");
  await mkdir(dataDir, { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, body ? `${body}\n` : "", "utf8");
  await rename(tmp, file);
  return file;
}

/**
 * Read and parse the whole file, oldest first. Missing file -> []. Malformed
 * or partial lines (e.g. a crash truncated the final append) are skipped with
 * a warning, never fatal (§9).
 */
export async function readDiaryEntries(dataDir: string): Promise<DiaryEntry[]> {
  const file = diaryEntriesPath(dataDir);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const entries: DiaryEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const entry = JSON.parse(trimmed) as DiaryEntry;
      // Legacy rows (Phase 1 era) can lack the current extraction shape, and
      // `extraction: null` marks a failed extraction. Coerce anything else to
      // the shape the API contract promises so no consumer sees `nodes`/
      // `edges`/`tags` undefined (the diary UI crashed on exactly that).
      entry.extraction = entry.extraction == null ? null : normalizeExtraction(entry.extraction);
      entries.push(entry);
    } catch {
      console.warn(`[diary] skipping malformed line in ${file}`);
    }
  }
  return entries;
}

/** Read a single entry by id. Throws NotFoundError when absent. */
export async function readDiaryEntry(dataDir: string, id: string): Promise<DiaryEntry> {
  const entries = await readDiaryEntries(dataDir);
  const found = entries.find((e) => e.id === id);
  if (!found) throw new NotFoundError(`no diary entry with id ${id}`);
  return found;
}