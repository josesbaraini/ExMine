import { randomUUID } from "node:crypto";
import { saveResolution } from "../storage/resolutions";
import type { CandidateSet, ExtractionResult, LLMClient, ResolutionResult } from "../types";

/**
 * Phase 3 §7 — Resolver. Orchestrates LLM call #2 (`LLMClient.resolve`), then
 * enriches the validated body with server facts (resolution id, source ref,
 * timestamp) and persists it as the audit entry — BEFORE any graph write.
 *
 * The audit-first ordering is the spec's invariant (§7): the resolution log is
 * the record of every decision, and the query compiler (§8) only ever reads a
 * `ResolutionResult`.
 */

export interface ResolveOutcome {
  resolution: ResolutionResult;
  resolution_file: string;
}

export async function resolveAndPersist(
  llm: LLMClient,
  extraction: ExtractionResult,
  candidates: CandidateSet,
  dataDir: string,
): Promise<ResolveOutcome> {
  const body = await llm.resolve(extraction, candidates);
  const resolution: ResolutionResult = {
    ...body,
    resolution_id: randomUUID(),
    source_extraction_ref: extraction.raw_source_ref,
    resolved_at: new Date().toISOString(),
  };
  const resolution_file = await saveResolution(dataDir, resolution);
  return { resolution, resolution_file };
}