// @vitest-environment jsdom
// Fresh chat threads have no `assistant_threads` row yet; the WS gate requires
// `?projectId=` on the handshake to upsert it (ADR-0003 §B.2), otherwise the
// upgrade 404s and the first send is dropped. These tests pin the query wiring
// at the `useAgent` boundary.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

const h = vi.hoisted(() => ({
  useAgent: vi.fn(),
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
  return { idle, state };
});

vi.mock("agents/react", () => ({
  useAgent: h.useAgent,
}));

vi.mock("@cloudflare/ai-chat/react", () => ({
  useAgentChat: () => ({
    ...chatFx.state.current,
    sendMessage: vi.fn(),
    stop: vi.fn(),
    setMessages: vi.fn(),
    clearError: vi.fn(),
  }),
}));

import { useAssistantAgent } from "./use-assistant-agent";
import type { KnownApprovalDecisions } from "./assistant-agent-adapter";

type UseAgentArgs = {
  basePath?: string;
  query?: { projectId?: string } | undefined;
};

function lastArgs(): UseAgentArgs {
  return h.useAgent.mock.calls[h.useAgent.mock.calls.length - 1]![0] as UseAgentArgs;
}

beforeEach(() => {
  h.useAgent.mockReset();
  h.useAgent.mockReturnValue({ identified: false, connectionError: null });
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

  it("keeps the query object referentially stable across renders", () => {
    const { rerender } = renderHook(
      ({ projectId }: { projectId: string }) => useAssistantAgent("assistant-chat:c1", { projectId }),
      { initialProps: { projectId: "p1" } }
    );
    const first = lastArgs().query;
    rerender({ projectId: "p1" });
    expect(lastArgs().query).toBe(first);
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
