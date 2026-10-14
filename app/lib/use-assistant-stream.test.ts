// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { assistantGetSnapshot, assistantSendForKey, useAssistantStream } from "./use-assistant-stream";

// D1: a send that fails before any content frame must end in a visible terminal
// error the caller can render (the store's snapshot), never a silent idle.
// D11: a stream that keeps the connection alive with heartbeat comments but
// sends no frame must still end in a bounded terminal error.

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("assistant stream pre-ingress failure", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("reports a transport failure as a terminal error with no ingress", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("boom"))));
    assistantSendForKey("t-fail", "/api/assistant/chat/stream", {});
    await flush();

    const snap = assistantGetSnapshot("t-fail");
    expect(snap.status).toBe("error");
    expect(snap.hasIngress).toBe(false);
    expect(snap.error?.code).toBe("ASSISTANT_GENERATION_FAILED");
  });

  it("bounds a heartbeat-only stream (pings, no frame) to a terminal error", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance", "Date"] });
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        // The server heartbeats a `: ping` comment every 15s; a stalled provider
        // sends no frame. These pings must not keep the turn alive forever.
        setInterval(() => controller.enqueue(encoder.encode(": ping\n\n")), 15_000);
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })))
    );

    assistantSendForKey("t-hang", "/api/assistant/chat/stream", {});
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(31_000);

    const snap = assistantGetSnapshot("t-hang");
    expect(snap.status).toBe("error");
    expect(snap.hasIngress).toBe(false);
    expect(snap.error?.code).toBe("ASSISTANT_GENERATION_FAILED");
  });
});

describe("assistant stream partial replies", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps received text when provider sends a terminal error", async () => {
    const frames = [
      { type: "delta", text: "partial answer" },
      { type: "error", code: "ASSISTANT_GENERATION_FAILED", message: "provider failed" },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })))
    );

    assistantSendForKey("t-partial-error", "/api/assistant/chat/stream", {});
    await flush();

    const snap = assistantGetSnapshot("t-partial-error");
    expect(snap.status).toBe("error");
    expect(snap.text).toBe("partial answer");
  });

  it("treats EOF without terminal settlement as failure and keeps partial text", async () => {
    const frame = { type: "delta", text: "partial answer" };
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(`data: ${JSON.stringify(frame)}\n\n`, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })))
    );

    assistantSendForKey("t-partial-eof", "/api/assistant/chat/stream", {});
    await flush();

    const snap = assistantGetSnapshot("t-partial-eof");
    expect(snap.status).toBe("error");
    expect(snap.text).toBe("partial answer");
  });
});

describe("assistant stream terminal recovery", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps a suspended terminal settled when the consumer resets before transport EOF", async () => {
    let controller: ReadableStreamDefaultController<Uint8Array>;
    vi.stubGlobal("fetch", (_input: unknown, init?: RequestInit) => Promise.resolve(new Response(new ReadableStream<Uint8Array>({
      start(active) {
        controller = active;
        init?.signal?.addEventListener("abort", () => active.error(Object.assign(new Error("cancelled"), { name: "AbortError" })));
      },
    }), { headers: { "content-type": "text/event-stream" } })));
    const { result } = renderHook(() => useAssistantStream("t-suspended-reset"));
    act(() => result.current.send("/api/assistant/chat/stream", {}));
    await waitFor(() => expect(result.current.status).toBe("streaming"));

    act(() => controller.enqueue(new TextEncoder().encode('data: {"type":"suspended","batchId":"b-reset"}\n\n')));
    await waitFor(() => expect(result.current.status).toBe("suspended"));
    await act(async () => {
      result.current.reset();
      await flush();
      await flush();
    });
    expect(result.current.status).toBe("idle");
    expect(result.current.error).toBeNull();
  });

  it("retains partial output but stops offering reconnect after an authoritative replay refusal", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response('data: {"type":"delta","text":"partial reply"}\n\n', {
        headers: { "content-type": "text/event-stream" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { code: "ASSISTANT_GENERATION_FAILED", message: "live reply buffer unavailable" },
      }), { status: 502, headers: { "content-type": "application/json" } })));
    const { result } = renderHook(() => useAssistantStream("t-replay-refused"));
    act(() => result.current.send("/api/assistant/chat/stream", {}));
    await waitFor(() => expect(result.current.canReconnect()).toBe(true));
    act(() => result.current.reconnect());
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.text).toBe("partial reply");
    expect(result.current.canReconnect()).toBe(false);
  });

  it("restores the owned reply across start-only navigation and later partial reload", async () => {
    const body = {
      projectId: "p-reload",
      chatId: "c-reload",
      message: "Continue the owned reply",
      agentId: "agent-reload",
      fromIndex: 4,
      reasoningEffort: "high",
      permissionMode: "auto",
      attachments: [{ storageKey: "blobs/reload", mimeType: "text/plain", name: "context.txt" }],
    };
    const key = "assistant-chat:c-reload";
    const encoder = new TextEncoder();
    let original: ReadableStreamDefaultController<Uint8Array>;
    let replay: ReadableStreamDefaultController<Uint8Array>;
    let generations = 0;
    let replays = 0;
    window.history.replaceState({}, "", "/project/chat?thread=c-reload");
    vi.stubGlobal("fetch", (_input: unknown, init?: RequestInit) => {
      const request: Record<string, unknown> = JSON.parse(String(init?.body));
      if (request.replayFrom === 0) {
        const matches = request.projectId === body.projectId && request.chatId === body.chatId
          && request.message === body.message && request.agentId === body.agentId
          && request.fromIndex === body.fromIndex && request.reasoningEffort === body.reasoningEffort
          && request.permissionMode === body.permissionMode
          && JSON.stringify(request.attachments) === JSON.stringify(body.attachments);
        if (!matches) return Promise.resolve(new Response('{"error":{"code":"ASSISTANT_TASK_ACTIVE","message":"different turn"}}', { status: 409 }));
        replays += 1;
        if (replays === 1) {
          return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
            start(controller) {
              replay = controller;
              controller.enqueue(encoder.encode('data: {"type":"delta","text":"owned reply"}\n\n'));
            },
          }), { headers: { "content-type": "text/event-stream" } }));
        }
        return Promise.resolve(new Response('data: {"type":"done","text":"owned reply complete"}\n\n', {
          headers: { "content-type": "text/event-stream" },
        }));
      }
      generations += 1;
      return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          original = controller;
          controller.enqueue(encoder.encode('data: {"type":"start","chatId":"c-reload","threadId":"owned"}\n\n'));
        },
      }), { headers: { "content-type": "text/event-stream" } }));
    });
    try {
      const selected = renderHook(({ selectedKey }) => useAssistantStream(selectedKey), { initialProps: { selectedKey: key } });
      act(() => selected.result.current.send("/api/assistant/chat/stream", body));
      await waitFor(() => expect(selected.result.current.frames.at(-1)?.type).toBe("start"));
      expect(selected.result.current.hasIngress).toBe(false);
      window.history.replaceState({}, "", "/project/chat?thread=other");
      selected.rerender({ selectedKey: "assistant-chat:other" });
      window.history.replaceState({}, "", "/project/chat?thread=c-reload");
      selected.rerender({ selectedKey: key });
      selected.unmount();
      original!.error(new Error("document disconnected before provider content"));
      await flush();
      vi.resetModules();
      // Both dynamic imports intentionally discard the old module store at reload boundaries.
      const reloaded = await import("./use-assistant-stream");
      const partial = renderHook(({ selectedKey }) => reloaded.useAssistantStream(selectedKey), { initialProps: { selectedKey: key } });
      act(() => partial.result.current.restoreDelivery({ role: "user" }));
      expect(partial.result.current.hasIngress).toBe(false);
      await waitFor(() => expect(partial.result.current.text).toBe("owned reply"));
      window.history.replaceState({}, "", "/project/chat?thread=other");
      partial.rerender({ selectedKey: "assistant-chat:other" });
      window.history.replaceState({}, "", "/project/chat?thread=c-reload");
      partial.rerender({ selectedKey: key });
      partial.unmount();
      replay!.error(new Error("document disconnected after partial reply"));
      await flush();
      vi.resetModules();
      const reloadedAfterPartial = await import("./use-assistant-stream");
      const { result } = renderHook(() => reloadedAfterPartial.useAssistantStream(key));
      act(() => result.current.restoreDelivery({ role: "assistant", metadata: { stopped: true } }));
      await waitFor(() => expect(result.current.status).toBe("done"));
      expect(result.current.text).toBe("owned reply complete");
      expect(generations).toBe(1);
    } finally {
      window.history.replaceState({}, "", "/");
    }
  });
});
