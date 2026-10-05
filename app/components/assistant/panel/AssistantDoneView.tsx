import { Check } from "lucide-react";
import type { Editor } from "@tiptap/core";
import type { useAssistantStream } from "../../../lib/use-assistant-stream";
import { ASSISTANT_AGENT_NAME } from "../../../lib/assistant-agent";
import type { AssistantReviewIdentity } from "../../../lib/useAssistantReview";
import { insertMarkdown } from "./assistant-panel-utils";

type Stream = ReturnType<typeof useAssistantStream>;

export function AssistantDoneView({
  stream,
  documentTitle,
  skillName,
  providerLabel,
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
  providerLabel: string | null;
  taskId: string | null;
  appliedTaskId?: string | null | undefined;
  rejectedTaskId?: string | null | undefined;
  reviewActive?: boolean | undefined;
  onReview?: ((text: string, identity: AssistantReviewIdentity) => void) | undefined;
  onDismiss: () => void;
  editor: Editor;
  onClose: () => void;
}) {
  if (!taskId) return null;

  const applied = appliedTaskId === taskId;
  const rejected = rejectedTaskId === taskId;
  const resolvedSkillName = skillName || "Assistant";

  const handleInsert = () => {
    if (!stream.text) return;
    insertMarkdown(editor, stream.text);
    onClose();
  };

  const handleReviewInEditor = () => {
    if (!stream.text) return;
    if (onReview) {
      onReview(stream.text, {
        skillName: resolvedSkillName,
        agentName: ASSISTANT_AGENT_NAME,
        provider: providerLabel,
        taskId,
      });
      onClose();
    } else {
      handleInsert();
    }
  };

  const terminalLabel = applied ? "Applied to document" : rejected ? "Result rejected" : "In review in editor";

  return (
    <div style={{ padding: 12 }}>
      <div
        style={{ background: "var(--lx-surface-input)", border: "1px solid var(--lx-border-default)", borderRadius: 6, padding: "10px 12px" }}
      >
        <div className="flex items-center gap-2 mb-1 min-w-0">
          <Check size={14} strokeWidth={2.5} className="text-lx-text-success shrink-0" />
          <span className="text-xs font-medium text-lx-text-primary truncate flex-1 min-w-0" style={{ fontFamily: "var(--lx-font-body)" }}>{documentTitle || "Document"}</span>
        </div>
        <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]">
          Ready to review
        </span>
      </div>
      <div className="flex items-center justify-end gap-2 mt-3">
        {reviewActive || applied || rejected ? (
          <span className="font-micro text-2xs text-lx-text-warning uppercase tracking-[0.04em]">{terminalLabel}</span>
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
