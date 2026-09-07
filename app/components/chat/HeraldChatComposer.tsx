import { memo, useCallback, useMemo, useRef, useState } from "react";
import { Send, Square } from "lucide-react";
import { acceptImageFiles, type HeraldImage } from "../../lib/herald-image";
import { useMentionTokens } from "../../lib/useMentionTokens";
import { HeraldImageAttach } from "../hearth/herald/HeraldImageAttach";
import { EffortPicker } from "./EffortPicker";
import type { HeraldReasoningEffort } from "../../../shared/herald";

const CHAT_CAPS = { maxCount: 3, maxTotalBytes: Math.floor(1.5 * 1024 * 1024) };
const ATTACH_DISABLED_TITLE_GLOBAL = "Images are disabled — configure vision in Project Settings → Herald.";

// Paste handler body: image files only, capped; null = nothing accepted.
function pastedImages(files: File[], current: HeraldImage[]): HeraldImage[] | null {
  const images = Array.from(files).filter((f) => f.type.startsWith("image/"));
  if (images.length === 0) return null;
  return acceptImageFiles(images, current, CHAT_CAPS).images;
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

// Footer right/left slots per composer phase (streaming / suspended / idle).
function ComposerFooter({
  streaming,
  suspendedLock,
  suspendTally,
  images,
  setImages,
  attachDisabled,
  isMobileComposer,
  effort,
  projectEffort,
  onEffortChange,
  onAbort,
  onSend,
  canSend,
}: {
  streaming: boolean;
  suspendedLock: boolean;
  suspendTally: string;
  images: HeraldImage[];
  setImages: (images: HeraldImage[]) => void;
  attachDisabled: boolean;
  isMobileComposer: boolean;
  effort: HeraldReasoningEffort | "";
  projectEffort: HeraldReasoningEffort | null | undefined;
  onEffortChange: (e: HeraldReasoningEffort | "") => void;
  onAbort: () => void;
  onSend: () => void;
  canSend: boolean;
}) {
  if (streaming) {
    return (
      <>
        <span className="font-micro text-2xs text-lx-text-warning uppercase tracking-[0.04em]">● Streaming…</span>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          style={{ borderColor: "var(--lx-bg-danger-subtle)", color: "var(--lx-text-danger)" }}
          onClick={onAbort}
        >
          <Square size={12} strokeWidth={1.5} fill="currentColor" />
          Stop
        </button>
      </>
    );
  }
  if (suspendedLock) {
    return (
      <>
        <span className="font-micro text-2xs text-lx-text-warning" style={{ transform: "uppercase", textTransform: "uppercase", letterSpacing: "0.04em" }}>
          ● Turn suspended{suspendTally ? ` — ${suspendTally}` : ""}
        </span>
        <button type="button" className="btn btn-primary btn-sm" disabled>
          Send
        </button>
      </>
    );
  }
  return (
    <>
      <div className="flex items-center gap-2">
        <HeraldImageAttach images={images} onChange={setImages} caps={CHAT_CAPS} hint="" compact disabled={attachDisabled} disabledTitle={ATTACH_DISABLED_TITLE_GLOBAL} />
        <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]">≤3 images · ≤1.5MB total</span>
      </div>
      <div className="flex items-center gap-2">
        <EffortPicker effort={effort} projectEffort={projectEffort ?? null} disabled={streaming} align={isMobileComposer ? "up" : "down"} onChange={onEffortChange} />
        <button type="button" className="btn btn-primary btn-sm" disabled={!canSend} onClick={onSend}>
          Send
          <Send size={12} strokeWidth={1.5} />
        </button>
      </div>
    </>
  );
}

export const HeraldChatComposer = memo(function HeraldChatComposer({
  slug,
  streaming,
  busy409,
  suspendedLock,
  suspendTally,
  attachDisabled,
  isMobileComposer,
  effort,
  projectEffort,
  onEffortChange,
  onSend,
  onAbort,
}: {
  slug: string;
  streaming: boolean;
  busy409: boolean;
  suspendedLock: boolean;
  suspendTally: string;
  attachDisabled: boolean;
  isMobileComposer: boolean;
  effort: HeraldReasoningEffort | "";
  projectEffort: HeraldReasoningEffort | null | undefined;
  onEffortChange: (e: HeraldReasoningEffort | "") => void;
  onSend: (message: string, imageCount: number) => void;
  onAbort: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [images, setImages] = useState<HeraldImage[]>([]);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const mention = useMentionTokens({ slug, value: draft, onChange: setDraft });

  const composerStyle = useMemo<React.CSSProperties>(
    () => ({ ...(busy409 || suspendedLock ? { opacity: 0.55 } : {}), position: "relative" }),
    [busy409, suspendedLock]
  );
  const textareaStyle = useMemo<React.CSSProperties>(() => ({ border: "none", background: "transparent" }), []);

  const pasteIntoComposer = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      if (attachDisabled) return;
      const result = pastedImages(Array.from(e.clipboardData.files), images);
      if (!result) return;
      e.preventDefault();
      setImages(result);
    },
    [attachDisabled, images]
  );

  const handleSend = useCallback(() => {
    const msg = draft.trim();
    if (!msg || streaming || suspendedLock || busy409) return;
    onSend(msg, images.length);
    setDraft("");
    mention.close();
    setImages([]);
  }, [draft, streaming, suspendedLock, busy409, onSend, images.length, mention]);

  const canSend = draft.trim().length > 0 && !busy409 && !streaming && !suspendedLock;

  return (
    <div className="composer" style={composerStyle}>
      {mention.open && <ComposerMentionPopup mention={mention} composerRef={composerRef} />}
      <textarea
        ref={composerRef}
        className="composer-editor w-full"
        rows={streaming || suspendedLock ? 1 : 2}
        placeholder={streaming ? "Herald is responding…" : suspendedLock ? "Decide the pending changes above…" : "Ask Herald anything about this project…"}
        value={draft}
        onChange={mention.handleChange}
        onPaste={pasteIntoComposer}
        onSelect={mention.handleSelectCaret}
        onKeyDown={(e) => {
          if (mention.handleKeyDown(e)) return;
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            handleSend();
          }
        }}
        disabled={streaming || busy409 || suspendedLock}
        style={textareaStyle}
      />
      <div className="composer-footer">
        <ComposerFooter
          streaming={streaming}
          suspendedLock={suspendedLock}
          suspendTally={suspendTally}
          images={images}
          setImages={setImages}
          attachDisabled={attachDisabled}
          isMobileComposer={isMobileComposer}
          effort={effort}
          projectEffort={projectEffort}
          onEffortChange={onEffortChange}
          onAbort={onAbort}
          onSend={handleSend}
          canSend={canSend}
        />
      </div>
    </div>
  );
});
