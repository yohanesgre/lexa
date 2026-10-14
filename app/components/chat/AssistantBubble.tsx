import { useMemo, type ReactNode } from "react";
import { AlertCircle } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { highlightCode } from "../../lib/markdownToReact";
import { MarkdownContent } from "../MarkdownContent";
import { withKeys } from "../../lib/withKeys";
import { AssistantActivity } from "./AssistantActivity";
import { AssistantApprovalBatch, SuspendedIndicator } from "./AssistantApprovals";
import type { ApprovalChip } from "./AssistantApprovals";
import { CopyButton, ExternalIcon, GlobeIcon, GearIcon, RegenerateIcon } from "./assistant-chat-icons";
import { GUIDANCE_BODY, guidanceFor, hhmm, splitFences, turnMayHaveAppliedWrite } from "./assistant-chat-utils";
import type { ActivityView, ChatTurn } from "./assistant-chat-utils";
// Assistant turn bubble (assistant-chat.html + assistant-chat-upgrades.html):
// meta line, error guidance panel, activity fold, fenced/markdown body,
// approval batch, citation chips, stopped row.

function AssistantErrorPanel({
  error,
  projectId,
  streaming,
  hasPartial,
  canManageSettings,
  isMember,
  canRetry,
  canReconnect,
  onRetry,
  onReconnect,
}: {
  error: { code: string; message: string };
  projectId?: string | undefined;
  streaming: boolean;
  hasPartial: boolean;
  canManageSettings: boolean;
  isMember: boolean;
  canRetry: boolean;
  canReconnect: boolean;
  onRetry: () => void;
  onReconnect: () => void;
}) {
  const guidance = guidanceFor(error.code);
  const guidanceBody = GUIDANCE_BODY[error.code] ?? "The reply failed. Check the output and activity above before taking another action.";
  const body = hasPartial
    ? error.code === "ASSISTANT_GENERATION_FAILED"
      ? "The reply stopped before it finished. Reload chat history to check saved output."
      : `The reply stopped before it finished. ${guidanceBody}`
    : guidanceBody;
  return (
    <div className="notice notice-danger" role="alert">
      <AlertCircle aria-hidden="true" size={14} strokeWidth={1.5} />
      <div className="text-xs text-lx-text-secondary" style={{ lineHeight: "16px" }}>
        <p>{body}</p>
        {guidance === "settings" && isMember && !canManageSettings && (
          <p className="mt-1">Ask a workspace admin to configure Assistant.</p>
        )}
        {guidance === "settings" && canManageSettings && projectId && (
          <div className="flex items-center gap-2 mt-2">
            <span>Fix provider settings:</span>
            <Link
              to="/settings/project/$projectId"
              params={{ projectId }}
              className="chip"
              style={{ display: "inline-flex", alignItems: "center", gap: 5, height: 22, padding: "0 8px", color: "var(--lx-text-link)", textDecoration: "none" }}
            >
              <GearIcon />
              <span className="font-micro text-2xs">Project Settings → Assistant</span>
              <ExternalIcon />
            </Link>
          </div>
        )}
        {canReconnect && (
          <div className="mt-2">
            <button type="button" className="btn btn-ghost btn-sm" disabled={streaming} onClick={onReconnect}>
              Reconnect
            </button>
            <span className="text-xs text-lx-text-muted ml-2">
              Delivers the missing tail from this turn; it does not start a new generation.
            </span>
          </div>
        )}
        {guidance === "retry" && canRetry && (
          <div className="mt-2">
            <button type="button" className="btn btn-primary btn-sm" disabled={streaming} onClick={onRetry}>
              <RegenerateIcon />
              Retry
            </button>
          </div>
        )}
        {!canRetry && (
          <p className="mt-1">Check affected items before starting another reply. Changes already applied are not undone.</p>
        )}
      </div>
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
          <div key={key} className="assistant-codeblock">
            <span className="assistant-codeblock-chrome">
              {seg.lang && <span className="assistant-codeblock-lang">{seg.lang}</span>}
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
  onRejectAll,
  onActiveChipChange,
}: {
  batch: ChatTurn["batch"];
  suspendedBatchId: string | undefined;
  batchBusy: boolean;
  onDecide: (chip: ApprovalChip, verdict: "approve" | "reject") => void;
  onApproveAll: (chips: ApprovalChip[]) => void;
  onRejectAll: (chips: ApprovalChip[]) => void;
  onActiveChipChange?: ((chip: ApprovalChip) => void) | undefined;
}) {
  return (
    <>
      {batch && batch.chips.length > 0 && (
        <AssistantApprovalBatch
          chips={batch.chips}
          locked={batchBusy}
          onDecide={onDecide}
          onApproveAll={() => onApproveAll(batch.chips)}
          onRejectAll={() => onRejectAll(batch.chips)}
          onActiveChipChange={onActiveChipChange}
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

export function AssistantBubble({
  turn,
  projectId,
  streaming,
  renderText,
  activity,
  usage,
  batchBusy,
  onDecide,
  onApproveAll,
  onRejectAll,
  onRetry,
  canReconnect,
  onReconnect,
  canManageSettings,
  isProjectMember,
  onActiveChipChange,
}: {
  turn: ChatTurn;
  projectId?: string | undefined;
  streaming: boolean;
  renderText: (text: string) => ReactNode;
  activity?: ActivityView | undefined;
  usage?: { in: number; out: number } | null | undefined;
  batchBusy: boolean;
  onDecide: (chip: ApprovalChip, verdict: "approve" | "reject") => void;
  onApproveAll: (chips: ApprovalChip[]) => void;
  onRejectAll: (chips: ApprovalChip[]) => void;
  onRetry: () => void;
  canReconnect: boolean;
  onReconnect: () => void;
  canManageSettings: boolean;
  isProjectMember: boolean;
  onActiveChipChange?: ((chip: ApprovalChip) => void) | undefined;
}) {
  const time = hhmm(turn.ts);
  // Persona label mirrors the project's configured agent (read-only — chat
  // always runs the Assistant lane, so it is always the Assistant Agent).
  // Skills ride `$name` per message, so the meta names no skill.
  const meta = `Assistant · Assistant Agent persona${turn.stopped ? " · stopped" : ""}`;
  const mayHaveApplied = turnMayHaveAppliedWrite(turn, activity);
  const canRetry = !mayHaveApplied;
  return (
    <div className="bubble-ai">
      <div className="bubble-meta">
        {meta}
        {time ? ` · ${time}` : ""}
        <span className="bubble-meta-copy">
          <CopyButton text={turn.text} label="Copy reply" />
        </span>
      </div>

      {activity && (
        <AssistantActivity
          items={activity.items}
          tools={activity.tools}
          reasoningActive={false}
          reasoningMs={activity.reasoningMs}
          done
        />
      )}
      {turn.text && <AssistantSegments text={turn.text} renderText={renderText} />}
      {usage && (
        <div className="font-micro text-2xs text-lx-text-muted mt-2" style={{ textTransform: "uppercase", letterSpacing: "0.04em" }}>
          ↑ {usage.in.toLocaleString("en-US")} · ↓ {usage.out.toLocaleString("en-US")} tokens
        </div>
      )}
      <AssistantBatch
        batch={turn.batch}
        suspendedBatchId={turn.suspendedBatchId}
        batchBusy={batchBusy}
        onDecide={onDecide}
        onApproveAll={onApproveAll}
        onRejectAll={onRejectAll}
        onActiveChipChange={onActiveChipChange}
      />
      <CitationsRow citations={turn.citations} />
      {turn.error && (
        <AssistantErrorPanel
          error={turn.error}
          projectId={projectId}
          canReconnect={canReconnect}
          onReconnect={onReconnect}
          streaming={streaming}
          hasPartial={turn.text.length > 0}
          canManageSettings={canManageSettings}
          isMember={isProjectMember}
          canRetry={canRetry}
          onRetry={onRetry}
        />
      )}
      {turn.stopped && (
        <>
          <div className="notice mt-2" role="status">
            <AlertCircle aria-hidden="true" size={14} strokeWidth={1.5} />
            <span>
              Reply stopped.
              {mayHaveApplied ? " Changes already applied are not undone." : ""}
            </span>
          </div>
          {canRetry ? (
            <button type="button" className="btn btn-primary btn-sm mt-2" disabled={streaming} onClick={onRetry}>
              <RegenerateIcon />
              Retry
            </button>
          ) : (
            <p className="text-xs text-lx-text-secondary mt-1">Check affected items before starting another reply.</p>
          )}
        </>
      )}
    </div>
  );
}
