import { Check, RefreshCw, Square } from "lucide-react";
import type { Editor } from "@tiptap/core";
import type { AssistantSettingsMasked } from "../../../../shared/assistant";
import type { useAssistantStream } from "../../../lib/use-assistant-stream";
import { AssistantToolChips } from "./AssistantToolChips";
import { AssistantProviderMissing } from "./AssistantProviderMissing";
import { AssistantStreamingPreview } from "./AssistantStreamingPreview";
import { AssistantDoneView } from "./AssistantDoneView";
import type { ReviewIdentity } from "./AssistantDoneView";
import { providerLine } from "./assistant-panel-utils";

type Stream = ReturnType<typeof useAssistantStream>;

// Assistant tier panel body — one phase per branch (assistant-popover.html
// States 1–7); the idle phase renders `children`.
export function AssistantPanelBody({
  stream,
  settings,
  providerMissing,
  projectId,
  documentTitle,
  skillName,
  provider,
  taskId,
  appliedTaskId,
  rejectedTaskId,
  reviewActive,
  onReview,
  onRetry,
  onStop,
  onDismiss,
  editor,
  onClose,
  children,
}: {
  stream: Stream;
  settings: AssistantSettingsMasked | null | undefined;
  providerMissing: boolean;
  projectId: string | undefined;
  documentTitle: string | undefined;
  skillName: string;
  provider: string | null;
  taskId: string | null;
  appliedTaskId?: string | null | undefined;
  rejectedTaskId?: string | null | undefined;
  reviewActive?: boolean | undefined;
  onReview?: ((text: string, identity: ReviewIdentity) => void) | undefined;
  onRetry: () => void;
  onStop: () => void;
  onDismiss: () => void;
  editor: Editor;
  onClose: () => void;
  children: React.ReactNode;
}) {
  if (providerMissing) {
    return <AssistantProviderMissing projectId={projectId} />;
  }

  const running = stream.status === "connecting" || stream.status === "streaming";
  const done = stream.status === "done";
  const failed = stream.status === "error";

  if (running) {
    return (
      <>
        <div style={{ padding: "10px 12px 0" }}>
          <span className="prop-label" style={{ display: "block", marginBottom: 6 }}>Tools</span>
          <AssistantToolChips tools={stream.tools} />
        </div>
        <AssistantStreamingPreview text={stream.text} />
        <div className="flex items-center justify-between" style={{ padding: "10px 12px", borderTop: "1px solid var(--lx-border-default)" }}>
          <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]">{providerLine(settings)}</span>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            style={{ borderColor: "rgba(255,68,68,0.45)", color: "var(--lx-text-danger)" }}
            onClick={onStop}
          >
            <Square size={12} strokeWidth={1.5} fill="currentColor" />
            Stop
          </button>
        </div>
      </>
    );
  }

  if (done) {
    return (
      <AssistantDoneView
        stream={stream}
        documentTitle={documentTitle}
        skillName={skillName}
        provider={provider}
        taskId={taskId}
        appliedTaskId={appliedTaskId}
        rejectedTaskId={rejectedTaskId}
        reviewActive={reviewActive}
        onReview={onReview}
        onDismiss={onDismiss}
        editor={editor}
        onClose={onClose}
      />
    );
  }

  if (failed) {
    return (
      <div style={{ padding: 12 }}>
        <div className="notice notice-danger" style={{ flexDirection: "column", alignItems: "flex-start", gap: 4 }}>
          <div className="flex items-center gap-2">
            <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} style={{ flexShrink: 0 }}>
              <circle cx="12" cy="12" r="10" />
              <path d="M12 8v4" />
              <path d="M12 16h.01" />
            </svg>
            <span className="font-mono text-xs font-medium">{stream.error?.code}</span>
          </div>
          <span className="text-xs" style={{ lineHeight: "16px" }}>{stream.error?.message}</span>
        </div>
        {/* Retry re-enqueues with the same prompt/agent/skill and returns
            the panel to streaming; Dismiss clears back to idle — the
            thread keeps prior turns. */}
        <div className="flex items-center justify-end gap-2 mt-3">
          <button type="button" className="btn btn-ghost" style={{ height: 26, padding: "0 10px", fontSize: 12 }} onClick={onDismiss}>Dismiss</button>
          <button type="button" className="btn btn-primary" style={{ height: 26, padding: "0 10px", fontSize: 12 }} onClick={onRetry}>
            <RefreshCw size={12} strokeWidth={1.5} />
            Retry
          </button>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
