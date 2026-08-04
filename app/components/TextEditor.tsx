import { useRef, useMemo, useState, useEffect } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import type { TipTapDoc } from "../../shared/types";
import type { JSONContent } from "@tiptap/core";
import { cn } from "./ui/cn";
import { ForgePopover } from "./forge/ForgePopover";
import { ForgeReviewSurface } from "./forge/ForgeReviewSurface";
import { useForgeReview, type ForgeReviewIdentity } from "./forge/useForgeReview";
import { textEditorExtensions } from "../lib/tiptap";
import Placeholder from "@tiptap/extension-placeholder";

interface TextEditorProps {
  initialContent: TipTapDoc;
  onChange?: (doc: TipTapDoc) => void;
  onBlur?: (doc: TipTapDoc) => void;
  placeholder?: string;
  editable?: boolean;
  editorProps?: Record<string, unknown>;
  className?: string;
  extensions?: typeof textEditorExtensions;
  // Forge (AI writing assistant) wiring
  forge?: {
    slug: string;
    documentType: "task" | "wiki";
    documentId: string;
  };
  // Fired when a Forge review enters/exits the editor (used by surfaces to
  // suspend autosave while a result is under review — the document itself is
  // never modified until Accept, so nothing unaccepted can be saved).
  onReviewStateChange?: (active: boolean) => void;
}

function ToolbarButton({
  command,
  isActive,
  title,
  children,
  disabled,
}: {
  command: () => void;
  isActive: boolean;
  title: string;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={isActive}
      onClick={command}
      disabled={disabled}
      className={cn("toolbar-btn", isActive && "active")}
    >
      {children}
    </button>
  );
}

function ToolbarSeparator() {
  return <span className="toolbar-sep" role="separator" aria-hidden="true" />;
}

function setLink(editor: NonNullable<ReturnType<typeof useEditor>>) {
  const previous = editor.getAttributes("link").href as string | undefined;
  const url = window.prompt("Link URL", previous ?? "");
  if (url === null) return;
  if (url.trim() === "") {
    editor.chain().focus().extendMarkRange("link").unsetLink().run();
    return;
  }
  const href = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
}

export function Toolbar({
  editor,
  headingLevel,
  forge,
  reviewActive,
  appliedTaskId,
  onReview,
}: {
  editor: NonNullable<ReturnType<typeof useEditor>>;
  headingLevel: number;
  forge?: TextEditorProps["forge"];
  // Forge review-in-editor: the review surface is rendered by the editing
  // surfaces in the editor body, not by the toolbar. The toolbar only opens
  // the Forge popover; "Review in editor" hands the result up via onReview.
  reviewActive: boolean;
  appliedTaskId: string | null;
  onReview?: (text: string, identity: ForgeReviewIdentity) => void;
}) {
  const [forgeOpen, setForgeOpen] = useState(false);
  const [forgeAnchor, setForgeAnchor] = useState<DOMRect | null>(null);
  const forgeBtnRef = useRef<HTMLButtonElement>(null);

  return (
    <>
      <div className="editor-toolbar wiki-toolbar-host" style={{ borderBottom: "1px solid var(--lx-border-default)", borderRadius: "6px 6px 0 0" }}>
        <div className="wiki-toolbar-row">
        <ToolbarButton command={() => editor.chain().focus().undo().run()} isActive={false} title="Undo" disabled={!editor.can().undo()}>
          <i className="ph ph-arrow-arc-left" />
        </ToolbarButton>
        <ToolbarButton command={() => editor.chain().focus().redo().run()} isActive={false} title="Redo" disabled={!editor.can().redo()}>
          <i className="ph ph-arrow-arc-right" />
        </ToolbarButton>
        <ToolbarSeparator />
        <ToolbarButton command={() => editor.chain().focus().toggleBold().run()} isActive={editor.isActive("bold")} title="Bold">
          <i className="ph ph-text-b" />
        </ToolbarButton>
        <ToolbarButton command={() => editor.chain().focus().toggleItalic().run()} isActive={editor.isActive("italic")} title="Italic">
          <i className="ph ph-text-italic" />
        </ToolbarButton>
        <ToolbarButton command={() => editor.chain().focus().toggleUnderline().run()} isActive={editor.isActive("underline")} title="Underline">
          <i className="ph ph-text-underline" />
        </ToolbarButton>
        <ToolbarButton command={() => editor.chain().focus().toggleStrike().run()} isActive={editor.isActive("strike")} title="Strikethrough">
          <i className="ph ph-text-strikethrough" />
        </ToolbarButton>
        <ToolbarButton command={() => editor.chain().focus().toggleHighlight().run()} isActive={editor.isActive("highlight")} title="Highlight">
          <i className="ph ph-highlighter-circle" />
        </ToolbarButton>
        <ToolbarSeparator />
        <ToolbarButton command={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} isActive={headingLevel === 2} title="Heading 2">
          <i className="ph ph-text-h-two" />
        </ToolbarButton>
        <ToolbarButton command={() => editor.chain().focus().toggleHeading({ level: 3 }).run()} isActive={headingLevel === 3} title="Heading 3">
          <i className="ph ph-text-h-three" />
        </ToolbarButton>
        <ToolbarButton command={() => editor.chain().focus().toggleHeading({ level: 4 }).run()} isActive={headingLevel === 4} title="Heading 4">
          <i className="ph ph-text-h-four" />
        </ToolbarButton>
        <ToolbarButton command={() => editor.chain().focus().toggleHeading({ level: 5 }).run()} isActive={headingLevel === 5} title="Heading 5">
          <i className="ph ph-text-h-five" />
        </ToolbarButton>
        <ToolbarSeparator />
        <ToolbarButton command={() => editor.chain().focus().toggleBulletList().run()} isActive={editor.isActive("bulletList")} title="Bullet list">
          <i className="ph ph-list-bullets" />
        </ToolbarButton>
        <ToolbarButton command={() => editor.chain().focus().toggleOrderedList().run()} isActive={editor.isActive("orderedList")} title="Ordered list">
          <i className="ph ph-list-numbers" />
        </ToolbarButton>
        <ToolbarButton command={() => editor.chain().focus().toggleTaskList().run()} isActive={editor.isActive("taskList")} title="Task list">
          <i className="ph ph-list-checks" />
        </ToolbarButton>
        <ToolbarSeparator />
        <ToolbarButton command={() => editor.chain().focus().toggleBlockquote().run()} isActive={editor.isActive("blockquote")} title="Blockquote">
          <i className="ph ph-quotes" />
        </ToolbarButton>
        <ToolbarButton command={() => editor.chain().focus().toggleCodeBlock().run()} isActive={editor.isActive("codeBlock")} title="Code block">
          <i className="ph ph-code-block" />
        </ToolbarButton>
        <ToolbarButton command={() => editor.chain().focus().setHorizontalRule().run()} isActive={false} title="Horizontal rule">
          <i className="ph ph-minus" />
        </ToolbarButton>
        <ToolbarSeparator />
        <ToolbarButton command={() => setLink(editor)} isActive={editor.isActive("link")} title="Link">
          <i className="ph ph-link" />
        </ToolbarButton>
        <ToolbarSeparator />
        <button
          ref={forgeBtnRef}
          type="button"
          className={cn("toolbar-btn", forgeOpen && "active")}
          title={forge ? "AI writing assistant (Forge)" : "AI writing assistant (coming soon)"}
          aria-label="Forge AI writing assistant"
          disabled={!forge}
          onClick={() => {
            setForgeAnchor(forgeBtnRef.current?.getBoundingClientRect() ?? null);
            setForgeOpen((v) => !v);
          }}
        >
          <i className="ph ph-hammer" style={{ fontSize: 16 }} />
          Forge
        </button>
      </div>
      </div>
      {forge && forgeOpen && (
        <ForgePopover
          editor={editor}
          slug={forge.slug}
          documentType={forge.documentType}
          documentId={forge.documentId}
          open={forgeOpen}
          onClose={() => setForgeOpen(false)}
          onReview={(text, identity) => {
            setForgeOpen(false);
            onReview?.(text, identity);
          }}
          reviewActive={reviewActive}
          appliedTaskId={appliedTaskId}
          anchorRect={forgeAnchor}
        />
      )}
    </>
  );
}

export function TextEditor({
  initialContent,
  onChange,
  onBlur,
  placeholder,
  editable = true,
  editorProps,
  className,
  extensions,
  forge,
  onReviewStateChange,
}: TextEditorProps) {
  const onBlurRef = useRef(onBlur);
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onBlurRef.current = onBlur;
    onChangeRef.current = onChange;
  });
  const wrapperRef = useRef<HTMLDivElement>(null);
  const lastPointerDownInside = useRef(false);

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      lastPointerDownInside.current =
        wrapperRef.current?.contains(target) === true || target?.closest("[data-forge-popover]") !== null;
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, []);

  const finalExtensions = useMemo(() => {
    const base = extensions ?? textEditorExtensions;
    if (!placeholder) return base;
    return base.map((e: any) => {
      if (typeof e === "object" && (e as any)?.name === "placeholder") {
        return Placeholder.configure({ placeholder });
      }
      return e;
    });
  }, [extensions, placeholder]);

  const editor = useEditor({
    immediatelyRender: false,
    extensions: finalExtensions,
    content: initialContent as unknown as JSONContent,
    editable,
    editorProps: {
      ...editorProps,
      handleDOMEvents: {
        ...(editorProps as Record<string, any> | undefined)?.handleDOMEvents,
        // Returning true stops ProseMirror's focusEvents plugin, so the
        // editor never reports a blur when focus moves within its own chrome
        // (toolbar buttons) and onBlur doesn't exit edit mode. A blur with
        // null relatedTarget (browser quirk when a selection is active) is
        // only kept when the pointer went down inside the chrome.
        blur: (_view, event) => {
          const related = (event as FocusEvent).relatedTarget as HTMLElement | null;
          if (related !== null) {
            return wrapperRef.current?.contains(related) === true || related?.closest("[data-forge-popover]") !== null;
          }
          return lastPointerDownInside.current;
        },
      },
    },
    onUpdate: ({ editor: nextEditor }) => {
      onChangeRef.current?.(nextEditor.getJSON() as unknown as TipTapDoc);
    },
    onBlur: ({ editor: ed }) => {
      onBlurRef.current?.(ed.getJSON() as unknown as TipTapDoc);
    },
  });

  const { review, appliedTaskId, handleReview, handleAcceptReview, handleRejectReview } = useForgeReview(editor, onReviewStateChange);

  if (!editor) return null;

  const headingLevel = (editor.getAttributes("heading").level as number | undefined) ?? 0;

  return (
    <div className={cn("editor-wrapper", className, review && "is-reviewing")} ref={wrapperRef}>
      <Toolbar editor={editor} headingLevel={headingLevel} forge={forge} reviewActive={review !== null} appliedTaskId={appliedTaskId} onReview={handleReview} />
      {review && (
        <ForgeReviewSurface action={review.action} runtime={review.runtime} diff={review.diff} onAccept={handleAcceptReview} onReject={handleRejectReview} />
      )}
      <EditorContent editor={editor} className="editor-content" />
    </div>
  );
}
