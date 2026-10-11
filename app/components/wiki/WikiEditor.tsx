import { useState } from "react";
import type { Editor } from "@tiptap/core";
import { EditorContent } from "@tiptap/react";
import type { TipTapDoc } from "../../../shared/types";
import { Toolbar } from "../TextEditor";
import { AssistantReviewSurface } from "../assistant/AssistantReviewSurface";
import { useAssistantReview } from "../../lib/useAssistantReview";
import { EditorViewToggle, type EditorView } from "../editor/EditorViewToggle";
import { renderDoc } from "../tiptap-render";
import { cn } from "../ui/cn";

interface WikiEditorProps {
  editor: Editor;
  slug: string;
  previewContent: TipTapDoc;
  runtime?: { slug: string; documentType: "task" | "wiki"; documentId: string };
  onReviewStateChange?: (active: boolean, accepted: boolean) => void;
}

// The page's editing surface: one pane, the rich editor with its toolbar as the
// box's top row and the content below it. The toggle lives in that toolbar and
// switches the pane to the rendered document (components/tiptap-render) — the
// same control the task description carries, so both surfaces behave alike. In
// preview the editor body stays mounted but hidden (one document, so the
// Assistant, the review flow and the save path keep working) and the toolbar's
// commands are disabled rather than editing a document nobody can see.
export function WikiEditor({ editor, slug, previewContent, runtime, onReviewStateChange }: WikiEditorProps) {
  const [view, setView] = useState<EditorView>("editor");
  const { review, appliedTaskId, rejectedTaskId, handleReview, handleAcceptReview, handleRejectReview } = useAssistantReview(editor, onReviewStateChange);
  return (
    <div className={cn("editor-wrapper flex flex-col flex-1 min-h-0", review && "is-reviewing")}>
      <Toolbar editor={editor} headingLevel={(editor.getAttributes("heading").level as number | undefined) ?? 0} runtime={runtime} reviewActive={review !== null} appliedTaskId={appliedTaskId} rejectedTaskId={rejectedTaskId} onReview={handleReview} disabled={view === "preview"}>
        <EditorViewToggle view={view} onChange={setView} />
      </Toolbar>
      {review && (
        <AssistantReviewSurface skillName={review.skillName} agentName={review.agentName} diff={review.diff} onAccept={handleAcceptReview} onReject={handleRejectReview} />
      )}
      <div className={cn(view === "preview" && "hidden")}>
        <EditorContent editor={editor} className="editor-content flex-1" />
      </div>
      {view === "preview" && <div className="editor-preview wiki-prose wiki-edit-preview">{renderDoc(previewContent, "wiki", slug)}</div>}
    </div>
  );
}
