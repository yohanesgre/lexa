import { useEffect, useRef } from "react";
import type { DiffResult } from "../../../shared/diff";
import { ReviewBanner } from "./ReviewBanner";

interface AssistantReviewSurfaceProps {
  skillName: string;
  agentName: string | null;
  diff: DiffResult;
  onAccept: () => void;
  onReject: () => void;
}

// Assistant review surface: a focused panel in the editor body — between the
// toolbar and the document, full content width. Not toolbar chrome: the
// toolbar above stays untouched, the editor wrapper carries the focus ring
// while review is active, and the document below is dimmed until Accept.
export function AssistantReviewSurface({ skillName, agentName, diff, onAccept, onReject }: AssistantReviewSurfaceProps) {
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
    <div className="runtime-review-panel" ref={ref}>
      <ReviewBanner skillName={skillName} agentName={agentName} diff={diff} onAccept={onAccept} onReject={onReject} />
    </div>
  );
}
