import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Image, Send, Square } from "lucide-react";
import { ALLOWED_TYPES, acceptImageFiles, type AssistantImage } from "../../lib/assistant-image";
import { useMentionTokens } from "../../lib/useMentionTokens";

const CHAT_CAPS = { maxCount: 3, maxTotalBytes: Math.floor(1.5 * 1024 * 1024) };
const ATTACH_DISABLED_TITLE_GLOBAL = "Images are disabled — configure vision in Project Settings → Assistant.";
const STATUS_DOT_STYLE: React.CSSProperties = { width: 6, height: 6, borderRadius: "50%", background: "var(--lx-text-warning)", display: "inline-block" };
const QUEUED_TEXT_STYLE: React.CSSProperties = { background: "none", border: 0, padding: 0, font: "inherit", color: "inherit", cursor: "pointer", minWidth: 0 };

// The suspended batch is the NEWEST turn, so `Review ↑` targets the LAST
// `.approval-batch` in the scroll container — not the first one rendered.
export function lastApprovalBatch(root: ParentNode): Element | null {
  const batches = root.querySelectorAll(".approval-batch");
  return batches.length > 0 ? batches[batches.length - 1]! : null;
}

// Paste handler body: image files only, capped; null = nothing accepted.
function pastedImages(files: File[], current: AssistantImage[]): { images: AssistantImage[]; rejection: string | null } | null {
  const images = Array.from(files).filter((f) => f.type.startsWith("image/"));
  if (images.length === 0) return null;
  return acceptImageFiles(images, current, CHAT_CAPS);
}

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

// @-mention popup above the composer (tasks + wiki pages).
function ComposerMentionPopup({
  mention,
  composerRef,
}: {
  mention: ReturnType<typeof useMentionTokens>;
  composerRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  return (
    <div className="dropdown-menu mention-popup" role="listbox" style={mention.popupStyle ?? undefined}>
      {mention.items.length === 0 ? (
        <div className="dropdown-item" style={{ cursor: "default", color: "var(--lx-text-muted)" }}>
          No matches
        </div>
      ) : (
        <>
          {mention.items.some((it) => it.refType === "task") && <div className="dropdown-label">Tasks</div>}
          {mention.items.map((it, idx) =>
            idx > 0 && mention.items[idx - 1]!.refType !== it.refType ? <div key={`sep-${idx}`} className="dropdown-separator" /> : null
          )}
          {mention.items.map((it, idx) => (
            <div
              key={`${it.refType}-${it.refId}`}
              role="option"
              tabIndex={-1}
              aria-selected={idx === mention.focusedIndex}
              className={idx === mention.focusedIndex ? "dropdown-item focused" : "dropdown-item"}
              onMouseDown={(e) => {
                e.preventDefault();
                mention.handleSelect(composerRef.current);
              }}
            >
              {it.refType === "task" ? (
                <>
                  <span className="task-key" style={{ fontSize: 13 }}>
                    {it.label}
                  </span>
                  <span className="truncate flex-1 min-w-0">{it.sublabel}</span>
                </>
              ) : (
                <>
                  <span className="truncate flex-1 min-w-0">{it.label}</span>
                  <span className="font-mono text-xs text-lx-text-muted">{it.sublabel}</span>
                </>
              )}
            </div>
          ))}
        </>
      )}
    </div>
  );
}

// Bare icon button + hidden picker; caps/rejections come from the same
// `acceptImageFiles` the paste path uses.
function AttachButton({ onPick, disabled }: { onPick: (files: File[]) => void; disabled: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={ALLOWED_TYPES.join(",")}
        multiple
        hidden
        aria-label="Attach images"
        onChange={(e) => {
          if (e.target.files) onPick(Array.from(e.target.files));
          e.target.value = "";
        }}
      />
      <button
        type="button"
        className="btn btn-ghost btn-icon-sm"
        title={disabled ? ATTACH_DISABLED_TITLE_GLOBAL : "Attach images — or paste into the composer"}
        aria-label={disabled ? "Attach images (disabled)" : "Attach images"}
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
      >
        <Image size={14} strokeWidth={1.5} />
      </button>
    </>
  );
}

// Attachment strip — renders with the first image (design §3.2): thumbnail ·
// name · size · remove, plus the caps meter. No permanent caps copy exists in
// the footer; an over-limit rejection surfaces here.
function AttachmentStrip({ images, onRemove }: { images: AssistantImage[]; onRemove: (id: string) => void }) {
  const total = images.reduce((sum, img) => sum + img.file.size, 0);
  const pct = Math.min(100, Math.round((total / CHAT_CAPS.maxTotalBytes) * 100));
  const over = total >= CHAT_CAPS.maxTotalBytes;
  return (
    <div className="deck-attach">
      {images.map((img) => (
        <span key={img.id} className="deck-attach-item">
          <img className="deck-attach-thumb" src={img.previewUrl} alt="" />
          {img.file.name} · {(img.file.size / (1024 * 1024)).toFixed(1)}MB
          <button type="button" aria-label={`Remove ${img.file.name}`} onClick={() => onRemove(img.id)} style={{ color: "var(--lx-text-muted)" }}>
            ✕
          </button>
        </span>
      ))}
      <span className={`deck-meter${over ? " is-over" : ""}`}>
        <span className="deck-meter-fill" style={{ width: `${pct}%` }} />
      </span>
      <span className="font-micro text-2xs" style={{ color: over ? "var(--lx-text-danger)" : "var(--lx-text-muted)" }}>
        {images.length}/3 · {(total / (1024 * 1024)).toFixed(1)}/1.5MB
      </span>
    </div>
  );
}

export const AssistantChatComposer = memo(function AssistantChatComposer({
  slug,
  streaming,
  busy409,
  suspendedLock,
  suspendCount,
  attachDisabled,
  onSend,
  onAbort,
  rail,
  queued,
  onQueue,
  onUnqueue,
  seed,
  initialImages,
}: {
  slug: string;
  streaming: boolean;
  busy409: boolean;
  suspendedLock: boolean;
  suspendCount: number;
  attachDisabled: boolean;
  onSend: (message: string, imageCount: number) => boolean;
  onAbort: () => void;
  rail?: ReactNode | undefined;
  queued?: { text: string; heldReason?: "stopped" | "failed"; flushing?: boolean } | null | undefined;
  onQueue?: ((text: string) => void) | undefined;
  onUnqueue?: (() => void) | undefined;
  seed?: { text: string; nonce: number } | null | undefined;
  initialImages?: AssistantImage[] | undefined;
}) {
  const [draft, setDraft] = useState("");
  const [images, setImages] = useState<AssistantImage[]>(() => initialImages ?? []);
  const [rejection, setRejection] = useState<string | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const mention = useMentionTokens({ slug, value: draft, onChange: setDraft });
  const queueMode = streaming || suspendedLock;
  const elapsed = useElapsedSeconds(streaming);

  // Object URLs outlive the list when a send clears it or the composer
  // unmounts — revoke any URL that dropped out of the list, and all of them on
  // unmount, so previews don't leak (ported from the panel attach control).
  const prevImagesRef = useRef<AssistantImage[]>([]);
  useEffect(() => {
    const currentUrls = new Set(images.map((img) => img.previewUrl));
    for (const img of prevImagesRef.current) {
      if (!currentUrls.has(img.previewUrl) && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(img.previewUrl);
    }
    prevImagesRef.current = images;
  }, [images]);
  useEffect(
    () => () => {
      for (const img of prevImagesRef.current) {
        if (typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(img.previewUrl);
      }
    },
    []
  );

  useEffect(() => {
    if (!seed) return;
    setDraft(seed.text);
    composerRef.current?.focus();
  }, [seed?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  const composerStyle = useMemo<React.CSSProperties>(() => ({ position: "relative" }), []);
  const textareaStyle = useMemo<React.CSSProperties>(() => ({ border: "none", background: "transparent" }), []);

  const pasteIntoComposer = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      if (attachDisabled) return;
      const result = pastedImages(Array.from(e.clipboardData.files), images);
      if (!result) return;
      e.preventDefault();
      setImages(result.images);
      setRejection(result.rejection);
    },
    [attachDisabled, images]
  );

  const pickImages = useCallback(
    (files: File[]) => {
      const result = acceptImageFiles(files, images, CHAT_CAPS);
      setImages(result.images);
      setRejection(result.rejection);
    },
    [images]
  );

  const removeImage = useCallback((id: string) => setImages((prev) => prev.filter((img) => img.id !== id)), []);

  const handleSend = useCallback(() => {
    const msg = draft.trim();
    if (!msg || streaming || suspendedLock || busy409) return;
    const accepted = onSend(msg, images.length);
    if (!accepted) return;
    setDraft("");
    mention.close();
    setImages([]);
    setRejection(null);
  }, [draft, streaming, suspendedLock, busy409, onSend, images.length, mention]);

  const handleQueue = useCallback(() => {
    const msg = draft.trim();
    if (!msg || busy409) return;
    onQueue?.(msg);
    setDraft("");
    mention.close();
  }, [draft, busy409, onQueue, mention]);

  // The held Send is a no-op while the composer is busy (streaming / suspended /
  // 409): the page's send refuses those, and flushing would clear the held
  // message + attachments for a send that never happened. The queue is cleared
  // ONLY on an accepted send.
  const flushHeld = useCallback(() => {
    if (!queued) return;
    if (streaming || suspendedLock || busy409) return;
    const accepted = onSend(queued.text, images.length);
    if (!accepted) return;
    onUnqueue?.();
    setImages([]);
    setRejection(null);
  }, [queued, streaming, suspendedLock, busy409, images.length, onSend, onUnqueue]);

  // Click the queued chip text to pull the held message back into the draft.
  const editQueuedText = useCallback(() => {
    if (!queued || queued.flushing) return;
    setDraft(queued.text);
    onUnqueue?.();
    composerRef.current?.focus();
  }, [queued, onUnqueue]);

  const reviewApprovals = useCallback(() => {
    const scrollRoot = document.querySelector(".chat-scroll") ?? document;
    lastApprovalBatch(scrollRoot)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, []);

  const canSend = draft.trim().length > 0 && !busy409 && !streaming && !suspendedLock;
  const canQueue = draft.trim().length > 0 && !busy409;

  const placeholder = busy409
    ? "Waiting for the current reply…"
    : queueMode
      ? "Queue your next message…"
      : "Ask Assistant anything about this project…";

  return (
    <div className="chat-deck" style={composerStyle}>
      {mention.open && <ComposerMentionPopup mention={mention} composerRef={composerRef} />}
      {rail && (
        <div className="deck-rail" style={busy409 || queueMode ? { opacity: 0.55 } : undefined}>
          {rail}
        </div>
      )}
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
                disabled={streaming || suspendedLock || busy409}
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
          disabled={busy409}
          style={textareaStyle}
        />
      </div>
      {images.length > 0 && <AttachmentStrip images={images} onRemove={removeImage} />}
      {rejection && <span className="deck-warn">{rejection}</span>}
      <div className="deck-action composer-footer">
        {busy409 ? (
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
              <AttachButton onPick={pickImages} disabled={attachDisabled} />
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
