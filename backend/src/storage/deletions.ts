import { existsSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DeleteNodeSnapshot } from "../graph/deleteNodeTool";

/**
 * Phase 3.6 deletion audit log: one immutable file per deletion at
 * `<dataDir>/deletions/{deletion_id}.json`.
 *
 * Append-only by construction: every deletion gets a fresh uuid.
 * The log contains a full snapshot of what was removed so a wrong
 * deletion can be manually recovered.
 */

export interface DeletionSnapshot extends DeleteNodeSnapshot {
  deletion_id: string;
  deleted_at: string;
}

/** Absolute on-disk directory holding deletion audit entries. */
export function deletionsDir(dataDir: string): string {
  return join(dataDir, "deletions");
}

/** Absolute on-disk path a deletion's audit entry lives at. */
export function deletionPath(dataDir: string, deletionId: string): string {
  return join(dataDir, "deletions", `${deletionId}.json`);
}

/** Write the audit entry (tmp + rename so a crash never leaves a partial file). */
export async function saveDeletion(dataDir: string, deletion: DeletionSnapshot): Promise<string> {
  const dir = deletionsDir(dataDir);
  await mkdir(dir, { recursive: true });
  const target = deletionPath(dataDir, deletion.deletion_id);
  if (existsSync(target)) {
    throw new Error(`refusing to overwrite audit entry ${target} — deletion ids must be unique (append-only log)`);
  }
  const tmp = `${target}.tmp`;
  await writeFile(tmp, `${JSON.stringify(deletion, null, 2)}\n`, "utf8");
  await rename(tmp, target);
  return target;
}