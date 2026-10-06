import type { ChatMessage } from "../types";

/**
 * Phase 2 §5.2 — the ONLY new code on the extraction path, and the only thing
 * allowed to touch it this phase. Wraps freeform diary text as a
 * single-message transcript so Phase 1's `extract()` and its prompts are
 * consumed unchanged. All other diary logic is pure storage/routing.
 *
 * Consequence (documented, not fixed here): `conversation_id` is a chat-era
 * name but is generic in practice — the route handler populates it with the
 * diary entry's own id, and `raw_source_ref` with the jsonl path, exactly like
 * Phase 1's route fills them for conversations. Renaming the field is flagged
 * for Phase 3 where the schema gets revisited.
 */
export function diaryTextToTranscript(text: string, timestamp: string): ChatMessage[] {
  return [{ role: "user", content: text, timestamp }];
}