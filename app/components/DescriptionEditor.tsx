import { useEffect, useRef, useState, type FocusEvent } from "react";
import { Check, X } from "lucide-react";
import { cn } from "./ui/cn";
import { MarkdownToolbar } from "./TextEditor";
import { AssistantReviewSurface } from "./assistant/AssistantReviewSurface";
import { useAssistantReview } from "../lib/useAssistantReview";
import { EditorViewToggle, type EditorView } from "./editor/EditorViewToggle";
import { MarkdownEditorPane, type MarkdownSource, type MarkdownTarget } from "./editor/MarkdownEditorPane";
import { MarkdownContent } from "./MarkdownContent";
import { useAttachmentEmbeds } from "../lib/useAttachmentEmbeds";

interface DescriptionEditorProps {
  initialContent: string;
  onChange?: (source: string) => void;
  onBlur?: (source: string) => void | Promise<void>;
  onDone?: (source: string) => void | Promise<void>;
  onCancel?: () => void;
  editable?: boolean | undefined;
  runtime?: { slug: string; documentType: "task" | "wiki"; documentId: string } | undefined;
  attachments?: { slug: string; documentId: string } | undefined;
  onReviewStateChange?: (active: boolean) => void;
}

export function DescriptionEditor({
  initialContent,
  onChange,
  onBlur,
  onDone,
  onCancel,
  editable = true,
  runtime,
  attachments,
  onReviewStateChange,
}: DescriptionEditorProps) {
  const onBlurRef = useRef(onBlur);
  const onChangeRef = useRef(onChange);
  const onDoneRef = useRef(onDone);
  const onCancelRef = useRef(onCancel);
  useEffect(() => {
    onBlurRef.current = onBlur;
    onChangeRef.current = onChange;
    onDoneRef.current = onDone;
    onCancelRef.current = onCancel;
  });
  const [view, setView] = useState<EditorView>("editor");
  const [source, setSource] = useState(initialContent);
  const sourceValueRef = useRef(source);
  const sourceRef = useRef<MarkdownSource | null>(null);
  const targetRef = useRef<MarkdownTarget | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const lastPointerDownInside = useRef(false);
  const slug = runtime?.slug ?? attachments?.slug;
  const sourceIdentity = `${runtime?.documentType ?? "task"}:${runtime?.documentId ?? attachments?.documentId ?? "draft"}`;

  const updateSource = (next: string) => {
    sourceValueRef.current = next;
    setSource(next);
    onChangeRef.current?.(next);
  };

  const handleReviewStateChange = (active: boolean, accepted: boolean) => {
    onReviewStateChange?.(active);
    if (!active && accepted) void onDoneRef.current?.(sourceRef.current?.getValue() ?? sourceValueRef.current);
  };
  const { review, appliedTaskId, rejectedTaskId, handleReview, handleAcceptReview, handleRejectReview } =
    useAssistantReview(sourceRef, sourceIdentity, handleReviewStateChange);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      lastPointerDownInside.current =
        wrapperRef.current?.contains(target) === true || target?.closest("[data-assistant-popover]") !== null;
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, []);

  const embeds = useAttachmentEmbeds(
    attachments
      ? { slug: attachments.slug, documentType: "task", documentId: attachments.documentId, enabled: editable }
      : { slug: "", documentType: "task", documentId: "", enabled: false }
  );
  const embedsActive = !!(attachments && attachments.slug && attachments.documentId && editable);

  const handleCancel = () => {
    embeds.cancelPending();
    onCancelRef.current?.();
  };

  const handleDone = async () => {
    const latest = sourceRef.current?.getValue() ?? sourceValueRef.current;
    sourceValueRef.current = latest;
    await onDoneRef.current?.(latest);
  };
  const handleWrapperBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (review !== null) return;
    const related = event.relatedTarget as HTMLElement | null;
    if (related !== null) {
      if (wrapperRef.current?.contains(related) === true || related.closest("[data-assistant-popover]") !== null) return;
    } else if (lastPointerDownInside.current) {
      return;
    }
    void onBlurRef.current?.(sourceRef.current?.getValue() ?? sourceValueRef.current);
  };

  const toolbar = (
    <MarkdownToolbar
      sourceRef={sourceRef}
      runtime={runtime}
      reviewActive={review !== null}
      appliedTaskId={appliedTaskId}
      rejectedTaskId={rejectedTaskId}
      onReview={handleReview}
      target={targetRef}
      disabled={view === "preview"}
    >
      <EditorViewToggle view={view} onChange={setView} />
    </MarkdownToolbar>
  );
  const reviewSurface = review ? (
    <AssistantReviewSurface skillName={review.skillName} agentName={review.agentName} diff={review.diff} onAccept={handleAcceptReview} onReject={handleRejectReview} />
  ) : null;
  const body = (
    <>
      <MarkdownEditorPane
        value={source}
        onChange={updateSource}
        editable={editable && review === null}
        onEnter={onDone && review === null ? () => void handleDone() : undefined}
        onEscape={review ? handleRejectReview : onDone ? handleCancel : undefined}
        targetRef={targetRef}
        sourceRef={sourceRef}
        ariaLabel="Task description, Markdown"
        hidden={view !== "editor"}
        mentionSlug={runtime?.slug}
        onPaste={embedsActive ? embeds.handlePaste : undefined}
        onDrop={embedsActive ? embeds.handleDrop : undefined}
        onViewUpdate={embeds.handleViewUpdate}
      />
      {view === "preview" && (
        <div className="editor-preview td-prose">
          {source.length > 0 ? <MarkdownContent md={source} surface="task" /> : <p className="italic text-lx-text-muted">Add a description...</p>}
        </div>
      )}
    </>
  );
  const exitControls = (
    <div className="flex items-center gap-2">
      <button
        type="button"
        className="btn btn-ghost btn-icon-sm"
        onClick={handleCancel}
        title="Revert changes (Esc)"
        aria-label="Revert changes"
      >
        <X size={13} strokeWidth={2} />
      </button>
      <button
        type="button"
        className="btn btn-primary btn-icon-sm"
        onClick={() => void handleDone()}
        title="Save and finish (Enter)"
        aria-label="Save and finish editing"
      >
        <Check size={13} strokeWidth={2.5} />
      </button>
    </div>
  );

  if (!onDone) {
    return (
      <div className={cn("editor-wrapper", review && "is-reviewing")} ref={wrapperRef}>
        <div style={{ display: "flex", alignItems: "center", background: "var(--lx-surface-card)", borderRadius: "6px 6px 0 0" }}>
          {toolbar}
        </div>
        {reviewSurface}
        {body}
      </div>
    );
  }

  return (
    <div ref={wrapperRef} onBlur={handleWrapperBlur}>
      <div className="flex items-center justify-between" style={{ padding: "0 0 6px" }}>
        <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]">Editing description</span>
        {exitControls}
      </div>
      <div className={cn("editor-wrapper", review && "is-reviewing")}>
        {toolbar}
        {reviewSurface}
        {body}
      </div>
    </div>
  );
}
