import { useRef, useState } from "react";
import { Flame } from "lucide-react";
import { cn } from "./ui/cn";
import { AssistantPopover } from "./assistant/panel/AssistantPopover";
import type { AssistantReviewIdentity } from "../lib/useAssistantReview";
import type { MarkdownSource, MarkdownTarget } from "./editor/MarkdownEditorPane";

interface RuntimeContext {
  slug: string;
  documentType: "task" | "wiki";
  documentId: string;
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


// The document surfaces edit the document's Markdown source (a plain-text
// coding area) with the rendered document beside them behind the view toggle.
// The toolbar therefore drives the SOURCE through a MarkdownTarget: wrap the
// selection (bold, italic, strikethrough), prefix the lines (headings, lists,
// quote) or insert a block (code fence, table, rule, image). Controls with no
// Markdown syntax — highlight, underline — and the caret-bound undo/redo pair
// are gone: an inert button is worse than an absent one. Grouping is gaps, not
// dividers, and the AI Assistant still acts on the document itself.
export function MarkdownToolbar({
  sourceRef,
  runtime,
  reviewActive,
  appliedTaskId,
  rejectedTaskId,
  onReview,
  target,
  disabled = false,
  children,
}: {
  sourceRef: { current: MarkdownSource | null };
  runtime?: RuntimeContext | undefined;
  reviewActive: boolean;
  appliedTaskId: string | null;
  rejectedTaskId: string | null;
  onReview?: (text: string, identity: AssistantReviewIdentity) => void;
  target: { current: MarkdownTarget | null };
  disabled?: boolean;
  children?: React.ReactNode;
}) {
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
          sourceRef={sourceRef}
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
