import { randomUUID } from "node:crypto";
import type { ChatMessage } from "./types";

/**
 * In-memory conversation store. This phase explicitly does not persist a
 * conversation until it is saved during extraction (§5). A map is fine.
 */
export class ConversationStore {
  private readonly conversations = new Map<string, ChatMessage[]>();

  has(id: string): boolean {
    return this.conversations.has(id);
  }

  get(id: string): ChatMessage[] | undefined {
    return this.conversations.get(id);
  }

  start(): { id: string; messages: ChatMessage[] } {
    const id = randomUUID();
    const messages: ChatMessage[] = [];
    this.conversations.set(id, messages);
    return { id, messages };
  }

  /** No-op for unknown ids — the callers guard with `has()` first. */
  append(id: string, msg: ChatMessage): void {
    this.conversations.get(id)?.push(msg);
  }
}