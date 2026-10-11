import { afterEach, describe, expect, it, vi } from "vitest";
import { assistantGetSnapshot, assistantSendForKey } from "./use-assistant-stream";

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
