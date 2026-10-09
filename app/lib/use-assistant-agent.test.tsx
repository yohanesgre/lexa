// @vitest-environment jsdom
// Fresh chat threads have no `assistant_threads` row yet; the WS gate requires
// `?projectId=` on the handshake to upsert it (ADR-0003 §B.2), otherwise the
// upgrade 404s and the first send is dropped. These tests pin the query wiring
// at the `useAgent` boundary.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

const h = vi.hoisted(() => ({
  useAgent: vi.fn(),
  useAgentChat: vi.fn(),
}));

// Mutable chat state for the `useAgentChat` mock, so tests can drive the
// recovering / terminal status projection.
const chatFx = vi.hoisted(() => {
  const idle = () => ({
    messages: [] as unknown[],
    status: "ready",
    error: null as Error | null,
    connectionError: null as Error | null,
    isStreaming: false,
    isRecovering: false,
  });
  const state = { current: idle() };
  return { idle, state, sendMessage: vi.fn() };
});

vi.mock("agents/react", () => ({
  useAgent: h.useAgent,
}));

vi.mock("@cloudflare/ai-chat/react", () => ({
  useAgentChat: (options: unknown) => h.useAgentChat(options),
}));

import { useAssistantAgent } from "./use-assistant-agent";
import type { KnownApprovalDecisions } from "./assistant-agent-adapter";

type UseAgentArgs = {
  basePath?: string;
  query?: { projectId?: string } | undefined;
  connectionTimeout?: number;
  onIdentityChange?: (oldName: string, newName: string, oldAgent: string, newAgent: string) => void;
};

function lastArgs(): UseAgentArgs {
  return h.useAgent.mock.calls[h.useAgent.mock.calls.length - 1]![0] as UseAgentArgs;
}

type ChatAgent = { send: (data: unknown) => boolean };
type UseAgentChatArgs = { agent: ChatAgent; resume?: boolean };

function lastChatArgs(): UseAgentChatArgs {
  return h.useAgentChat.mock.calls[h.useAgentChat.mock.calls.length - 1]![0] as UseAgentChatArgs;
}

beforeEach(() => {
  h.useAgent.mockReset();
  h.useAgent.mockReturnValue({ identified: false, connectionError: null });
  h.useAgentChat.mockReset();
  chatFx.sendMessage.mockReset();
  h.useAgentChat.mockImplementation(() => ({
    ...chatFx.state.current,
    sendMessage: chatFx.sendMessage,
    stop: vi.fn(),
    setMessages: vi.fn(),
    clearError: vi.fn(),
  }));
  chatFx.state.current = chatFx.idle();
});

describe("useAssistantAgent query wiring", () => {
  it("passes projectId through to useAgent's query for a chat thread", () => {
    renderHook(() => useAssistantAgent("assistant-chat:c1", { projectId: "p1" }));
    expect(h.useAgent).toHaveBeenCalledTimes(1);
    expect(lastArgs().basePath).toBe("api/assistant/agent/chat:c1");
    expect(lastArgs().query).toEqual({ projectId: "p1" });
  });

  it("uses the idle basePath when there is no thread key", () => {
    renderHook(() => useAssistantAgent(null));
    expect(lastArgs().basePath).toBe("api/assistant/agent/__idle__");
  });

  it("omits the query when projectId is undefined (task/wiki/panel)", () => {
    renderHook(() => useAssistantAgent("assistant-task:t1"));
    expect(lastArgs().query).toBeUndefined();
  });

  it("resolves a task document surface key to the canonical document thread", () => {
    renderHook(() => useAssistantAgent("assistant-task:doc1"));
    expect(lastArgs().basePath).toBe("api/assistant/agent/task:doc1");
  });

  it("resolves a wiki document surface key to the canonical document thread", () => {
    renderHook(() => useAssistantAgent("assistant-wiki:page-slug"));
    expect(lastArgs().basePath).toBe("api/assistant/agent/wiki:page-slug");
  });

  it("percent-encodes the thread id so a wiki slug with ? or / cannot split the path", () => {
    renderHook(() => useAssistantAgent("assistant-wiki:a?b/c"));
    expect(lastArgs().basePath).toBe("api/assistant/agent/wiki:a%3Fb%2Fc");
  });

  it("keeps the query object referentially stable across renders", () => {
    const { rerender } = renderHook(
      ({ projectId }: { projectId: string }) => useAssistantAgent("assistant-chat:c1", { projectId }),
      { initialProps: { projectId: "p1" } }
    );
    const first = lastArgs().query;
    rerender({ projectId: "p1" });
    expect(lastArgs().query).toBe(first);
  });

  it("acknowledges thread identity changes via onIdentityChange (no SDK advisory)", () => {
    renderHook(() => useAssistantAgent("assistant-chat:c1", { projectId: "p1" }));
    const onIdentityChange = lastArgs().onIdentityChange;
    expect(typeof onIdentityChange).toBe("function");
    expect(() => onIdentityChange!("chat:old", "chat:new", "LexaAssistantAgent", "LexaAssistantAgent")).not.toThrow();
  });

  it("raises partysocket's connection timeout so a cold-DO first dial is not aborted", () => {
    renderHook(() => useAssistantAgent("assistant-chat:c1", { projectId: "p1" }));
    expect(lastArgs().connectionTimeout).toBe(15000);
  });
});

describe("useAssistantAgent — recovering status projection", () => {
  it("does not rewrite a terminal done status back to connecting while recovering", () => {
    chatFx.state.current = {
      ...chatFx.idle(),
      messages: [{ id: "m1", role: "assistant", parts: [{ type: "text", text: "hello" }] }],
      isRecovering: true,
    };
    const { result } = renderHook(() => useAssistantAgent("assistant-chat:c1", { projectId: "p1" }));
    expect(result.current.status).toBe("done");
  });

  it("still surfaces connecting during recovery before any ingress", () => {
    chatFx.state.current = { ...chatFx.idle(), isRecovering: true };
    const { result } = renderHook(() => useAssistantAgent("assistant-chat:c1", { projectId: "p1" }));
    expect(result.current.status).toBe("connecting");
  });
});

describe("useAssistantAgent — suspended carrier projection (LX-120)", () => {
  it("flips to suspended for a carrier on an earlier assistant message than the last", () => {
    chatFx.state.current = {
      ...chatFx.idle(),
      messages: [
        { id: "u1", role: "user", parts: [{ type: "text", text: "go" }] },
        {
          id: "m1",
          role: "assistant",
          parts: [
            {
              type: "tool-create_task",
              toolCallId: "c1",
              state: "output-available",
              input: {},
              output: { approvalId: "a1", batchId: "b1", seq: 0, name: "create_task", diff: {} },
            },
          ],
        },
        { id: "m2", role: "assistant", parts: [{ type: "text", text: "done" }] },
      ],
    };
    const { result } = renderHook(() => useAssistantAgent("assistant-chat:c1", { projectId: "p1" }));
    expect(result.current.status).toBe("suspended");
    expect(result.current.suspendedBatchId).toBe("b1");
    expect(result.current.pending.map((c) => c.approvalId)).toEqual(["a1"]);
  });

  it("flips to suspended for a marker-only carrier", () => {
    chatFx.state.current = {
      ...chatFx.idle(),
      messages: [
        { id: "u1", role: "user", parts: [{ type: "text", text: "go" }] },
        {
          id: "m1",
          role: "assistant",
          parts: [
            { type: "text", text: "proposed" },
            { type: "data-assistant-approval", data: { batchId: "b9", approvals: [] } },
          ],
        },
      ],
    };
    const { result } = renderHook(() => useAssistantAgent("assistant-chat:c1", { projectId: "p1" }));
    expect(result.current.status).toBe("suspended");
    expect(result.current.suspendedBatchId).toBe("b9");
  });

  it("stays non-suspended when a terminal carrier supersedes a pending one", () => {
    chatFx.state.current = {
      ...chatFx.idle(),
      messages: [
        { id: "u1", role: "user", parts: [{ type: "text", text: "go" }] },
        {
          id: "m1",
          role: "assistant",
          parts: [
            {
              type: "tool-create_task",
              toolCallId: "c1",
              state: "output-available",
              input: {},
              output: { approvalId: "a1", batchId: "b1", seq: 0, name: "create_task", diff: {} },
            },
          ],
        },
        {
          id: "m2",
          role: "assistant",
          parts: [
            {
              type: "tool-create_task",
              toolCallId: "c2",
              state: "output-available",
              input: {},
              output: { approvalId: "a1", batchId: "b1", seq: 0, name: "create_task", diff: {}, status: "approved" },
            },
          ],
        },
      ],
    };
    const { result } = renderHook(() => useAssistantAgent("assistant-chat:c1", { projectId: "p1" }));
    expect(result.current.suspendedBatchId).toBeNull();
    expect(result.current.status).toBe("done");
    expect(result.current.pending.map((c) => c.state)).toEqual(["approved"]);
  });
});

describe("useAssistantAgent — known decisions overlay", () => {
  const EMPTY: KnownApprovalDecisions = { byApproval: new Map(), settledBatches: new Set() };

  it("settles a pending carrier once the client knows the batch is decided", () => {
    chatFx.state.current = {
      ...chatFx.idle(),
      messages: [
        { id: "u1", role: "user", parts: [{ type: "text", text: "go" }] },
        {
          id: "m1",
          role: "assistant",
          parts: [
            {
              type: "tool-create_task",
              toolCallId: "c1",
              state: "output-available",
              input: {},
              output: { approvalId: "a1", batchId: "b1", seq: 0, name: "create_task", diff: {} },
            },
          ],
        },
      ],
    };
    const { result, rerender } = renderHook(
      ({ decisions }: { decisions: KnownApprovalDecisions }) =>
        useAssistantAgent("assistant-chat:c1", { projectId: "p1", decisions }),
      { initialProps: { decisions: EMPTY } }
    );
    expect(result.current.status).toBe("suspended");
    expect(result.current.suspendedBatchId).toBe("b1");

    rerender({ decisions: { byApproval: new Map([["a1", "rejected" as const]]), settledBatches: new Set(["b1"]) } });
    expect(result.current.suspendedBatchId).toBeNull();
    expect(result.current.status).toBe("done");
    expect(result.current.pending.map((c) => c.state)).toEqual(["rejected"]);
  });
});

describe("useAssistantAgent — resume outcome callback", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reports ok=true when the resume POST succeeds", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    const { result } = renderHook(() => useAssistantAgent("assistant-chat:c1", { projectId: "p1" }));
    const onResult = vi.fn();
    act(() => result.current.send("/api/assistant/chat/c1/resume", {}, onResult));
    await waitFor(() => expect(onResult).toHaveBeenCalledWith({ ok: true }));
  });

  it("reports ok=false when the resume POST fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const { result } = renderHook(() => useAssistantAgent("assistant-chat:c1", { projectId: "p1" }));
    const onResult = vi.fn();
    act(() => result.current.send("/api/assistant/chat/c1/resume", {}, onResult));
    await waitFor(() => expect(onResult).toHaveBeenCalledWith({ ok: false }));
  });

  it("never invokes the outcome callback for a non-resume send", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useAssistantAgent("assistant-chat:c1", { projectId: "p1" }));
    const onResult = vi.fn();
    act(() => result.current.send("/api/assistant/chat/stream", { message: "hi" }, onResult));
    expect(onResult).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("useAssistantAgent — resume option", () => {
  it("disables resume with no thread (the idle landing never probes a closed socket)", () => {
    renderHook(() => useAssistantAgent(null));
    expect(lastChatArgs().resume).toBe(false);
  });

  it("keeps resume on a real thread", () => {
    renderHook(() => useAssistantAgent("assistant-chat:c1"));
    expect(lastChatArgs().resume).toBe(true);
  });
});

describe("useAssistantAgent — resume-probe send guard", () => {
  const PROBE = JSON.stringify({ type: "cf_agent_stream_resume_request" });

  function renderWithSocket(socket: { readyState: number; shouldReconnect: boolean }) {
    const send = vi.fn(() => true);
    h.useAgent.mockReturnValue({ identified: false, connectionError: null, send, ...socket });
    const { result } = renderHook(() => useAssistantAgent("assistant-chat:c1", { projectId: "p1" }));
    return { result, send, chatAgent: lastChatArgs().agent };
  }

  it("drops the probe on a discarded socket (CLOSED + not reconnecting)", () => {
    const { send, chatAgent } = renderWithSocket({ readyState: 3, shouldReconnect: false });
    expect(chatAgent.send(PROBE)).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("forwards the probe on a CLOSED socket that will reconnect", () => {
    const { send, chatAgent } = renderWithSocket({ readyState: 3, shouldReconnect: true });
    expect(chatAgent.send(PROBE)).toBe(true);
    expect(send).toHaveBeenCalledWith(PROBE);
  });

  it("drops the probe on an OPEN socket that will not reconnect (readyState is window dressing)", () => {
    const { send, chatAgent } = renderWithSocket({ readyState: 1, shouldReconnect: false });
    expect(chatAgent.send(PROBE)).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("always forwards a non-probe frame", () => {
    const { send, chatAgent } = renderWithSocket({ readyState: 3, shouldReconnect: false });
    expect(chatAgent.send("hello")).toBe(true);
    expect(send).toHaveBeenCalledWith("hello");
  });

  it("keeps the raw agent on the returned stream", () => {
    const raw = { identified: false, connectionError: null, readyState: 3, shouldReconnect: false, send: vi.fn(() => true) };
    h.useAgent.mockReturnValue(raw);
    const { result } = renderHook(() => useAssistantAgent("assistant-chat:c1", { projectId: "p1" }));
    expect(result.current.agent).toBe(raw);
  });
});

// partysocket closes the outgoing socket whenever its memo key changes, and the
// browser warns "WebSocket is closed before the connection is established" when
// that socket is still CONNECTING. The hook must therefore hold every identity
// change until the outgoing socket has settled — covering the three automated
// sequences the chat surface produces: stale-restore eviction, orphan-deep-link
// eviction, and a fast thread switch.
describe("useAssistantAgent — identity settle gate (no churn while CONNECTING)", () => {
  const CONNECTING = { identified: false, connectionError: null, readyState: 0, shouldReconnect: false };
  const OPEN = { identified: true, connectionError: null, readyState: 1, shouldReconnect: true };

  type Props = { key: string | null; projectId?: string };

  it("does not swap identity while the outgoing socket is CONNECTING, then swaps once it settles", () => {
    h.useAgent.mockReturnValue(CONNECTING);
    const { rerender } = renderHook(
      ({ key, projectId }: Props) => useAssistantAgent(key, { projectId }),
      { initialProps: { key: "assistant-chat:a", projectId: "p1" } }
    );
    expect(lastArgs().basePath).toBe("api/assistant/agent/chat:a");

    // Fast thread switch: identity flips while the first socket is CONNECTING.
    rerender({ key: "assistant-chat:b", projectId: "p1" });
    expect(lastArgs().basePath).toBe("api/assistant/agent/chat:a");

    // The first dial settles → the deferred identity commits.
    h.useAgent.mockReturnValue(OPEN);
    rerender({ key: "assistant-chat:b", projectId: "p1" });
    expect(lastArgs().basePath).toBe("api/assistant/agent/chat:b");
  });

  it("defers a stale-restore eviction (thread → idle) until the socket settles", () => {
    h.useAgent.mockReturnValue(CONNECTING);
    const { rerender } = renderHook(
      ({ key, projectId }: Props) => useAssistantAgent(key, { projectId }),
      { initialProps: { key: "assistant-chat:stale", projectId: "p1" } }
    );
    expect(lastArgs().basePath).toBe("api/assistant/agent/chat:stale");

    // dropUnknownThread clears chatId while the restored thread is CONNECTING.
    rerender({ key: null, projectId: "p1" });
    expect(lastArgs().basePath).toBe("api/assistant/agent/chat:stale");

    h.useAgent.mockReturnValue(OPEN);
    rerender({ key: null, projectId: "p1" });
    expect(lastArgs().basePath).toBe("api/assistant/agent/__idle__");
    expect(lastArgs().enabled).toBe(false);
  });

  it("defers an orphan-deep-link eviction (thread → idle) until the socket settles", () => {
    // Landing (idle, settled) → orphan deep link dials immediately.
    h.useAgent.mockReturnValue({ identified: false, connectionError: null, readyState: 3 });
    const { rerender } = renderHook(
      ({ key, projectId }: Props) => useAssistantAgent(key, { projectId }),
      { initialProps: { key: null, projectId: "p1" } }
    );
    rerender({ key: "assistant-chat:orphan", projectId: "p1" });
    expect(lastArgs().basePath).toBe("api/assistant/agent/chat:orphan");

    // The orphan dial is now in flight.
    h.useAgent.mockReturnValue(CONNECTING);

    // orphanThreadNeedsRecovery lands fresh while the orphan socket is CONNECTING.
    rerender({ key: null, projectId: "p1" });
    expect(lastArgs().basePath).toBe("api/assistant/agent/chat:orphan");

    h.useAgent.mockReturnValue(OPEN);
    rerender({ key: null, projectId: "p1" });
    expect(lastArgs().basePath).toBe("api/assistant/agent/__idle__");
  });

  it("defers a project switch (query churn) until the socket settles", () => {
    h.useAgent.mockReturnValue(CONNECTING);
    const { rerender } = renderHook(
      ({ key, projectId }: Props) => useAssistantAgent(key, { projectId }),
      { initialProps: { key: "assistant-chat:a", projectId: "p1" } }
    );
    expect(lastArgs().query).toEqual({ projectId: "p1" });

    rerender({ key: "assistant-chat:a", projectId: "p2" });
    expect(lastArgs().query).toEqual({ projectId: "p1" });

    h.useAgent.mockReturnValue(OPEN);
    rerender({ key: "assistant-chat:a", projectId: "p2" });
    expect(lastArgs().query).toEqual({ projectId: "p2" });
  });

  it("settles a socket closed by a final connection error so a change is never pinned", () => {
    h.useAgent.mockReturnValue(CONNECTING);
    const { rerender } = renderHook(
      ({ key, projectId }: Props) => useAssistantAgent(key, { projectId }),
      { initialProps: { key: "assistant-chat:a", projectId: "p1" } }
    );
    rerender({ key: "assistant-chat:b", projectId: "p1" });
    expect(lastArgs().basePath).toBe("api/assistant/agent/chat:a");

    // Final close: the SDK sets connectionError only once readyState is CLOSED.
    h.useAgent.mockReturnValue({ identified: false, connectionError: new Error("gate 404"), readyState: 3 });
    rerender({ key: "assistant-chat:b", projectId: "p1" });
    expect(lastArgs().basePath).toBe("api/assistant/agent/chat:b");
  });

  it("commits the deferred identity when readyState flips in place (25ms interval path, no rerender)", async () => {
    const sock = { identified: false, connectionError: null, readyState: 0, shouldReconnect: false };
    h.useAgent.mockReturnValue(sock);
    const { rerender } = renderHook(
      ({ key, projectId }: Props) => useAssistantAgent(key, { projectId }),
      { initialProps: { key: "assistant-chat:a", projectId: "p1" } }
    );
    rerender({ key: "assistant-chat:b", projectId: "p1" });
    expect(lastArgs().basePath).toBe("api/assistant/agent/chat:a");

    // readyState mutates on the socket object without any React update; the
    // poll (not a render) must apply the deferred identity.
    sock.readyState = 1;
    await waitFor(() => expect(lastArgs().basePath).toBe("api/assistant/agent/chat:b"));
  });

  it("defers a send made before the held identity settles (never writes to the old thread's socket)", async () => {
    const sock = { identified: false, connectionError: null, readyState: 0, shouldReconnect: false };
    h.useAgent.mockReturnValue(sock);
    const { result, rerender } = renderHook(
      ({ key, projectId }: Props) => useAssistantAgent(key, { projectId }),
      { initialProps: { key: "assistant-chat:a", projectId: "p1" } }
    );
    // Select B while A is still CONNECTING: the gate holds the swap.
    rerender({ key: "assistant-chat:b", projectId: "p1" });
    expect(lastArgs().basePath).toBe("api/assistant/agent/chat:a");

    act(() => result.current.send("/api/assistant/chat/stream", { message: "hi" }));
    // Must not write through A's socket — it would land in A's DO.
    expect(chatFx.sendMessage).not.toHaveBeenCalled();

    // A settles → B commits; B identifies → the deferred payload flushes to B.
    sock.readyState = 1;
    await waitFor(() => expect(lastArgs().basePath).toBe("api/assistant/agent/chat:b"));
    sock.identified = true;
    rerender({ key: "assistant-chat:b", projectId: "p1" });
    expect(chatFx.sendMessage).toHaveBeenCalledWith({ parts: [{ type: "text", text: "hi" }] });
  });

  it("delivers two sends made inside one hold window, in order (per-key FIFO)", async () => {
    const sock = { identified: false, connectionError: null, readyState: 0, shouldReconnect: false };
    h.useAgent.mockReturnValue(sock);
    const { result, rerender } = renderHook(
      ({ key, projectId }: Props) => useAssistantAgent(key, { projectId }),
      { initialProps: { key: "assistant-chat:f1", projectId: "p1" } }
    );
    rerender({ key: "assistant-chat:f2", projectId: "p1" });
    expect(lastArgs().basePath).toBe("api/assistant/agent/chat:f1");

    act(() => result.current.send("/api/assistant/chat/stream", { message: "first" }));
    act(() => result.current.send("/api/assistant/chat/stream", { message: "second" }));
    expect(chatFx.sendMessage).not.toHaveBeenCalled();

    sock.readyState = 1;
    await waitFor(() => expect(lastArgs().basePath).toBe("api/assistant/agent/chat:f2"));
    sock.identified = true;
    rerender({ key: "assistant-chat:f2", projectId: "p1" });

    const texts = chatFx.sendMessage.mock.calls.map(
      (call) => (call[0] as { parts: Array<{ text?: string }> }).parts[0]?.text
    );
    expect(texts).toEqual(["first", "second"]);
  });

  it("drops a deferred send when its target is abandoned (drop-on-abandon, bounded retention)", async () => {
    const sock = { identified: false, connectionError: null, readyState: 0, shouldReconnect: false };
    h.useAgent.mockReturnValue(sock);
    const { result, rerender } = renderHook(
      ({ key, projectId }: Props) => useAssistantAgent(key, { projectId }),
      { initialProps: { key: "assistant-chat:d1", projectId: "p1" } }
    );
    rerender({ key: "assistant-chat:d2", projectId: "p1" });
    act(() => result.current.send("/api/assistant/chat/stream", { message: "abandoned" }));
    // d1 is still CONNECTING: select a third thread, so d2 never commits.
    rerender({ key: "assistant-chat:d3", projectId: "p1" });
    expect(lastArgs().basePath).toBe("api/assistant/agent/chat:d1");

    sock.readyState = 1;
    await waitFor(() => expect(lastArgs().basePath).toBe("api/assistant/agent/chat:d3"));
    sock.identified = true;
    rerender({ key: "assistant-chat:d3", projectId: "p1" });

    // d2's queue was dropped on abandon — nothing is delivered to d3.
    expect(chatFx.sendMessage).not.toHaveBeenCalled();
  });
});
