// @vitest-environment jsdom
import { createRef, useState } from "react";
import { act, fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { undo, redo } from "@codemirror/commands";
import { MarkdownEditorPane, type MarkdownSource, type MarkdownTarget } from "./MarkdownEditorPane";
import { useAssistantReview, type AssistantReviewHandler } from "../../lib/useAssistantReview";

function SourceFlow({ sourceRef, onEnter, sourceIdentity = "document-a", captureReviewRef, initialSource = "# Original", captureViewRef, onSourceChange, projection }: {
  sourceRef: { current: MarkdownSource | null };
  onEnter?: () => void;
  sourceIdentity?: string;
  captureReviewRef?: { current: AssistantReviewHandler | null };
  initialSource?: string;
  captureViewRef?: { current: EditorView | null };
  onSourceChange?: (source: string) => void;
  projection?: string;
}) {
  const [source, setSource] = useState(initialSource);
  const { review, handleReview, handleAcceptReview, handleRejectReview } = useAssistantReview(sourceRef, sourceIdentity);
  if (captureReviewRef) captureReviewRef.current = handleReview;
  return <>
    <MarkdownEditorPane value={projection ?? source} onChange={(next) => { setSource(next); onSourceChange?.(next); }} sourceRef={sourceRef}
      editable={projection === undefined && review === null} ariaLabel="Document source" onEnter={onEnter}
      onViewUpdate={(update) => { if (captureViewRef) captureViewRef.current = update.view; }} />
    <button onClick={() => handleReview("## Accepted\n\n`@MS`", {
      skillName: "edit", agentName: null, provider: null, taskId: "review-a",
    })}>Review</button>
    {review && <button onClick={handleAcceptReview}>Accept</button>}
    {review && <button onClick={handleRejectReview}>Reject</button>}
  </>;
}

function RevisionFlow({ sourceRef, initialSource, revisionSource, onSourceChange }: {
  sourceRef: { current: MarkdownSource | null };
  initialSource: string;
  revisionSource: string;
  onSourceChange: (source: string) => void;
}) {
  const [source, setSource] = useState(initialSource);
  const [preview, setPreview] = useState(false);
  return <>
    <MarkdownEditorPane value={preview ? revisionSource : source} editable={!preview} sourceRef={sourceRef}
      onChange={(next) => { setSource(next); onSourceChange(next); }} ariaLabel="Document source" />
    <button onClick={() => setPreview(true)}>Open revision</button>
    <button onClick={() => setPreview(false)}>Close revision</button>
  </>;
}

describe("Markdown source editing", () => {
  it.each([0, 250])("isolates revision preview from native draft history when closed after %i ms", (previewDuration) => {
    vi.useFakeTimers();
    const original = "Original\r\nsecond\rlast\n";
    const draft = "Original!\r\nsecond\rlast\n";
    const sourceRef = createRef<MarkdownSource>();
    const changes: string[] = [];
    const ui = render(<RevisionFlow sourceRef={sourceRef} initialSource={original}
      revisionSource={"Historical\rcontent\n"} onSourceChange={(next) => changes.push(next)} />);
    try {
      const view = EditorView.findFromDOM(ui.getByRole("textbox", { name: "Document source" }))!;
      act(() => view.dispatch({
        changes: { from: view.state.doc.line(1).to, insert: "!" },
        selection: { anchor: 2, head: 7 },
        userEvent: "input.type",
      }));
      expect(sourceRef.current?.getValue()).toBe(draft);
      fireEvent.click(ui.getByRole("button", { name: "Open revision" }));
      act(() => vi.advanceTimersByTime(previewDuration));
      fireEvent.click(ui.getByRole("button", { name: "Close revision" }));
      act(() => vi.advanceTimersByTime(250));

      expect(sourceRef.current?.getValue()).toBe(draft);
      expect(view.state.selection.main.anchor).toBe(2);
      expect(view.state.selection.main.head).toBe(7);
      expect(changes).toEqual([draft]);
      expect(EditorView.findFromDOM(ui.getByRole("textbox", { name: "Document source" }))).toBe(view);
      act(() => { expect(undo(view)).toBe(true); });
      expect(sourceRef.current?.getValue()).toBe(original);

      fireEvent.click(ui.getByRole("button", { name: "Open revision" }));
      act(() => vi.advanceTimersByTime(250));
      expect(sourceRef.current?.getValue()).toBe("Historical\rcontent\n");
      act(() => sourceRef.current!.replace("Not an accepted historical edit"));
      expect(sourceRef.current?.getValue()).toBe("Historical\rcontent\n");
      ui.rerender(<RevisionFlow sourceRef={sourceRef} initialSource={original}
        revisionSource={"Another\r\nrevision\r"} onSourceChange={(next) => changes.push(next)} />);
      expect(sourceRef.current?.getValue()).toBe("Another\r\nrevision\r");
      fireEvent.click(ui.getByRole("button", { name: "Close revision" }));
      act(() => vi.advanceTimersByTime(250));
      expect(sourceRef.current?.getValue()).toBe(original);
      act(() => { expect(redo(view)).toBe(true); });
      expect(sourceRef.current?.getValue()).toBe(draft);
      act(() => { expect(undo(view)).toBe(true); });
      expect(sourceRef.current?.getValue()).toBe(original);
      act(() => { expect(undo(view)).toBe(false); });
      expect(changes).toEqual([draft, original, draft, original]);
    } finally {
      ui.unmount();
      vi.useRealTimers();
    }
  });

  it("blocks stale toolbar, native changes, and submit while read-only but keeps explicit acceptance undoable", () => {
    const sourceRef = createRef<MarkdownSource>();
    const targetRef = createRef<MarkdownTarget>();
    const changes: string[] = [];
    let submissions = 0;
    const props = {
      value: "Live\r\ndraft",
      sourceRef,
      targetRef,
      onChange: (next: string) => changes.push(next),
      onEnter: () => { submissions++; },
      ariaLabel: "Document source",
    };
    const ui = render(<MarkdownEditorPane {...props} />);
    const view = EditorView.findFromDOM(ui.getByRole("textbox", { name: "Document source" }))!;
    const staleTarget = targetRef.current!;
    ui.rerender(<MarkdownEditorPane {...props} editable={false} />);

    act(() => {
      staleTarget.wrap("**", "**");
      staleTarget.prefix("> ");
      staleTarget.insert("Forbidden");
      view.dispatch({ changes: { from: 0, insert: "Forbidden" }, userEvent: "input.type" });
      fireEvent.keyDown(view.contentDOM, { key: "Enter", code: "Enter" });
    });
    expect(sourceRef.current?.getValue()).toBe(props.value);
    expect(changes).toEqual([]);
    expect(submissions).toBe(0);
    const accepted = "Accepted\rsource\n";
    act(() => sourceRef.current!.replace(accepted));
    expect(sourceRef.current?.getValue()).toBe(accepted);
    expect(changes).toEqual([accepted]);
    ui.rerender(<MarkdownEditorPane {...props} value={accepted} />);
    act(() => { expect(undo(view)).toBe(true); });
    expect(sourceRef.current?.getValue()).toBe(props.value);
    act(() => { expect(redo(view)).toBe(true); });
    expect(sourceRef.current?.getValue()).toBe(accepted);
  });

  it("retains exact mixed line endings through native edits, replacement, selection, and undo", () => {
    const original = "A\\* 😀\r\nB\nC\rD\r\n";
    const replacement = "## 原文\r\n\\_literal\\_\n🙂\rLast";
    const sourceRef = createRef<MarkdownSource>();
    const captureViewRef = createRef<EditorView>();
    const changes: string[] = [];
    const ui = render(<SourceFlow sourceRef={sourceRef} initialSource={original}
      captureViewRef={captureViewRef} onSourceChange={(next) => changes.push(next)} />);
    const view = EditorView.findFromDOM(ui.getByRole("textbox", { name: "Document source" }))!;
    expect(sourceRef.current?.getValue()).toBe(original);
    expect(changes).toEqual([]);
    act(() => view.dispatch({ changes: { from: view.state.doc.line(2).to, insert: "!" }, userEvent: "input.type" }));
    expect(changes.at(-1)).toBe("A\\* 😀\r\nB!\nC\rD\r\n");
    act(() => view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } }));
    expect(sourceRef.current?.getSelection()).toBe(sourceRef.current?.getValue());
    act(() => sourceRef.current!.replace(replacement));
    expect(changes.at(-1)).toBe(replacement);
    expect(sourceRef.current?.getValue()).toBe(replacement);
    expect(view.state.selection.main.head).toBe(view.state.doc.length);
    act(() => { undo(view); });
    expect(sourceRef.current?.getValue()).toBe("A\\* 😀\r\nB!\nC\rD\r\n");
    act(() => { redo(view); });
    expect(sourceRef.current?.getValue()).toBe(replacement);
  });

  it("redoes on Ctrl+Shift+Z instead of undoing", () => {
    const sourceRef = createRef<MarkdownSource>();
    const ui = render(<SourceFlow sourceRef={sourceRef} initialSource="alpha" />);
    const editor = ui.getByRole("textbox", { name: "Document source" });
    const view = EditorView.findFromDOM(editor)!;
    act(() => { view.dispatch({ changes: { from: view.state.doc.length, insert: " beta" }, userEvent: "input.type" }); });
    expect(sourceRef.current?.getValue()).toBe("alpha beta");
    act(() => { undo(view); });
    expect(sourceRef.current?.getValue()).toBe("alpha");
    act(() => { fireEvent.keyDown(editor, { key: "z", code: "KeyZ", ctrlKey: true, shiftKey: true }); });
    expect(sourceRef.current?.getValue()).toBe("alpha beta");
  });

  it("keeps native composition defaults without submitting", () => {
    const sourceRef = createRef<MarkdownSource>();
    let submissions = 0;
    const ui = render(<SourceFlow sourceRef={sourceRef} onEnter={() => { submissions++; }} />);
    const editor = ui.getByRole("textbox", { name: "Document source" });
    fireEvent.compositionStart(editor);
    const composingEnter = new KeyboardEvent("keydown", {
      key: "Enter", code: "Enter", keyCode: 229, isComposing: true, bubbles: true, cancelable: true,
    });
    fireEvent(editor, composingEnter);
    fireEvent.compositionEnd(editor);
    expect(composingEnter.defaultPrevented).toBe(false);
    expect(submissions).toBe(0);
    expect(sourceRef.current?.getValue()).toBe("# Original");
  });

  it("keeps a refused historical replacement in review and accepts only the live source", () => {
    const sourceRef = createRef<MarkdownSource>();
    const ui = render(<SourceFlow sourceRef={sourceRef} />);
    fireEvent.click(ui.getByRole("button", { name: "Review" }));
    ui.rerender(<SourceFlow sourceRef={sourceRef} projection="# Historical" />);
    fireEvent.click(ui.getByRole("button", { name: "Accept" }));
    expect(sourceRef.current?.getValue()).toBe("# Historical");
    expect(ui.queryByRole("button", { name: "Accept" })).not.toBeNull();
    fireEvent.click(ui.getByRole("button", { name: "Reject" }));
    ui.rerender(<SourceFlow sourceRef={sourceRef} />);
    expect(sourceRef.current?.getValue()).toBe("# Original");
    fireEvent.click(ui.getByRole("button", { name: "Review" }));
    fireEvent.click(ui.getByRole("button", { name: "Accept" }));
    expect(sourceRef.current?.getValue()).toBe("## Accepted\n\n`@MS`");
  });
  it("ignores a completed review callback from the previous document identity", () => {
    const sourceRef = createRef<MarkdownSource>();
    const captureReviewRef: { current: AssistantReviewHandler | null } = { current: null };
    const ui = render(<SourceFlow sourceRef={sourceRef} sourceIdentity="task-a" captureReviewRef={captureReviewRef} />);
    const staleReview = captureReviewRef.current!;
    ui.rerender(<SourceFlow sourceRef={sourceRef} sourceIdentity="task-b" captureReviewRef={captureReviewRef} />);

    act(() => staleReview("## Late result", {
      skillName: "edit", agentName: null, provider: null, taskId: "review-late",
    }));

    expect(ui.queryByRole("button", { name: "Accept" })).toBeNull();
    expect(sourceRef.current?.getValue()).toBe("# Original");
  });
});
