import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertCircle, FileText, Image as ImageIcon, Paperclip, Send, Square, XCircle } from "lucide-react";
import {
  CHAT_ATTACHMENT_CAPS,
  DOCUMENT_ACCEPT,
  IMAGE_ACCEPT,
  chatAttachmentKind,
  countedBytes,
  emptyMessage,
  extractionFailedMessage,
  formatBytes,
  formatMegaBytes,
  pickAttachments,
  pickPastedImages,
  unsupportedMessage,
  uploadFailedMessage,
  type ChatAttachmentKind,
  type ChatAttachmentRef,
  type ComposerAttachment,
  type ComposerRejection,
} from "../../lib/assistant-image";
import type { ChatAttachment } from "../../lib/api";
import type { AssistantStreamStatus } from "../../lib/use-assistant-stream";
import { MENTION_SECTIONS, type MentionItem } from "../../lib/mention-suggestion";
import { useMentionTokens } from "../../lib/useMentionTokens";
import { matchMedia } from "../../lib/viewport";
import { lastApprovalBatch } from "./assistant-chat-utils";
import type { LexaSkill } from "../../../shared/types";

const ATTACH_DISABLED_TITLE_GLOBAL = "Images are disabled — configure vision in Project Settings → Assistant.";
const STATUS_DOT_STYLE: React.CSSProperties = { width: 6, height: 6, borderRadius: "50%", background: "var(--lx-text-warning)", display: "inline-block" };
const QUEUED_TEXT_STYLE: React.CSSProperties = { background: "none", border: 0, padding: 0, font: "inherit", color: "inherit", cursor: "pointer", minWidth: 0 };
const ERROR_ROW_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  margin: "0 10px 6px",
  padding: "6px 8px",
  border: "1px solid var(--lx-bg-danger-subtle)",
  borderRadius: 4,
  background: "var(--lx-bg-danger-subtle)",
};
const ERROR_TEXT_STYLE: React.CSSProperties = { fontSize: 12, lineHeight: "16px", color: "var(--lx-text-danger)", flex: 1, minWidth: 0 };

export interface ChatUploadRequest {
  chatId: string;
  file: File;
  onProgress: (percent: number) => void;
  onHandle: (handle: { abort: () => void }) => void;
}

// Re-exported for existing tests; the definition lives with the auto-scroll
// hook in assistant-chat-utils so `Review ↑` and proposal arrival share one
// last-`.approval-batch` target.
export { lastApprovalBatch };

function mmss(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

// Elapsed stream clock for the status line (visual only — aria-hidden at the
// call site; the status text itself is the live region).
function useElapsedSeconds(streaming: boolean): number {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!streaming) {
      setSeconds(0);
      return;
    }
    const started = Date.now();
    const id = window.setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(id);
  }, [streaming]);
  return seconds;
}

// Composer autocomplete popup: "@" renders the five entity sections in order
// (non-empty only); "$" renders the bound-skill list with its own header and
// empty/no-match states (mentions-autocomplete.html / herald-chat.html).
function ComposerMentionPopup({
  mention,
  hasBoundSkills,
  composerRef,
}: {
  mention: ReturnType<typeof useMentionTokens>;
  hasBoundSkills: boolean;
  composerRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const skillMode = mention.sigil === "$";
  const empty = mention.items.length === 0;
  const sections = MENTION_SECTIONS.map((section) => ({
    section,
    rows: mention.items.map((item, index) => ({ item, index })).filter(({ item }) => item.refType === section.refType),
  })).filter(({ rows }) => rows.length > 0);

  const row = (item: MentionItem, index: number) => (
    <div
      key={`${item.refType}-${item.refId}`}
      role="option"
      tabIndex={-1}
      aria-selected={index === mention.focusedIndex}
      className={index === mention.focusedIndex ? "dropdown-item focused" : "dropdown-item"}
      onMouseDown={(e) => {
        e.preventDefault();
        mention.handleSelect(composerRef.current, item);
      }}
    >
      {item.refType === "task" ? (
        <>
          <span className="task-key" style={{ fontSize: 13 }}>
            {item.label}
          </span>
          <span className="truncate flex-1 min-w-0">{item.sublabel}</span>
        </>
      ) : (
        <>
          <span className="truncate flex-1 min-w-0">{item.label}</span>
          <span className="font-mono text-xs text-lx-text-muted">{item.sublabel}</span>
        </>
      )}
    </div>
  );

  return (
    <div className="dropdown-menu mention-popup" role="listbox" style={mention.popupStyle ?? undefined}>
      {skillMode ? (
        <>
          <div className="dropdown-label mention-popup-skill-header">Skills — invoke with $</div>
          {empty ? (
            <div className="dropdown-item" style={{ cursor: "default", color: "var(--lx-text-muted)" }}>
              {hasBoundSkills ? "No matches" : "No skills attached — add them in Settings"}
            </div>
          ) : (
            mention.items.map((it, idx) => (
              <div
                key={it.refId}
                role="option"
                tabIndex={-1}
                aria-selected={idx === mention.focusedIndex}
                className={idx === mention.focusedIndex ? "dropdown-item focused" : "dropdown-item"}
                onMouseDown={(e) => {
                  e.preventDefault();
                  mention.handleSelect(composerRef.current, it);
                }}
              >
                <span className="truncate flex-1 min-w-0">
                  {it.label}
                  {it.sublabel ? ` — ${it.sublabel}` : ""}
                </span>
              </div>
            ))
          )}
        </>
      ) : empty ? (
        <div className="dropdown-item" style={{ cursor: "default", color: "var(--lx-text-muted)" }}>
          No matches
        </div>
      ) : (
        sections.map(({ section, rows }, sectionIndex) => (
          <Fragment key={section.refType}>
            {sectionIndex > 0 && <div className="dropdown-separator" />}
            <div className="dropdown-label">{section.label}</div>
            {rows.map(({ item, index }) => row(item, index))}
          </Fragment>
        ))
      )}
    </div>
  );
}

// Paperclip trigger + two-row picker (design-system `.dropdown-menu`). Images
// may also be pasted into the composer; documents only arrive through the
// picker. The image row is disabled when vision is not configured (the
// document row stays live — extraction needs no vision).
function AttachControl({
  imageDisabled,
  onPick,
  onPickText,
}: {
  imageDisabled: boolean;
  onPick: (files: File[], kind: ChatAttachmentKind) => void;
  onPickText: string;
}) {
  const [open, setOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const imageRef = useRef<HTMLInputElement>(null);
  const documentRef = useRef<HTMLInputElement>(null);
  const firstEnabled = imageDisabled ? 1 : 0;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Open focuses the first enabled row; ↑/↓ cycle the enabled rows, Enter
  // activates the focused row (native button activation).
  useEffect(() => {
    if (!open) return;
    setFocusedIndex(firstEnabled);
    rowRefs.current[firstEnabled]?.focus();
  }, [open, firstEnabled]);

  const moveFocus = (delta: 1 | -1) => {
    const enabled = rowRefs.current.map((row, index) => (row && !row.disabled ? index : -1)).filter((index) => index >= 0);
    if (enabled.length === 0) return;
    const pos = enabled.indexOf(focusedIndex);
    const nextPos = pos < 0 ? (delta > 0 ? 0 : enabled.length - 1) : (pos + delta + enabled.length) % enabled.length;
    const next = enabled[nextPos]!;
    setFocusedIndex(next);
    rowRefs.current[next]?.focus();
  };

  const onMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    moveFocus(e.key === "ArrowDown" ? 1 : -1);
  };

  const pick = (input: HTMLInputElement) => {
    setOpen(false);
    input.click();
  };

  return (
    <div ref={rootRef} style={{ position: "relative", display: "inline-flex" }}>
      <button
        type="button"
        className={`btn btn-ghost btn-icon-sm${open ? " is-active" : ""}`}
        title={onPickText}
        aria-label="Attach files"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Paperclip size={14} strokeWidth={1.5} />
      </button>
      <input
        ref={imageRef}
        type="file"
        accept={IMAGE_ACCEPT}
        multiple
        hidden
        aria-label="Attach images"
        onChange={(e) => {
          if (e.target.files) onPick(Array.from(e.target.files), "image");
          e.target.value = "";
        }}
      />
      <input
        ref={documentRef}
        type="file"
        accept={DOCUMENT_ACCEPT}
        multiple
        hidden
        aria-label="Attach documents"
        onChange={(e) => {
          if (e.target.files) onPick(Array.from(e.target.files), "document");
          e.target.value = "";
        }}
      />
      {open && (
        <div
          className="dropdown-menu"
          role="menu"
          aria-label="Attach"
          onKeyDown={onMenuKeyDown}
          style={{ position: "absolute", left: 10, bottom: "calc(100% + 6px)", width: 270, zIndex: 30 }}
        >
          <div className="dropdown-label">Attach</div>
          <button
            ref={(el) => {
              rowRefs.current[0] = el;
            }}
            type="button"
            role="menuitem"
            className={focusedIndex === 0 ? "dropdown-item focused" : "dropdown-item"}
            disabled={imageDisabled}
            title={imageDisabled ? ATTACH_DISABLED_TITLE_GLOBAL : undefined}
            aria-disabled={imageDisabled}
            style={imageDisabled ? { opacity: 0.5, cursor: "not-allowed" } : undefined}
            onClick={() => {
              if (!imageDisabled) pick(imageRef.current!);
            }}
          >
            <ImageIcon size={16} strokeWidth={1.5} />
            Attach image
            <span className="dropdown-shortcut">png · jpeg · gif · webp</span>
          </button>
          <button
            ref={(el) => {
              rowRefs.current[1] = el;
            }}
            type="button"
            role="menuitem"
            className={focusedIndex === 1 ? "dropdown-item focused" : "dropdown-item"}
            onClick={() => pick(documentRef.current!)}
          >
            <FileText size={16} strokeWidth={1.5} />
            Attach document
            <span className="dropdown-shortcut">pdf · txt · md · csv</span>
          </button>
        </div>
      )}
    </div>
  );
}

// Attachment strip: chips (uploading / ready), the error rows (rejections,
// failed uploads, extraction failures), the caps meter and the caps warning.
// The meter counts ready + uploading + failed + extraction-failed bytes.
function AttachmentStrip({
  attachments,
  rejections,
  warning,
  onRemove,
  onRetry,
  onDismissRejection,
}: {
  attachments: ComposerAttachment[];
  rejections: ComposerRejection[];
  warning: string | null;
  onRemove: (id: string) => void;
  onRetry: (id: string) => void;
  onDismissRejection: (id: string) => void;
}) {
  const total = countedBytes(attachments);
  const pct = Math.min(100, Math.round((total / CHAT_ATTACHMENT_CAPS.maxTotalBytes) * 100));
  const over = attachments.length >= CHAT_ATTACHMENT_CAPS.maxCount || total >= CHAT_ATTACHMENT_CAPS.maxTotalBytes;
  const chips = attachments.filter((a) => a.status === "uploading" || a.status === "ready");
  const failed = attachments.filter((a) => a.status === "failed");
  const unreadable = attachments.filter((a) => a.status === "extraction-failed");

  if (chips.length === 0 && rejections.length === 0 && failed.length === 0 && unreadable.length === 0) return null;

  return (
    <>
      {chips.length > 0 && (
        <div className="deck-attach">
          {chips.map((att) =>
            att.status === "uploading" ? (
              att.progress > 0 ? (
                <span key={att.id} className="deck-attach-item" style={{ flex: 1, minWidth: 0 }}>
                  <span className="spinner" style={{ width: 12, height: 12 }} />
                  <span className="text-xs truncate" style={{ color: "var(--lx-text-primary)", flex: 1, minWidth: 0 }}>
                    {att.name}
                  </span>
                  <span style={{ width: 64, height: 3, borderRadius: 2, background: "var(--lx-border-subtle)", overflow: "hidden", flexShrink: 0 }}>
                    <span style={{ display: "block", width: `${att.progress}%`, height: "100%", borderRadius: 2, background: "var(--lx-text-link)" }} />
                  </span>
                  <span className="font-micro text-2xs text-lx-text-muted" style={{ flexShrink: 0 }}>
                    {att.progress}% · {formatBytes(att.size)}
                  </span>
                  <button type="button" title="Cancel upload" aria-label={`Cancel upload ${att.name}`} onClick={() => onRemove(att.id)} style={{ border: "none", background: "none", cursor: "pointer", padding: 0, color: "var(--lx-text-muted)" }}>
                    ✕
                  </button>
                </span>
              ) : (
                <span key={att.id} className="deck-attach-item is-pending">
                  <span className="spinner" style={{ width: 10, height: 10 }} />
                  {att.name} · uploading…
                  <button type="button" aria-label={`Cancel upload ${att.name}`} onClick={() => onRemove(att.id)} style={{ border: "none", background: "none", cursor: "pointer", padding: 0, color: "var(--lx-text-muted)" }}>
                    ✕
                  </button>
                </span>
              )
            ) : (
              <span key={att.id} className="deck-attach-item">
                {att.kind === "image" && att.previewUrl ? (
                  <img className="deck-attach-thumb" src={att.previewUrl} alt="" />
                ) : (
                  <FileText size={14} strokeWidth={1.5} style={{ color: "var(--lx-text-muted)", flexShrink: 0 }} />
                )}
                {att.name} · {formatBytes(att.size)}
                <button type="button" aria-label={`Remove ${att.name}`} onClick={() => onRemove(att.id)} style={{ color: "var(--lx-text-muted)" }}>
                  ✕
                </button>
              </span>
            )
          )}
        </div>
      )}

      {rejections.map((rej) => (
        <div key={rej.id} style={ERROR_ROW_STYLE}>
          <AlertCircle size={14} strokeWidth={1.5} style={{ color: "var(--lx-text-danger)", flexShrink: 0 }} />
          <span style={ERROR_TEXT_STYLE}>{rej.message}</span>
          <button type="button" aria-label="Dismiss error" onClick={() => onDismissRejection(rej.id)} style={{ border: "none", background: "none", cursor: "pointer", padding: 0, color: "var(--lx-text-muted)", flexShrink: 0 }}>
            ✕
          </button>
        </div>
      ))}

      {failed.map((att) => (
        <div key={att.id} style={ERROR_ROW_STYLE}>
          <XCircle size={14} strokeWidth={1.5} style={{ color: "var(--lx-text-danger)", flexShrink: 0 }} />
          <span style={ERROR_TEXT_STYLE}>{uploadFailedMessage(att.name)}</span>
          <button type="button" className="btn btn-ghost btn-sm" style={{ flexShrink: 0, height: 24, padding: "0 8px", fontSize: 11 }} onClick={() => onRetry(att.id)}>
            Retry
          </button>
          <button type="button" aria-label={`Remove ${att.name}`} onClick={() => onRemove(att.id)} style={{ border: "none", background: "none", cursor: "pointer", padding: 0, color: "var(--lx-text-muted)", flexShrink: 0 }}>
            ✕
          </button>
        </div>
      ))}

      {unreadable.map((att) => (
        <div key={att.id} style={ERROR_ROW_STYLE}>
          <AlertCircle size={14} strokeWidth={1.5} style={{ color: "var(--lx-text-danger)", flexShrink: 0 }} />
          <span style={ERROR_TEXT_STYLE}>{extractionFailedMessage(att.name)}</span>
          <button type="button" className="btn btn-ghost btn-sm" style={{ flexShrink: 0, height: 24, padding: "0 8px", fontSize: 11 }} onClick={() => onRemove(att.id)}>
            Remove
          </button>
        </div>
      ))}

      {(chips.length > 0 || failed.length > 0 || unreadable.length > 0) && (
        <div className="deck-attach">
          <span className={`deck-meter${over ? " is-over" : ""}`}>
            <span className="deck-meter-fill" style={{ width: `${pct}%` }} />
          </span>
          <span className="font-micro text-2xs" style={{ color: over ? "var(--lx-text-danger)" : "var(--lx-text-muted)" }}>
            {attachments.length}/{CHAT_ATTACHMENT_CAPS.maxCount} · {formatMegaBytes(total)}/10MB
          </span>
        </div>
      )}

      {warning && <span className="deck-warn">{warning}</span>}
    </>
  );
}

export const AssistantChatComposer = memo(function AssistantChatComposer({
  slug,
  skills,
  streaming,
  streamStatus,
  busy409,
  suspendedLock,
  suspendCount,
  attachDisabled,
  attachmentsEnabled = true,
  sendError,
  reconnecting = false,
  resumed = false,
  onSend,
  onAbort,
  rail,
  railHint,
  queued,
  onQueue,
  onUnqueue,
  seed,
  initialAttachments,
  ensureChatId,
  uploadAttachment,
}: {
  slug: string;
  skills?: LexaSkill[] | undefined;
  streaming: boolean;
  streamStatus?: AssistantStreamStatus | undefined;
  busy409: boolean;
  suspendedLock: boolean;
  suspendCount: number;
  // Transport reconnect (herald-chat.html): the socket is down while the turn
  // keeps running server-side; the composer stays locked and the footer shows
  // RECONNECTING. `resumed` is the short-lived confirmation after recovery.
  reconnecting?: boolean | undefined;
  resumed?: boolean | undefined;
  // Images disabled (no vision chain) — the picker's image row is disabled.
  attachDisabled: boolean;
  // Kill switch: false hides the attach control entirely.
  attachmentsEnabled?: boolean | undefined;
  // Terminal stream error (carries `details` for extraction failures).
  sendError?: { code: string; details?: unknown } | null | undefined;
  onSend: (message: string, attachments: ChatAttachmentRef[]) => boolean;
  onAbort: () => void;
  rail?: ReactNode | undefined;
  // One-line hint rendered directly under the rail (herald-chat.html State 4:
  // a `.deck-rail` sibling, never inside it).
  railHint?: ReactNode | undefined;
  queued?: { text: string; heldReason?: "stopped" | "failed"; flushing?: boolean } | null | undefined;
  onQueue?: ((text: string) => void) | undefined;
  onUnqueue?: (() => void) | undefined;
  seed?: { text: string; nonce: number } | null | undefined;
  initialAttachments?: ComposerAttachment[] | undefined;
  ensureChatId?: (() => string) | undefined;
  uploadAttachment?: ((req: ChatUploadRequest) => Promise<ChatAttachment>) | undefined;
}) {
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<ComposerAttachment[]>(() => initialAttachments ?? []);
  const [rejections, setRejections] = useState<ComposerRejection[]>([]);
  const [warning, setWarning] = useState<string | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const mention = useMentionTokens({ slug, value: draft, onChange: setDraft, skills });
  const queueMode = streaming || suspendedLock;
  const elapsed = useElapsedSeconds(streaming);
  const reconnectSeconds = useElapsedSeconds(reconnecting);
  const uploadsRef = useRef<Map<string, { abort: () => void }>>(new Map());
  const sentIdsRef = useRef<string[]>([]);
  const sentTextRef = useRef<string | null>(null);

  // Object URLs outlive the list when a send clears it or the composer
  // unmounts — revoke any URL that dropped out of the list, and all of them on
  // unmount, so previews don't leak.
  const prevAttachmentsRef = useRef<ComposerAttachment[]>([]);
  useEffect(() => {
    const currentUrls = new Set(attachments.map((a) => a.previewUrl).filter((u): u is string => !!u));
    for (const att of prevAttachmentsRef.current) {
      if (att.previewUrl && !currentUrls.has(att.previewUrl) && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(att.previewUrl);
    }
    prevAttachmentsRef.current = attachments;
  }, [attachments]);
  useEffect(
    () => () => {
      for (const att of prevAttachmentsRef.current) {
        if (att.previewUrl && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(att.previewUrl);
      }
    },
    []
  );

  useEffect(() => {
    if (!seed) return;
    setDraft(seed.text);
    composerRef.current?.focus();
  }, [seed?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  const startUpload = useCallback(
    async (att: ComposerAttachment, threadId?: string) => {
      if (!uploadAttachment || !ensureChatId) {
        setAttachments((prev) => prev.map((a) => (a.id === att.id ? { ...a, status: "failed" } : a)));
        return;
      }
      const targetChatId = threadId ?? ensureChatId();
      try {
        const result = await uploadAttachment({
          chatId: targetChatId,
          file: att.file,
          onProgress: (percent) => setAttachments((prev) => prev.map((a) => (a.id === att.id ? { ...a, progress: percent } : a))),
          onHandle: (handle) => uploadsRef.current.set(att.id, handle),
        });
        setAttachments((prev) =>
          prev.map((a) =>
            a.id === att.id ? { ...a, status: "ready", progress: 100, storageKey: result.storageKey, mimeType: result.mimeType, name: result.filename } : a
          )
        );
      } catch (e) {
        if ((e as { code?: string }).code === "UPLOAD_CANCELLED") return;
        setAttachments((prev) => prev.map((a) => (a.id === att.id ? { ...a, status: "failed" } : a)));
      } finally {
        uploadsRef.current.delete(att.id);
      }
    },
    [uploadAttachment, ensureChatId]
  );

  const pick = useCallback(
    (files: File[], kind: ChatAttachmentKind) => {
      // Filter by kind BEFORE the caps check: a wrong-kind file in the same
      // multi-select must never consume an attachment slot.
      const matched = files.filter((f) => chatAttachmentKind(f) === kind);
      const mismatched = files.filter((f) => chatAttachmentKind(f) !== kind);
      const result = pickAttachments(matched, attachments);
      const created: ComposerAttachment[] = result.accepted.map((file) => ({
        id: crypto.randomUUID(),
        kind,
        file,
        name: file.name,
        size: file.size,
        mimeType: file.type || (kind === "image" ? "image/png" : "text/plain"),
        ...(kind === "image" ? { previewUrl: URL.createObjectURL(file) } : {}),
        status: "uploading" as const,
        progress: 0,
      }));
      if (created.length > 0) {
        setAttachments((prev) => [...prev, ...created]);
        // ONE thread id per pick — every file in the batch shares it.
        const threadId = ensureChatId?.();
        for (const att of created) void startUpload(att, threadId);
      }
      const rejectedMessages = [
        ...result.rejections,
        ...mismatched.map((f) => (f.size === 0 ? emptyMessage(f.name) : unsupportedMessage(f.name))),
      ];
      if (rejectedMessages.length > 0) {
        setRejections((prev) => [...prev, ...rejectedMessages.map((message) => ({ id: crypto.randomUUID(), message }))]);
      }
      // Unconditional: adding a file clears a stale caps warning (wireframe
      // herald-chat.html — the warning clears when the offending chip is removed
      // or another is added).
      setWarning(result.warning);
    },
    [attachments, startUpload, ensureChatId]
  );

  const pasteIntoComposer = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      if (!attachmentsEnabled || attachDisabled) return;
      const result = pickPastedImages(Array.from(e.clipboardData.files), attachments);
      if (!result) return;
      e.preventDefault();
      const created: ComposerAttachment[] = result.accepted.map((file) => ({
        id: crypto.randomUUID(),
        kind: "image" as const,
        file,
        name: file.name,
        size: file.size,
        mimeType: file.type || "image/png",
        previewUrl: URL.createObjectURL(file),
        status: "uploading" as const,
        progress: 0,
      }));
      if (created.length > 0) {
        setAttachments((prev) => [...prev, ...created]);
        const threadId = ensureChatId?.();
        for (const att of created) void startUpload(att, threadId);
      }
      if (result.rejections.length > 0) {
        setRejections((prev) => [...prev, ...result.rejections.map((message) => ({ id: crypto.randomUUID(), message }))]);
      }
      setWarning(result.warning);
    },
    [attachmentsEnabled, attachDisabled, attachments, startUpload, ensureChatId]
  );

  const removeAttachment = useCallback((id: string) => {
    uploadsRef.current.get(id)?.abort();
    uploadsRef.current.delete(id);
    setAttachments((prev) => prev.filter((a) => a.id !== id));
    setWarning(null);
  }, []);

  const retryAttachment = useCallback(
    (id: string) => {
      const att = attachments.find((a) => a.id === id);
      if (!att) return;
      setAttachments((prev) => prev.map((a) => (a.id === id ? { ...a, status: "uploading", progress: 0 } : a)));
      void startUpload({ ...att, status: "uploading", progress: 0 });
    },
    [attachments, startUpload]
  );

  const dismissRejection = useCallback((id: string) => setRejections((prev) => prev.filter((r) => r.id !== id)), []);

  const readyRefs = useCallback(
    (): ChatAttachmentRef[] =>
      attachments
        .filter((a) => a.status === "ready" && !!a.storageKey)
        .map((a) => ({ storageKey: a.storageKey!, mimeType: a.mimeType, name: a.name, sizeBytes: a.size, ...(a.previewUrl ? { previewUrl: a.previewUrl } : {}) })),
    [attachments]
  );

  const hasExtractionFailure = attachments.some((a) => a.status === "extraction-failed");

  const handleSend = useCallback(() => {
    const msg = draft.trim();
    if (!msg || streaming || suspendedLock || busy409 || reconnecting || hasExtractionFailure) return;
    const accepted = onSend(msg, readyRefs());
    if (!accepted) return;
    sentIdsRef.current = attachments.filter((a) => a.status === "ready").map((a) => a.id);
    sentTextRef.current = msg;
    setDraft("");
    mention.close();
    setRejections([]);
    setWarning(null);
  }, [draft, streaming, suspendedLock, busy409, reconnecting, hasExtractionFailure, onSend, readyRefs, attachments, mention]);

  const handleQueue = useCallback(() => {
    const msg = draft.trim();
    if (!msg || busy409 || reconnecting) return;
    onQueue?.(msg);
    setDraft("");
    mention.close();
  }, [draft, busy409, reconnecting, onQueue, mention]);

  const flushHeld = useCallback(() => {
    if (!queued) return;
    if (streaming || suspendedLock || busy409 || reconnecting || hasExtractionFailure) return;
    const accepted = onSend(queued.text, readyRefs());
    if (!accepted) return;
    sentIdsRef.current = attachments.filter((a) => a.status === "ready").map((a) => a.id);
    sentTextRef.current = queued.text;
    onUnqueue?.();
    setRejections([]);
    setWarning(null);
  }, [queued, streaming, suspendedLock, busy409, reconnecting, hasExtractionFailure, onSend, readyRefs, attachments, onUnqueue]);

  // Click the queued chip text to pull the held message back into the draft.
  const editQueuedText = useCallback(() => {
    if (!queued || queued.flushing) return;
    setDraft(queued.text);
    onUnqueue?.();
    composerRef.current?.focus();
  }, [queued, onUnqueue]);

  const reviewApprovals = useCallback(() => {
    const scrollRoot = document.querySelector(".chat-scroll") ?? document;
    lastApprovalBatch(scrollRoot)?.scrollIntoView({
      block: "start",
      behavior: matchMedia("(prefers-reduced-motion: reduce)") ? "auto" : "smooth",
    });
  }, []);

  // Extraction failure surfaces as a terminal stream error; keep the chips,
  // mark the named document unreadable and restore the draft so the user can
  // act on the error row (the whole send is refused).
  useEffect(() => {
    if (sendError?.code !== "ATTACHMENT_EXTRACTION_FAILED") return;
    const filename = (sendError.details as { filename?: unknown } | undefined)?.filename;
    const ids = sentIdsRef.current;
    if (ids.length > 0) {
      setAttachments((prev) => prev.map((a) => (ids.includes(a.id) && (typeof filename !== "string" || a.name === filename) ? { ...a, status: "extraction-failed" } : a)));
    }
    if (sentTextRef.current) setDraft((prev) => (prev.trim() ? prev : sentTextRef.current!));
    sentIdsRef.current = [];
  }, [sendError]);

  // Any other terminal status clears the chips that rode the accepted send.
  useEffect(() => {
    const status = streamStatus ?? (streaming ? "streaming" : "idle");
    if (status !== "done" && status !== "error" && status !== "aborted") return;
    if (sendError?.code === "ATTACHMENT_EXTRACTION_FAILED") return;
    if (sentIdsRef.current.length === 0) return;
    const ids = sentIdsRef.current;
    sentIdsRef.current = [];
    setAttachments((prev) => prev.filter((a) => !ids.includes(a.id)));
    setWarning(null);
  }, [streamStatus, streaming, sendError]);

  const canSend = draft.trim().length > 0 && !busy409 && !reconnecting && !streaming && !suspendedLock && !hasExtractionFailure;
  const canQueue = draft.trim().length > 0 && !busy409 && !reconnecting;

  const placeholder = busy409
    ? "Waiting for the current reply…"
    : queueMode
      ? "Queue your next message…"
      : "Ask Assistant anything about this project…";

  return (
    <div className="chat-deck" style={{ position: "relative" }}>
      {mention.open && <ComposerMentionPopup mention={mention} hasBoundSkills={(skills?.length ?? 0) > 0} composerRef={composerRef} />}
      {rail && (
        <div className="deck-rail" style={busy409 || queueMode ? { opacity: 0.55 } : undefined}>
          {rail}
        </div>
      )}
      {railHint}
      {queued && (
        <div className="deck-queued" role="status" aria-live="polite">
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, maxWidth: "100%" }}>
            <span className={`deck-queued-chip${queued.heldReason ? " is-held" : queued.flushing ? " is-flushing" : ""}`}>
              {queued.flushing ? (
                <span className="deck-queued-text">Sending queued message…</span>
              ) : (
                <button type="button" className="deck-queued-text" style={QUEUED_TEXT_STYLE} onClick={editQueuedText}>
                  {`1 queued · “${queued.text}”`}
                </button>
              )}
              {!queued.flushing && (
                <button
                  type="button"
                  className="btn btn-ghost btn-icon-sm"
                  aria-label="Cancel queued message"
                  onClick={onUnqueue}
                  style={{ color: "var(--lx-text-muted)" }}
                >
                  ✕
                </button>
              )}
            </span>
            {!queued.flushing && queued.heldReason && (
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={streaming || suspendedLock || busy409 || hasExtractionFailure}
                onClick={flushHeld}
              >
                Send
              </button>
            )}
          </span>
        </div>
      )}
      <div className="deck-message">
        <textarea
          ref={composerRef}
          className="composer-editor w-full"
          aria-label="Message Assistant"
          rows={busy409 ? 1 : 2}
          placeholder={placeholder}
          value={draft}
          onChange={mention.handleChange}
          onPaste={pasteIntoComposer}
          onSelect={mention.handleSelectCaret}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
            if (mention.handleKeyDown(e)) return;
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (queueMode) handleQueue();
              else handleSend();
            }
          }}
          disabled={busy409 || reconnecting}
          style={{ border: "none", background: "transparent" }}
        />
      </div>
      {attachmentsEnabled && (
        <AttachmentStrip
          attachments={attachments}
          rejections={rejections}
          warning={warning}
          onRemove={removeAttachment}
          onRetry={retryAttachment}
          onDismissRejection={dismissRejection}
        />
      )}
      {resumed && !reconnecting && (
        <div className="deck-action composer-footer" role="status">
          <span className="deck-status" style={{ color: "var(--lx-text-success)" }}>
            ● RESUMED
          </span>
          <span className="text-xs color-secondary">Reconnected — stream resumed from the last frame.</span>
        </div>
      )}
      <div className="deck-action composer-footer">
        {reconnecting ? (
          <span className="deck-status" role="status">
            <span aria-hidden="true" style={STATUS_DOT_STYLE} />
            RECONNECTING · <span aria-hidden="true">{reconnectSeconds}s</span>
          </span>
        ) : busy409 ? (
          <span className="deck-status" style={{ color: "var(--lx-text-secondary)" }}>
            ANOTHER ASSISTANT RUN IS IN PROGRESS
          </span>
        ) : queueMode ? (
          <>
            <span className="deck-status" role="status">
              <span aria-hidden="true" style={STATUS_DOT_STYLE} />
              {streaming ? (
                <>
                  STREAMING · <span aria-hidden="true">{mmss(elapsed)}</span>
                </>
              ) : (
                <>
                  TURN SUSPENDED · {suspendCount} PENDING APPROVALS
                </>
              )}
            </span>
            <div className="flex items-center gap-2">
              <button type="button" className="btn btn-primary btn-sm" disabled={!canQueue} onClick={handleQueue}>
                Queue ⏎
              </button>
              {streaming ? (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  style={{ borderColor: "var(--lx-bg-danger-subtle)", color: "var(--lx-text-danger)" }}
                  onClick={onAbort}
                >
                  <Square size={12} strokeWidth={1.5} fill="currentColor" />
                  Stop
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  style={{ borderColor: "var(--lx-border-focus)", color: "var(--lx-text-link)" }}
                  onClick={reviewApprovals}
                >
                  Review ↑
                </button>
              )}
            </div>
          </>
        ) : queued?.heldReason ? (
          <span className="deck-status" style={{ color: "var(--lx-text-danger)" }}>
            {queued.heldReason === "stopped" ? "HELD — TURN STOPPED" : "HELD — TURN FAILED"}
          </span>
        ) : (
          <>
            <div className="flex items-center gap-2">
              {attachmentsEnabled && <AttachControl imageDisabled={attachDisabled} onPick={pick} onPickText="Attach files — images or documents, or paste an image" />}
              <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em] hidden md:inline">⏎ SEND</span>
            </div>
            <button type="button" className="btn btn-primary btn-sm" style={{ marginLeft: "auto" }} disabled={!canSend} onClick={handleSend}>
              Send
              <Send size={12} strokeWidth={1.5} />
            </button>
          </>
        )}
      </div>
    </div>
  );
});
