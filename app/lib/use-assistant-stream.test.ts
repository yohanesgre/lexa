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
});
