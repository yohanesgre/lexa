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
    expect(seen.some((s) => !s.reasoningActive && s.tools.length === 1 && s.tools[0].phase === "call")).toBe(true);
    // Second burst reopened the buffer WITHOUT discarding the first.
    expect(seen.some((s) => s.reasoningActive && s.reasoningText === "plan aplan b")).toBe(true);
    expect(latest!.reasoningText).toBe("plan aplan b");
    // Both bursts banked time (≥1ms each).
    expect(latest!.reasoningMs).toBeGreaterThanOrEqual(2);
    // Tool chip flipped to result exactly once.
    expect(latest!.tools).toHaveLength(1);
    expect(latest!.tools[0]).toMatchObject({ label: "Searching web…", phase: "result" });
  });

  it("threads tool frame detail into chips; blank or absent detail leaves the humanized name alone", async () => {
    sendAndRecord(
      "tool-detail",
      sseStream([
        { type: "start", threadId: "t" },
        { type: "tool", phase: "call", name: "wiki_search", detail: 'Searching wiki for "setup"' },
        { type: "tool", phase: "result", name: "wiki_search" },
        { type: "tool", phase: "call", name: "web_search", detail: "   " },
        { type: "done", text: "", usage: { in: 0, out: 0 } },
      ])
    );

    await waitFor(() => expect(latest!.status).toBe("done"));

    // Detail survives the call→result flip (result frame carried none).
    expect(latest!.tools[0]).toMatchObject({
      label: "wiki_search",
      phase: "result",
      detail: 'Searching wiki for "setup"',
    });
    // Whitespace-only detail is dropped → bare humanized chip.
    expect(latest!.tools[1]).toMatchObject({ label: "Searching web…", phase: "call" });
    expect(latest!.tools[1].detail).toBeUndefined();
  });

  it("timeline: text→tool→text yields three items in arrival order; consecutive deltas merge; tool result flips in place", async () => {
    sendAndRecord(
      "timeline-order",
      sseStream([
        { type: "start", threadId: "t" },
        { type: "delta", text: "first burst " },
        { type: "delta", text: "one" },
        { type: "tool", phase: "call", name: "wiki_search", detail: 'Searching wiki for "setup"' },
        { type: "tool", phase: "result", name: "wiki_search", detail: "3 pages matched" },
        { type: "delta", text: "second burst" },
        { type: "done", text: "first burst onesecond burst", usage: { in: 1, out: 1 } },
      ])
    );

    await waitFor(() => expect(latest!.status).toBe("done"));

    const items = latest!.items;
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ kind: "text", text: "first burst one" });
    expect(items[1]).toMatchObject({ kind: "tool" });
    expect(items[2]).toMatchObject({ kind: "text", text: "second burst" });
    // Tool chip flipped to result INSIDE the timeline item, position kept.
    const chip = (items[1] as { kind: "tool"; chip: { phase: string; resultDetail?: string } }).chip;
    expect(chip.phase).toBe("result");
    expect(chip.resultDetail).toBe("3 pages matched");
    expect(latest!.tools[0]).toMatchObject({ phase: "result" });
  });

  it("timeline: interleaved reasoning bursts become separate ordered reasoning items with banked durations", async () => {
    sendAndRecord(
      "timeline-reasoning",
      sseStream([
        { type: "start", threadId: "t" },
        { type: "reasoning", delta: "plan a" },
        { type: "reasoning", delta: " continues" },
        { type: "delta", text: "mid answer" },
        { type: "reasoning", delta: "plan b" },
        { type: "delta", text: " final" },
        { type: "done", text: "mid answer final", usage: { in: 1, out: 1 } },
      ])
    );

    await waitFor(() => expect(latest!.status).toBe("done"));

    const items = latest!.items;
    expect(items.map((it) => it.kind)).toEqual(["reasoning", "text", "reasoning", "text"]);
    expect(items[0]).toMatchObject({ kind: "reasoning", text: "plan a continues" });
    if (items[0].kind === "reasoning") {
      expect(items[0].ms).not.toBeNull();
    }
    expect(items[1]).toMatchObject({ kind: "text", text: "mid answer" });
    expect(items[2]).toMatchObject({ kind: "reasoning", text: "plan b" });
    // Aggregate fields still feed the summary label.
    expect(latest!.reasoningText).toBe("plan a continuesplan b");
    expect(latest!.reasoningMs).toBeGreaterThanOrEqual(2);
  });

  it("malformed reasoning payloads are skipped without killing the stream", async () => {
    sendAndRecord(
      "reasoning-malformed",
      sse([
        { type: "start", threadId: "t" },
        { type: "reasoning", delta: 42 },
        { type: "reasoning" },
        { type: "delta", text: "ok" },
        { type: "done", text: "ok", usage: { in: 0, out: 0 } },
      ])
    );

    await waitFor(() => expect(latest!.status).toBe("done"));
    expect(latest!.reasoningText).toBe("");
    expect(latest!.reasoningMs).toBeNull();
    expect(latest!.text).toBe("ok");
  });

  it("reset clears the reasoning buffer back to idle", async () => {
    sendAndRecord(
      "reasoning-reset",
      sse([
        { type: "reasoning", delta: "thinking" },
        { type: "done", text: "x", usage: { in: 0, out: 0 } },
      ])
    );
    await waitFor(() => expect(latest!.status).toBe("done"));
    expect(latest!.reasoningText).toBe("thinking");

    act(() => latest!.reset());
    expect(latest!.status).toBe("idle");
    expect(latest!.reasoningText).toBe("");
    expect(latest!.reasoningActive).toBe(false);
    expect(latest!.reasoningMs).toBeNull();
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
    expect(latest!.pending[0].diff).toMatchObject({ type: "task_create", title: "Fix" });
    expect(latest!.pending[1].diff).toMatchObject({ type: "task_move", toColumn: "In Progress" });
    expect(latest!.text).toBe("Working…");
    // Stream end after `suspended` is NOT an error (terminal contract).
    expect(latest!.error).toBeNull();
  });
});
