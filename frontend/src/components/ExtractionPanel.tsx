import type { Extraction } from "../api";

/**
 * What the extraction pass found: the summary, the entities it recognised,
 * the links between them, and the tone. Rendered identically in the chat rail
 * and under each diary entry.
 */

export interface GraphWrite {
  summary: string | null;
  warning: string | null;
}

interface ExtractionPanelProps {
  extraction: Extraction;
  graphWrite?: GraphWrite | null;
}

export default function ExtractionPanel({ extraction, graphWrite }: ExtractionPanelProps) {
  return (
    <>
      <p className="lead-line">{extraction.summary}</p>
      <p className="meta-line">tone: {extraction.mood_or_tone ?? "unstated"}</p>

      {extraction.nodes.length > 0 && (
        <div className="chips">
          {extraction.nodes.map((n, i) => (
            <span
              key={`${n.name}-${i}`}
              className="chip"
              title={`${n.category} · ${Math.round(n.confidence * 100)}% confident${
                n.tags.length ? " · " + n.tags.join(", ") : ""
              }`}
            >
              {n.name}
              <em>{n.category}</em>
            </span>
          ))}
        </div>
      )}

      {extraction.edges.length > 0 && (
        <ul className="edges">
          {extraction.edges.map((e, i) => (
            <li key={`${e.from}-${e.relation}-${e.to}-${i}`}>
              {e.from} <span className="rel">—{e.relation}→</span> {e.to}
            </li>
          ))}
        </ul>
      )}

      {extraction.tags.length > 0 && (
        <div className="hashes">
          {extraction.tags.map((tag) => (
            <span key={tag}>#{tag}</span>
          ))}
        </div>
      )}

      {graphWrite?.summary && (
        <p className="written">
          <strong>Written to the graph.</strong> {graphWrite.summary}
        </p>
      )}

      {graphWrite?.warning && (
        <p className="notice notice-inset">
          <span>
            The extraction is saved. The graph step didn&apos;t finish: {graphWrite.warning}
          </span>
        </p>
      )}

      <p className="meta-line source-ref">
        {extraction.raw_source_ref}
      </p>
    </>
  );
}