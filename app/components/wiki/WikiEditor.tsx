import { useRef, useState } from "react";
import { MarkdownToolbar } from "../TextEditor";
import { AssistantReviewSurface } from "../assistant/AssistantReviewSurface";
import { useAssistantReview } from "../../lib/useAssistantReview";
import { EditorViewToggle, type EditorView } from "../editor/EditorViewToggle";
import { MarkdownEditorPane, type MarkdownSource, type MarkdownTarget } from "../editor/MarkdownEditorPane";
import { MarkdownContent } from "../MarkdownContent";
import { cn } from "../ui/cn";
import { useAttachmentEmbeds } from "../../lib/useAttachmentEmbeds";

interface WikiEditorProps {
  source: string;
  sourceIdentity: string;
  editable: boolean;
  onSourceChange: (source: string) => void;
  runtime: { slug: string; documentType: "wiki"; documentId: string };
  onReviewStateChange?: (active: boolean, accepted: boolean) => void;
}

export function WikiEditor({ source, sourceIdentity, editable, onSourceChange, runtime, onReviewStateChange }: WikiEditorProps) {
  const [view, setView] = useState<EditorView>("editor");
  const targetRef = useRef<MarkdownTarget | null>(null);
  const sourceRef = useRef<MarkdownSource | null>(null);
  const editableRef = useRef(editable);
  editableRef.current = editable;
  const embeds = useAttachmentEmbeds({ slug: runtime.slug, documentType: "wiki", documentId: runtime.documentId });
  const { review, appliedTaskId, rejectedTaskId, handleReview, handleAcceptReview, handleRejectReview } =
    useAssistantReview(sourceRef, sourceIdentity, onReviewStateChange);
  return (
    <div className={cn("editor-wrapper flex flex-col flex-1 min-h-0", review && "is-reviewing")}>
      <MarkdownToolbar
        sourceRef={sourceRef}
        runtime={runtime}
        reviewActive={review !== null}
        appliedTaskId={appliedTaskId}
        rejectedTaskId={rejectedTaskId}
        onReview={(text, identity) => { if (editableRef.current) handleReview(text, identity); }}
        target={targetRef}
        disabled={!editable || view === "preview"}
      >
        <EditorViewToggle view={view} onChange={setView} />
      </MarkdownToolbar>
      {review && (
        <AssistantReviewSurface skillName={review.skillName} agentName={review.agentName} diff={review.diff} onAccept={handleAcceptReview} onReject={handleRejectReview} />
      )}
      <MarkdownEditorPane
        value={source}
        onChange={onSourceChange}
        editable={editable && review === null}
        targetRef={targetRef}
        sourceRef={sourceRef}
        ariaLabel="Page content, Markdown"
        hidden={view !== "editor"}
        mentionSlug={runtime.slug}
        onPaste={embeds.handlePaste}
        onDrop={embeds.handleDrop}
        onViewUpdate={embeds.handleViewUpdate}
      />
      {view === "preview" && (
        <div className="editor-preview wiki-prose wiki-edit-preview">
          <MarkdownContent md={source} surface="document" />
        </div>
      )}
    </div>
  );
}
