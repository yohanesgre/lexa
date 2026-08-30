// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import { useHeraldStream, type HeraldStream, type HeraldStreamSnapshot } from "./use-herald-stream";

// Session store is module-level keyed — unique keys per test isolate state.
let latest: HeraldStream | null = null;

function Harness({ k }: { k: string }) {
  latest = useHeraldStream(k);
  return null;
}

// Single-shot SSE body — fine for terminal-state assertions.
function sse(frames: unknown[]): Response {
  const body = frames.map((f) => `event: ${(f as { type: string }).type}\ndata: ${JSON.stringify(f)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

// Chunked SSE body — frames land across timer ticks so MID-STREAM snapshots
// stay observable after the subscriber attaches (a one-chunk Response drains
// entirely inside the send() act flush).
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

describe("use-herald-stream reasoning frames", () => {
  const fetchMock = vi.fn();
  const seen: HeraldStreamSnapshot[] = [];
  let unsubscribe: (() => void) | null = null;

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
  });

  function recordSnapshots() {
    unsubscribe?.();
    unsubscribe = latest!.subscribe(() => {
      const snap = latest!.getSnapshot();
      seen.push(snap);
    });
  }

  function sendAndRecord(key: string, res: Response) {
    fetchMock.mockReturnValue(Promise.resolve(res));
    render(<Harness k={key} />);
    act(() => latest!.send("/api/herald/chat/stream", {}));
    // Post-flush: `latest` is rebound to the live session and the chunked
    // body is still ticking — every remaining frame lands in `seen`.
    recordSnapshots();
  }

  it("accumulates reasoning deltas into an ephemeral buffer and closes the burst on the next non-reasoning frame", async () => {
    sendAndRecord(
      "reasoning-basic",
      sseStream([
        { type: "start", threadId: "t" },
        { type: "reasoning", delta: "first thought " },
        { type: "reasoning", delta: "continues" },
        { type: "delta", text: "Answer." },
        { type: "done", text: "Answer.", usage: { in: 1, out: 1 } },
      ])
    );

    await waitFor(() => expect(latest!.status).toBe("done"));

    // Live reasoning state was observable mid-stream…
    expect(seen.some((s) => s.reasoningActive && s.reasoningText === "first thought ")).toBe(true);
    expect(seen.some((s) => s.reasoningActive && s.reasoningText === "first thought continues")).toBe(true);
    // …and closed by the following delta frame.
    expect(latest!.reasoningText).toBe("first thought continues");
    expect(latest!.reasoningActive).toBe(false);
    expect(latest!.reasoningMs).toBeGreaterThanOrEqual(1);
    // Text/tool pipeline unaffected.
    expect(latest!.text).toBe("Answer.");
    expect(latest!.tools).toEqual([]);
  });
  it("accumulates burst durations across interleaved reasoning bursts and keeps tool phases intact", async () => {
    sendAndRecord(
      "reasoning-interleaved",
      sseStream([
        { type: "start", threadId: "t" },
        { type: "reasoning", delta: "plan a" },
        { type: "tool", phase: "call", name: "web_search" },
        { type: "tool", phase: "result", name: "web_search" },
        { type: "reasoning", delta: "plan b" },
        { type: "delta", text: "Done." },
        { type: "done", text: "Done.", usage: { in: 1, out: 1 } },
      ])
    );

    await waitFor(() => expect(latest!.status).toBe("done"));

    expect(seen.some((s) => s.reasoningActive && s.reasoningText === "plan a")).toBe(true);
    expect(seen.some((s) => !s.reasoningActive && s.tools.length === 1 && s.tools[0]!.phase === "call")).toBe(true);
    // Second burst reopened the buffer WITHOUT discarding the first.
    expect(seen.some((s) => s.reasoningActive && s.reasoningText === "plan aplan b")).toBe(true);
    expect(latest!.reasoningText).toBe("plan aplan b");
    // Both bursts banked time (≥1ms each).
    expect(latest!.reasoningMs).toBeGreaterThanOrEqual(2);
    // Tool chip flipped to result exactly once.
    expect(latest!.tools).toHaveLength(1);
    expect(latest!.tools[0]).toMatchObject({ label: "Searching web…", phase: "result" });
  });
});
describe("use-herald-stream write approvals", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    act(() => latest?.reset());
    latest = null;
    vi.unstubAllGlobals();
  });

  function sendAndRecord(key: string, res: Response) {
    fetchMock.mockReturnValue(Promise.resolve(res));
    render(<Harness k={key} />);
    act(() => latest!.send("/api/herald/chat/stream", {}));
  }

  it("tool_pending frames accumulate as seq-sorted chips; suspended is a terminal status carrying the batchId", async () => {
    sendAndRecord(
      "approvals-suspend",
      sseStream([
        { type: "start", threadId: "t" },
        { type: "delta", text: "Working…" },
        { type: "tool_pending", approvalId: "a2", batchId: "b1", seq: 1, name: "move_task", diff: { type: "task_move", taskRef: "LEX-12", taskTitle: "T", fromColumn: "Backlog", toColumn: "In Progress" } },
        { type: "tool_pending", approvalId: "a1", batchId: "b1", seq: 0, name: "create_task", diff: { type: "task_create", title: "Fix", fields: {} } },
        { type: "suspended", batchId: "b1" },
      ])
    );

    await waitFor(() => expect(latest!.status).toBe("suspended"));
    expect(latest!.suspendedBatchId).toBe("b1");
    // Seq order wins over arrival order; diff payloads ride through intact.
    expect(latest!.pending.map((p) => p.approvalId)).toEqual(["a1", "a2"]);
    expect(latest!.pending[0]!.diff).toMatchObject({ type: "task_create", title: "Fix" });
    expect(latest!.pending[1]!.diff).toMatchObject({ type: "task_move", toColumn: "In Progress" });
    expect(latest!.text).toBe("Working…");
    // Stream end after `suspended` is NOT an error (terminal contract).
    expect(latest!.error).toBeNull();
  });
});
describe("hasIngress", () => {
  const fetchMock = vi.fn();
  const seen: HeraldStreamSnapshot[] = [];
  let unsubscribe: (() => void) | null = null;

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
  });

  function recordSnapshots() {
    unsubscribe?.();
    unsubscribe = latest!.subscribe(() => {
      const snap = latest!.getSnapshot();
      seen.push(snap);
    });
  }

  function sendAndRecord(key: string, res: Response) {
    fetchMock.mockReturnValue(Promise.resolve(res));
    render(<Harness k={key} />);
    act(() => latest!.send("/api/herald/chat/stream", {}));
    recordSnapshots();
  }

  it("false after start/connecting, true after first delta", async () => {
    sendAndRecord(
      "hasIngress-delta",
      sseStream([
        { type: "start", threadId: "t" },
        { type: "delta", text: "hello" },
        { type: "done", text: "hello", usage: { in: 1, out: 1 } },
      ])
    );
    expect(latest!.hasIngress).toBe(false);
    await waitFor(() => expect(latest!.hasIngress).toBe(true));
    await waitFor(() => expect(latest!.status).toBe("done"));
    expect(latest!.hasIngress).toBe(true);
  });
});
