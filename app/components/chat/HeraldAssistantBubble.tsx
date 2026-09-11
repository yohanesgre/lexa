import { useMemo, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { highlightCode } from "../../lib/markdownToReact";
import { MarkdownContent } from "../MarkdownContent";
import { withKeys } from "../../lib/withKeys";
import { HeraldActivity } from "./HeraldActivity";
import { HeraldApprovalBatch, SuspendedIndicator } from "./HeraldApprovals";
import type { ApprovalChip } from "./HeraldApprovals";
import { CopyButton, ExternalIcon, GlobeIcon, GearIcon, RegenerateIcon } from "./herald-chat-icons";
import { GUIDANCE_BODY, guidanceFor, hhmm, splitFences } from "./herald-chat-utils";
import type { ActivityView, ChatTurn } from "./herald-chat-utils";

// Assistant turn bubble (herald-chat.html + herald-chat-upgrades.html):
// meta line, error guidance panel, activity fold, fenced/markdown body,
// approval batch, citation chips, stopped row.

function AssistantErrorPanel({
  error,
  projectId,
  streaming,
  onRetry,
}: {
  error: { code: string; message: string };
  projectId?: string | undefined;
  streaming: boolean;
  onRetry: () => void;
}) {
  const guidance = guidanceFor(error.code);
  const body = error.message?.trim() || GUIDANCE_BODY[error.code] || "The reply failed. Nothing was added to the thread.";
  return (
    <div
      style={{
        background: "var(--lx-bg-danger-subtle)",
        border: "1px solid var(--lx-bg-danger-subtle)",
        borderRadius: "6px",
        padding: "10px 14px",
        overflow: "hidden",
      }}
    >
      <div className="font-mono text-xs font-medium" style={{ color: "var(--lx-text-danger)" }}>{error.code}</div>
      <div className="text-xs text-lx-text-secondary mt-1" style={{ lineHeight: "16px" }}>{body}</div>
      {guidance === "settings" && projectId && (
        <div className="flex items-center gap-2 mt-2">
          <span className="text-xs text-lx-text-secondary">Fix provider settings:</span>
          <Link
            to="/settings/project/$projectId"
            params={{ projectId }}
            className="chip"
            style={{ display: "inline-flex", alignItems: "center", gap: 5, height: 22, padding: "0 8px", color: "var(--lx-text-link)", textDecoration: "none" }}
          >
            <GearIcon />
            <span className="font-micro text-2xs">Project Settings → Herald</span>
            <ExternalIcon />
          </Link>
        </div>
      )}
      {guidance === "retry" && (
        <div className="mt-2">
          <button type="button" className="btn btn-primary btn-sm" disabled={streaming} onClick={onRetry}>
            <RegenerateIcon />
            Retry
          </button>
        </div>
      )}
    </div>
  );
}

// Code fences render as highlighted mono blocks; plain segments as markdown.
function AssistantSegments({ text, renderText }: { text: string; renderText: (text: string) => ReactNode }) {
  const segments = useMemo(() => splitFences(text), [text]);
  return (
    <>
      {withKeys(segments, (seg) => `${seg.fenced ? "f" : "t"}:${seg.lang ?? ""}:${seg.body.length}`).map(({ item: seg, key }) =>
        seg.fenced ? (
          <div key={key} className="herald-codeblock">
            <span className="herald-codeblock-chrome">
              {seg.lang && <span className="herald-codeblock-lang">{seg.lang}</span>}
              <CopyButton text={seg.body} label="Copy code" />
            </span>
            <code
              className="hljs-theme"
              dangerouslySetInnerHTML={{ __html: highlightCode(seg.body, seg.lang) }}
            />
          </div>
        ) : (
          <div key={key} className="bubble-md">
            <MarkdownContent md={seg.body} renderText={renderText} />
          </div>
        )
      )}
    </>
  );
}

// Frozen approval batch (session memory) + suspended waiting indicator for
// marker-only reloads.
function AssistantBatch({
  batch,
  suspendedBatchId,
  batchBusy,
  onDecide,
  onApproveAll,
}: {
  batch: ChatTurn["batch"];
  suspendedBatchId: string | undefined;
  batchBusy: boolean;
  onDecide: (chip: ApprovalChip, verdict: "approve" | "reject") => void;
  onApproveAll: (chips: ApprovalChip[]) => void;
}) {
  return (
    <>
      {batch && batch.chips.length > 0 && (
        <HeraldApprovalBatch
          chips={batch.chips}
          locked={batchBusy}
          onDecide={onDecide}
          onApproveAll={() => onApproveAll(batch.chips)}
        />
      )}
      {(batch ? batch.chips.some((c) => c.state === "pending") : !!suspendedBatchId) && <SuspendedIndicator />}
    </>
  );
}

function CitationsRow({ citations }: { citations: ChatTurn["citations"] }) {
  if (!citations || citations.length === 0) return null;
  return (
    <div className="flex items-center mt-2" style={{ gap: 6, flexWrap: "wrap" }}>
      {citations.map((c) => (
        <a
          key={c.url}
          className="chip"
          href={c.url}
          target="_blank"
          rel="noreferrer"
          style={{ display: "inline-flex", alignItems: "center", gap: 6, height: 22, padding: "0 8px", textDecoration: "none" }}
          title={c.url}
        >
          <GlobeIcon />
          <span className="font-micro text-2xs text-lx-text-muted">{c.hostname}</span>
          <span className="font-micro text-2xs text-lx-text-secondary truncate" style={{ maxWidth: 160 }}>{c.title ?? c.hostname}</span>
          <ExternalIcon />
        </a>
      ))}
    </div>
  );
}

export function HeraldAssistantBubble({
  turn,
  skillName,
  projectId,
  streaming,
  renderText,
  activity,
  batchBusy,
  onDecide,
  onApproveAll,
  onRetry,
}: {
  turn: ChatTurn;
  skillName?: string | undefined;
  projectId?: string | undefined;
  streaming: boolean;
  renderText: (text: string) => ReactNode;
  activity?: ActivityView | undefined;
  batchBusy: boolean;
  onDecide: (chip: ApprovalChip, verdict: "approve" | "reject") => void;
  onApproveAll: (chips: ApprovalChip[]) => void;
  onRetry: () => void;
}) {
  const time = hhmm(turn.ts);
  // Persona label mirrors the project's configured agent (read-only — chat
  // always runs the Herald lane, so it is always the Herald Agent).
  const meta = `Herald · Herald Agent persona${skillName ? ` · ${skillName}` : ""}${turn.stopped ? " · stopped" : ""}`;

  return (
    <div className="bubble-ai">
      <div className="bubble-meta">
        {meta}
        {time ? ` · ${time}` : ""}
        <span className="bubble-meta-copy">
          <CopyButton text={turn.text} label="Copy reply" />
        </span>
      </div>

      {turn.error ? (
        <AssistantErrorPanel error={turn.error} projectId={projectId} streaming={streaming} onRetry={onRetry} />
      ) : (
        <>
          {activity && (
            <HeraldActivity
              items={activity.items}
              tools={activity.tools}
              reasoningActive={false}
              reasoningMs={activity.reasoningMs}
              done
            />
          )}
          <AssistantSegments text={turn.text} renderText={renderText} />
          <AssistantBatch
            batch={turn.batch}
            suspendedBatchId={turn.suspendedBatchId}
            batchBusy={batchBusy}
            onDecide={onDecide}
            onApproveAll={onApproveAll}
          />
          <CitationsRow citations={turn.citations} />
          {turn.stopped && (
            <div className="flex items-center gap-2 mt-2">
              <span className="font-micro text-2xs text-lx-text-muted" style={{ textTransform: "uppercase", letterSpacing: "0.04em" }}>● Stopped</span>
              <span style={{ flex: 1, height: 1, background: "var(--lx-border-subtle)" }} />
              <button type="button" className="btn btn-primary btn-sm" disabled={streaming} onClick={onRetry}>
                <RegenerateIcon />
                Retry
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
