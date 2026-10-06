import { useEffect, useState } from "react";
import { api, ApiError, type DiaryEntry, type AnalyseResponse, type Proposal } from "./api";
import PipelineRail, { type NodeStatus } from "./components/PipelineRail";
import ProposalCard from "./components/ProposalCard";
import ExtractionPanel from "./components/ExtractionPanel";

/**
 * The Write surface — the other fork into the same pipeline.
 *
 * One textarea, two actions. Save persists the entry FIRST and then runs the
 * extraction pass on it, so an extraction failure can never cost you the
 * writing. Analyse proposes graph writes without saving anything. Entries are
 * append-only.
 */

const FOLD_AT = 400;

interface DiaryPageProps {
  /** Owned by the chrome bar so both surfaces use one picker. */
  model: string;
}

function stampOf(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime())
    ? ""
    : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function readError(err: unknown): string {
  if (err instanceof ApiError) {
    return err.providerMessage ? `${err.message} — ${err.providerMessage}` : err.message;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

export default function DiaryPage({ model }: DiaryPageProps) {
  const [text, setText] = useState("");
  const [entries, setEntries] = useState<DiaryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [fault, setFault] = useState<string | null>(null);

  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [analysing, setAnalysing] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [analysingId, setAnalysingId] = useState<string | null>(null);
  const [written, setWritten] = useState<string | null>(null);

  const [unfolded, setUnfolded] = useState<Set<string>>(new Set());

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const res = await api<{ entries: DiaryEntry[] }>("/api/diary/entries");
        if (live) setEntries(res.entries);
      } catch (err) {
        if (live) setFault(readError(err));
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  async function save() {
    const value = text.trim();
    if (!value || saving) return;
    setSaving(true);
    setFault(null);
    try {
      const res = await api<{ entry: DiaryEntry }>("/api/diary/entries", {
        method: "POST",
        body: JSON.stringify({ text: value, model: model || undefined }),
      });
      // The store returns oldest-first; the list reads newest-first.
      setEntries((prev) => [res.entry, ...prev]);
      setText("");
    } catch (err) {
      setFault(readError(err));
    } finally {
      setSaving(false);
    }
  }

  async function analyse(body: string, entryId: string | null) {
    if (!body.trim() || analysing) return;
    setAnalysing(true);
    setAnalysingId(entryId);
    setFault(null);
    setProposal(null);
    setTarget(entryId);
    try {
      const res = await api<AnalyseResponse>("/api/analyse", {
        method: "POST",
        body: JSON.stringify({ text: body, model: model || undefined }),
      });
      if (res.error || !res.proposal) setFault(res.error ?? "The proposer came back empty.");
      else setProposal(res.proposal);
    } catch (err) {
      if (err instanceof ApiError && err.code === "GRAPH_UNAVAILABLE") {
        setFault("Can't reach the graph. Is Neo4j running? Check with docker compose ps.");
      } else if (err instanceof ApiError && err.code === "LLM_PROVIDER_ERROR") {
        setFault(
          `The AI provider rejected the request${err.providerMessage ? ` — ${err.providerMessage}` : ""}. It's logged in data/logs/operations.jsonl.`,
        );
      } else {
        setFault(readError(err));
      }
    } finally {
      setAnalysing(false);
      setAnalysingId(null);
    }
  }

  async function accept() {
    if (!proposal || executing) return;
    setExecuting(true);
    setFault(null);
    try {
      const res = await api<{ ok: boolean; applied: number; errors?: string[] }>("/api/propose/execute", {
        method: "POST",
        body: JSON.stringify({ proposal }),
      });
      if (!res.ok) {
        setFault(
          `${res.applied} of ${proposal.steps.length} steps written, then it stopped: ${res.errors?.join("; ") ?? "no reason given"}.`,
        );
        return;
      }
      setWritten(res.applied === 1 ? "1 step written." : `${res.applied} steps written.`);
      setProposal(null);
      setTarget(null);
    } catch (err) {
      setFault(readError(err));
    } finally {
      setExecuting(false);
    }
  }

  function fold(id: string) {
    setUnfolded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const newest = [...entries].sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  const capture: NodeStatus = text.trim() || entries.length > 0 ? "active" : "idle";
  const analyseStage: NodeStatus = analysing ? "live" : proposal || written ? "done" : "idle";
  const decision: NodeStatus = proposal ? "ready" : written ? "done" : "idle";
  const graphStage: NodeStatus = written ? "done" : "idle";

  const composerProposal = proposal && target === null ? proposal : null;

  return (
    <div className="page">
      <section className="surface">
        <div className="column">
          {fault && (
            <p className="notice notice-top">
              <span>{fault}</span>
              <button onClick={() => setFault(null)} aria-label="Dismiss">
                ✕
              </button>
            </p>
          )}

          <div className="diary-write">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Freeform. Whatever's on your mind — saving it also pulls out people, projects, and links."
            />
            <div className="diary-actions">
              <button className="btn btn-info" onClick={() => void save()} disabled={saving || !text.trim()}>
                {saving ? "Saving…" : "Save entry"}
              </button>
              <button
                className="btn btn-act"
                onClick={() => void analyse(text, null)}
                disabled={analysing || !text.trim()}
              >
                {analysing && target === null ? "Reading…" : "Propose graph writes"}
              </button>
              {saving && <span className="hint">Your text is already safe on disk.</span>}
            </div>
          </div>

          <h2 className="section-head">Past entries</h2>
          <p className="section-sub">
            {newest.length > 0
              ? `${newest.length} saved. Newest first.`
              : "Nothing written yet."}
          </p>

          {loading ? (
            <p className="empty-note">Loading your entries…</p>
          ) : newest.length === 0 ? (
            <p className="empty-note">Write something above and save it. It lands here with whatever Jarvis pulled out of it.</p>
          ) : (
            <ul className="entries">
              {newest.map((entry) => {
                const long = entry.text.length > FOLD_AT;
                const open = unfolded.has(entry.id);

                return (
                  <li key={entry.id} className="entry">
                    <div className="entry-head">
                      <time>{stampOf(entry.timestamp)}</time>
                      <span>{entry.id.slice(0, 8)}</span>
                    </div>

                    <p className="entry-text">
                      {long && !open ? `${entry.text.slice(0, FOLD_AT).trimEnd()}…` : entry.text}
                      {long && (
                        <button className="entry-fold" onClick={() => fold(entry.id)}>
                          {open ? "Show less" : "Show more"}
                        </button>
                      )}
                    </p>

                    {entry.warning ? (
                      <p className="notice entry-notice">
                        <span>
                          Saved, but extraction didn&apos;t finish: {entry.warning}
                        </span>
                      </p>
                    ) : (
                      entry.extraction && (
                        <div className="entry-extract">
                          <ExtractionPanel extraction={entry.extraction} />
                          <button
                            className="btn btn-quiet btn-tiny"
                            onClick={() => void analyse(entry.text, entry.id)}
                            disabled={analysing}
                          >
                            {analysing && analysingId === entry.id
                              ? "Reading…"
                              : "Propose graph writes"}
                          </button>

                          {fault && analysingId === entry.id && (
                            <p className="note-inset">{fault}</p>
                          )}
                          {proposal && target === entry.id && (
                            <div className="entry-proposal">
                              <ProposalCard
                                proposal={proposal}
                                executing={executing}
                                onAccept={() => void accept()}
                                onDiscard={() => {
                                  setProposal(null);
                                  setTarget(null);
                                }}
                                nothingToDo="Nothing new to save. Either this entry had nothing substantial in it, or the graph already knows all of it."
                              />
                            </div>
                          )}
                        </div>
                      )
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>

      <aside className="rail">
        <section className="bay">
          <h2 className="bay-title">Pipeline</h2>
          <PipelineRail
            source="write"
            capture={capture}
            analyse={analyseStage}
            decision={decision}
            graph={graphStage}
            written={written}
          />
        </section>

        {composerProposal && (
          <section className="bay">
            <h2 className="bay-title">
              Needs your call
              <button className="x" onClick={() => setProposal(null)} aria-label="Dismiss proposal">
                ✕
              </button>
            </h2>
            <ProposalCard
              proposal={composerProposal}
              executing={executing}
              onAccept={() => void accept()}
              onDiscard={() => setProposal(null)}
            />
          </section>
        )}

        <section className="bay">
          <h2 className="bay-title">How a write happens</h2>
          <ol className="steps flush-end">
            <li>Saving runs the extraction pass. Nothing reaches Neo4j from it.</li>
            <li>Proposing reads your text and drafts graph writes, then checks each one.</li>
            <li>You accept the whole proposal or none of it. There is no partial accept.</li>
          </ol>
        </section>
      </aside>
    </div>
  );
}