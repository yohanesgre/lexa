// @vitest-environment jsdom
// Fresh chat threads have no `assistant_threads` row yet; the WS gate requires
// `?projectId=` on the handshake to upsert it (ADR-0003 §B.2), otherwise the
// upgrade 404s and the first send is dropped. These tests pin the query wiring
// at the `useAgent` boundary.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";

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
