import { Check } from "lucide-react";
import type { Editor } from "@tiptap/core";
import type { useHeraldStream } from "../../../lib/use-herald-stream";
import { insertMarkdown } from "./herald-panel-utils";

type Stream = ReturnType<typeof useHeraldStream>;
export type ReviewIdentity = { action: string; runtimeName: string | null; provider: string | null; taskId: string };

export function HeraldDoneView({
  stream,
  documentTitle,
  skillName,
  provider,
  taskId,
  appliedTaskId,
  rejectedTaskId,
  reviewActive,
  onReview,
  onDismiss,
  editor,
  onClose,
}: {
  stream: Stream;
  documentTitle: string | undefined;
  skillName: string;
  provider: string | null;
  taskId: string | null;
  appliedTaskId?: string | null | undefined;
  rejectedTaskId?: string | null | undefined;
  reviewActive?: boolean | undefined;
  onReview?: ((text: string, identity: ReviewIdentity) => void) | undefined;
  onDismiss: () => void;
  editor: Editor;
  onClose: () => void;
}) {
  if (!taskId) return null;

  const alreadyHandled = appliedTaskId === taskId || rejectedTaskId === taskId;
  const resolvedSkillName = skillName || "Herald";

  const handleInsert = () => {
    if (!stream.text) return;
    insertMarkdown(editor, stream.text);
    onClose();
  };

  const handleReviewInEditor = () => {
    if (!stream.text) return;
    if (onReview) {
      onReview(stream.text, {
        action: resolvedSkillName,
        runtimeName: null,
        provider,
        taskId,
      });
      onClose();
    } else {
      handleInsert();
    }
  };

  return (
    <div style={{ padding: 12 }}>
      <div
        style={{ background: "var(--lx-surface-input)", border: "1px solid var(--lx-border-default)", borderRadius: 6, padding: "10px 12px" }}
      >
        <div className="flex items-center gap-2 mb-1 min-w-0">
          <Check size={14} strokeWidth={2.5} className="text-lx-text-success shrink-0" />
          <span className="text-xs font-medium text-lx-text-primary truncate flex-1 min-w-0" style={{ fontFamily: "var(--lx-font-body)" }}>{documentTitle || "Document"}</span>
        </div>
        <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]" style={{ letterSpacing: "0.04em" }}>
          {resolvedSkillName} — ready to review
        </span>
      </div>
      <div className="flex items-center justify-end gap-2 mt-3">
        {reviewActive || alreadyHandled ? (
          <span className="font-micro text-2xs text-lx-text-warning uppercase tracking-[0.04em]">In review in editor</span>
        ) : (
          <>
            <button type="button" className="btn btn-ghost" style={{ height: 26, padding: "0 10px", fontSize: 12 }} onClick={onDismiss}>Reject</button>
            <button type="button" className="btn btn-primary" style={{ height: 26, padding: "0 10px", fontSize: 12 }} onClick={handleReviewInEditor}>
              <Check size={12} strokeWidth={2.5} />
              Review in editor
            </button>
          </>
        )}
      </div>
    </div>
  );
}
