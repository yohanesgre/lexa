import { useState } from "react";
import type { Editor, JSONContent } from "@tiptap/core";
import type { TipTapDoc } from "../../../shared/types";
import { markdownToDoc } from "../../../shared/markdown";
import { diffText, docToDiffText, type DiffResult } from "../../../shared/diff";

const FORGE_APPLIED_KEY = "lxk.forge-applied-task";
const FORGE_REJECTED_KEY = "lxk.forge-rejected-task";

export interface ForgeReviewIdentity {
  action: string;
  runtimeName: string | null;
  provider: string | null;
  taskId: string;
}

export interface ForgeReviewState {
  result: string;
  action: string;
  runtime: string | null;
  taskId: string | null;
  diff: DiffResult;
}

// Review-in-editor state for the editing surfaces (task description editor,
// wiki editor). The review surface renders in the editor body, not the
// toolbar. The document is NOT touched here: the diff is computed between the
// whole document's plain-text form and the result's; Accept REPLACES the whole
// document with the result (markdown → TipTap), Reject is a no-op. The result
// is formatted Markdown from the runtime, so formatting survives the apply.
export function useForgeReview(editor: Editor | null, onReviewStateChange?: (active: boolean, accepted: boolean) => void) {
  const [review, setReview] = useState<ForgeReviewState | null>(null);
  // Accepted forge result — terminal for this tab session, so a reload
  // doesn't re-offer it for insert (duplicate risk).
  const [appliedTaskId, setAppliedTaskId] = useState<string | null>(() =>
    typeof window !== "undefined" ? sessionStorage.getItem(FORGE_APPLIED_KEY) : null
  );
  // Rejected forge result — same terminal semantics: the popover re-attaches
  // to the newest completed task when it reopens, and an editor-side reject
  // must not let that task re-offer its result.
  const [rejectedTaskId, setRejectedTaskId] = useState<string | null>(() =>
    typeof window !== "undefined" ? sessionStorage.getItem(FORGE_REJECTED_KEY) : null
  );

  const handleReview = (text: string, identity: ForgeReviewIdentity) => {
    if (!text?.trim() || !editor) return;
    const docJson = editor.state.doc.toJSON() as unknown as TipTapDoc;
    const diff = diffText(docToDiffText(docJson), docToDiffText(markdownToDoc(text)));
    editor.setEditable(false);
    setReview({
      result: text,
      action: identity.action,
      runtime: identity.runtimeName ? `${identity.runtimeName} · ${identity.provider}` : null,
      taskId: identity.taskId,
      diff,
    });
    onReviewStateChange?.(true, false);
  };

  const handleAcceptReview = () => {
    if (!review || !editor) return;
    if (review.diff.hunks.length > 0) {
      const doc = markdownToDoc(review.result) as unknown as JSONContent;
      // Full-document replace. setContent accepts the whole doc JSON — the
      // previous insertContentAt with a {type:"doc"} NODE was a schema
      // violation (doc inside doc): ProseMirror rejected the step, so an
      // accepted review never landed (or the invalid-content fallback
      // replaced the document with an empty doc, wiping the description).
      editor.commands.setContent(doc);
    }
    editor.setEditable(true);
    // Review ended AFTER the replacement so surfaces reading the doc on
    // review-end (task save) see the accepted result.
    onReviewStateChange?.(false, true);
    setAppliedTaskId(review.taskId);
    if (review.taskId) sessionStorage.setItem(FORGE_APPLIED_KEY, review.taskId);
    setReview(null);
  };

  const handleRejectReview = () => {
    if (!review || !editor) return;
    editor.setEditable(true);
    setReview(null);
    onReviewStateChange?.(false, false);
    // Remember the rejection so the popover doesn't re-offer this result
    // when it reopens (same terminal semantics as appliedTaskId).
    setRejectedTaskId(review.taskId);
    if (review.taskId) sessionStorage.setItem(FORGE_REJECTED_KEY, review.taskId);
  };

  return { review, appliedTaskId, rejectedTaskId, handleReview, handleAcceptReview, handleRejectReview };
}
