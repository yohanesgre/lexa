import type { Editor } from "@tiptap/core";
import { EditorContent } from "@tiptap/react";
import { Toolbar } from "../TextEditor";
import { ForgeReviewSurface } from "../forge/ForgeReviewSurface";
import { useForgeReview } from "../forge/useForgeReview";
import { cn } from "../ui/cn";

interface WikiEditorProps {
  editor: Editor;
  forge?: { slug: string; documentType: "task" | "wiki"; documentId: string };
  onReviewStateChange?: (active: boolean, accepted: boolean) => void;
}

export function WikiEditor({ editor, forge, onReviewStateChange }: WikiEditorProps) {
  const { review, appliedTaskId, rejectedTaskId, handleReview, handleAcceptReview, handleRejectReview } = useForgeReview(editor, onReviewStateChange);
  return (
    <div className={cn("editor-wrapper flex flex-col flex-1 min-h-0", review && "is-reviewing")}>
      <Toolbar editor={editor} headingLevel={(editor.getAttributes("heading").level as number | undefined) ?? 0} forge={forge} reviewActive={review !== null} appliedTaskId={appliedTaskId} rejectedTaskId={rejectedTaskId} onReview={handleReview} />
      {review && (
        <ForgeReviewSurface action={review.action} runtime={review.runtime} diff={review.diff} onAccept={handleAcceptReview} onReject={handleRejectReview} />
      )}
      <EditorContent editor={editor} className="editor-content flex-1 p-4 px-5" />
    </div>
  );
}
