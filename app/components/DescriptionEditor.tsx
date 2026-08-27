import { useEffect, useRef } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import type { JSONContent } from "@tiptap/core";
import { Check, X } from "lucide-react";
import type { TipTapDoc } from "../../shared/types";
import { textEditorExtensions, extensionsWithMentions } from "../lib/tiptap";
import { useAttachmentEmbeds } from "../lib/useAttachmentEmbeds";
import { cn } from "./ui/cn";
import { TextEditor, Toolbar } from "./TextEditor";
import { HearthReviewSurface } from "./hearth/HearthReviewSurface";
import { useHearthReview } from "./hearth/useHearthReview";

interface DescriptionEditorProps {
  initialContent: TipTapDoc;
  onChange?: (doc: TipTapDoc) => void;
  onBlur?: (doc: TipTapDoc) => void;
  onDone?: (doc: TipTapDoc) => void;
  onCancel?: () => void;
  placeholder?: string | undefined;
  editable?: boolean | undefined;
  hearth?: { slug: string; documentType: "task" | "wiki"; documentId: string } | undefined;
  // Paste/drop-to-embed uploads (attachments API). Absent in create mode —
  // there is no taskId to attach to yet.
  attachments?: { slug: string; documentId: string } | undefined;
  onReviewStateChange?: (active: boolean) => void;
}

export function DescriptionEditor({
  initialContent,
  onChange,
  onBlur,
  onDone,
  onCancel,
  placeholder,
  editable = true,
  hearth,
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
  // Hearth review end: persist whatever the doc holds now (the accepted
  // replacement) via the same save path as Done. Reject leaves the doc
  // untouched — stay in edit mode.
  const handleReviewStateChange = (active: boolean, accepted: boolean) => {
    onReviewStateChange?.(active);
    if (!active && accepted && onDoneRef.current && editorRef.current) {
      onDoneRef.current(editorRef.current.getJSON() as unknown as TipTapDoc);
    }
  };
  const wrapperRef = useRef<HTMLDivElement>(null);
  const lastPointerDownInside = useRef(false);
  const editorRef = useRef<NonNullable<ReturnType<typeof useEditor>> | null>(null);

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      lastPointerDownInside.current =
        wrapperRef.current?.contains(target) === true || target?.closest("[data-hearth-popover]") !== null;
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

  const editor = useEditor({
    immediatelyRender: false,
    extensions: extensionsWithMentions(
      textEditorExtensions,
      attachments?.slug ?? hearth?.slug
    ),
    content: initialContent as unknown as JSONContent,
    editable,
    onUpdate: ({ editor: nextEditor }) => {
      onChangeRef.current?.(nextEditor.getJSON() as unknown as TipTapDoc);
    },
    onBlur: ({ editor: ed }) => {
      onBlurRef.current?.(ed.getJSON() as unknown as TipTapDoc);
    },
    onCreate: ({ editor: ed }) => {
      editorRef.current = ed;
    },
    editorProps: {
      handleKeyDown: (_view, event) => {
        // Enter (not during IME composition) finishes editing; Esc reverts.
        if (event.key === "Enter" && !event.isComposing && !event.shiftKey) {
          event.preventDefault();
          const doc = editor?.getJSON() as unknown as TipTapDoc | undefined;
          if (doc) onDoneRef.current?.(doc);
          return true;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          onCancelRef.current?.();
          return true;
        }
        return false;
      },
      ...(embedsActive ? { handlePaste: embeds.handlePaste, handleDrop: embeds.handleDrop } : {}),
      handleDOMEvents: {
        // Returning true stops ProseMirror's focusEvents plugin, so the
        // editor never reports a blur when focus moves within its own chrome
        // (toolbar, done/cancel buttons) and onBlur doesn't exit edit mode.
        // A blur with null relatedTarget (browser quirk when a selection is
        // active, or prompt dialogs) is only kept when the pointer went down
        // inside the chrome.
        blur: (_view, event) => {
          const related = (event as FocusEvent).relatedTarget as HTMLElement | null;
          if (related !== null) {
            return wrapperRef.current?.contains(related) === true || related?.closest("[data-hearth-popover]") !== null;
          }
          return lastPointerDownInside.current;
        },
      },
    },
  });

  const { review, appliedTaskId, rejectedTaskId, handleReview, handleAcceptReview, handleRejectReview } = useHearthReview(editor, handleReviewStateChange);

  if (!editor) return null;

  const headingLevel = (editor.getAttributes("heading").level as number | undefined) ?? 0;

  const handleDone = () => {
    onDoneRef.current?.(editor.getJSON() as unknown as TipTapDoc);
  };

  const toolbar = (
    <Toolbar editor={editor} headingLevel={headingLevel} hearth={hearth} reviewActive={review !== null} appliedTaskId={appliedTaskId} rejectedTaskId={rejectedTaskId} onReview={handleReview} />
  );
  const reviewSurface = review ? (
    <HearthReviewSurface action={review.action} runtime={review.runtime} diff={review.diff} onAccept={handleAcceptReview} onReject={handleRejectReview} />
  ) : null;

  // Create mode (no onDone): legacy inset card — toolbar + document inside
  // the bordered wrapper, unchanged from before the edit-mode restructure.
  if (!onDone) {
    return (
      <div className={cn("editor-wrapper", review && "is-reviewing")} ref={wrapperRef}>
        <div style={{ display: "flex", alignItems: "center", background: "var(--lx-surface-card)", borderRadius: "6px 6px 0 0" }}>
          {toolbar}
        </div>
        {reviewSurface}
        <EditorContent editor={editor} className="editor-content" />
      </div>
    );
  }

  // Edit mode (task-detail-edit.html): chrome band — header strip + toolbar —
  // renders full-bleed OUTSIDE the bordered card; the card wraps only the
  // document so focus border + glow stay inset. wrapperRef still spans both,
  // so blur inside the chrome never exits edit mode.
  return (
    <div className="task-editor-host" ref={wrapperRef}>
      <div className="task-editor-chrome">
        <div
          className="flex items-center justify-between"
          style={{ padding: "6px 16px", borderBottom: "1px solid var(--lx-border-default)" }}
        >
          <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]">Editing description</span>
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
        </div>
        <div style={{ display: "flex", alignItems: "center", background: "var(--lx-surface-card)", borderBottom: "1px solid var(--lx-border-default)" }}>
          {toolbar}
        </div>
      </div>
      <div className={cn("editor-wrapper", review && "is-reviewing")}>
        {reviewSurface}
        <EditorContent editor={editor} className="editor-content" />
      </div>
    </div>
  );
}
