// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import type { useAssistantStream } from "../../lib/use-assistant-stream";
import type { AssistantWriteDiff } from "../../../shared/assistant";
import { AssistantResumeProgress } from "./AssistantResumeProgress";
import { RESUME_DEADLINE_MS, useStreamFrameFreeze } from "./assistant-chat-session";
import type { ChatTurn } from "./assistant-chat-utils";
import type { ApprovalChip } from "./AssistantApprovals";

type Stream = ReturnType<typeof useAssistantStream>;
type ResumeResult = { ok: boolean; executed?: boolean | undefined; reason?: string | undefined };

function makeStream(overrides: Partial<Stream> = {}): Stream {
  const base: Partial<Stream> = {
    status: "idle",
    frames: [],
    text: "",
    tools: [],
    items: [],
    reasoningText: "",
    reasoningActive: false,
    reasoningMs: null,
    pending: [],
    suspendedBatchId: null,
    error: null,
    usage: null,
    hasIngress: false,
    send: () => {},
    abort: () => {},
    reset: () => {},
    subscribe: () => () => {},
    getSnapshot: () => ({}) as never,
  };
  return { ...base, ...overrides } as unknown as Stream;
}

const DIFF: AssistantWriteDiff = { type: "task_create", title: "New task", fields: {} };

function chip(batchId: string, state: ApprovalChip["state"]): ApprovalChip {
  return { approvalId: `${batchId}-a1`, batchId, seq: 0, name: "create_task", diff: DIFF, state };
}

function batchTurn(batchId: string, state: ApprovalChip["state"]): ChatTurn {
  return { role: "assistant", text: "proposed", imageCount: 0, rawIndex: -1, batch: { batchId, chips: [chip(batchId, state)] } };
}

function continuationTurn(): ChatTurn {
  return { role: "assistant", text: "continued", imageCount: 0, rawIndex: 1 };
}

function makeResumeStream() {
  const calls: Array<{ url: string; body: unknown; onResult?: ((result: ResumeResult) => void) | undefined }> = [];
  const send = vi.fn((url: string, body: unknown, onResult?: (result: ResumeResult) => void) => {
    calls.push({ url, body, onResult });
  });
  return { stream: makeStream({ send }), calls };
}

function renderResume(stream: Stream, turns: ChatTurn[], chatId = "C1") {
  const setTurns = vi.fn();
  const ingressInsertedRef = { current: new Set<string>() };
  const utils = renderHook(
    ({ stream, turns, streaming }: { stream: Stream; turns: ChatTurn[]; streaming: boolean }) =>
      useStreamFrameFreeze({ stream, setTurns, turns, chatId, streaming, ingressInsertedRef }),
    { initialProps: { stream, turns, streaming: false } }
  );
  return { ...utils, setTurns, ingressInsertedRef };
}

describe("AssistantResumeProgress — row copy variants", () => {
  it("renders the approve path running line with a live caret", () => {
    const { container } = render(<AssistantResumeProgress progress={{ kind: "running", mode: "approve" }} onRetry={() => {}} />);
    expect(container.querySelector(".resume-progress")).not.toBeNull();
    expect(screen.getByText("[execute_approved]")).toBeInTheDocument();
    expect(screen.getByText("Executing approved writes…")).toBeInTheDocument();
    expect(container.querySelector(".assistant-activity-caret")).not.toBeNull();
  });

  it("renders the reject path running line", () => {
    render(<AssistantResumeProgress progress={{ kind: "running", mode: "reject" }} onRetry={() => {}} />);
    expect(screen.getByText("[resume]")).toBeInTheDocument();
    expect(screen.getByText("Assistant is working…")).toBeInTheDocument();
  });

  it("renders the failed fallback with Retry and stops the caret", () => {
    const onRetry = vi.fn();
    const { container } = render(<AssistantResumeProgress progress={{ kind: "failed" }} onRetry={onRetry} />);
    expect(screen.getByText("Resume failed.")).toBeInTheDocument();
    expect(container.querySelector(".assistant-activity-caret")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("renders the timeout fallback with Retry", () => {
    const onRetry = vi.fn();
    render(<AssistantResumeProgress progress={{ kind: "timeout" }} onRetry={onRetry} />);
    expect(screen.getByText("Resume is taking longer than expected.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe("useStreamFrameFreeze — post-decision resume progress", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => vi.useRealTimers());

  it("arms the approve row when the batch's last chip is approved", () => {
    const { stream, calls } = makeResumeStream();
    const { result } = renderResume(stream, [batchTurn("b1", "approved")]);
    expect(calls).toHaveLength(1);
    expect(result.current.resumeProgress).toEqual({ kind: "running", mode: "approve" });
  });

  it("never arms while any chip is still pending", () => {
    const { stream, calls } = makeResumeStream();
    const { result } = renderResume(stream, [batchTurn("b1", "pending")]);
    expect(calls).toHaveLength(0);
    expect(result.current.resumeProgress).toBeNull();
  });

  it("arms the reject row once an observed-pending batch goes all-rejected", () => {
    const { stream } = makeResumeStream();
    const { result, rerender } = renderResume(stream, [batchTurn("b1", "pending")]);
    expect(result.current.resumeProgress).toBeNull();
    rerender({ stream, turns: [batchTurn("b1", "rejected")], streaming: false });
    expect(result.current.resumeProgress).toEqual({ kind: "running", mode: "reject" });
  });

  it("clears the row when the continuation turn mounts", () => {
    const { stream } = makeResumeStream();
    const { result, rerender } = renderResume(stream, [batchTurn("b1", "approved")]);
    expect(result.current.resumeProgress).toEqual({ kind: "running", mode: "approve" });
    rerender({ stream, turns: [batchTurn("b1", "approved"), continuationTurn()], streaming: false });
    expect(result.current.resumeProgress).toBeNull();
  });

  it("clears the row on the first resume stream frame", () => {
    const { stream } = makeResumeStream();
    const { result, rerender } = renderResume(stream, [batchTurn("b1", "approved")]);
    expect(result.current.resumeProgress?.kind).toBe("running");
    rerender({ stream, turns: [batchTurn("b1", "approved")], streaming: true });
    expect(result.current.resumeProgress).toBeNull();
  });

  it("settles to the failed fallback and Retry re-fires the resume POST", () => {
    const { stream, calls } = makeResumeStream();
    const { result } = renderResume(stream, [batchTurn("b1", "approved")]);
    expect(calls).toHaveLength(1);
    act(() => calls[0]!.onResult?.({ ok: false }));
    expect(result.current.resumeProgress).toEqual({ kind: "failed" });
    act(() => result.current.retryResume());
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toBe("/api/assistant/chat/C1/resume");
    expect(calls[1]!.body).toEqual({ batchId: "b1" });
    expect(result.current.resumeProgress).toEqual({ kind: "running", mode: "approve" });
  });

  it("settles to the deadline warning after the resume deadline elapses", () => {
    vi.useFakeTimers();
    const { stream } = makeResumeStream();
    const { result } = renderResume(stream, [batchTurn("b1", "approved")]);
    expect(result.current.resumeProgress?.kind).toBe("running");
    act(() => vi.advanceTimersByTime(RESUME_DEADLINE_MS));
    expect(result.current.resumeProgress).toEqual({ kind: "timeout" });
  });
});

describe("resume progress CSS port", () => {
  it("ports .resume-progress / .resume-progress-fallback into phosphor.css", () => {
    const css = readFileSync(new URL("app/styles/phosphor.css", `file://${process.cwd()}/`), "utf8");
    expect(css).toContain(".resume-progress {");
    expect(css).toContain(".resume-progress .assistant-activity");
    expect(css).toContain(".resume-progress-fallback {");
    expect(css).toContain(".resume-progress-fallback .btn");
  });
});
