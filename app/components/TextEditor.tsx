import { useRef, useMemo, useState, useEffect } from "react";
import { Flame } from "lucide-react";
import { useEditor, EditorContent } from "@tiptap/react";
import type { TipTapDoc } from "../../shared/types";
import type { JSONContent } from "@tiptap/core";
import { cn } from "./ui/cn";
import { AssistantPopover } from "./assistant/panel/AssistantPopover";
import { AssistantReviewSurface } from "./assistant/AssistantReviewSurface";
import { useAssistantReview, type AssistantReviewIdentity } from "../lib/useAssistantReview";
import { textEditorExtensions, extensionsWithMentions } from "../lib/tiptap";
import { useAttachmentEmbeds } from "../lib/useAttachmentEmbeds";
import Placeholder from "@tiptap/extension-placeholder";
import type { MarkdownTarget } from "./editor/MarkdownEditorPane";

interface TextEditorProps {
  initialContent: TipTapDoc;
  onChange?: (doc: TipTapDoc) => void;
  onBlur?: (doc: TipTapDoc) => void;
  placeholder?: string | undefined;
  editable?: boolean | undefined;
  editorProps?: Record<string, unknown>;
  className?: string | undefined;
  extensions?: typeof textEditorExtensions;
  // Runtime (AI writing assistant) wiring
  runtime?: {
    slug: string;
    documentType: "task" | "wiki";
    documentId: string;
  };
  // Paste/drop-to-embed uploads (attachments API). Absent in create mode —
  // there is no taskId to attach to yet.
  attachments?: {
    slug: string;
    documentType: "task" | "wiki";
    documentId: string;
  };
  // Fired when a Runtime review enters/exits the editor (used by surfaces to
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
  // A markdown command has no caret context to read, so the pressed state is
  // only rendered when a command actually reports one.
  isActive?: boolean | undefined;
  title: string;
  children: React.ReactNode;
  disabled?: boolean | undefined;
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

function setImage(editor: NonNullable<ReturnType<typeof useEditor>>) {
  const url = window.prompt("Image URL");
  if (url === null) return;
  const trimmed = url.trim();
  // Same scheme allowlist as stored images (shared/safe-href.ts): only
  // http(s) can be inserted — anything else is rejected at the authoring
  // boundary so a bad src never lands in the doc.
  if (!/^https?:\/\//i.test(trimmed)) {
    window.alert("Not a valid image URL — must start with http:// or https://");
    return;
  }
  const alt = window.prompt("Alt text (optional)")?.trim() ?? "";
  editor.chain().focus().setImage({ src: trimmed, ...(alt ? { alt } : {}) }).run();
}

// The document surfaces edit the document's Markdown source (a plain-text
// coding area) with the rendered document beside them behind the view toggle.
// The toolbar therefore drives the SOURCE through a MarkdownTarget: wrap the
// selection (bold, italic, strikethrough), prefix the lines (headings, lists,
// quote) or insert a block (code fence, table, rule, image). Controls with no
// Markdown syntax — highlight, underline — and the caret-bound undo/redo pair
// are gone: an inert button is worse than an absent one. Grouping is gaps, not
// dividers, and the AI Assistant still acts on the document itself.
export function Toolbar({
  editor,
  headingLevel,
  runtime,
  reviewActive,
  appliedTaskId,
  rejectedTaskId,
  onReview,
  target,
  disabled = false,
  children,
}: {
  // The editor instance stays the document model: the Assistant and the
  // review-in-editor flow read it, and every pane commit lands in it, so the
  // Markdown source and the stored document are always the same thing.
  editor: NonNullable<ReturnType<typeof useEditor>>;
  headingLevel?: number | undefined;
  runtime?: TextEditorProps["runtime"];
  // Runtime review-in-editor: the review surface is rendered by the editing
  // surfaces in the editor body, not by the toolbar. The toolbar only opens the
  // Runtime popover; "Review in editor" hands the result up via onReview.
  reviewActive: boolean;
  appliedTaskId: string | null;
  rejectedTaskId: string | null;
  onReview?: (text: string, identity: AssistantReviewIdentity) => void;
  // The Markdown source this toolbar edits.
  target: { current: MarkdownTarget | null };
  disabled?: boolean;
  children?: React.ReactNode;
}) {
  void headingLevel;
  const [runtimeOpen, setRuntimeOpen] = useState(false);
  const [runtimeAnchor, setRuntimeAnchor] = useState<DOMRect | null>(null);
  const runtimeBtnRef = useRef<HTMLButtonElement>(null);

  const markdown = (run: (target: MarkdownTarget) => void) => () => {
    const current = target.current;
    if (current) run(current);
  };

  const setLink = markdown((t) => {
    const url = window.prompt("Link URL", "https://");
    if (url === null || url.trim() === "") return;
    const href = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    t.wrap("[", `](${href})`);
  });

  const setImage = markdown((t) => {
    const url = window.prompt("Image URL");
    if (url === null) return;
    const trimmed = url.trim();
    // Same scheme allowlist as stored images (shared/safe-href.ts): only http(s)
    // reaches the document, so a bad src never lands in the Markdown.
    if (!/^https?:\/\//i.test(trimmed)) {
      window.alert("Not a valid image URL — must start with http:// or https://");
      return;
    }
    const alt = window.prompt("Alt text (optional)")?.trim() ?? "";
    t.insert(`![${alt}](${trimmed})`);
  });

  return (
    <>
      <div className="editor-toolbar wiki-toolbar-host">
        <div className="wiki-toolbar-row">
        <fieldset className="toolbar-group" disabled={disabled}>
        <span className="toolbar-cluster">
        <ToolbarButton command={markdown((t) => t.prefix("## "))} title="Heading 2">
          <i className="ph ph-text-h-two" />
        </ToolbarButton>
        <ToolbarButton command={markdown((t) => t.prefix("### "))} title="Heading 3">
          <i className="ph ph-text-h-three" />
        </ToolbarButton>
        <ToolbarButton command={markdown((t) => t.prefix("#### "))} title="Heading 4">
          <i className="ph ph-text-h-four" />
        </ToolbarButton>
        <ToolbarButton command={markdown((t) => t.prefix("##### "))} title="Heading 5">
          <i className="ph ph-text-h-five" />
        </ToolbarButton>
        </span>
        <span className="toolbar-cluster">
        <ToolbarButton command={markdown((t) => t.wrap("**", "**"))} title="Bold">
          <i className="ph ph-text-b" />
        </ToolbarButton>
        <ToolbarButton command={markdown((t) => t.wrap("*", "*"))} title="Italic">
          <i className="ph ph-text-italic" />
        </ToolbarButton>
        </span>
        <span className="toolbar-cluster">
        <ToolbarButton command={markdown((t) => t.prefix("- "))} title="Bullet list">
          <i className="ph ph-list-bullets" />
        </ToolbarButton>
        <ToolbarButton command={markdown((t) => t.prefix("1. "))} title="Ordered list">
          <i className="ph ph-list-numbers" />
        </ToolbarButton>
        <ToolbarButton command={markdown((t) => t.prefix("- [ ] "))} title="Task list">
          <i className="ph ph-list-checks" />
        </ToolbarButton>
        </span>
        <span className="toolbar-cluster">
        <ToolbarButton command={setImage} title="Image">
          <i className="ph ph-image" />
        </ToolbarButton>
        </span>
        <span className="toolbar-cluster">
        <ToolbarButton command={markdown((t) => t.wrap("~~", "~~"))} title="Strikethrough">
          <i className="ph ph-text-strikethrough" />
        </ToolbarButton>
        </span>
        <span className="toolbar-cluster">
        <ToolbarButton command={markdown((t) => t.insert("```\n\n```"))} title="Code block">
          <i className="ph ph-code-block" />
        </ToolbarButton>
        <ToolbarButton command={markdown((t) => t.prefix("> "))} title="Blockquote">
          <i className="ph ph-quotes" />
        </ToolbarButton>
        <ToolbarButton command={markdown((t) => t.insert("---\n"))} title="Horizontal rule">
          <i className="ph ph-minus" />
        </ToolbarButton>
        <ToolbarButton command={markdown((t) => t.insert("| Column | Column |\n| --- | --- |\n| Cell | Cell |"))} title="Insert table">
          <i className="ph ph-table" />
        </ToolbarButton>
        </span>
        <span className="toolbar-cluster">
        <ToolbarButton command={setLink} title="Link">
          <i className="ph ph-link" />
        </ToolbarButton>
        </span>
        <button
          ref={runtimeBtnRef}
          type="button"
          data-assistant-trigger
          className={cn("toolbar-btn", runtimeOpen && "active")}
          title={runtime ? "AI project assistant" : "AI writing assistant (coming soon)"}
          aria-label={runtime ? "AI project assistant" : "AI writing assistant (coming soon)"}
          disabled={!runtime}
          onClick={() => {
            setRuntimeAnchor(runtimeBtnRef.current?.getBoundingClientRect() ?? null);
            setRuntimeOpen((v) => !v);
          }}
        >
          <Flame size={16} strokeWidth={1.5} />
          Assistant
        </button>
        </fieldset>
        {children}
      </div>
      </div>
      {runtime && runtimeOpen && (
        <AssistantPopover
          editor={editor}
          slug={runtime.slug}
          documentType={runtime.documentType}
          documentId={runtime.documentId}
          open={runtimeOpen}
          onClose={() => setRuntimeOpen(false)}
          onReview={(text, identity) => {
            setRuntimeOpen(false);
            onReview?.(text, identity);
          }}
          reviewActive={reviewActive}
          appliedTaskId={appliedTaskId}
          rejectedTaskId={rejectedTaskId}
          anchorRect={runtimeAnchor}
          triggerRef={runtimeBtnRef}
        />
      )}
    </>
  );
}

const emptyTarget = { current: null } as { current: MarkdownTarget | null };

export function TextEditor({
  initialContent,
  onChange,
  onBlur,
  placeholder,
  editable = true,
  editorProps,
  className,
  extensions,
  runtime,
  attachments,
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
        wrapperRef.current?.contains(target) === true || target?.closest("[data-assistant-popover]") !== null;
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, []);

  const finalExtensions = useMemo(() => {
    const base = extensions ?? textEditorExtensions;
    let withPlaceholder = base;
    if (placeholder) {
      withPlaceholder = base.map((e: any) => {
        if (typeof e === "object" && (e as any)?.name === "placeholder") {
          return Placeholder.configure({ placeholder });
        }
        return e;
      });
    }
    // Mentions need the project slug — available when runtime or attachments
    // wiring exists. Absent both, the editor carries no mention plugin.
    const mentionSlug = attachments?.slug ?? runtime?.slug;
    return extensionsWithMentions(withPlaceholder, mentionSlug);
  }, [extensions, placeholder, attachments?.slug, runtime?.slug]);

  // Hooks run unconditionally — empty options when attachments wiring is
  // absent (create mode); handlers only spread while active.
  const embeds = useAttachmentEmbeds(attachments ?? { slug: "", documentType: "task", documentId: "" });
  const embedsActive = !!(attachments && attachments.slug && attachments.documentId);

  const editor = useEditor({
    immediatelyRender: false,
    extensions: finalExtensions,
    content: initialContent as unknown as JSONContent,
    editable,
    editorProps: {
      ...(editorProps as Record<string, unknown>),
      ...(embedsActive ? { handlePaste: embeds.handlePaste, handleDrop: embeds.handleDrop } : {}),
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
            return wrapperRef.current?.contains(related) === true || related?.closest("[data-assistant-popover]") !== null;
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

  const { review, appliedTaskId, rejectedTaskId, handleReview, handleAcceptReview, handleRejectReview } = useAssistantReview(editor, onReviewStateChange);

  if (!editor) return null;

  const headingLevel = (editor.getAttributes("heading").level as number | undefined) ?? 0;

  return (
    <div className={cn("editor-wrapper", className, review && "is-reviewing")} ref={wrapperRef}>
      <Toolbar editor={editor} headingLevel={headingLevel} target={emptyTarget} runtime={runtime} reviewActive={review !== null} appliedTaskId={appliedTaskId} rejectedTaskId={rejectedTaskId} onReview={handleReview} />
      {review && (
        <AssistantReviewSurface skillName={review.skillName} agentName={review.agentName} diff={review.diff} onAccept={handleAcceptReview} onReject={handleRejectReview} />
      )}
      <EditorContent editor={editor} className="editor-content" />
    </div>
  );
}