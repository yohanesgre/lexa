// @vitest-environment jsdom
import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import type { useAssistantStream } from "../../lib/use-assistant-stream";
import { useMentionTokens } from "../../lib/useMentionTokens";
import { AssistantChatComposer } from "./AssistantChatComposer";
import { useSettledTurns, useTurnResend } from "./assistant-chat-session";

type Stream = ReturnType<typeof useAssistantStream>;

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

const BATCH_MSG = {
  role: "assistant",
  content: "proposed",
  pendingBatch: {
    batchId: "b1",
    approvals: [{ approvalId: "a1", toolCallId: "call_1", seq: 0, name: "delete_task", diff: { type: "task_delete", taskRef: "LX-1", taskTitle: "x" } }],
  },
};

describe("useSettledTurns — per-thread isolation", () => {
  it("resets the transcript when the active chat changes", () => {
    const stream = makeStream();
    const { result, rerender } = renderHook(
      ({ chatId, messages }: { chatId: string; messages: unknown[] }) =>
        useSettledTurns({ chatId, transcriptData: { messages }, transcriptError: undefined, streaming: false, stream }),
      { initialProps: { chatId: "A", messages: [BATCH_MSG] as unknown[] } }
    );
    expect(result.current.turns?.[0]?.batch?.batchId).toBe("b1");

    rerender({ chatId: "B", messages: [{ role: "user", content: "hi" }] });
    expect(result.current.turns).toEqual([{ role: "user", text: "hi", imageCount: 0, rawIndex: 0 }]);
  });
});

describe("useTurnResend — no sentinel fromIndex", () => {
  it("does not resend a retry while the trigger turn is still optimistic", () => {
    const startStream = vi.fn();
    const turns = [
      { role: "user" as const, text: "hello", imageCount: 0, rawIndex: -1 },
      { role: "assistant" as const, text: "", imageCount: 0, rawIndex: -1, error: { code: "PROVIDER_UNREACHABLE", message: "x" } },
    ];
    const { result } = renderHook(() => useTurnResend({ turns, setTurns: vi.fn(), rawMessages: [], streaming: false, startStream }));
    act(() => result.current.handleRetryTurn(turns[1]!));
    expect(startStream).not.toHaveBeenCalled();
  });

  it("resends from the raw user index once the transcript has it", () => {
    const startStream = vi.fn();
    const raw = [{ role: "user", content: "hello" }, { role: "assistant", content: "x" }];
    const turns = [
      { role: "user" as const, text: "hello", imageCount: 0, rawIndex: 0 },
      { role: "assistant" as const, text: "x", imageCount: 0, rawIndex: 1, error: { code: "PROVIDER_UNREACHABLE", message: "x" } },
    ];
    const { result } = renderHook(() => useTurnResend({ turns, setTurns: vi.fn(), rawMessages: raw, streaming: false, startStream }));
    act(() => result.current.handleRetryTurn(turns[1]!));
    expect(startStream).toHaveBeenCalledWith("hello", 0);
  });
});

function renderComposer(overrides: Partial<Parameters<typeof AssistantChatComposer>[0]> = {}) {
  const onSend = vi.fn();
  render(
    <AssistantChatComposer
      slug="nimbus"
      streaming={false}
      busy409={false}
      suspendedLock={false}
      suspendTally=""
      attachDisabled={false}
      onSend={onSend}
      onAbort={() => {}}
      {...overrides}
    />
  );
  return { onSend };
}

describe("AssistantChatComposer", () => {
  it("labels the textarea for assistive tech", () => {
    renderComposer();
    expect(screen.getByLabelText("Message Assistant")).toBeTruthy();
  });

  it("does not send on the Enter that commits an IME composition", () => {
    const { onSend } = renderComposer();
    const textarea = screen.getByLabelText("Message Assistant");
    fireEvent.change(textarea, { target: { value: "hello" } });
    fireEvent.keyDown(textarea, { key: "Enter", isComposing: true });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("hello", 0);
  });

  it("shows the wireframe busy-409 placeholder", () => {
    renderComposer({ busy409: true });
    expect(screen.getByPlaceholderText("Waiting for the current reply…")).toBeTruthy();
  });
});

describe("useMentionTokens — IME guard", () => {
  it("ignores Enter while a composition is active", async () => {
    const fetchItems = vi.fn().mockResolvedValue([{ refType: "task", refId: "t1", label: "LX-1", sublabel: "Task" }]);
    const handled: boolean[] = [];
    function Harness() {
      const [value, setValue] = useState("@");
      const mention = useMentionTokens({ slug: "s", value, onChange: setValue, debounceMs: 0, fetchItems });
      const ref = useRef<HTMLTextAreaElement>(null);
      return (
        <textarea
          ref={ref}
          aria-label="mention"
          value={value}
          onChange={mention.handleChange}
          onKeyDown={(e) => {
            handled.push(mention.handleKeyDown(e));
          }}
        />
      );
    }
    render(<Harness />);
    const textarea = screen.getByLabelText("mention") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "@a" } });
    await waitFor(() => expect(fetchItems).toHaveBeenCalled());
    fireEvent.keyDown(textarea, { key: "Enter", isComposing: true });
    expect(handled.at(-1)).toBe(false);
    expect(textarea.value).toBe("@a");
  });
});
