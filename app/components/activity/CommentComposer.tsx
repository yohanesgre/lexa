import { useLayoutEffect, useRef, useState } from "react";
import { isMarkdownEmpty, markdownToText } from "../../../shared/markdown";
import { useAddComment } from "../../lib/queries";
import { MarkdownEditorPane, type MarkdownTarget } from "../editor/MarkdownEditorPane";
import { CommentToolbar } from "./CommentToolbar";

function canSubmit(body: string): boolean {
  return markdownToText(body).trim() !== "" && JSON.stringify(body).length <= 65_536;
}

export function CommentComposer({ slug, taskId }: { slug: string; taskId: string }) {
  const addComment = useAddComment(slug, taskId);
  const [body, setBody] = useState("");
  const bodyRef = useRef(body);
  const taskIdentity = `${slug}:${taskId}`;
  const bodyIdentityRef = useRef(taskIdentity);
  const taskIdentityRef = useRef(taskIdentity);
  taskIdentityRef.current = taskIdentity;
  const submitGenerationRef = useRef(0);
  const submittingRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  useLayoutEffect(() => {
    bodyIdentityRef.current = taskIdentity;
    bodyRef.current = "";
    setBody("");
    submitGenerationRef.current += 1;
    submittingRef.current = false;
    setSubmitting(false);
  }, [taskIdentity]);
  const draftBody = bodyIdentityRef.current === taskIdentity ? body : "";
  const updateBody = (next: string) => {
    bodyRef.current = next;
    setBody(next);
  };
  const targetRef = useRef<MarkdownTarget | null>(null);
  const empty = isMarkdownEmpty(draftBody) || !canSubmit(draftBody);
  const submit = async () => {
    const submittedBody = bodyRef.current;
    const submittedIdentity = taskIdentity;
    if (isMarkdownEmpty(submittedBody) || !canSubmit(submittedBody) || submittingRef.current) return;
    const generation = ++submitGenerationRef.current;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      await addComment.mutateAsync({ body: submittedBody, projectSlug: slug, taskId });
      if (taskIdentityRef.current === submittedIdentity && bodyRef.current === submittedBody) updateBody("");
    } catch {
      // Preserve the draft when the mutation fails.
    } finally {
      if (submitGenerationRef.current === generation && taskIdentityRef.current === submittedIdentity) {
        submittingRef.current = false;
        setSubmitting(false);
      }
    }
  };

  return (
    <div className="composer">
      <CommentToolbar target={targetRef} />
      <MarkdownEditorPane
        key={taskIdentity}
        value={draftBody}
        onChange={updateBody}
        onEnter={submit}
        targetRef={targetRef}
        ariaLabel="Add a comment"
        placeholder="Add a comment…"
        variant="comment"
        className="comment-source"
      />
      <div className="composer-footer">
        <span className="font-micro text-2xs text-lx-text-muted uppercase tracking-[0.04em]">Enter to comment · Shift+Enter newline</span>
        <button type="button" className="btn btn-primary btn-sm" disabled={empty || submitting} onClick={submit}>
          Comment
        </button>
      </div>
    </div>
  );
}
