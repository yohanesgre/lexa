import { useRef, useState } from "react";
import type { Editor, JSONContent } from "@tiptap/core";
import { EditorContent } from "@tiptap/react";
import type { TipTapDoc } from "../../../shared/types";
import { Toolbar } from "../TextEditor";
import { AssistantReviewSurface } from "../assistant/AssistantReviewSurface";
import { useAssistantReview } from "../../lib/useAssistantReview";
import { EditorViewToggle, type EditorView } from "../editor/EditorViewToggle";
import { MarkdownEditorPane, type MarkdownTarget } from "../editor/MarkdownEditorPane";
import { renderDoc } from "../tiptap-render";
import { cn } from "../ui/cn";

interface WikiEditorProps {
  editor: Editor;
  slug: string;
  previewContent: TipTapDoc;
  editable: boolean;
  onDocChange: (doc: TipTapDoc) => void;
  runtime?: { slug: string; documentType: "task" | "wiki"; documentId: string };
  onReviewStateChange?: (active: boolean, accepted: boolean) => void;
}

// The page's editing surface: one pane. The Editor view is the page document's
// Markdown source (the toolbar acts on that source), the Preview view is the
// same document through the read renderer. The document stays TipTap JSON: a
// pane edit converts back through shared/markdown.ts, and the editor instance
// stays the model the save payload (manual and autosave), the Assistant popover
// and the review-in-editor flow read.
export function WikiEditor({ editor, slug, previewContent, editable, onDocChange, runtime, onReviewStateChange }: WikiEditorProps) {
  const [view, setView] = useState<EditorView>("editor");
  const targetRef = useRef<MarkdownTarget | null>(null);
  const { review, appliedTaskId, rejectedTaskId, handleReview, handleAcceptReview, handleRejectReview } = useAssistantReview(editor, onReviewStateChange);
  return (
    <div className={cn("editor-wrapper flex flex-col flex-1 min-h-0", review && "is-reviewing")}>
      <Toolbar editor={editor} runtime={runtime} reviewActive={review !== null} appliedTaskId={appliedTaskId} rejectedTaskId={rejectedTaskId} onReview={handleReview} target={targetRef} disabled={view === "preview"}>
        <EditorViewToggle view={view} onChange={setView} />
      </Toolbar>
      {review && (
        <AssistantReviewSurface skillName={review.skillName} agentName={review.agentName} diff={review.diff} onAccept={handleAcceptReview} onReject={handleRejectReview} />
      )}
      {view === "editor" ? (
        <MarkdownEditorPane
          doc={previewContent}
          slug={slug}
          editable={editable && review === null}
          onDocChange={onDocChange}
          targetRef={targetRef}
          ariaLabel="Page content, Markdown"
        />
      ) : (
        <div className="editor-preview wiki-prose wiki-edit-preview">{renderDoc(previewContent, "wiki", slug)}</div>
      )}
      <div hidden>
        <EditorContent editor={editor} className="editor-content flex-1" />
      </div>
    </div>
  );
}
