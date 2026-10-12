import { useEffect, useMemo, useRef, useState, type FocusEvent } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import type { JSONContent } from "@tiptap/core";
import { Check, X } from "lucide-react";
import type { TipTapDoc } from "../../shared/types";
import { textEditorExtensions, extensionsWithMentions } from "../lib/tiptap";
import { useAttachmentEmbeds } from "../lib/useAttachmentEmbeds";
import { cn } from "./ui/cn";
import { Toolbar } from "./TextEditor";
import { AssistantReviewSurface } from "./assistant/AssistantReviewSurface";
import { useAssistantReview } from "../lib/useAssistantReview";
import { EditorViewToggle, type EditorView } from "./editor/EditorViewToggle";
import { MarkdownEditorPane, type MarkdownTarget } from "./editor/MarkdownEditorPane";
import { renderDoc } from "./tiptap-render";

interface DescriptionEditorProps {
  initialContent: TipTapDoc;
  onChange?: (doc: TipTapDoc) => void;
  onBlur?: (doc: TipTapDoc) => void;
  onDone?: (doc: TipTapDoc) => void;
  onCancel?: () => void;
  editable?: boolean | undefined;
  runtime?: { slug: string; documentType: "task" | "wiki"; documentId: string } | undefined;
  // Paste/drop-to-embed uploads (attachments API). Absent in create mode —
  // there is no taskId to attach to yet.
  attachments?: { slug: string; documentId: string } | undefined;
  onReviewStateChange?: (active: boolean) => void;
}

// The task description editor. The Editor view is the document's Markdown
// source (a plain-text coding area) with the toolbar acting on that source; the
// Preview view is the same document through the read renderer. The document
// stays TipTap JSON (invariant 7): a pane edit converts back through
// shared/markdown.ts and is carried over the constructs Markdown cannot write
// (see carryNonMarkdownContent), and the editor instance below stays the model
// the Assistant, the review flow and the save path read.
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
  const [doc, setDoc] = useState<TipTapDoc>(initialContent);
  const docRef = useRef(doc);
  const targetRef = useRef<MarkdownTarget | null>(null);
  const slug = runtime?.slug ?? attachments?.slug;

  useEffect(() => {
    docRef.current = doc;
  }, [doc]);

  const applyDoc = (next: TipTapDoc) => {
    docRef.current = next;
    setDoc(next);
    editorRef.current?.commands.setContent(next as unknown as JSONContent, { emitUpdate: false });
    onChangeRef.current?.(next);
  };

  // An accepted Assistant result replaces the document through the editor, so
  // the pane takes the document back from there.
  const adoptEditorDoc = () => {
    const next = editorRef.current?.getJSON() as unknown as TipTapDoc | undefined;
    if (!next) return;
    docRef.current = next;
    setDoc(next);
    onChangeRef.current?.(next);
  };

  // Runtime review end: persist whatever the doc holds now (the accepted
  // replacement) via the same save path as Done. Reject leaves the doc
  // untouched — stay in edit mode.
  const handleReviewStateChange = (active: boolean, accepted: boolean) => {
    onReviewStateChange?.(active);
    if (!active && accepted && onDoneRef.current) {
      onDoneRef.current(docRef.current);
    }
  };
  const wrapperRef = useRef<HTMLDivElement>(null);
  const lastPointerDownInside = useRef(false);
  const editorRef = useRef<NonNullable<ReturnType<typeof useEditor>> | null>(null);

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      lastPointerDownInside.current =
        wrapperRef.current?.contains(target) === true || target?.closest("[data-assistant-popover]") !== null;
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, []);

  // Hooks run unconditionally — empty options when attachments wiring is
  // absent (create mode); handlers only spread while active.
  const embeds = useAttachmentEmbeds(
    attachments
      ? { slug: attachments.slug, documentType: "task", documentId: attachments.documentId }
      : { slug: "", documentType: "task", documentId: "" }
  );
  const embedsActive = !!(attachments && attachments.slug && attachments.documentId);

  // Stable extension list — rebuilding it per render made TipTap re-apply
  // options on every keystroke.
  const extensions = useMemo(
    () => extensionsWithMentions(textEditorExtensions, attachments?.slug ?? runtime?.slug),
    [attachments?.slug, runtime?.slug]
  );

  const editor = useEditor({
    immediatelyRender: false,
    extensions,
    content: initialContent as unknown as JSONContent,
    editable,
    // The pane commits the document itself; this fires when something else
    // replaced the editor document (an accepted Assistant result).
    onUpdate: () => adoptEditorDoc(),
    onCreate: ({ editor: ed }) => {
      editorRef.current = ed;
    },
    editorProps: {
      ...(embedsActive ? { handlePaste: embeds.handlePaste, handleDrop: embeds.handleDrop } : {}),
    },
  });

  const { review, appliedTaskId, rejectedTaskId, handleReview, handleAcceptReview, handleRejectReview } = useAssistantReview(editor, handleReviewStateChange);

  if (!editor) return null;

  const handleDone = () => {
    onDoneRef.current?.(docRef.current);
  };

  // The pane's textarea is the field that takes focus now, so the
  // exit-on-blur rule lives on the wrapper: a focus that leaves the editor and
  // its chrome saves and closes, exactly as the editor body used to.
  const handleWrapperBlur = (event: FocusEvent<HTMLDivElement>) => {
    const related = event.relatedTarget as HTMLElement | null;
    if (related !== null) {
      if (wrapperRef.current?.contains(related) === true || related.closest("[data-assistant-popover]") !== null) return;
    } else if (lastPointerDownInside.current) {
      return;
    }
    onBlurRef.current?.(docRef.current);
  };

  const toolbar = (
    <Toolbar editor={editor} runtime={runtime} reviewActive={review !== null} appliedTaskId={appliedTaskId} rejectedTaskId={rejectedTaskId} onReview={handleReview} target={targetRef} disabled={view === "preview"}>
      <EditorViewToggle view={view} onChange={setView} />
    </Toolbar>
  );
  const reviewSurface = review ? (
    <AssistantReviewSurface skillName={review.skillName} agentName={review.agentName} diff={review.diff} onAccept={handleAcceptReview} onReject={handleRejectReview} />
  ) : null;
  const body =
    view === "editor" ? (
      <MarkdownEditorPane
        doc={doc}
        slug={slug}
        editable={editable && review === null}
        onDocChange={applyDoc}
        onEnter={onDone ? handleDone : undefined}
        onEscape={onDone ? () => onCancelRef.current?.() : undefined}
        targetRef={targetRef}
        ariaLabel="Task description, Markdown"
      />
    ) : (
      <div className="editor-preview td-prose">{renderDoc(doc, "task", slug)}</div>
    );
  // The editor instance stays mounted: it is the document model the Assistant
  // popover and the review flow read, and every pane commit lands in it.
  const model = (
    <div hidden>
      <EditorContent editor={editor} className="editor-content" />
    </div>
  );
  const exitControls = (
    <div className="flex items-center gap-2">
      <button
        type="button"
        className="btn btn-ghost btn-icon-sm"
        onClick={() => onCancelRef.current?.()}
        title="Revert changes (Esc)"
        aria-label="Revert changes"
      >
        <X size={13} strokeWidth={2} />
      </button>
      <button
        type="button"
        className="btn btn-primary btn-icon-sm"
        onClick={handleDone}
        title="Save and finish (Enter)"
        aria-label="Save and finish editing"
      >
        <Check size={13} strokeWidth={2.5} />
      </button>
    </div>
  );

  // Create mode (no onDone): legacy inset card — toolbar + document inside the
  // bordered wrapper, unchanged from before the edit-mode restructure.
  if (!onDone) {
    return (
      <div className={cn("editor-wrapper", review && "is-reviewing")} ref={wrapperRef}>
        <div style={{ display: "flex", alignItems: "center", background: "var(--lx-surface-card)", borderRadius: "6px 6px 0 0" }}>
          {toolbar}
        </div>
        {reviewSurface}
        {body}
        {model}
      </div>
    );
  }

  // Edit mode (task-detail-edit.html / task-detail-page-edit.html): the
  // wiki-style card — label + exit controls on a quiet row above one bordered
  // wrapper holding the toolbar and document. wrapperRef spans both so blur
  // inside the row never exits edit mode.
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
        {model}
      </div>
    </div>
  );
}
