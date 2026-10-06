/**
 * The pipeline rail — the flow diagram from the reference, wired to the real
 * state machine instead of decorating it.
 *
 * Four stages, in the order they actually run:
 *   you → extract → your call → graph
 *
 * Blue marks state that exists (extraction ran, nodes were written).
 * Red marks the only stage that can change anything: the confirmation.
 * Statuses are derived by the page, never decided here.
 */

export type NodeStatus = "idle" | "active" | "live" | "ready" | "done";

export interface PipelineProps {
  source: "talk" | "write";
  capture: NodeStatus;
  analyse: NodeStatus;
  decision: NodeStatus;
  graph: NodeStatus;
  /** Written to the graph by the last successful execute, for the graph node. */
  written?: string | null;
}

export default function PipelineRail({
  source,
  capture,
  analyse,
  decision,
  graph,
  written,
}: PipelineProps) {
  return (
    <>
      <div className="fork" aria-hidden="true">
        <b data-on={source === "talk"}>talk</b>
        <b data-on={source === "write"}>write</b>
      </div>

      <ol className="pipe">
        <li data-status={capture}>
          <span className="pipe-name">You</span>
          <span className="pipe-note">
            {source === "talk" ? "Said it out loud" : "Wrote it down"}
          </span>
        </li>

        <li data-status={analyse}>
          <span className="pipe-name">Extract</span>
          <span className="pipe-note">
            {analyse === "live" ? "Reading it now" : "Entities, links, tone"}
          </span>
        </li>

        <li data-status={decision}>
          <span className="pipe-name">Your call</span>
          <span className="pipe-note">
            {decision === "ready"
              ? "Waiting on you — nothing is written yet"
              : "You confirm every write"}
          </span>
        </li>

        <li data-status={graph}>
          <span className="pipe-name">Graph</span>
          <span className="pipe-note">{written ?? "Neo4j, on your say-so"}</span>
        </li>
      </ol>
    </>
  );
}