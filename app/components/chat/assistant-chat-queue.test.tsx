// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { AssistantChatComposer, lastApprovalBatch } from "./AssistantChatComposer";
import { useChatQueue } from "./useChatQueue";
import { stubMatchMedia } from "../../test-utils";
import type { ChatAttachmentRef, ComposerAttachment } from "../../lib/assistant-image";
import type { AssistantStreamStatus } from "../../lib/use-assistant-stream";

// Client-only queue (assistant-chat-deck §3.3): one held message per thread.
// Clean `done` flushes it; aborted/error keeps it held for an explicit Send.

function renderQueue(status: AssistantStreamStatus, send = vi.fn()) {
  const utils = renderHook(
    ({ chatId, streamStatus }: { chatId: string; streamStatus: AssistantStreamStatus }) =>
      useChatQueue({ chatId, streamStatus, send }),
    { initialProps: { chatId: "A", streamStatus: status } }
  );
  return { ...utils, send };
}

function readyAttachment(overrides: Partial<ComposerAttachment> = {}): ComposerAttachment {
  return {
    id: "i1",
    kind: "image",
    file: new File([new Uint8Array(1024)], "sketch.png", { type: "image/png" }),
    name: "sketch.png",
    size: 1024,
    mimeType: "image/png",
    previewUrl: "blob:mock",
    status: "ready",
    progress: 100,
    storageKey: "sk1",
    ...overrides,
  };
}

describe("useChatQueue", () => {
  it("holds a message while streaming without sending it", () => {
    const { result, send } = renderQueue("streaming");
    act(() => result.current.enqueue("hold this"));
    expect(result.current.queued?.text).toBe("hold this");
    expect(send).not.toHaveBeenCalled();
  });

  it("flushes the queue on a clean done and marks it flushing", () => {
    const { result, rerender, send } = renderQueue("streaming");
    act(() => result.current.enqueue("ship it"));
    rerender({ chatId: "A", streamStatus: "done" });

    expect(send).toHaveBeenCalledWith("ship it", []);
    expect(result.current.queued?.flushing).toBe(true);
  });

  it("keeps the message held (stopped) after an aborted turn", () => {
    const { result, rerender, send } = renderQueue("streaming");
    act(() => result.current.enqueue("still here"));
    rerender({ chatId: "A", streamStatus: "aborted" });

    expect(send).not.toHaveBeenCalled();
    expect(result.current.queued?.heldReason).toBe("stopped");
  });

  it("keeps the message held (failed) after an errored turn", () => {
    const { result, rerender, send } = renderQueue("streaming");
    act(() => result.current.enqueue("still here"));
    rerender({ chatId: "A", streamStatus: "error" });

    expect(send).not.toHaveBeenCalled();
    expect(result.current.queued?.heldReason).toBe("failed");
  });

  it("re-holds a flushed message when that turn fails", () => {
    const { result, rerender, send } = renderQueue("streaming");
    act(() => result.current.enqueue("try me"));
    rerender({ chatId: "A", streamStatus: "done" });
    expect(send).toHaveBeenCalledTimes(1);

    rerender({ chatId: "A", streamStatus: "error" });
    expect(result.current.queued?.heldReason).toBe("failed");
    expect(result.current.queued?.flushing).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does not flush while the turn is suspended, then flushes on done", () => {
    const { result, rerender, send } = renderQueue("streaming");
    act(() => result.current.enqueue("after approvals"));
    rerender({ chatId: "A", streamStatus: "suspended" });

    expect(send).not.toHaveBeenCalled();
    expect(result.current.queued?.heldReason).toBeUndefined();

    rerender({ chatId: "A", streamStatus: "done" });
    expect(send).toHaveBeenCalledWith("after approvals", []);
  });

  it("keeps one message per thread", () => {
    const { result, rerender } = renderQueue("streaming");
    act(() => result.current.enqueue("for A"));
    expect(result.current.queued?.text).toBe("for A");

    rerender({ chatId: "B", streamStatus: "streaming" });
    expect(result.current.queued).toBeNull();

    rerender({ chatId: "A", streamStatus: "streaming" });
    expect(result.current.queued?.text).toBe("for A");
  });

  it("keeps the queued entry (not stuck sending) when the clean-done flush is refused", () => {
    const send = vi.fn(() => false);
    const onUnqueue = vi.fn();
    const { result, rerender } = renderQueue("streaming", send);
    act(() => result.current.enqueue("keep me"));
    rerender({ chatId: "A", streamStatus: "done" });

    // The refused flush is attempted once, never reported as sent, and the
    // entry stays held with flushing cleared (not a stuck "Sending…" chip).
    expect(send).toHaveBeenCalledWith("keep me", []);
    expect(send).toHaveBeenCalledTimes(1);
    expect(result.current.queued).toMatchObject({ text: "keep me", flushing: false });

    const { container } = renderComposer({ queued: result.current.queued, onUnqueue });
    expect(container.querySelector(".deck-queued-text")!.textContent).toContain("keep me");
    expect(screen.queryByText("Sending queued message…")).toBeNull();
    expect(onUnqueue).not.toHaveBeenCalled();
  });
});

function renderComposer(overrides: Partial<Parameters<typeof AssistantChatComposer>[0]> = {}) {
  const onSend = vi.fn(() => true);
  const onQueue = vi.fn();
  const onUnqueue = vi.fn();
  const utils = render(
    <AssistantChatComposer
      slug="nimbus"
      streaming={false}
      busy409={false}
      suspendedLock={false}
      suspendCount={0}
      attachDisabled={false}
      onSend={onSend}
      onAbort={() => {}}
      onQueue={onQueue}
      onUnqueue={onUnqueue}
      {...overrides}
    />
  );
  return { ...utils, onSend, onQueue, onUnqueue };
}

describe("AssistantChatComposer — queue controls", () => {
  it("queues on Enter while streaming (never sends)", () => {
    const { onSend, onQueue } = renderComposer({ streaming: true });
    const textarea = screen.getByLabelText("Message Assistant");
    fireEvent.change(textarea, { target: { value: "next up" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(onQueue).toHaveBeenCalledWith("next up");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("shows the queued chip text and cancels it with ✕", () => {
    const { container, onUnqueue } = renderComposer({ queued: { text: "later, please" } });
    expect(container.querySelector(".deck-queued-text")!.textContent).toBe("1 queued · “later, please”");

    fireEvent.click(screen.getByRole("button", { name: "Cancel queued message" }));
    expect(onUnqueue).toHaveBeenCalledTimes(1);
  });

  it("reads 'Sending queued message…' while flushing (no cancel control)", () => {
    const { container } = renderComposer({ queued: { text: "later", flushing: true } });
    expect(container.querySelector(".deck-queued-text")!.textContent).toBe("Sending queued message…");
    expect(screen.queryByRole("button", { name: "Cancel queued message" })).toBeNull();
  });

  it("holds a stopped message and sends it explicitly", () => {
    const { container, onSend, onUnqueue } = renderComposer({ queued: { text: "later", heldReason: "stopped" } });
    expect(container.querySelector(".deck-action")!.textContent).toContain("HELD — TURN STOPPED");

    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenCalledWith("later", []);
    expect(onUnqueue).toHaveBeenCalledTimes(1);
  });

  it("announces the queued row as a polite status region", () => {
    const { container } = renderComposer({ queued: { text: "later" } });
    const row = container.querySelector(".deck-queued")!;
    expect(row).toHaveAttribute("role", "status");
    expect(row).toHaveAttribute("aria-live", "polite");
  });

  it("returns the queued text into the draft and unqueues when the chip is clicked", () => {
    const { container, onUnqueue } = renderComposer({ queued: { text: "back to draft" } });
    fireEvent.click(container.querySelector(".deck-queued-text")!);

    expect(screen.getByLabelText("Message Assistant")).toHaveValue("back to draft");
    expect(onUnqueue).toHaveBeenCalledTimes(1);
  });

  it("flushes a refused held send without destroying the chip or its attachments", () => {
    const onSend = vi.fn((_message: string, _attachments: ChatAttachmentRef[]) => false);
    const onUnqueue = vi.fn();
    const utils = render(
      <AssistantChatComposer
        slug="nimbus"
        streaming={false}
        busy409={false}
        suspendedLock={false}
        suspendCount={0}
        attachDisabled={false}
        onSend={onSend}
        onAbort={() => {}}
        onUnqueue={onUnqueue}
        queued={{ text: "keep me", heldReason: "stopped" }}
        initialAttachments={[readyAttachment()]}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    const refs = onSend.mock.calls[0]![1];
    expect(onSend.mock.calls[0]![0]).toBe("keep me");
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ storageKey: "sk1", mimeType: "image/png", name: "sketch.png" });
    expect(onUnqueue).not.toHaveBeenCalled();
    expect(utils.container.querySelector(".deck-queued-text")!.textContent).toContain("keep me");
    expect(utils.container.querySelector(".deck-attach-item")).toBeTruthy();
  });

  it("keeps a held chip and its attachments safe while a stream runs (Send is a guarded no-op)", () => {
    const onSend = vi.fn(() => true);
    const onUnqueue = vi.fn();
    const props = {
      slug: "nimbus",
      busy409: false,
      suspendedLock: false,
      suspendCount: 0,
      attachDisabled: false,
      onSend,
      onAbort: () => {},
      onUnqueue,
    } as const;
    const utils = render(
      <AssistantChatComposer
        {...props}
        streaming={false}
        queued={{ text: "held msg", heldReason: "stopped" as const }}
        initialAttachments={[readyAttachment()]}
      />
    );

    utils.rerender(
      <AssistantChatComposer
        {...props}
        streaming
        queued={{ text: "held msg", heldReason: "stopped" as const }}
        initialAttachments={[readyAttachment()]}
      />
    );

    // Running stream keeps the interrupt reachable...
    expect(screen.getByRole("button", { name: /Stop/ })).toBeTruthy();
    // ...and clicking the held Send can never fire a send it would then drop.
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).not.toHaveBeenCalled();
    expect(onUnqueue).not.toHaveBeenCalled();
    expect(utils.container.querySelector(".deck-queued-text")!.textContent).toContain("held msg");
    expect(utils.container.querySelector(".deck-attach-item")).toBeTruthy();
  });

  it("blocks the held Send while an attachment failed extraction", () => {
    const onSend = vi.fn(() => true);
    render(
      <AssistantChatComposer
        slug="nimbus"
        streaming={false}
        busy409={false}
        suspendedLock={false}
        suspendCount={0}
        attachDisabled={false}
        onSend={onSend}
        onAbort={() => {}}
        queued={{ text: "held msg", heldReason: "stopped" }}
        initialAttachments={[readyAttachment({ status: "extraction-failed" })]}
      />
    );

    const send = screen.getByRole("button", { name: "Send" });
    expect(send).toBeDisabled();
    fireEvent.click(send);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("revokes preview URLs when an attachment is removed and when the sent chip clears", () => {
    const revoke = vi.fn();
    const originalRevoke = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
    Object.defineProperty(URL, "revokeObjectURL", { value: revoke, configurable: true, writable: true });
    try {
      const first = readyAttachment({ id: "i1", name: "a.png", previewUrl: "blob:first" });
      const second = readyAttachment({ id: "i2", name: "b.png", previewUrl: "blob:second", storageKey: "sk2" });
      const overrides = { initialAttachments: [first, second] };
      const { container, rerender } = renderComposer(overrides);

      fireEvent.click(screen.getByRole("button", { name: "Remove a.png" }));
      expect(revoke).toHaveBeenCalledWith("blob:first");
      expect(revoke).toHaveBeenCalledTimes(1);
      expect(container.querySelector(".deck-attach-item")).toBeTruthy();

      fireEvent.change(screen.getByLabelText("Message Assistant"), { target: { value: "go" } });
      fireEvent.click(screen.getByRole("button", { name: "Send" }));

      // Sent chips clear on the terminal stream status; the object URL is
      // revoked with the chip.
      rerender(
        <AssistantChatComposer
          slug="nimbus"
          streaming={false}
          streamStatus="done"
          busy409={false}
          suspendedLock={false}
          suspendCount={0}
          attachDisabled={false}
          onSend={() => true}
          onAbort={() => {}}
          {...overrides}
        />
      );
      expect(revoke).toHaveBeenCalledWith("blob:second");
    } finally {
      if (originalRevoke) Object.defineProperty(URL, "revokeObjectURL", originalRevoke);
      else delete (URL as unknown as Record<string, unknown>).revokeObjectURL;
    }
  });

  it("targets the LAST approval batch for Review ↑", () => {
    const root = document.createElement("div");
    root.innerHTML =
      '<div class="chat-scroll"><div class="approval-batch" data-id="old"></div><div class="approval-batch" data-id="new"></div></div>';
    expect(lastApprovalBatch(root.querySelector(".chat-scroll")!)?.getAttribute("data-id")).toBe("new");
  });
});

describe("AssistantChatComposer — Review ↑ reachability", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

  function mountBatchInScroller() {
    const batch = document.createElement("div");
    batch.className = "approval-batch";
    batch.setAttribute("data-id", "newest");
    const scroll = document.createElement("div");
    scroll.className = "chat-scroll";
    scroll.appendChild(batch);
    document.body.appendChild(scroll);
    return scroll;
  }

  function stubScrollIntoView() {
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, "scrollIntoView", { value: scrollIntoView, configurable: true, writable: true });
    return scrollIntoView;
  }

  it("scrolls the last approval batch to block:start (smooth by default)", () => {
    const scrollIntoView = stubScrollIntoView();
    stubMatchMedia(false);
    const scroll = mountBatchInScroller();
    try {
      renderComposer({ suspendedLock: true, suspendCount: 1 });
      fireEvent.click(screen.getByRole("button", { name: /Review/ }));
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "start", behavior: "smooth" });
    } finally {
      scroll.remove();
    }
  });

  it("clears the header instantly under prefers-reduced-motion", () => {
    const scrollIntoView = stubScrollIntoView();
    stubMatchMedia(true);
    const scroll = mountBatchInScroller();
    try {
      renderComposer({ suspendedLock: true, suspendCount: 1 });
      fireEvent.click(screen.getByRole("button", { name: /Review/ }));
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "start", behavior: "auto" });
    } finally {
      scroll.remove();
    }
  });
});
