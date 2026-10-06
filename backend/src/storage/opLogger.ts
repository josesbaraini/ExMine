import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Append-only operation log for development/debugging.
 * Every significant operation writes one JSONL line to
 * `<dataDir>/logs/operations.jsonl` so we can audit what happened
 * without opening Neo4j Browser or guessing from state.
 */

export interface OperationLogEntry {
  timestamp: string;
  operation: string;
  input_summary?: string;
  result: "ok" | "error";
  detail?: string;
}

export async function logOperation(
  dataDir: string,
  entry: Omit<OperationLogEntry, "timestamp">,
): Promise<void> {
  try {
    const dir = join(dataDir, "logs");
    await mkdir(dir, { recursive: true });
    const line =
      JSON.stringify({
        timestamp: new Date().toISOString(),
        ...entry,
      }) + "\n";
    await appendFile(join(dir, "operations.jsonl"), line, "utf8");
  } catch {
    // Logging must never crash the request — it's a dev aid, not the product.
  }
}
