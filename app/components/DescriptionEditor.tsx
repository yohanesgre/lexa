import { useEffect, useRef } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import type { JSONContent } from "@tiptap/core";
import { Check, X } from "lucide-react";
import type { TipTapDoc } from "../../shared/types";
import { textEditorExtensions } from "../lib/tiptap";
import { cn } from "./ui/cn";
import { TextEditor, Toolbar } from "./TextEditor";
import { ForgeReviewSurface } from "./forge/ForgeReviewSurface";
import { useForgeReview } from "./forge/useForgeReview";

interface DescriptionEditorProps {
  initialContent: TipTapDoc;
  onChange?: (doc: TipTapDoc) => void;
  onBlur?: (doc: TipTapDoc) => void;
  onDone?: (doc: TipTapDoc) => void;
  onCancel?: () => void;
  placeholder?: string;
  editable?: boolean;
  forge?: { slug: string; documentType: "task" | "wiki"; documentId: string };
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
  forge,
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
  // Forge review end: persist whatever the doc holds now (the accepted
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
        wrapperRef.current?.contains(target) === true || target?.closest("[data-forge-popover]") !== null;
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, []);

  const editor = useEditor({
    immediatelyRender: false,
    extensions: textEditorExtensions,
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
            return wrapperRef.current?.contains(related) === true || related?.closest("[data-forge-popover]") !== null;
          }
          return lastPointerDownInside.current;
        },
      },
    },
  });

  const { review, appliedTaskId, handleReview, handleAcceptReview, handleRejectReview } = useForgeReview(editor, handleReviewStateChange);

  if (!editor) return null;

  const headingLevel = (editor.getAttributes("heading").level as number | undefined) ?? 0;

  const handleDone = () => {
    onDoneRef.current?.(editor.getJSON() as unknown as TipTapDoc);
  };

  return (
    <div className={cn("editor-wrapper", review && "is-reviewing")} ref={wrapperRef}>
      {onDone && (
        <div
          className="flex items-center justify-between"
          style={{ padding: "6px 8px 6px 12px", borderBottom: "1px solid var(--lx-border-default)", borderRadius: "6px 6px 0 0", background: "var(--lx-surface-card)" }}
        >
          <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]">Editing description</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="btn btn-ghost btn-icon-sm"
              style={{ width: 28, height: 28, padding: 0 }}
              onClick={() => onCancelRef.current?.()}
              title="Revert changes (Esc)"
              aria-label="Revert changes"
            >
              <X size={13} strokeWidth={2} />
            </button>
            <button
              type="button"
              className="btn btn-primary btn-icon-sm"
              style={{ width: 28, height: 28, padding: 0 }}
              onClick={handleDone}
              title="Save and finish (Enter)"
              aria-label="Save and finish editing"
            >
              <Check size={13} strokeWidth={2.5} />
            </button>
          </div>
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", borderBottom: "1px solid var(--lx-border-default)" }}>
        <Toolbar editor={editor} headingLevel={headingLevel} forge={forge} reviewActive={review !== null} appliedTaskId={appliedTaskId} onReview={handleReview} />
      </div>
      {review && (
        <ForgeReviewSurface action={review.action} runtime={review.runtime} diff={review.diff} onAccept={handleAcceptReview} onReject={handleRejectReview} />
      )}
      <EditorContent editor={editor} className="editor-content" />
    </div>
  );
}
