import { useEffect, useRef } from "react";
import type { DiffResult } from "../../../shared/diff";
import { ReviewBanner } from "./ReviewBanner";

interface HearthReviewSurfaceProps {
  action: string;
  runtime: string | null;
  diff: DiffResult;
  onAccept: () => void;
  onReject: () => void;
}

// Hearth review surface: a focused panel in the editor body — between the
// toolbar and the document, full content width. Not toolbar chrome: the
// toolbar above stays untouched, the editor wrapper carries the focus ring
// while review is active, and the document below is dimmed until Accept.
export function HearthReviewSurface({ action, runtime, diff, onAccept, onReject }: HearthReviewSurfaceProps) {
  const ref = useRef<HTMLDivElement>(null);

  // The editor can sit deep in a scrollable slideover body — without this the
  // banner would land off-screen above the fold and Accept/Reject would be
  // unreachable. Align the panel's top edge into view (block "start": the
  // banner pins to the top of the scroll area; "nearest" can undershoot when
  // the slideover carries a transform).
  useEffect(() => {
    ref.current?.scrollIntoView({ block: "start" });
  }, []);

  return (
    <div className="hearth-review-panel" ref={ref}>
      <ReviewBanner action={action} runtime={runtime} diff={diff} onAccept={onAccept} onReject={onReject} />
    </div>
  );
}
