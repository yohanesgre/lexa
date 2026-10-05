import type { ResumeProgress } from "./assistant-chat-session";

// Post-decision resume progress (wireframes/src/herald-write-approvals.html
// State 3c): a transient row between the proposal bubble and the continuation
// bubble's slot. Chrome only — it reuses the shared activity-strip running-line
// language (mono `[name] detail…` + blinking caret) and never becomes a third
// bubble. Cleared by the parent the moment the continuation mounts.
function ClockIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </svg>
  );
}

function AlertIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <path d="m15 9-6 6" />
      <path d="m9 9 6 6" />
    </svg>
  );
}

export function AssistantResumeProgress({ progress, onRetry }: { progress: ResumeProgress; onRetry: () => void }) {
  if (progress.kind === "running") {
    const label = progress.mode === "approve" ? "[execute_approved]" : "[resume]";
    const detail = progress.mode === "approve" ? "Executing approved writes…" : "Assistant is working…";
    return (
      <div className="resume-progress">
        <div className="assistant-activity">
          <div className="assistant-activity-tool active">
            <span className="assistant-activity-tool-name">{label}</span>
            <span className="assistant-activity-tool-detail">{detail}</span>
            <span className="assistant-activity-caret" aria-hidden="true">▍</span>
          </div>
        </div>
      </div>
    );
  }
  if (progress.kind === "failed") {
    return (
      <div className="resume-progress">
        <div className="resume-progress-fallback" style={{ color: "var(--lx-text-danger)" }}>
          <AlertIcon />
          <span>Resume failed.</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onRetry}>
            Retry
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="resume-progress">
      <div className="resume-progress-fallback">
        <ClockIcon />
        <span>Resume is taking longer than expected.</span>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onRetry}>
          Retry
        </button>
      </div>
    </div>
  );
}
