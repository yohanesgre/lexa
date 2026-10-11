// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useChatQueue } from "./useChatQueue";

// D8 data loss: one held message per thread. A second enqueue must be refused
// (returns false) rather than silently overwriting the first — a message the
// user typed is never discarded without notice.
describe("useChatQueue", () => {
  it("refuses a second queued message instead of overwriting the first", () => {
    const send = vi.fn(() => true);
    const { result } = renderHook(() => useChatQueue({ chatId: "c1", streamStatus: "idle", send }));

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
});
