// @vitest-environment jsdom
import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import type { useAssistantStream } from "../../lib/use-assistant-stream";
import { useMentionTokens } from "../../lib/useMentionTokens";
import { AssistantChatComposer } from "./AssistantChatComposer";
import type { ChatUploadRequest } from "./AssistantChatComposer";
import { ToastProvider } from "../ui/Toast";
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
    act(() => result.current.setTurns((prev) => appendEphemeralUserTurn(prev, "hello", [])));
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
      <button onClick={() => setTurns((prev) => appendEphemeralUserTurn(prev, "hello", []))}>send</button>
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

describe("useTurnResend — raw index space", () => {
  const errorTurn = { role: "assistant" as const, text: "", imageCount: 0, rawIndex: -1, error: { code: "PROVIDER_UNREACHABLE", message: "x" } };

  function renderResend(args: { turns: Parameters<typeof useTurnResend>[0]["turns"]; rawMessages: unknown[] }) {
    const startStream = vi.fn();
    const setTurns = vi.fn();
    const { result } = renderHook(
      () => useTurnResend({ turns: args.turns, setTurns, rawMessages: args.rawMessages, streaming: false, startStream }),
      { wrapper: ({ children }) => <ToastProvider>{children}</ToastProvider> }
    );
    return { result, startStream, setTurns };
  }

  it("surfaces an error instead of a silent no-op for an unmappable trigger", () => {
    const turns = [{ role: "user" as const, text: "hello", imageCount: 0, rawIndex: -1 }, errorTurn];
    const { result, startStream } = renderResend({ turns, rawMessages: [] });
    act(() => result.current.handleRetryTurn(turns[1]!));
    expect(startStream).not.toHaveBeenCalled();
    expect(screen.getByText("Couldn’t resend turn")).toBeTruthy();
  });

  it("maps an optimistic retry trigger to its raw user message (never a no-op)", () => {
    const turns = [{ role: "user" as const, text: "hello", imageCount: 0, rawIndex: -1 }, errorTurn];
    const { result, startStream } = renderResend({ turns, rawMessages: [{ role: "user", content: "hello" }] });
    act(() => result.current.handleRetryTurn(turns[1]!));
    expect(startStream).toHaveBeenCalledWith("hello", [], 0);
  });

  it("resends from the raw user index once the transcript has it", () => {
    const raw = [{ role: "user", content: "hello" }, { role: "assistant", content: "x" }];
    const turns = [
      { role: "user" as const, text: "hello", imageCount: 0, rawIndex: 0 },
      { role: "assistant" as const, text: "x", imageCount: 0, rawIndex: 1, error: { code: "PROVIDER_UNREACHABLE", message: "x" } },
    ];
    const { result, startStream } = renderResend({ turns, rawMessages: raw });
    act(() => result.current.handleRetryTurn(turns[1]!));
    expect(startStream).toHaveBeenCalledWith("hello", [], 0);
  });

  it("regenerates from the correct raw index despite a stale display position", () => {
    const raw = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "x" },
      { role: "user", content: "next" },
      { role: "assistant", content: "y" },
    ];
    const target = { role: "user" as const, text: "next", imageCount: 0, rawIndex: 0 };
    const { result, startStream } = renderResend({ turns: [target], rawMessages: raw });
    act(() => result.current.handleRegenerate(target));
    expect(startStream).toHaveBeenCalledWith("next", [], 2);
  });

  it("refuses an optimistic retry whose duplicate text only matches an older prompt (stale raw → toast, no truncation)", () => {
    const raw = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "a1" },
    ];
    const turns = [
      { role: "user" as const, text: "hello", imageCount: 0, rawIndex: 0 },
      { role: "assistant" as const, text: "a1", imageCount: 0, rawIndex: 1 },
      { role: "user" as const, text: "hello", imageCount: 0, rawIndex: -1 },
      errorTurn,
    ];
    const { result, startStream } = renderResend({ turns, rawMessages: raw });
    act(() => result.current.handleRetryTurn(turns[3]!));
    expect(startStream).not.toHaveBeenCalled();
    expect(screen.getByText("Couldn’t resend turn")).toBeTruthy();
  });

  it("resends the LAST duplicate once the raw transcript catches up", () => {
    const raw = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "a2" },
    ];
    const turns = [
      { role: "user" as const, text: "hello", imageCount: 0, rawIndex: 0 },
      { role: "assistant" as const, text: "a1", imageCount: 0, rawIndex: 1 },
      { role: "user" as const, text: "hello", imageCount: 0, rawIndex: -1 },
      errorTurn,
    ];
    const { result, startStream } = renderResend({ turns, rawMessages: raw });
    act(() => result.current.handleRetryTurn(turns[3]!));
    expect(startStream).toHaveBeenCalledWith("hello", [], 2);
  });
});

function renderComposer(overrides: Partial<Parameters<typeof AssistantChatComposer>[0]> = {}) {
  const onSend = vi.fn(() => true);
  const onQueue = vi.fn();
  const onUnqueue = vi.fn();
  const uploadAttachment = vi.fn(async (req: ChatUploadRequest) => ({
    id: "att-1",
    projectId: "p1",
    chatId: req.chatId,
    filename: req.file.name,
    mimeType: req.file.type,
    sizeBytes: req.file.size,
    sha256: "sha",
    storageKey: "sk-1",
    uploadedBy: null,
    uploadedByLabel: null,
    createdAt: "2026-01-01T00:00:00Z",
  }));
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
      ensureChatId={() => "chat-1"}
      uploadAttachment={uploadAttachment}
      {...overrides}
    />
  );
  return { ...utils, onSend, onQueue, onUnqueue, uploadAttachment };
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
    expect(onSend).toHaveBeenCalledWith("hello", []);
  });

  it("shows the wireframe busy-409 placeholder, reason line, and no action button", () => {
    const { container } = renderComposer({ busy409: true });
    expect(screen.getByPlaceholderText("Waiting for the current reply…")).toBeTruthy();
    const action = container.querySelector(".deck-action")!;
    expect(action.textContent).toContain("ANOTHER ASSISTANT RUN IS IN PROGRESS");
    expect(action.querySelectorAll("button")).toHaveLength(0);
  });

  it("renders the deck regions in rail / message / action order", () => {
    const { container } = renderComposer({ rail: <span className="deck-label">Skill</span> });
    const deck = container.querySelector(".chat-deck")!;
    const rail = deck.querySelector(".deck-rail")!;
    const message = deck.querySelector(".deck-message")!;
    const action = deck.querySelector(".deck-action")!;
    expect(rail).toBeTruthy();
    expect(rail.compareDocumentPosition(message) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(message.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("offers Queue + Review (no Send) while the turn is suspended", () => {
    const { onSend, onQueue } = renderComposer({ suspendedLock: true, suspendCount: 2 });
    expect(screen.getByPlaceholderText("Queue your next message…")).toBeTruthy();
    expect(screen.getByText(/TURN SUSPENDED · 2 PENDING APPROVALS/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Review/ })).toBeTruthy();

    const textarea = screen.getByLabelText("Message Assistant");
    fireEvent.change(textarea, { target: { value: "next" } });
    const queue = screen.getByRole("button", { name: /Queue/ });
    expect(queue).toBeEnabled();
    fireEvent.click(queue);
    expect(onQueue).toHaveBeenCalledWith("next");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("renders the attachment strip with name, size and meter — no caps copy", async () => {
    const createObjectURL = vi.fn(() => "blob:preview");
    Object.defineProperty(URL, "createObjectURL", { value: createObjectURL, configurable: true });
    const { container } = renderComposer();
    const file = new File([new Uint8Array(524288)], "screenshot.png", { type: "image/png" });
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } });

    await waitFor(() => expect(container.querySelector(".deck-attach-item")).toBeTruthy());
    const item = container.querySelector(".deck-attach-item")!;
    expect(item.textContent).toContain("screenshot.png");
    expect(item.textContent).toContain("512KB");
    expect(item.querySelector(".deck-attach-thumb")).toBeTruthy();
    expect(container.querySelector(".deck-meter")).toBeTruthy();
    expect(container.querySelector(".deck-meter-fill")).toBeTruthy();
    expect(container.textContent).not.toContain("≤");
  });

  it("prefills and focuses the composer from the landing seed", () => {
    const { rerender } = render(
      <AssistantChatComposer
        slug="nimbus"
        streaming={false}
        busy409={false}
        suspendedLock={false}
        suspendCount={0}
        attachDisabled={false}
        onSend={() => true}
        onAbort={() => {}}
        seed={{ text: "Summarize the board", nonce: 1 }}
      />
    );
    const textarea = screen.getByLabelText("Message Assistant") as HTMLTextAreaElement;
    expect(textarea.value).toBe("Summarize the board");
    expect(textarea).toHaveFocus();

    rerender(
      <AssistantChatComposer
        slug="nimbus"
        streaming={false}
        busy409={false}
        suspendedLock={false}
        suspendCount={0}
        attachDisabled={false}
        onSend={() => true}
        onAbort={() => {}}
        seed={{ text: "Find related wiki pages", nonce: 2 }}
      />
    );
    expect(textarea.value).toBe("Find related wiki pages");
    expect(textarea).toHaveFocus();
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
