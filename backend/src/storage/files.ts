import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChatMessage, ExtractionResult } from "../types";
import { normalizeExtraction } from "./normalize";

/**
 * Flat-file storage (§2). This module is the ONLY place that knows paths.
 * Extraction code must stay storage-agnostic (§6) — it calls into here, never
 * the other way around.
 */

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

export interface ConversationFile {
  conversation_id: string;
  messages: ChatMessage[];
}

/**
 * Resolve the data directory. Default: <repo-root>/data (container sets
 * DATA_DIR=/app/data, which resolves identically since /app is the repo root
 * in the image). In dev this is the checked-in ./data folder.
 */
export function defaultDataDir(): string {
  return process.env.DATA_DIR ?? join(import.meta.dir, "..", "..", "..", "data");
}

/** Absolute on-disk path a conversation will be written to. */
export function conversationPath(dataDir: string, id: string): string {
  return join(dataDir, "conversations", `${id}.json`);
}

/** Absolute on-disk path an extraction will be written to. */
export function extractionPath(dataDir: string, id: string): string {
  return join(dataDir, "extractions", `${id}.json`);
}

/** Writes the file and returns the absolute path written (so callers can report real paths). */
export async function saveConversation(dataDir: string, id: string, messages: ChatMessage[]): Promise<string> {
  const file: ConversationFile = { conversation_id: id, messages };
  return writeJsonAtomic(dataDir, "conversations", `${id}.json`, file);
}

export async function saveExtraction(dataDir: string, id: string, extraction: ExtractionResult): Promise<string> {
  return writeJsonAtomic(dataDir, "extractions", `${id}.json`, extraction);
}

export async function readConversation(dataDir: string, id: string): Promise<ConversationFile> {
  return readJson(dataDir, "conversations", `${id}.json`) as Promise<ConversationFile>;
}

export async function readExtraction(dataDir: string, id: string): Promise<ExtractionResult> {
  // Normalize legacy (pre-nodes/edges) extraction files into the current shape
  // — same guarantee as the diary reader, for the saved-conversation view.
  return normalizeExtraction(await readJson(dataDir, "extractions", `${id}.json`));
}

/**
 * Write via tmp + rename so a crash never leaves a half-written JSON file on
 * disk, and so readers (host user inspecting ./data) never see a partial file.
 */
async function writeJsonAtomic(dataDir: string, subdir: string, name: string, value: unknown): Promise<string> {
  const dir = join(dataDir, subdir);
  await mkdir(dir, { recursive: true });
  const target = join(dir, name);
  const tmp = `${target}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmp, target);
  return target;
}

async function readJson(dataDir: string, subdir: string, name: string): Promise<unknown> {
  const file = join(dataDir, subdir, name);
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new NotFoundError(`no file at ${file}`);
    }
    throw err;
  }
}