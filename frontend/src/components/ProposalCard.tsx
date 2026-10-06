import type { Proposal } from "../api";

/**
 * The proposal surface. Three call sites (chat composer, diary composer, one
 * per diary entry) rendered one way, because "Accept & Execute" has to mean
 * the same thing everywhere it appears.
 */

interface ProposalCardProps {
  proposal: Proposal;
  executing: boolean;
  onAccept: () => void;
  onDiscard: () => void;
  /** Shown when the proposer returned zero steps. */
  nothingToDo?: string;
}

export default function ProposalCard({
  proposal,
  executing,
  onAccept,
  onDiscard,
  nothingToDo = "Nothing new to save. Either there was nothing substantial here, or the graph already knows all of it.",
}: ProposalCardProps) {
  const empty = proposal.steps.length === 0;

  return (
    <div className="proposal">
      <h3>Proposal</h3>
      <p className="lead">{proposal.human_text}</p>

      {empty ? (
        <p className="empty-note">{nothingToDo}</p>
      ) : (
        <>
          <ol className="steps">
            {proposal.steps.map((s) => (
              <li key={s.seq}>
                <span className="tool">{s.tool}</span>
                {s.human_text}
                <pre>{JSON.stringify(s.args, null, 2)}</pre>
              </li>
            ))}
          </ol>

          <div className="proposal-actions">
            <button className="btn btn-act" onClick={onAccept} disabled={executing}>
              {executing ? "Writing…" : "Accept and write"}
            </button>
            <button className="btn btn-quiet" onClick={onDiscard} disabled={executing}>
              Discard
            </button>
          </div>
        </>
      )}

      <p className="proposal-meta">
        {proposal.proposal_id} · judge {String(proposal.judge_approved)}
      </p>
    </div>
  );
}