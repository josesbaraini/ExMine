/**
 * Phase 4 §3/§7 — the propose→judge loop. This module is the heart of the
 * new analyse pipeline and replaces the old extract→link path for chat.
 *
 * Flow per round:
 *   gather evidence (searchContext) → proposer LLM → deterministic checks →
 *   judge LLM → approved? return : retry-with-reason (max 3 fixes)
 *
 * Outer loop: if all 3 fixes fail, discard the round and restart from zero
 *   (fresh gather + propose). Max 3 rounds (9 proposals total).
 *
 * Final fail: write a log file with every attempt and return an error object.
 */

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildProposalSystemPrompt, buildJudgeSystemPrompt } from "../llm/prompts";
import { searchContext } from "./search";
import type {
  CandidateSet,
  ChatMessage,
  ExtractionResult,
  JudgeResult,
  LLMClient,
  Proposal,
  ProposalStep,
} from "../types";
import type { GraphClient } from "./client";

export interface ProposeResult {
  ok: true;
  proposal: Proposal;
}

export interface ProposeFailure {
  ok: false;
  error: string;
  log_file: string;
}

export type AnalyseResult = ProposeResult | ProposeFailure;

const MAX_FIXES_PER_ROUND = 3;
const MAX_ROUNDS = 3;

/** Run the old extractor against the chat as the evidence-gathering sub-tool. */
async function gatherEvidence(
  chat: ChatMessage[],
  llm: LLMClient,
  graph: GraphClient,
  model?: string,
): Promise<{ extraction: ExtractionResult; candidates: CandidateSet }> {
  const transcript = chat.map(({ role, content }) => ({ role: role as "user" | "assistant", content }));
  let extraction: ExtractionResult;
  try {
    extraction = await llm.extract(transcript as ChatMessage[], {
      conversation_id: "analyse_gather",
      raw_source_ref: "analyse gather",
    }, model);
  } catch {
    // Extraction is an evidence-gathering sub-tool — never fatal to the
    // analyse pipeline. Fall back to a stub so the proposer still runs and
    // can propose from chat alone; the judge gate still guards quality.
    extraction = {
      conversation_id: "analyse_gather",
      extracted_at: new Date().toISOString(),
      raw_source_ref: "analyse gather (extract fallback)",
      summary: "",
      tags: [],
      nodes: [],
      edges: [],
      mood_or_tone: null,
    };
  }
  const candidates = await searchContext(extraction, graph);
  return { extraction, candidates };
}

export async function runAnalyse(
  chat: ChatMessage[],
  llm: LLMClient,
  graph: GraphClient,
  dataDir: string,
  model?: string,
): Promise<AnalyseResult> {
  const attempts: Array<{
    round: number;
    fix: number;
    proposalRaw: string;
    judgeRaw: string;
    judgeReason: string | null;
  }> = [];

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const { extraction, candidates } = await gatherEvidence(chat, llm, graph, model);
    const evidenceJson = JSON.stringify({ extraction, candidates }, null, 2);

    for (let fix = 1; fix <= MAX_FIXES_PER_ROUND; fix++) {
      const previousReason =
        attempts.length > 0 && attempts[attempts.length - 1].round === round
          ? attempts[attempts.length - 1].judgeReason
          : null;

      // --- LLM call A: proposer ---
      const proposalMessages: Array<{ role: "system" | "user" | "assistant" | "tool"; content: string }> = [
        { role: "system", content: buildProposalSystemPrompt() },
        {
          role: "user",
          content: JSON.stringify({
            chat: chat.map(({ role, content }) => ({ role, content })),
            evidence: evidenceJson,
            ...(previousReason ? { previous_judge_feedback: previousReason } : {}),
          }),
        },
      ];

      const proposalRaw = await llm.chat(
        proposalMessages as Array<{ role: "system" | "user" | "assistant" | "tool"; content: string }>,
        undefined,
        model,
      );
      const proposalText = typeof proposalRaw === "string" ? proposalRaw : (proposalRaw as { reply?: string }).reply ?? "";

      const parsed = parseProposal(proposalText);
      if (!parsed.ok) {
        attempts.push({ round, fix, proposalRaw: proposalText, judgeRaw: "", judgeReason: parsed.error });
        continue; // deterministic check failed → judge would reject anyway, treat as fix
      }

      const detFailures = deterministicCheck(parsed.proposal);
      if (detFailures.length > 0) {
        attempts.push({ round, fix, proposalRaw: proposalText, judgeRaw: "", judgeReason: detFailures.join("; ") });
        continue;
      }

      // --- LLM call B: judge ---
      const judgeRaw = await llm.chat([
        { role: "system", content: buildJudgeSystemPrompt() },
        {
          role: "user",
          content: JSON.stringify({
            chat: chat.map(({ role, content }) => ({ role, content })),
            evidence: evidenceJson,
            proposal: parsed.proposal,
          }),
        },
      ] as Array<{ role: "system" | "user" | "assistant" | "tool"; content: string }>, undefined, model);

      const judgeText = typeof judgeRaw === "string" ? judgeRaw : (judgeRaw as { reply?: string }).reply ?? "";
      const judge = parseJudge(judgeText);

      attempts.push({ round, fix, proposalRaw: proposalText, judgeRaw: judgeText, judgeReason: judge.reason ?? null });

      if (judge.approved) {
        return {
          ok: true,
          proposal: {
            proposal_id: randomUUID(),
            created_at: new Date().toISOString(),
            ...parsed.proposal,
            judge_approved: true,
            user_confirmed: false,
          },
        };
      }
    }
  }

  // Total failure — write the audit log
  const logDir = join(dataDir, "proposal-failures");
  await mkdir(logDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logPath = join(logDir, `failure-${stamp}-${randomUUID().slice(0, 8)}.json`);
  await writeFile(
    logPath,
    JSON.stringify(
      {
        chat_excerpt: chat.slice(-10),
        attempts,
        note: "9 proposal attempts (3 rounds × 3 fixes) exhausted without judge approval",
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  return {
    ok: false,
    error: "Couldn't build a safe proposal after 9 tries — nothing was changed.",
    log_file: logPath,
  };
}

function parseProposal(text: string): { ok: true; proposal: { human_text: string; steps: ProposalStep[] } } | { ok: false; error: string } {
  try {
    const json = JSON.parse(text.trim().replace(/^```json\s*/, "").replace(/```\s*$/, ""));
    if (typeof json.human_text !== "string" || !Array.isArray(json.steps)) {
      return { ok: false, error: "proposal missing human_text or steps array" };
    }
    return { ok: true, proposal: { human_text: json.human_text, steps: json.steps } };
  } catch {
    return { ok: false, error: "proposal is not valid JSON" };
  }
}

function deterministicCheck(proposal: { human_text: string; steps: ProposalStep[] }): string[] {
  const errors: string[] = [];
  if (typeof proposal.human_text !== "string" || proposal.human_text.trim() === "") {
    errors.push("human_text must be a non-empty string");
  }
  proposal.steps.forEach((step, i) => {
    if (typeof step.seq !== "number" || step.seq !== i + 1) {
      errors.push(`step ${i}: seq must be ${i + 1}`);
    }
    if (typeof step.human_text !== "string" || step.human_text.trim() === "") {
      errors.push(`step ${i}: human_text required`);
    }
    const validTools = ["create_node", "update_node", "merge_nodes", "delete_node", "create_edge", "update_edge", "delete_edge"];
    if (!validTools.includes(step.tool)) {
      errors.push(`step ${i}: unknown tool "${step.tool}"`);
    }
    if (typeof step.args !== "object" || step.args === null) {
      errors.push(`step ${i}: args must be an object`);
      return;
    }
    const args = step.args as Record<string, unknown>;
    const requireIdLike = (key: string) => {
      const v = args[key];
      if (typeof v !== "string" || v.trim() === "") errors.push(`step ${i} (${step.tool}): missing ${key}`);
      else if (!v.includes(":") && !v.match(/^\d+:\d+:\d+$/) && v.length < 4) errors.push(`step ${i} (${step.tool}): ${key} should be an elementId from evidence, got "${v}"`);
    };
    switch (step.tool) {
      case "create_node":
        if (typeof args.name !== "string" || args.name.trim() === "") errors.push(`step ${i}: create_node requires non-empty name`);
        if (typeof args.category !== "string" || args.category.trim() === "") errors.push(`step ${i}: create_node requires non-empty category`);
        break;
      case "update_node":
        requireIdLike("node_id");
        break;
      case "merge_nodes":
        requireIdLike("source_node_id");
        requireIdLike("target_node_id");
        break;
      case "delete_node":
        requireIdLike("node_id");
        break;
      case "create_edge": {
        const hasIds = typeof args.from_node_id === "string" && typeof args.to_node_id === "string";
        const hasNames = typeof args.from === "string" && typeof args.to === "string";
        if (!hasIds && !hasNames) errors.push(`step ${i} (create_edge): provide from_node_id+to_node_id OR from+to (names)`);
        if (hasIds) { requireIdLike("from_node_id"); requireIdLike("to_node_id"); }
        if (typeof args.relation !== "string" || args.relation.trim() === "") errors.push(`step ${i}: create_edge requires non-empty relation`);
        break;
      }
      case "update_edge":
        requireIdLike("edge_id");
        break;
      case "delete_edge":
        requireIdLike("edge_id");
        break;
    }
  });
  return errors;
}

function parseJudge(text: string): JudgeResult {
  try {
    const json = JSON.parse(text.trim().replace(/^```json\s*/, "").replace(/```\s*$/, ""));
    return { approved: !!json.approved, reason: typeof json.reason === "string" ? json.reason : undefined };
  } catch {
    return { approved: false, reason: "judge returned invalid JSON" };
  }
}
