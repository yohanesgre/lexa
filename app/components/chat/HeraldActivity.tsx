import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { MarkdownContent } from "../MarkdownContent";
import type { HeraldTimelineItem, HeraldToolChip } from "../../lib/use-herald-stream";

// Chronological reply timeline inside the assistant bubble
// (herald-chat.html): while STREAMING, reasoning bursts, verbose
// `[tool_name] detail…` lines and text deltas render IN FRAME ARRIVAL ORDER,
// interleaved and always expanded. On DONE, all process output hoists into
// ONE collapsible block at the top behind the "Thought for Ns · N tools"
// summary line — the reply text below stays clean for copy/select.
// Session-memory only — never rendered for turns loaded from a transcript.
export interface HeraldActivityProps {
  items: HeraldTimelineItem[];
  tools: HeraldToolChip[];
  reasoningActive: boolean;
  reasoningMs: number | null;
  // Done turn: process output collapses behind the summary line.
  done?: boolean | undefined;
  // Plain-text hook threaded through to text items' markdown renderer.
  renderText?: (text: string) => ReactNode;
}

function thoughtLabel(ms: number | null): string | null {
  if (ms === null) return null;
  return ms < 1000 ? "Thought for <1s" : `Thought for ${Math.round(ms / 1000)}s`;
}

function ReasoningRow({ item, active }: { item: Extract<HeraldTimelineItem, { kind: "reasoning" }>; active: boolean }) {
  // Expansion derives from the active prop; a user click sets a null-able
  // override that lasts until the parent drops the row's active state.
  const [override, setOverride] = useState<boolean | null>(null);
  const expanded = override ?? active;

  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = bodyRef.current;
    if (expanded && el) el.scrollTop = el.scrollHeight;
  }, [expanded, item.text]);

  const label = active ? "Thinking…" : thoughtLabel(item.ms) ?? "Thought";
  return (
    <div className="herald-activity">
      <button type="button" className="herald-activity-toggle" aria-expanded={expanded} onClick={() => setOverride(!expanded)}>
        <svg className={expanded ? "herald-activity-chevron" : "herald-activity-chevron collapsed"} viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="m6 9 6 6 6-6" />
        </svg>
        <span>{label}</span>
      </button>
      {expanded && (
        <div ref={bodyRef} className="herald-activity-reasoning">
          {item.text}
        </div>
      )}
    </div>
  );
}

function ToolLine({ chip }: { chip: HeraldToolChip }) {
  return (
    <Fragment>
      <div className={chip.phase === "result" ? "herald-activity-tool done" : "herald-activity-tool"}>
        <span className="herald-activity-tool-name">[{chip.name}]</span>
        <span className="herald-activity-tool-detail">{chip.detail ?? chip.label}</span>
        {chip.phase === "call" && (
          <span className="herald-activity-caret" aria-hidden="true">
            ▍
          </span>
        )}
      </div>
      {chip.phase === "result" && chip.resultDetail && <div className="herald-activity-result">↳ {chip.resultDetail}</div>}
    </Fragment>
  );
}

export function HeraldActivity({ items, tools, reasoningActive, reasoningMs, done = false, renderText }: HeraldActivityProps) {
  if (done) {
    return (
      <DoneFold
        items={items.filter((it): it is Exclude<HeraldTimelineItem, { kind: "text" }> => it.kind !== "text")}
        tools={tools}
        reasoningMs={reasoningMs}
      />
    );
  }

  // Streaming: every element expanded, chronological, no folding.
  // Pre-first-token window: no frames yet — a lone caret keeps the bubble
  // visibly alive instead of rendering empty space while STREAMING runs.
  if (items.length === 0) {
    return (
      <>
        <div className="bubble-meta">Herald · Herald Agent persona</div>
        <div className="bubble-md">
          <span className="herald-stream-caret" aria-hidden="true">
            ▍
          </span>
        </div>
      </>
    );
  }
  const lastReasoningItem = items.findLast((it) => it.kind === "reasoning");
  return (
    <>
      {items.map((item) => {
        if (item.kind === "text") {
          const isLatest = item === items[items.length - 1];
          return (
            <div key={item.id} className="bubble-md">
              <MarkdownContent
                md={item.text}
                renderText={renderText}
                trailing={isLatest ? <span className="herald-stream-caret">▍</span> : undefined}
              />
            </div>
          );
        }
        if (item.kind === "tool") {
          return (
            <div key={item.id} className="herald-activity">
              <ToolLine chip={item.chip} />
            </div>
          );
        }
        const rowActive = reasoningActive && item === lastReasoningItem;
        return <ReasoningRow key={item.id} item={item} active={rowActive} />;
      })}
    </>
  );
}

// Done-fold strip: compact summary line toggling ALL non-text timeline items
// (arrival order, plain per-call lines) ABOVE the reply. HeraldChatPage
// renders the reply text outside this block, so copying the bubble yields
// the clean answer. Kept separate so streaming and fold never share state.
function DoneFold({ items, tools, reasoningMs }: {
  items: Array<Extract<HeraldTimelineItem, { kind: "tool" | "reasoning" }>>;
  tools: HeraldToolChip[];
  reasoningMs: number | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const summary =
    [thoughtLabel(reasoningMs), tools.length > 0 ? `${tools.length} tool${tools.length === 1 ? "" : "s"}` : null]
      .filter((part): part is string => part !== null)
      .join(" · ") || null;
  if (!summary) return null;
  const bodyVisible = expanded && items.length > 0;
  return (
    <div className="herald-activity">
      <button type="button" className="herald-activity-toggle" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
        <svg className={expanded ? "herald-activity-chevron" : "herald-activity-chevron collapsed"} viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="m6 9 6 6 6-6" />
        </svg>
        <span>{summary}</span>
      </button>
      {bodyVisible &&
        items.map((item) =>
          item.kind === "reasoning" ? (
            item.text ? <div key={item.id} className="herald-activity-reasoning">{item.text}</div> : null
          ) : (
            <ToolLine key={item.id} chip={item.chip} />
          )
        )}
    </div>
  );
}