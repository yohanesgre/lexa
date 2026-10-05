import { RefreshCw, Square } from "lucide-react";
import type { Editor } from "@tiptap/core";
import type { useAssistantStream } from "../../../lib/use-assistant-stream";
import { AssistantToolChips } from "./AssistantToolChips";
import { AssistantProviderMissing } from "./AssistantProviderMissing";
import { AssistantStreamingPreview } from "./AssistantStreamingPreview";
import { AssistantDoneView } from "./AssistantDoneView";
import type { AssistantReviewIdentity } from "../../../lib/useAssistantReview";

type Stream = ReturnType<typeof useAssistantStream>;

// Assistant tier panel body — one phase per branch (herald-popover.html
// States 1–7); the idle phase renders `children`.
export function AssistantPanelBody({
  stream,
  providerMissing,
  settingsError,
  onRetrySettings,
  projectId,
  documentTitle,
  skillName,
  providerLabel,
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
  reconnecting,
  children,
}: {
  stream: Stream;
  providerMissing: boolean;
  settingsError: boolean;
  onRetrySettings: () => void;
  projectId: string | undefined;
  documentTitle: string | undefined;
  skillName: string;
  providerLabel: string | null;
  taskId: string | null;
  appliedTaskId?: string | null | undefined;
  rejectedTaskId?: string | null | undefined;
  reviewActive?: boolean | undefined;
  onReview?: ((text: string, identity: AssistantReviewIdentity) => void) | undefined;
  onRetry: () => void;
  onStop: () => void;
  onDismiss: () => void;
  editor: Editor;
  onClose: () => void;
  // Transport reconnect (herald-popover.html): the socket is down but the run
  // continues server-side. Read off the agent stream in AssistantPanel and
  // passed in so this view stays transport-blind.
  reconnecting: boolean;
  children: React.ReactNode;
}) {
  if (providerMissing) {
    return <AssistantProviderMissing projectId={projectId} />;
  }

  const running = stream.status === "connecting" || stream.status === "streaming" || reconnecting;
  const done = stream.status === "done";
  const failed = stream.status === "error";
  // Reconnect (herald-popover.html): the socket is down but the run continues
  // server-side — keep the last frame and replace the footer controls with the
  // warning banner. Also wins over a premature terminal status while the WS
  // re-establishes.

  // A settings fetch failure is not a missing provider — say so and offer a
  // retry instead of a silently disabled form.
  if (settingsError && !running && !done && !failed) {
    return (
      <div style={{ padding: 12 }}>
        <div className="notice notice-danger" role="alert" style={{ flexDirection: "column", alignItems: "flex-start", gap: 4 }}>
          <span className="text-xs font-medium">Could not load Assistant settings</span>
          <span className="text-xs" style={{ lineHeight: "16px" }}>Retry to reload the provider settings.</span>
        </div>
        <div className="flex items-center justify-end gap-2 mt-3">
          <button type="button" className="btn btn-primary" style={{ height: 26, padding: "0 10px", fontSize: 12 }} onClick={onRetrySettings}>
            <RefreshCw size={12} strokeWidth={1.5} />
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (running) {
    return (
      <>
        {stream.tools.length > 0 && (
          <div style={{ padding: "10px 12px 0" }}>
            <span className="prop-label" style={{ display: "block", marginBottom: 6 }}>Tools</span>
            <AssistantToolChips tools={stream.tools} />
          </div>
        )}
        <AssistantStreamingPreview text={stream.text} />
        {reconnecting ? (
          <div className="banner-warning" role="status" style={{ margin: "0 12px 10px" }}>
            <span className="spinner" style={{ width: 12, height: 12, borderWidth: 2 }} aria-hidden="true" />
            <span>Connection lost — reconnecting. The run continues server-side.</span>
          </div>
        ) : (
          <div className="flex items-center justify-end" style={{ padding: "10px 12px", borderTop: "1px solid var(--lx-border-default)" }}>
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
        )}
      </>
    );
  }

  if (done) {
    return (
      <AssistantDoneView
        stream={stream}
        documentTitle={documentTitle}
        skillName={skillName}
        providerLabel={providerLabel}
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
        <div className="notice notice-danger" role="alert" style={{ flexDirection: "column", alignItems: "flex-start", gap: 4 }}>
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
        {/* Retry re-enqueues with the same prompt/agent and returns
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
