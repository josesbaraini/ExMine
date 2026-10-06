import { existsSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ResolutionResult } from "../types";

/**
 * Phase 3 §7 audit log: one immutable file per resolution at
 * `<dataDir>/resolutions/{resolution_id}.json`.
 *
 * Append-only by construction: every resolution gets a fresh uuid, and
 * saveResolution refuses to overwrite an existing id. The spec's invariant is
 * that NOTHING reaches the graph without a corresponding entry here (§7/§10) —
 * the /api/graph/link pipeline persists before it compiles.
 */

/** Absolute on-disk directory holding resolution audit entries. */
export function resolutionsDir(dataDir: string): string {
  return join(dataDir, "resolutions");
}

/** Absolute on-disk path a resolution's audit entry lives at. */
export function resolutionPath(dataDir: string, resolutionId: string): string {
  return join(dataDir, "resolutions", `${resolutionId}.json`);
}

/** Write the audit entry (tmp + rename so a crash never leaves a partial file). */
export async function saveResolution(dataDir: string, resolution: ResolutionResult): Promise<string> {
  const dir = resolutionsDir(dataDir);
  await mkdir(dir, { recursive: true });
  const target = resolutionPath(dataDir, resolution.resolution_id);
  if (existsSync(target)) {
    throw new Error(`refusing to overwrite audit entry ${target} — resolution ids must be unique (append-only log)`);
  }
  const tmp = `${target}.tmp`;
  await writeFile(tmp, `${JSON.stringify(resolution, null, 2)}\n`, "utf8");
  await rename(tmp, target);
  return target;
}