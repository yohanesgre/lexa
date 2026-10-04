// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useChatAutoScroll } from "./assistant-chat-hooks";
import { stubMatchMedia } from "../../test-utils";
import type { ChatTurn } from "./assistant-chat-utils";
import type { AssistantWriteDiff } from "../../../shared/assistant";
import type { useAssistantStream } from "../../lib/use-assistant-stream";

// jsdom has no layout: assert the scroll CALLS/TARGETS honestly — the
// proposal-arrival effect must land the batch header at the scroller top
// instead of pinning to the bottom.

const DIFF: AssistantWriteDiff = { type: "task_create", title: "New task", fields: {} };

function userTurn(): ChatTurn {
  return { role: "user", text: "create a task", imageCount: 0, rawIndex: 0 };
}

function pendingBatchTurn(): ChatTurn {
  return {
    role: "assistant",
    text: "",
    imageCount: 0,
    rawIndex: 1,
    batch: {
      batchId: "b1",
      chips: [{ approvalId: "a1", batchId: "b1", seq: 0, name: "create_task", diff: DIFF, state: "pending" }],
    },
  };
}

function decidedBatchTurn(): ChatTurn {
  const turn = pendingBatchTurn();
  turn.batch = { ...turn.batch!, chips: turn.batch!.chips.map((c) => ({ ...c, state: "approved" })) };
  return turn;
}

const STREAM = { text: "", reasoningText: "", items: [] } as unknown as ReturnType<typeof useAssistantStream>;

function mountScroller() {
  const batch = document.createElement("div");
  batch.className = "approval-batch";
  batch.setAttribute("data-id", "newest");
  const scroll = document.createElement("div");
  scroll.className = "chat-scroll";
  scroll.appendChild(batch);
  document.body.appendChild(scroll);
  return scroll;
}

describe("useChatAutoScroll — proposal arrival", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    delete (Element.prototype as { scrollTo?: unknown }).scrollTo;
  });

  it("scrolls the last approval batch to block:start when the newest turn carries a pending batch", () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, "scrollIntoView", { value: scrollIntoView, configurable: true, writable: true });
    Object.defineProperty(Element.prototype, "scrollTo", { value: vi.fn(), configurable: true, writable: true });
    stubMatchMedia(false);
    const scroll = mountScroller();

    try {
      const { result, rerender } = renderHook(({ turns }: { turns: ChatTurn[] }) => useChatAutoScroll({ turns, stream: STREAM }), {
        initialProps: { turns: [userTurn()] },
      });
      act(() => {
        result.current.scrollRef.current = scroll;
      });
      rerender({ turns: [userTurn(), pendingBatchTurn()] });

      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "start", behavior: "smooth" });
      // The receiver must be the mounted newest `.approval-batch` element — the
      // ones inside `mountScroller()` — not any generic Element.
      expect(scrollIntoView.mock.instances[0]).toBe(scroll.querySelector(".approval-batch"));
    } finally {
      scroll.remove();
    }
  });

  it("honors prefers-reduced-motion on proposal arrival", () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, "scrollIntoView", { value: scrollIntoView, configurable: true, writable: true });
    Object.defineProperty(Element.prototype, "scrollTo", { value: vi.fn(), configurable: true, writable: true });
    stubMatchMedia(true);
    const scroll = mountScroller();

    try {
      const { result, rerender } = renderHook(({ turns }: { turns: ChatTurn[] }) => useChatAutoScroll({ turns, stream: STREAM }), {
        initialProps: { turns: [userTurn()] },
      });
      act(() => {
        result.current.scrollRef.current = scroll;
      });
      rerender({ turns: [userTurn(), pendingBatchTurn()] });

      expect(scrollIntoView).toHaveBeenCalledWith({ block: "start", behavior: "auto" });
    } finally {
      scroll.remove();
    }
  });

  it("follows the bottom when the newest turn has no pending batch", () => {
    const scrollIntoView = vi.fn();
    const scrollTo = vi.fn();
    Object.defineProperty(Element.prototype, "scrollIntoView", { value: scrollIntoView, configurable: true, writable: true });
    Object.defineProperty(Element.prototype, "scrollTo", { value: scrollTo, configurable: true, writable: true });
    stubMatchMedia(false);
    const scroll = mountScroller();

    try {
      const { result, rerender } = renderHook(({ turns }: { turns: ChatTurn[] }) => useChatAutoScroll({ turns, stream: STREAM }), {
        initialProps: { turns: [userTurn()] },
      });
      act(() => {
        result.current.scrollRef.current = scroll;
      });
      rerender({ turns: [userTurn(), decidedBatchTurn()] });

      expect(scrollIntoView).not.toHaveBeenCalled();
      expect(scrollTo).toHaveBeenCalledWith({ top: scroll.scrollHeight, behavior: "auto" });
    } finally {
      scroll.remove();
    }
  });

  it("does not scroll to the batch header after the user has scrolled up", () => {
    const scrollIntoView = vi.fn();
    const scrollTo = vi.fn();
    Object.defineProperty(Element.prototype, "scrollIntoView", { value: scrollIntoView, configurable: true, writable: true });
    Object.defineProperty(Element.prototype, "scrollTo", { value: scrollTo, configurable: true, writable: true });
    stubMatchMedia(false);
    const scroll = mountScroller();
    Object.defineProperty(scroll, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(scroll, "clientHeight", { value: 100, configurable: true });
    scroll.scrollTop = 0;

    try {
      const { result, rerender } = renderHook(({ turns }: { turns: ChatTurn[] }) => useChatAutoScroll({ turns, stream: STREAM }), {
        initialProps: { turns: [userTurn()] },
      });
      act(() => {
        result.current.scrollRef.current = scroll;
      });
      // 1000 - 0 - 100 = 900 ≥ 24 → the user is scrolled up, pin released.
      act(() => {
        result.current.handleTranscriptScroll();
      });
      rerender({ turns: [userTurn(), pendingBatchTurn()] });

      expect(scrollIntoView).not.toHaveBeenCalled();
      expect(scrollTo).not.toHaveBeenCalled();
    } finally {
      scroll.remove();
    }
  });

  it("scrolls to the bottom when the newest batch flips from pending to all-terminal", () => {
    const scrollIntoView = vi.fn();
    const scrollTo = vi.fn();
    Object.defineProperty(Element.prototype, "scrollIntoView", { value: scrollIntoView, configurable: true, writable: true });
    Object.defineProperty(Element.prototype, "scrollTo", { value: scrollTo, configurable: true, writable: true });
    stubMatchMedia(false);
    const scroll = mountScroller();

    try {
      const { result, rerender } = renderHook(({ turns }: { turns: ChatTurn[] }) => useChatAutoScroll({ turns, stream: STREAM }), {
        initialProps: { turns: [userTurn(), pendingBatchTurn()] },
      });
      act(() => {
        result.current.scrollRef.current = scroll;
      });
      scrollTo.mockClear();
      rerender({ turns: [userTurn(), decidedBatchTurn()] });

      // One motionless jump to the bottom so the resume continuation is followed.
      expect(scrollTo).toHaveBeenCalledTimes(1);
      expect(scrollTo).toHaveBeenCalledWith({ top: scroll.scrollHeight, behavior: "auto" });
    } finally {
      scroll.remove();
    }
  });
});
