import { useEffect } from "react";
import { Check, X } from "lucide-react";
import type { DiffResult } from "../../../shared/diff";
import { DiffView } from "./DiffView";

interface ReviewBannerProps {
  action: string;
  runtime: string | null;
  diff: DiffResult;
  onAccept: () => void;
  onReject: () => void;
}

// Review-in-editor banner, rendered inside the review panel (forge-review
// wireframe) — between the toolbar and the editor content, full width. The
// document is NOT modified while the banner is up — Accept inserts the
// result, Reject is a no-op (nothing to restore).
export function ReviewBanner({ action, runtime, diff, onAccept, onReject }: ReviewBannerProps) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onReject();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onReject]);

  return (
    <>
      <div className="forge-review-banner">
        <div className="forge-review-identity">
          <span className="forge-review-title">
            Hearth · {action}
            {runtime ? ` · ${runtime}` : ""}
          </span>
          <span className="forge-review-note">Nothing is changed until you accept</span>
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
            aria-label="Reject Hearth result"
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
            aria-label="Accept Hearth result"
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
