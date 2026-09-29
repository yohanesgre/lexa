// @vitest-environment jsdom
import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import type { useAssistantStream } from "../../lib/use-assistant-stream";
import { useMentionTokens } from "../../lib/useMentionTokens";
import { AssistantChatComposer } from "./AssistantChatComposer";
import { appendEphemeralUserTurn, terminalTranscriptAction } from "./assistant-chat-logic";
import { useSettledTurns, useTerminalRefetch, useTurnResend } from "./assistant-chat-session";

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

const NOT_FOUND = { code: "ASSISTANT_THREAD_NOT_FOUND", message: "not found" };

describe("useSettledTurns — fresh thread 404 keeps the optimistic user turn", () => {
  it("survives connecting, streaming and terminal while the transcript 404s", () => {
    const { result, rerender } = renderHook(
      ({ stream }: { stream: Stream }) =>
        useSettledTurns({
          chatId: "N",
          transcriptData: undefined,
          transcriptError: NOT_FOUND,
          streaming: stream.status === "connecting" || stream.status === "streaming",
          stream,
        }),
      { initialProps: { stream: makeStream() } }
    );
    expect(result.current.turns).toEqual([]);

    // send()'s optimistic append
    act(() => result.current.setTurns((prev) => appendEphemeralUserTurn(prev, "hello", 0)));
    const optimistic = [{ role: "user", text: "hello", imageCount: 0, rawIndex: -1 }];
    expect(result.current.turns).toEqual(optimistic);

    // stream.send flips to connecting (no ingress yet) — must not drop the turn.
    rerender({ stream: makeStream({ status: "connecting" }) });
    expect(result.current.turns).toEqual(optimistic);

    // first ingress
    rerender({ stream: makeStream({ status: "streaming", hasIngress: true }) });
    expect(result.current.turns).toEqual(optimistic);

    // terminal done with the now-stale 404
    rerender({ stream: makeStream({ status: "done", hasIngress: true }) });
    expect(result.current.turns).toEqual(optimistic);
  });

  it("clears when a genuinely dead thread (404, no ingress) is settled", () => {
    const { result } = renderHook(() =>
      useSettledTurns({ chatId: "N", transcriptData: undefined, transcriptError: NOT_FOUND, streaming: false, stream: makeStream() })
    );
    expect(result.current.turns).toEqual([]);
  });
});

function TerminalHarness({ stream, queryFn }: { stream: Stream; queryFn: () => Promise<unknown> }) {
  const qc = useQueryClient();
  const transcript = useQuery({ queryKey: ["assistant-chat", "N"], queryFn, retry: false, staleTime: Infinity });
  useTerminalRefetch({ stream, chatId: "N", projectId: "p1", qc, transcriptError: transcript.error });
  const messages = (transcript.data as { messages?: Array<{ content?: string }> } | undefined)?.messages ?? [];
  return <div data-testid="msgs">{messages.map((m) => m.content ?? "").join("|")}</div>;
}

describe("useTerminalRefetch — fresh-thread 404 recovery", () => {
  function renderTerminal() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const queryFn = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("missing"), NOT_FOUND))
      .mockResolvedValue({ messages: [{ role: "user", content: "hello" }] });
    const idle = makeStream();
    const utils = render(
      <QueryClientProvider client={qc}>
        <TerminalHarness stream={idle} queryFn={queryFn} />
      </QueryClientProvider>
    );
    const rerender = (stream: Stream) =>
      utils.rerender(
        <QueryClientProvider client={qc}>
          <TerminalHarness stream={stream} queryFn={queryFn} />
        </QueryClientProvider>
      );
    return { qc, queryFn, rerender };
  }

  it("refetches (not removes) when the 404 predates ingress and the stream had ingress", async () => {
    const { qc, queryFn, rerender } = renderTerminal();
    await waitFor(() => expect(qc.getQueryState(["assistant-chat", "N"])?.status).toBe("error"));

    rerender(makeStream({ status: "done", hasIngress: true }));
    await waitFor(() => expect(screen.getByTestId("msgs").textContent).toBe("hello"));
    expect(queryFn.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("removes the query for a genuinely dead thread (404, no ingress)", async () => {
    const { qc, rerender } = renderTerminal();
    await waitFor(() => expect(qc.getQueryState(["assistant-chat", "N"])?.status).toBe("error"));

    rerender(makeStream({ status: "done", hasIngress: false }));
    await waitFor(() => expect(qc.getQueryState(["assistant-chat", "N"])).toBeUndefined());
  });
});

function FreshThreadHarness({ stream, queryFn }: { stream: Stream; queryFn: () => Promise<unknown> }) {
  const qc = useQueryClient();
  const chatId = "N";
  const transcript = useQuery({ queryKey: ["assistant-chat", chatId], queryFn, retry: false, staleTime: Infinity });
  const streaming = stream.status === "connecting" || stream.status === "streaming";
  const { turns, setTurns } = useSettledTurns({
    chatId,
    transcriptData: transcript.data as { messages: unknown[] } | undefined,
    transcriptError: transcript.error,
    streaming,
    stream,
  });
  useTerminalRefetch({ stream, chatId, projectId: "p1", qc, transcriptError: transcript.error });
  return (
    <>
      <button onClick={() => setTurns((prev) => appendEphemeralUserTurn(prev, "hello", 0))}>send</button>
      <div data-testid="turns">{(turns ?? []).map((t) => `${t.role}:${t.text}`).join("|")}</div>
    </>
  );
}

describe("fresh thread — first send stays visible end to end", () => {
  it("keeps the user bubble through connecting, streaming and the terminal refetch", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const queryFn = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("missing"), NOT_FOUND))
      .mockResolvedValue({ messages: [{ role: "user", content: "hello" }] });
    const { rerender } = render(
      <QueryClientProvider client={qc}>
        <FreshThreadHarness stream={makeStream()} queryFn={queryFn} />
      </QueryClientProvider>
    );
    // fresh UUID 404s
    await waitFor(() => expect(qc.getQueryState(["assistant-chat", "N"])?.status).toBe("error"));

    fireEvent.click(screen.getByText("send"));
    expect(screen.getByTestId("turns").textContent).toBe("user:hello");

    const renderStream = (stream: Stream) =>
      rerender(
        <QueryClientProvider client={qc}>
          <FreshThreadHarness stream={stream} queryFn={queryFn} />
        </QueryClientProvider>
      );

    renderStream(makeStream({ status: "connecting" }));
    expect(screen.getByTestId("turns").textContent).toBe("user:hello");

    renderStream(makeStream({ status: "streaming", hasIngress: true }));
    expect(screen.getByTestId("turns").textContent).toBe("user:hello");

    renderStream(makeStream({ status: "done", hasIngress: true }));
    expect(screen.getByTestId("turns").textContent).toBe("user:hello");

    // terminal refetch replaced the stale 404 with the persisted transcript,
    // without duplicating the user turn.
    await waitFor(() => expect(queryFn.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(screen.getByTestId("turns").textContent).toBe("user:hello");
  });
});

describe("terminalTranscriptAction — not-found vs ingress", () => {
  it("drops a not-found that predates any ingress", () => {
    expect(terminalTranscriptAction("ASSISTANT_THREAD_NOT_FOUND", false)).toBe("drop");
    expect(terminalTranscriptAction("NOT_FOUND", false)).toBe("drop");
  });

  it("refetches a not-found once the stream had ingress", () => {
    expect(terminalTranscriptAction("ASSISTANT_THREAD_NOT_FOUND", true)).toBe("refetch");
    expect(terminalTranscriptAction("NOT_FOUND", true)).toBe("refetch");
  });

  it("refetches every other terminal outcome", () => {
    expect(terminalTranscriptAction("PROVIDER_UNREACHABLE", false)).toBe("refetch");
    expect(terminalTranscriptAction(undefined, false)).toBe("refetch");
    expect(terminalTranscriptAction(undefined, true)).toBe("refetch");
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
