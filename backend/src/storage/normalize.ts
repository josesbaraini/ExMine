import type { ExtractionEdge, ExtractionNode, ExtractionResult } from "../types";

/**
 * Coerce any extraction JSON read from disk into the current ExtractionResult
 * shape.
 *
 * Why this exists: extractions written before nodes/edges existed (Phase 1-era
 * files carry `entities`/`action_items` and NO nodes/edges) are still served
 * by GET endpoints. Frontends read `extraction.nodes/edges/tags` without
 * guarding (DiaryPage renders chips from `nodes.map(...)`, counts
 * `edges.length`, lists `tags.map(...)`), so an unnormalized legacy row
 * crashes the whole page with `undefined.map`. Normalizing here — at the only
 * place disk JSON enters the app — fixes every consumer (diary list, diary
 * single, saved-conversation view) at once, not just one UI.
 *
 * Guarantees over the result:
 * - `nodes`, `edges`, `tags` are ALWAYS arrays (never undefined/null).
 * - Legacy `entities` become `nodes`. `action_items` stay dropped — a plain
 *   to-do was never a graph node (§6).
 * - Strings default to `""`, `mood_or_tone` to `null`, numbers to `1`.
 *   Unknown/extra fields are dropped; nothing is invented.
 *
 * For already-current rows this is an identity transform (same values out).
 */
export function normalizeExtraction(raw: unknown): ExtractionResult {
  const src = (raw ?? {}) as Record<string, unknown>;

  const nodes: ExtractionNode[] = Array.isArray(src.nodes)
    ? normalizeNodes(src.nodes)
    : normalizeNodes(src.entities);

  const edges: ExtractionEdge[] = Array.isArray(src.edges) ? normalizeEdges(src.edges) : [];

  return {
    conversation_id: asString(src.conversation_id),
    extracted_at: asString(src.extracted_at),
    summary: asString(src.summary),
    tags: asStringArray(src.tags),
    nodes,
    edges,
    mood_or_tone: typeof src.mood_or_tone === "string" ? src.mood_or_tone : null,
    raw_source_ref: asString(src.raw_source_ref),
  };
}

function normalizeNodes(maybe: unknown): ExtractionNode[] {
  if (!Array.isArray(maybe)) return [];
  return maybe
    .filter((n): n is Record<string, unknown> => n !== null && typeof n === "object")
    .map((n) => ({
      name: asString(n.name),
      category: asString(n.category) || "entity",
      confidence: typeof n.confidence === "number" && n.confidence >= 0 ? n.confidence : 1,
      tags: asStringArray(n.tags),
    }));
}

function normalizeEdges(maybe: unknown): ExtractionEdge[] {
  if (!Array.isArray(maybe)) return [];
  return maybe
    .filter((e): e is Record<string, unknown> => e !== null && typeof e === "object")
    .map((e) => ({
      relation: asString(e.relation),
      from: asString(e.from),
      to: asString(e.to),
      confidence: typeof e.confidence === "number" && e.confidence >= 0 ? e.confidence : 1,
      attributes:
        e.attributes !== null && typeof e.attributes === "object" && !Array.isArray(e.attributes)
          ? (e.attributes as Record<string, unknown>)
          : {},
    }));
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}