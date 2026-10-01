import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { formatRelative } from "../../lib/relative-time";
import type { useAssistantStream } from "../../lib/use-assistant-stream";
import { AssistantApprovalBatch } from "./AssistantApprovals";
import type { ApprovalChip } from "./AssistantApprovals";
import { ChatJumpButton, StreamingBubble, UserTurnBubble } from "./AssistantChatTurns";
import { AssistantBubble } from "./AssistantBubble";
import { AssistantChatComposer, type ChatUploadRequest } from "./AssistantChatComposer";
import { EffortPicker, DeckRailSummary } from "./EffortPicker";
import { useChatComposerClearance } from "./assistant-chat-hooks";
import type { ActivityView, ChatTurn } from "./assistant-chat-utils";
import type { QueuedMessage } from "./useChatQueue";
import type { LexaSkill } from "../../../shared/types";
import type { AssistantReasoningEffort } from "../../../shared/assistant";
import type { AssistantStreamStatus } from "../../lib/use-assistant-stream";
import type { ChatAttachmentRef } from "../../lib/assistant-image";
import type { ChatAttachment } from "../../lib/api";

type Stream = ReturnType<typeof useAssistantStream>;

// Chat page shell pieces (assistant-chat.html): header bar, transcript scroll
// area, composer area with skill panel + warning banners. Pure render —
// state and stream orchestration stay in AssistantChatPage.

// Delete confirm — the reset-confirm dialog anatomy, moved verbatim from the
// sidebar now that thread actions live in the header. Owns its focus contract
// (focus Cancel on open, restore the invoking button on close, Tab trapped
// inside, Escape closes unless a delete is in flight).
function ChatDeleteDialog({
  title,
  triggerRef,
  onCancel,
  onConfirm,
}: {
  title: string;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  onCancel: () => void;
  onConfirm: () => void | Promise<unknown>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
    return () => triggerRef.current?.focus();
  }, [triggerRef]);

  const onDialogKeyDown = (event: ReactKeyboardEvent<HTMLDialogElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      if (!deleting) onCancel();
      return;
    }
    if (event.key !== "Tab") return;
    const focusables = dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    if (!focusables || focusables.length === 0) return;
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const confirm = async () => {
    setDeleting(true);
    try {
      await onConfirm();
      onCancel();
      setError(null);
    } catch (err) {
      // ASSISTANT_TASK_ACTIVE etc — dialog stays open, code surfaced inline.
      const code = (err as { code?: string }).code;
      setError(code ?? (err as Error).message ?? "Delete failed");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <button type="button" className="slideover-overlay" style={{ zIndex: 90 }} aria-label="Close" onClick={() => !deleting && onCancel()} />
      <div style={{ position: "fixed", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, pointerEvents: "none" }}>
        <dialog ref={dialogRef} open className="dialog dialog-enter pointer-events-auto" aria-modal="true" aria-label="Delete this chat?" onKeyDown={onDialogKeyDown}>
          <div className="flex items-center justify-between mb-2">
            <span className="font-display text-base font-semibold text-lx-text-primary">Delete this chat?</span>
            <button type="button" className="btn btn-ghost btn-icon-sm" aria-label="Cancel delete" disabled={deleting} onClick={onCancel}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12" /></svg>
            </button>
          </div>
          <p className="text-xs text-lx-text-secondary" style={{ lineHeight: "18px" }}>
            Deletes "<span className="font-mono">{title}</span>" — both turns and attachments. The view lands on a fresh empty chat. This cannot be undone.
          </p>
          {error && (
            <div className="notice notice-danger mt-3">
              <span className="font-mono text-xs font-medium">{error}</span>
            </div>
          )}
          <div className="flex items-center justify-end gap-2 mt-4">
            <button ref={cancelRef} type="button" className="btn btn-ghost btn-sm" disabled={deleting} onClick={onCancel}>Cancel</button>
            <button type="button" className="btn btn-danger-solid btn-sm" disabled={deleting} onClick={() => void confirm()}>
              {deleting ? "Deleting…" : "Delete chat"}
            </button>
          </div>
        </dialog>
      </div>
    </>
  );
}

// Thread-led header: the thread's own title renames in place (pencil or
// double-click; Enter saves, Esc cancels, empty is a no-op) over
// `{project} · updated {relative}`. Pin / rename / delete live here only; the
// landing variant renders the project alone with no actions.
export interface ChatHeaderProps {
  landing: boolean;
  loading: boolean;
  title: string | null;
  projectName: string;
  updatedAt: string | null;
  pinned: boolean;
  actionsDisabled: boolean;
  onRename: (title: string) => void;
  onPinToggle: () => void;
  onDelete: () => void | Promise<unknown>;
}

export function ChatHeader({
  landing,
  loading,
  title,
  projectName,
  updatedAt,
  pinned,
  actionsDisabled,
  onRename,
  onPinToggle,
  onDelete,
}: ChatHeaderProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const deleteRef = useRef<HTMLButtonElement>(null);
  const heading = landing ? "Assistant Chat" : title ?? "New chat";
  const sub = landing || !updatedAt ? projectName : `${projectName} · updated ${formatRelative(updatedAt)}`;

  const commit = () => {
    const next = draft.trim();
    if (!next) return;
    setEditing(false);
    if (next !== (title ?? "")) onRename(next);
  };

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  return (
    <div className="chat-header">
      <div className="chat-header-main">
        <span className="chat-header-glyph" aria-hidden="true">✦</span>
        <div className="chat-header-titles">
          {editing ? (
            <input
              ref={inputRef}
              className="chat-header-input"
              aria-label="Thread title"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commit();
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setEditing(false);
                }
              }}
              onBlur={commit}
            />
          ) : loading ? (
            <span className="chat-header-title" style={{ width: 180, background: "var(--lx-surface-card)", borderRadius: 4 }} aria-hidden="true">&nbsp;</span>
          ) : (
            <h1
              className="chat-header-title"
              onDoubleClick={() => {
                if (!landing && !actionsDisabled) {
                  setDraft(title ?? "");
                  setEditing(true);
                }
              }}
            >
              {heading}
            </h1>
          )}
          <span className="chat-header-sub">{sub}</span>
        </div>
      </div>
      {!landing && (
        <div className="chat-header-actions">
          <button
            type="button"
            className={`icon-btn${pinned ? " is-pinned" : ""}`}
            aria-pressed={pinned}
            title={pinned ? "Unpin thread" : "Pin thread"}
            aria-label={pinned ? "Unpin thread" : "Pin thread"}
            disabled={actionsDisabled}
            onClick={onPinToggle}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M12 17v5m-5-9.5A5.5 5.5 0 1 1 17 12.5" /><path d="M12 17a5 5 0 1 0-5-5" /></svg>
          </button>
          <button
            type="button"
            className="icon-btn"
            title="Rename thread"
            aria-label="Rename thread"
            disabled={actionsDisabled}
            onClick={() => {
              setDraft(title ?? "");
              setEditing(true);
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" /></svg>
          </button>
          <button type="button" ref={deleteRef} className="icon-btn" title="Delete thread" aria-label="Delete thread" disabled={actionsDisabled} onClick={() => setConfirmOpen(true)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
          </button>
        </div>
      )}
      {confirmOpen && (
        <ChatDeleteDialog title={heading} triggerRef={deleteRef} onCancel={() => setConfirmOpen(false)} onConfirm={onDelete} />
      )}
    </div>
  );
}

export function ChatTranscriptArea({
  turns,
  slug,
  streaming,
  renderText,
  projectId,
  streamActivity,
  batchBusy,
  onDecide,
  onApproveAll,
  onRejectAll,
  onRetryTurn,
  scrollRef,
  onScroll,
  editingPos,
  editDraft,
  onEditDraftChange,
  onBeginEdit,
  onCancelEdit,
  onCommitEdit,
  lastUserPos,
  onRegenerate,
  stream,
  atBottom,
  onJump,
  attachmentIndex,
}: {
  turns: ChatTurn[];
  slug: string;
  streaming: boolean;
  renderText: (text: string) => ReactNode;
  projectId?: string | undefined;
  streamActivity: ActivityView | undefined;
  batchBusy: boolean;
  onDecide: (chip: ApprovalChip, verdict: "approve" | "reject") => void;
  onApproveAll: (chips: ApprovalChip[]) => void;
  onRejectAll: (chips: ApprovalChip[]) => void;
  onRetryTurn: (turn: ChatTurn) => void;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  onScroll: () => void;
  editingPos: number | null;
  editDraft: string;
  onEditDraftChange: (value: string) => void;
  onBeginEdit: (pos: number) => void;
  onCancelEdit: () => void;
  onCommitEdit: (pos: number) => void;
  lastUserPos: number;
  onRegenerate: (turn: ChatTurn) => void;
  stream: Stream;
  atBottom: boolean;
  onJump: () => void;
  attachmentIndex?: Map<string, ChatAttachment> | undefined;
}) {
  const lastAssistantPos = turns.findLastIndex((turn) => turn.role === "assistant");
  return (
    <div className="chat-transcript">
      <div className="chat-header-scrim" aria-hidden="true" />
      <div ref={scrollRef} className="chat-scroll" onScroll={onScroll}>
        <div className="chat-column" role="log" aria-live="polite">
          {turns.map((turn, pos) =>
            turn.role === "user" ? (
              <UserTurnBubble
                key={pos}
                turn={turn}
                pos={pos}
                slug={slug}
                editing={editingPos === pos}
                editDraft={editDraft}
                onEditDraftChange={onEditDraftChange}
                onBeginEdit={() => onBeginEdit(pos)}
                onCancelEdit={onCancelEdit}
                onCommitEdit={() => onCommitEdit(pos)}
                lastUser={pos === lastUserPos}
                streaming={streaming}
                onRegenerate={() => onRegenerate(turn)}
                attachmentIndex={attachmentIndex}
              />
            ) : (
              <AssistantBubble
                key={pos}
                turn={turn}
                projectId={projectId}
                streaming={streaming}
                renderText={renderText}
                activity={turn.activity ?? (streamActivity && pos === turns.length - 1 ? streamActivity : undefined)}
                usage={stream.status === "done" && pos === lastAssistantPos ? stream.usage : undefined}
                batchBusy={batchBusy}
                onDecide={onDecide}
                onApproveAll={onApproveAll}
                onRejectAll={onRejectAll}
                onRetry={() => onRetryTurn(turn)}
              />
            )
          )}

          {streaming && <StreamingBubble stream={stream} renderText={renderText} />}
        </div>
      </div>
      <ChatJumpButton atBottom={atBottom} onClick={onJump} />
    </div>
  );
}

export function ChatComposerArea({
  skills,
  busy409,
  slug,
  streaming,
  streamStatus,
  sendError,
  reconnecting = false,
  resumed = false,
  suspendedLock,
  suspendCount,
  attachDisabled,
  attachmentsEnabled = true,
  isMobileComposer,
  effort,
  projectEffort,
  onEffortChange,
  onSend,
  onAbort,
  landing,
  queued,
  onQueue,
  onUnqueue,
  seed,
  ensureChatId,
  uploadAttachment,
}: {
  skills: LexaSkill[];
  busy409: boolean;
  slug: string;
  streaming: boolean;
  streamStatus?: AssistantStreamStatus | undefined;
  sendError?: { code: string; details?: unknown } | null | undefined;
  // Transport reconnect (herald-chat.html "Connection lost → auto-resume").
  reconnecting?: boolean | undefined;
  resumed?: boolean | undefined;
  suspendedLock: boolean;
  suspendCount: number;
  attachDisabled: boolean;
  attachmentsEnabled?: boolean | undefined;
  isMobileComposer: boolean;
  effort: AssistantReasoningEffort | "";
  projectEffort: AssistantReasoningEffort | null | undefined;
  onEffortChange: (e: AssistantReasoningEffort | "") => void;
  onSend: (message: string, attachments: ChatAttachmentRef[]) => boolean;
  onAbort: () => void;
  landing?: boolean | undefined;
  queued?: QueuedMessage | null | undefined;
  onQueue?: ((text: string) => void) | undefined;
  onUnqueue?: (() => void) | undefined;
  seed?: { text: string; nonce: number } | null | undefined;
  ensureChatId?: (() => string) | undefined;
  uploadAttachment?: ((req: ChatUploadRequest) => Promise<ChatAttachment>) | undefined;
}) {
  const railDisabled = streaming || busy409 || suspendedLock;
  // The docked composer floats over the transcript (chat-composer-float);
  // measure it and publish the clearance var on the shell. Landing never
  // attaches the ref — it stays static and in-flow.
  const composerRef = useChatComposerClearance();
  // The docked Deck sits at the bottom of a 100vh layout, so its rail menus
  // must open UPWARD; the landing centers the Deck and keeps them below.
  const menuAlign: "up" | "down" = landing ? "down" : "up";
  return (
    <div
      ref={landing ? undefined : composerRef}
      className={landing ? "chat-composer is-landing" : "chat-composer chat-composer-float"}
      style={landing ? { width: "100%" } : undefined}
    >
      {!landing && <div className="chat-composer-scrim" aria-hidden="true" />}
      <div className="chat-composer-inner">
        {reconnecting && (
          <div className="banner-warning" role="status" style={{ marginBottom: 12 }}>
            <span className="spinner" style={{ width: 12, height: 12, borderWidth: 2 }} aria-hidden="true" />
            <span>Connection lost — reconnecting… Your reply keeps running on the server.</span>
          </div>
        )}
        <AssistantChatComposer
          slug={slug}
          skills={skills}
          streaming={streaming}
          streamStatus={streamStatus}
          busy409={busy409}
          suspendedLock={suspendedLock}
          suspendCount={suspendCount}
          attachDisabled={attachDisabled}
          attachmentsEnabled={attachmentsEnabled}
          sendError={sendError}
          reconnecting={reconnecting}
          resumed={resumed}
          onSend={onSend}
          onAbort={onAbort}
          queued={queued}
          onQueue={onQueue}
          onUnqueue={onUnqueue}
          seed={seed}
          ensureChatId={ensureChatId}
          uploadAttachment={uploadAttachment}
          rail={
            isMobileComposer ? (
              <>
                <DeckRailSummary
                  effort={effort}
                  projectEffort={projectEffort ?? null}
                  onEffortChange={onEffortChange}
                  disabled={railDisabled}
                />
                <span className="deck-rail-spacer" />
              </>
            ) : (
              <>
                <span className="deck-rail-spacer" />
                <span className="deck-label">Effort</span>
                <EffortPicker effort={effort} projectEffort={projectEffort ?? null} disabled={railDisabled} align={menuAlign} onChange={onEffortChange} />
              </>
            )
          }
        />
      </div>
    </div>
  );
}
