import { useLayoutEffect, useRef, useState } from "react";
import type { MarkdownSource } from "../components/editor/MarkdownEditorPane";
import { diffText, type DiffResult } from "../../shared/diff";

const ASSISTANT_APPLIED_KEY = "lxk.assistant-applied-task";
const ASSISTANT_REJECTED_KEY = "lxk.assistant-rejected-task";

export interface AssistantReviewIdentity {
  skillName: string;
  agentName: string | null;
  provider: string | null;
  taskId: string;
}
export type AssistantReviewHandler = (text: string, identity: AssistantReviewIdentity) => void;
export interface AssistantReviewState {
  result: string;
  skillName: string;
  agentName: string | null;
  taskId: string | null;
  sourceIdentity: string;
  diff: DiffResult;
}

export function useAssistantReview(
  sourceRef: { current: MarkdownSource | null },
  sourceIdentity: string,
  onReviewStateChange?: (active: boolean, accepted: boolean) => void,
) {
  const onReviewStateChangeRef = useRef(onReviewStateChange);
  onReviewStateChangeRef.current = onReviewStateChange;
  const sourceIdentityRef = useRef(sourceIdentity);
  sourceIdentityRef.current = sourceIdentity;
  const [review, setReview] = useState<AssistantReviewState | null>(null);
  const [appliedTaskId, setAppliedTaskId] = useState<string | null>(() =>
    typeof window !== "undefined" ? sessionStorage.getItem(ASSISTANT_APPLIED_KEY) : null
  );
  const [rejectedTaskId, setRejectedTaskId] = useState<string | null>(() =>
    typeof window !== "undefined" ? sessionStorage.getItem(ASSISTANT_REJECTED_KEY) : null
  );

  useLayoutEffect(() => {
    setReview(null);
    onReviewStateChangeRef.current?.(false, false);
  }, [sourceIdentity]);

  const handleReview: AssistantReviewHandler = (text, identity) => {
    const source = sourceRef.current;
    if (sourceIdentityRef.current !== sourceIdentity || !text?.trim() || !source) return;
    setReview({
      result: text,
      skillName: identity.skillName,
      agentName: identity.agentName,
      taskId: identity.taskId,
      sourceIdentity,
      diff: diffText(source.getValue(), text),
    });
    onReviewStateChangeRef.current?.(true, false);
  };

  const handleAcceptReview = () => {
    if (!review || review.sourceIdentity !== sourceIdentity || sourceIdentityRef.current !== sourceIdentity) return;
    const source = sourceRef.current;
    if (!source) return;
    if (!source.replace(review.result)) return;
    onReviewStateChangeRef.current?.(false, true);
    setAppliedTaskId(review.taskId);
    if (review.taskId) sessionStorage.setItem(ASSISTANT_APPLIED_KEY, review.taskId);
    setReview(null);
  };

  const handleRejectReview = () => {
    if (!review || review.sourceIdentity !== sourceIdentity || sourceIdentityRef.current !== sourceIdentity) return;
    onReviewStateChangeRef.current?.(false, false);
    setRejectedTaskId(review.taskId);
    if (review.taskId) sessionStorage.setItem(ASSISTANT_REJECTED_KEY, review.taskId);
    setReview(null);
  };

  return { review, appliedTaskId, rejectedTaskId, handleReview, handleAcceptReview, handleRejectReview };
}
