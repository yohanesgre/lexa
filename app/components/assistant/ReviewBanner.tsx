import { useEffect } from "react";
import { Check, X } from "lucide-react";
import type { DiffResult } from "../../../shared/diff";
import { DiffView } from "./DiffView";

interface ReviewBannerProps {
  skillName: string;
  agentName: string | null;
  diff: DiffResult;
  onAccept: () => void;
  onReject: () => void;
}

// Escape must not reject the pending result while the user is typing in the
// editor, the review note, or any other field — only when focus is on the page
// chrome (audit LX-99).
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

// Review-in-editor banner, rendered inside the review panel (hearth-review
// wireframe) — between the toolbar and the editor content, full width. The
// document is NOT modified while the banner is up — Accept inserts the
// result, Reject is a no-op (nothing to restore).
export function ReviewBanner({ skillName, agentName, diff, onAccept, onReject }: ReviewBannerProps) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !isEditableTarget(e.target)) onReject();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onReject]);

  return (
    <>
      <div className="runtime-review-banner">
        <div className="runtime-review-identity">
          <span className="runtime-review-title">
            AI · {agentName ?? "Assistant"}
            {skillName ? ` · ${skillName}` : ""}
          </span>
          <span className="runtime-review-note">Nothing is changed until you accept</span>
        </div>
        <div className="flex items-center gap-2" style={{ flexShrink: 0 }}>
          <span
            className="font-mono"
            style={{ fontSize: 11, letterSpacing: "0.02em", whiteSpace: "nowrap" }}
            aria-label={`${diff.additions} additions, ${diff.deletions} deletions`}
          >
            <span style={{ color: "var(--lx-text-success)" }}>+{diff.additions}</span>{" "}
            <span style={{ color: "var(--lx-text-danger)" }}>−{diff.deletions}</span>
          </span>
          <button
            type="button"
            className="btn btn-ghost"
            style={{ height: 28, padding: "0 10px", fontSize: 12 }}
            title="Discard the result — the document is untouched"
            aria-label="Reject AI result"
            onMouseDown={(e) => e.preventDefault()}
            onClick={onReject}
          >
            <X size={12} strokeWidth={2} />
            Reject
          </button>
          <button
            type="button"
            className="btn btn-primary"
            style={{ height: 28, padding: "0 10px", fontSize: 12 }}
            title="Replace the document with the result"
            aria-label="Accept AI result"
            onMouseDown={(e) => e.preventDefault()}
            onClick={onAccept}
          >
            <Check size={12} strokeWidth={2.5} />
            Accept
          </button>
        </div>
      </div>
      <DiffView diff={diff} />
    </>
  );
}
