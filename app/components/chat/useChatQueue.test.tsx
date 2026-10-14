// @vitest-environment jsdom
import type { AssistantStreamStatus } from "../../lib/use-assistant-stream";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useChatQueue } from "./useChatQueue";

// D8 data loss: one held message per thread. A second enqueue must be refused
// (returns false) rather than silently overwriting the first — a message the
// user typed is never discarded without notice.
describe("useChatQueue", () => {
  it("refuses a second queued message instead of overwriting the first", () => {
    const send = vi.fn(() => true);
    const { result } = renderHook(() => useChatQueue({ chatId: "c1", streamStatus: "idle", hasIngress: false, send }));

    let first = false;
    act(() => {
      first = result.current.enqueue("first");
    });
    expect(first).toBe(true);
    expect(result.current.queued?.text).toBe("first");

    let second = true;
    act(() => {
      second = result.current.enqueue("second");
    });
    expect(second).toBe(false);
    expect(result.current.queued?.text).toBe("first");
  });

  it("holds automatic dispatch until retained attachments are ready", () => {
    const send = vi.fn(() => true);
    const { result, rerender } = renderHook(
      ({ canDispatch, streamStatus }: { canDispatch: boolean; streamStatus: AssistantStreamStatus }) =>
        useChatQueue({ chatId: "c1", streamStatus, hasIngress: false, send, canDispatch }),
      { initialProps: { canDispatch: false, streamStatus: "idle" as AssistantStreamStatus } }
    );

    act(() => {
      result.current.enqueue("follow-up");
    });
    rerender({ canDispatch: false, streamStatus: "done" });
    expect(send).not.toHaveBeenCalled();
    expect(result.current.queued?.text).toBe("follow-up");

    rerender({ canDispatch: true, streamStatus: "done" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("retires an automatically dispatched message only after ingress, preserving pre-ingress failures", () => {
    const send = vi.fn(() => true);
    const { result, rerender } = renderHook(
      ({ streamStatus, hasIngress }: { streamStatus: AssistantStreamStatus; hasIngress: boolean }) =>
        useChatQueue({ chatId: "c1", streamStatus, hasIngress, send }),
      { initialProps: { streamStatus: "streaming" as AssistantStreamStatus, hasIngress: false } }
    );
    act(() => { result.current.enqueue("first follow-up"); });
    rerender({ streamStatus: "done", hasIngress: false });
    rerender({ streamStatus: "connecting", hasIngress: false });
    expect(result.current.queued?.text).toBe("first follow-up");
    rerender({ streamStatus: "error", hasIngress: false });
    expect(result.current.queued?.heldReason).toBe("failed");
    act(() => { result.current.unqueue(); });
    rerender({ streamStatus: "streaming", hasIngress: false });
    act(() => { result.current.enqueue("second follow-up"); });
    rerender({ streamStatus: "done", hasIngress: false });
    rerender({ streamStatus: "connecting", hasIngress: false });
    expect(result.current.queued?.text).toBe("second follow-up");
    rerender({ streamStatus: "streaming", hasIngress: true });
    expect(result.current.queued).toBeNull();
  });
});
