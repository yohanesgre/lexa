// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import { useHeraldStream, type HeraldStream, type HeraldStreamSnapshot } from "./use-herald-stream";
import { STREAM_STALL_MESSAGE } from "../../shared/herald";

let latest: HeraldStream | null = null;

function Harness({ k }: { k: string }) {
  latest = useHeraldStream(k);
  return null;
}

function sseStream(frames: unknown[], delayMs = 25): Response {
  const encoder = new TextEncoder();
  const chunks = frames.map((f) => `event: ${(f as { type: string }).type}\ndata: ${JSON.stringify(f)}\n\n`);
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
        await new Promise((r) => setTimeout(r, delayMs));
      }
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function sseHanging(): Response {
  const body = new ReadableStream<Uint8Array>({
    start() {
      // never enqueue, never close — triggers stall timeout or streaming fallback
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

describe("use-herald-stream Effect path", () => {
  const fetchMock = vi.fn();
  let unsubscribe: (() => void) | null = null;
  const seen: HeraldStreamSnapshot[] = [];

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    seen.length = 0;
    unsubscribe = null;
  });

  afterEach(() => {
    unsubscribe?.();
    unsubscribe = null;
    act(() => latest?.reset());
    latest = null;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function recordSnapshots() {
    unsubscribe?.();
    unsubscribe = latest!.subscribe(() => {
      seen.push(latest!.getSnapshot());
    });
  }

  function sendAndRecord(key: string, res: Response) {
    fetchMock.mockReturnValue(Promise.resolve(res));
    render(<Harness k={key} />);
    act(() => latest!.send("/api/herald/chat/stream", {}));
    recordSnapshots();
  }

  it("stall timeout => HERALD_GENERATION_FAILED/STREAM_STALL_MESSAGE", async () => {
    sendAndRecord(
      "effect-stall",
      sseStream([{ type: "start", threadId: "t" }], 5)
    );
    await waitFor(() => expect(latest!.status).toBe("error"), { timeout: 2000 });
    expect(latest!.error).toEqual({ code: "HERALD_GENERATION_FAILED", message: STREAM_STALL_MESSAGE });
    expect(latest!.error?.message).toBe(STREAM_STALL_MESSAGE);
  });

  it("abort via AbortSignal transitions to aborted and preserves snapshot", async () => {
    fetchMock.mockReturnValue(Promise.resolve(sseHanging()));
    render(<Harness k="effect-abort" />);
    act(() => latest!.send("/api/herald/chat/stream", {}));
    recordSnapshots();
    await waitFor(() => expect(latest!.status).toBe("streaming"));
    act(() => latest!.abort());
    await waitFor(() => expect(latest!.status).toBe("aborted"));
    expect(latest!.error).toBeNull();
    expect(fetchMock).toHaveBeenCalled();
    const callInit = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(callInit?.signal).toBeInstanceOf(AbortSignal);
  });

  it("reasoning burst accumulates and closes on next frame", async () => {
    sendAndRecord(
      "effect-reasoning-burst",
      sseStream([
        { type: "start", threadId: "t" },
        { type: "reasoning", delta: "think " },
        { type: "reasoning", delta: "more" },
        { type: "reasoning", delta: " thoughts" },
        { type: "delta", text: "Answer." },
        { type: "done", text: "Answer.", usage: { in: 2, out: 3 } },
      ])
    );

    await waitFor(() => expect(latest!.status).toBe("done"), { timeout: 2000 });

    expect(seen.some((s) => s.reasoningActive && s.reasoningText === "think ")).toBe(true);
    expect(seen.some((s) => s.reasoningActive && s.reasoningText === "think more thoughts")).toBe(true);
    expect(latest!.reasoningText).toBe("think more thoughts");
    expect(latest!.reasoningActive).toBe(false);
    expect(latest!.reasoningMs).toBeGreaterThanOrEqual(1);
    expect(latest!.text).toBe("Answer.");
    expect(latest!.hasIngress).toBe(true);
  });

  it("reasoning burst interleaved with tool phases", async () => {
    sendAndRecord(
      "effect-reasoning-tool",
      sseStream([
        { type: "start", threadId: "t" },
        { type: "reasoning", delta: "alpha" },
        { type: "tool", phase: "call", name: "web_search" },
        { type: "reasoning", delta: "beta" },
        { type: "delta", text: "done" },
        { type: "done", text: "done", usage: { in: 1, out: 1 } },
      ])
    );
    await waitFor(() => expect(latest!.status).toBe("done"), { timeout: 2000 });
    expect(latest!.reasoningText).toBe("alphabeta");
    expect(latest!.tools).toHaveLength(1);
  });
});
