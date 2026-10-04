import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import { ArrowDown, FileText } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { renderTokenized } from "../../lib/tokenizeTranscript";
import { AssistantFlameIcon } from "../assistant/panel/AssistantFlameIcon";
import { CheckIcon, CopyButton, EditIcon, RegenerateIcon, XIcon } from "./assistant-chat-icons";
import { AssistantActivity } from "./AssistantActivity";
import { AssistantApprovalBatch } from "./AssistantApprovals";
import { hhmm, refKind } from "./assistant-chat-utils";
import type { ChatTurn } from "./assistant-chat-utils";
import { chatAttachmentUrl, type ChatAttachment } from "../../lib/api";
import { formatBytes, type ChatAttachmentRef } from "../../lib/assistant-image";
import type { useAssistantStream } from "../../lib/use-assistant-stream";

type Stream = ReturnType<typeof useAssistantStream>;

// Render-only pieces of the Assistant chat page (assistant-chat.html). State and
// stream orchestration stay in AssistantChatPage; these take props only.

export function ChatProviderMissingPanel({ projectId }: { projectId: string | undefined }) {
  return (
    <div className="chat-scroll">
      <div className="card-panel" style={{ maxWidth: 760, margin: "0 auto" }}>
        <div className="empty-state" style={{ padding: "32px 20px" }}>
          <div className="empty-state-icon">
            <AssistantFlameIcon size={24} />
          </div>
          <div className="text-sm font-medium text-lx-text-primary">No AI provider configured</div>
          <p className="text-xs text-lx-text-secondary mt-1" style={{ maxWidth: 260 }}>
            Set up a provider for this project in Project Settings → Assistant provider.
          </p>
          {projectId && (
            <div className="mt-3">
              <Link to="/settings/project/$projectId" params={{ projectId }} className="btn btn-primary btn-sm" style={{ textDecoration: "none" }}>
                Open Settings
              </Link>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function UserTurnEditor({
  draft,
  onDraftChange,
  onCommit,
  onCancel,
  style,
}: {
  draft: string;
  onDraftChange: (value: string) => void;
  onCommit: () => void;
  onCancel: () => void;
  style: React.CSSProperties;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  // Mount focus without the autoFocus attribute (a11y: no programmatic
  // focus steal after page load).
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <>
      <textarea
        ref={ref}
        rows={2}
        value={draft}
        onChange={(e) => onDraftChange(e.target.value)}
        placeholder="Enter save, Shift+Enter newline"
        title="Enter save, Shift+Enter newline"
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onCommit();
          } else if (e.key === "Enter" && e.shiftKey) {
            // allow newline
          }
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        aria-label="Edit message"
        style={style}
      />
      <div className="flex items-center justify-end gap-2 mt-2">
        <button type="button" className="btn btn-primary btn-icon-sm" title="Save edit (Enter)" aria-label="Save edit" onClick={onCommit}>
          <CheckIcon />
        </button>
        <button type="button" className="icon-btn" title="Cancel edit (Esc)" aria-label="Cancel edit" onClick={onCancel}>
          <XIcon />
        </button>
      </div>
    </>
  );
}

// Sent-message attachments (herald-chat.html "Sent-message rendering"): images
// resolve as storage-ref thumbnails inside the user bubble (local object URL
// while optimistic, chat attachment serve URL after reload), documents as a
// glyph + name + size chip. Both re-appear on reload because they ride the
// persisted turn.
function SentAttachment({ att, index }: { att: ChatAttachmentRef; index: Map<string, ChatAttachment> | undefined }) {
  const meta = index?.get(att.storageKey);
  const name = att.name || meta?.filename || "";
  const size = att.sizeBytes ?? meta?.sizeBytes;
  if (refKind(att.mimeType) === "image") {
    const src = (meta ? chatAttachmentUrl(meta.id) : undefined) ?? att.previewUrl;
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {src ? (
          <img alt={name} src={src} style={{ width: 56, height: 56, border: "1px solid var(--lx-border-default)", borderRadius: 6, background: "var(--lx-surface-card-hover)", objectFit: "cover" }} />
        ) : (
          <div style={{ width: 56, height: 56, border: "1px solid var(--lx-border-default)", borderRadius: 6, background: "var(--lx-surface-card-hover)" }} />
        )}
        {name && <span className="font-micro text-2xs text-lx-text-muted truncate" style={{ maxWidth: 72 }}>{name}</span>}
      </div>
    );
  }
  return (
    <span className="deck-attach-item" style={{ background: "var(--lx-surface-card)" }}>
      <FileText size={14} strokeWidth={1.5} style={{ color: "var(--lx-text-muted)", flexShrink: 0 }} />
      {name || "document"}{size !== undefined ? ` · ${formatBytes(size)}` : ""}
    </span>
  );
}

export function UserTurnBubble({
  turn,
  pos,
  slug,
  editing,
  editDraft,
  onEditDraftChange,
  onBeginEdit,
  onCancelEdit,
  onCommitEdit,
  lastUser,
  streaming,
  onRegenerate,
  attachmentIndex,
}: {
  turn: ChatTurn;
  pos: number;
  slug: string;
  editing: boolean;
  editDraft: string;
  onEditDraftChange: (value: string) => void;
  onBeginEdit: () => void;
  onCancelEdit: () => void;
  onCommitEdit: () => void;
  lastUser: boolean;
  streaming: boolean;
  onRegenerate: () => void;
  attachmentIndex?: Map<string, ChatAttachment> | undefined;
}) {
  const time = hhmm(turn.ts);
  const attachments = turn.attachments ?? [];
  return (
    <div className="bubble-user">
      <div className="bubble-meta" style={{ textAlign: "right" }}>You{time ? ` · ${time}` : ""}</div>
      {editing ? (
        <UserTurnEditor draft={editDraft} onDraftChange={onEditDraftChange} onCommit={onCommitEdit} onCancel={onCancelEdit} style={{ width: "100%", resize: "vertical", background: "var(--lx-surface-input)", border: "1px solid var(--lx-border-focus)", borderRadius: 6, padding: "8px 10px", fontSize: 13, lineHeight: "18px", fontFamily: "var(--lx-font-body)", color: "var(--lx-text-primary)" }} />
      ) : (
        <>
          <div className="text-sm text-lx-text-primary" style={{ lineHeight: "20px" }}>{renderTokenized(turn.text, slug)}</div>
          {attachments.length > 0 && (
            <div style={{ display: "flex", alignItems: "flex-end", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
              {attachments.map((att, j) => (
                <SentAttachment key={`${att.storageKey}-${j}`} att={att} index={attachmentIndex} />
              ))}
            </div>
          )}
          <div className="bubble-actions">
            <CopyButton text={turn.text} label="Copy message" />
            <button type="button" className="icon-btn" title="Edit message" aria-label={`Edit message ${pos + 1}`} onClick={onBeginEdit}>
              <EditIcon />
            </button>
            {lastUser && (
              <button type="button" className="icon-btn" title="Regenerate from here" aria-label="Regenerate from here" disabled={streaming} onClick={onRegenerate}>
                <RegenerateIcon />
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export function StreamingBubble({
  stream,
  renderText,
}: {
  stream: Stream;
  renderText: (text: string) => ReactNode;
}) {
  return (
    <div className="bubble-ai">
      <div className="bubble-meta">Assistant · Assistant Agent persona</div>
      <AssistantActivity
        items={stream.items}
        tools={stream.tools}
        reasoningActive={stream.reasoningActive}
        reasoningMs={stream.reasoningMs}
        renderText={renderText}
      />
      {stream.pending.length > 0 && (
        <AssistantApprovalBatch
          chips={stream.pending.map((p) => ({ ...p, state: p.state ?? "pending" }))}
          locked
          onDecide={() => {}}
          onApproveAll={() => {}}
          onRejectAll={() => {}}
        />
      )}
    </div>
  );
}

export function ChatJumpButton({ atBottom, onClick }: { atBottom: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className="btn btn-ghost btn-icon-sm chat-jump-bottom"
      title="Jump to latest"
      aria-label="Jump to latest"
      aria-hidden={atBottom ? "true" : "false"}
      tabIndex={atBottom ? -1 : 0}
      style={atBottom ? { opacity: 0, pointerEvents: "none" } : undefined}
      onClick={onClick}
    >
      <ArrowDown size={14} strokeWidth={1.5} />
    </button>
  );
}
