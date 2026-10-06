import { useEffect, useRef, useState } from "react";
import { api, ApiError, type Extraction, type AnalyseResponse, type Proposal } from "./api";
import DiaryPage from "./DiaryPage";
import PipelineRail, { type NodeStatus } from "./components/PipelineRail";
import ProposalCard from "./components/ProposalCard";
import ExtractionPanel from "./components/ExtractionPanel";

interface Message {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

interface ChatResponse {
  conversation_id: string;
  reply: string;
  messages: Message[];
}

interface SavedConversation {
  conversation_id: string;
  messages: Message[];
}

const SAVED_KEY = "jarvis.saved-conversations";
const MODEL_KEY = "jarvis.selectedModel";
const WAITING = "(typing…)";
const WORKING = "(working…)";

const PRESETS = [
  "Plan a weekend trip to the coast",
  "I'm overwhelmed by work, want to talk",
  "How do I write a retry loop in TypeScript?",
];

function loadSavedIds(): Array<{ id: string; at: string }> {
  try {
    const raw = localStorage.getItem(SAVED_KEY);
    return raw ? (JSON.parse(raw) as Array<{ id: string; at: string }>) : [];
  } catch {
    return [];
  }
}

function forget(id: string): Array<{ id: string; at: string }> {
  const next = loadSavedIds().filter((s) => s.id !== id);
  localStorage.setItem(SAVED_KEY, JSON.stringify(next));
  return next;
}

/** The server forgot this conversation (restart) — history lives in memory until saved. */
const STALE =
  "The server restarted, so this conversation is gone from memory. Anything already saved to disk is untouched. Start again.";

function clockOf(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function readError(err: unknown): string {
  if (err instanceof ApiError) {
    return err.providerMessage ? `${err.message} — ${err.providerMessage}` : err.message;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

export default function App() {
  const [mode, setMode] = useState<"talk" | "write">("talk");

  // Lifted out of the pages: the picker used to be fetched and rendered twice,
  // once per page, and both copies disagreed after a model change.
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState("");

  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [analysing, setAnalysing] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [written, setWritten] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState(loadSavedIds());
  const [archive, setArchive] = useState<{
    id: string;
    conversation: SavedConversation;
    extraction: Extraction | null;
  } | null>(null);

  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const res = await api<{ models: string[] }>("/api/models");
        if (!live) return;
        setModels(res.models);
        const remembered = localStorage.getItem(MODEL_KEY);
        setModel(
          remembered && res.models.includes(remembered) ? remembered : (res.models[0] ?? ""),
        );
      } catch {
        if (live) setModels([]);
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, analysing]);

  /** One conversation is lost — drop the local half so the next send starts clean. */
  function dropConversation() {
    setConversationId(null);
    setMessages([]);
    setProposal(null);
    setWritten(null);
  }

  async function send(preset?: string) {
    const text = (preset ?? draft).trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<ChatResponse>("/api/chat", {
        method: "POST",
        body: JSON.stringify({ conversation_id: conversationId, message: text, model: model || undefined }),
      });
      setConversationId(res.conversation_id);
      setMessages(res.messages);
      setDraft("");
    } catch (err) {
      if (err instanceof ApiError && err.code === "UNKNOWN_CONVERSATION") {
        dropConversation();
        setError(STALE);
      } else {
        setError(readError(err));
      }
    } finally {
      setBusy(false);
    }
  }

  async function analyse() {
    if (!conversationId || analysing) return;
    setAnalysing(true);
    setError(null);
    setProposal(null);
    try {
      const res = await api<AnalyseResponse>("/api/analyse", {
        method: "POST",
        body: JSON.stringify({ conversation_id: conversationId, model: model || undefined }),
      });
      if (res.error || !res.proposal) setError(res.error ?? "The proposer came back empty.");
      else setProposal(res.proposal);
    } catch (err) {
      if (err instanceof ApiError && err.code === "UNKNOWN_CONVERSATION") {
        dropConversation();
        setError(STALE);
      } else if (err instanceof ApiError && err.code === "GRAPH_UNAVAILABLE") {
        setError("Can't reach the graph. Is Neo4j running? Check with docker compose ps.");
      } else if (err instanceof ApiError && err.code === "LLM_PROVIDER_ERROR") {
        setError(
          `The AI provider rejected the request${err.providerMessage ? ` — ${err.providerMessage}` : ""}. It's logged in data/logs/operations.jsonl.`,
        );
      } else {
        setError(readError(err));
      }
    } finally {
      setAnalysing(false);
    }
  }

  async function accept() {
    if (!proposal || executing) return;
    setExecuting(true);
    setError(null);
    try {
      const res = await api<{ ok: boolean; applied: number; errors?: string[] }>("/api/propose/execute", {
        method: "POST",
        body: JSON.stringify({ proposal }),
      });
      if (!res.ok) {
        setError(
          `${res.applied} of ${proposal.steps.length} steps written, then it stopped: ${res.errors?.join("; ") ?? "no reason given"}.`,
        );
        return;
      }
      setWritten(
        res.applied === 1 ? "1 step written." : `${res.applied} steps written.`,
      );
      setProposal(null);
    } catch (err) {
      setError(readError(err));
    } finally {
      setExecuting(false);
    }
  }

  async function openArchived(id: string) {
    setError(null);
    try {
      const res = await api<{ conversation: SavedConversation; extraction: Extraction | null }>(
        `/api/conversations/${id}`,
      );
      setArchive({ id, ...res });
      dropConversation();
    } catch (err) {
      if (err instanceof ApiError && err.code === "NOT_FOUND") {
        setHistory(forget(id));
        setError("That conversation is no longer on disk, so it's been dropped from your list.");
      } else {
        setError(readError(err));
      }
    }
  }

  // Pipeline statuses, derived from state — never stored.
  const capture: NodeStatus = messages.length > 0 ? "active" : "idle";
  const analyseStage: NodeStatus = analysing ? "live" : proposal || written ? "done" : "idle";
  const decision: NodeStatus = proposal ? "ready" : written ? "done" : "idle";
  const graphStage: NodeStatus = written ? "done" : "idle";

  return (
    <div className="shell">
      <header className="topbar">
        <div className="lights" aria-hidden="true">
          <i />
          <i />
          <i />
        </div>

        <div className="brand">
          jarvis<span>single-user knowledge agent</span>
        </div>

        <div className="seg" role="group" aria-label="Surface">
          <button
            aria-pressed={mode === "talk"}
            onClick={() => {
              setError(null);
              setMode("talk");
            }}
          >
            Talk
          </button>
          <button
            aria-pressed={mode === "write"}
            onClick={() => {
              setError(null);
              setMode("write");
            }}
          >
            Write
          </button>
        </div>

        <div className="topbar-end">
          <select
            className="model"
            value={model}
            onChange={(e) => {
              setModel(e.target.value);
              localStorage.setItem(MODEL_KEY, e.target.value);
            }}
          >
            <option value="">Default model</option>
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>

          {mode === "talk" && (
            <button
              className="btn btn-quiet"
              onClick={() => {
                dropConversation();
                setError(null);
              }}
              disabled={busy || analysing}
            >
              New
            </button>
          )}
        </div>
      </header>

      {mode === "write" ? (
        <DiaryPage model={model} />
      ) : (
        <div className="page">
          <section className="surface">
            <div className="column">
              {error && (
                <p className="notice notice-top">
                  <span>{error}</span>
                  <button onClick={() => setError(null)} aria-label="Dismiss">
                    ✕
                  </button>
                </p>
              )}

              <div className="thread">
                {messages.length === 0 ? (
                  <div className="opener">
                    <h2>Say it however it comes out.</h2>
                    <p>
                      Jarvis pulls people, projects, and the links between them out of what you say.
                      Nothing reaches your knowledge graph until you approve it.
                    </p>
                    <div className="presets">
                      {PRESETS.map((p) => (
                        <button
                          key={p}
                          className="preset"
                          onClick={() => void send(p)}
                          disabled={busy}
                        >
                          {p}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  messages.map((m, i) => (
                    <div key={i} className={`turn ${m.role === "user" ? "you" : "jarvis"}`}>
                      <span className="who">
                        {m.role === "user" ? "you" : "jarvis"} · {clockOf(m.timestamp)}
                      </span>
                      <div className="said">{m.content}</div>
                    </div>
                  ))
                )}

                {(busy || analysing) && (
                  <div className="turn jarvis">
                    <span className="who">jarvis</span>
                    <div className="said waiting">{analysing ? WORKING : WAITING}</div>
                  </div>
                )}
              </div>

              <div ref={endRef} />

              <div className="composer">
                <textarea
                  value={draft}
                  rows={2}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                  placeholder="Enter sends. Shift+Enter starts a new line."
                />
                <div className="composer-row">
                  <button className="btn btn-info" onClick={() => void send()} disabled={busy || !draft.trim()}>
                    Send
                  </button>
                  <button
                    className="btn btn-act"
                    onClick={() => void analyse()}
                    disabled={analysing || busy || !conversationId}
                    title="Read the conversation and propose graph writes"
                  >
                    {analysing ? "Reading…" : "Propose graph writes"}
                  </button>
                </div>
              </div>
            </div>
          </section>

          <aside className="rail">
            <section className="bay">
              <h2 className="bay-title">Pipeline</h2>
              <PipelineRail
                source="talk"
                capture={capture}
                analyse={analyseStage}
                decision={decision}
                graph={graphStage}
                written={written}
              />
            </section>

            {proposal && (
              <section className="bay">
                <h2 className="bay-title">
                  Needs your call
                  <button className="x" onClick={() => setProposal(null)} aria-label="Dismiss proposal">
                    ✕
                  </button>
                </h2>
                <ProposalCard
                  proposal={proposal}
                  executing={executing}
                  onAccept={() => void accept()}
                  onDiscard={() => setProposal(null)}
                />
              </section>
            )}

            <section className="bay">
              <h2 className="bay-title">Past conversations</h2>
              {history.length === 0 ? (
                <p className="empty-note">
                  Nothing here yet. Saved conversations show up in this list.
                </p>
              ) : (
                <ul className="history">
                  {history.map((h) => (
                    <li key={h.id}>
                      <button onClick={() => void openArchived(h.id)}>
                        <span className="when">{new Date(h.at).toLocaleString()}</span>
                        {h.id.slice(0, 8)}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {archive && (
              <section className="bay">
                <h2 className="bay-title">
                  Saved conversation
                  <button className="x" onClick={() => setArchive(null)} aria-label="Close">
                    ✕
                  </button>
                </h2>
                <div className="archive">
                  {archive.conversation.messages.map((m, i) => (
                    <p key={i}>
                      <b>{m.role === "user" ? "you" : "jarvis"}</b> {m.content}
                    </p>
                  ))}
                </div>
                {archive.extraction && (
                  <div className="archive-extract">
                    <ExtractionPanel extraction={archive.extraction} />
                  </div>
                )}
              </section>
            )}
          </aside>
        </div>
      )}

      <footer className="footbar">
        <span>
          Everything stays on this machine — conversations and extractions in{" "}
          <code>./data/</code>, graph nodes in Neo4j.
        </span>
      </footer>
    </div>
  );
}