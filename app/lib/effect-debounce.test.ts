// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Effect } from "effect";
import { createDebouncedEffect, createWikiAutosaveEffect } from "./effect-api";

function makeTipTapDoc(text: string) {
  return { type: "doc" as const, content: [{ type: "paragraph", content: [{ type: "text", text }] }] };
}

describe("createDebouncedEffect — debounce 800ms + fiber interrupt concurrency 1", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("only last trigger fires after delay", async () => {
    const calls: number[] = [];
    const fn = (v: number) => Effect.sync(() => calls.push(v));
    const d = createDebouncedEffect(fn, 800);
    d.trigger(1);
    d.trigger(2);
    d.trigger(3);
    expect(calls).toEqual([]);
    vi.advanceTimersByTime(799);
    expect(calls).toEqual([]);
    vi.advanceTimersByTime(1);
    await vi.advanceTimersByTimeAsync(10);
    // allow forked fiber to run (microtask)
    await Promise.resolve();
    expect(calls).toEqual([3]);
    d.destroy();
  });

  it("interrupt previous running effect when new trigger arrives during execution", async () => {
    const started: number[] = [];
    const finished: number[] = [];
    const fn = (v: number) =>
      Effect.gen(function* () {
        started.push(v);
        yield* Effect.sleep(500 as unknown as never);
        finished.push(v);
      }) as unknown as Effect.Effect<void, never>;
    const d = createDebouncedEffect(fn, 100);
    d.trigger(1);
    vi.advanceTimersByTime(100);
    await Promise.resolve();
    // first effect started
    expect(started).toEqual([1]);
    // trigger second while first still sleeping — should interrupt first
    d.trigger(2);
    vi.advanceTimersByTime(100);
    await Promise.resolve();
    expect(started).toEqual([1, 2]);
    // advance past sleep — only second should finish due to interrupt
    vi.advanceTimersByTime(600);
    await vi.advanceTimersByTimeAsync(10);
    await Promise.resolve();
    expect(finished).toEqual([2]);
    d.destroy();
  });

  it("cancel prevents pending execution", async () => {
    const calls: number[] = [];
    const fn = (v: number) => Effect.sync(() => calls.push(v));
    const d = createDebouncedEffect(fn, 200);
    d.trigger(42);
    d.cancel();
    vi.advanceTimersByTime(300);
    await Promise.resolve();
    expect(calls).toEqual([]);
    d.destroy();
  });

  it("destroy cancels timer and interrupts fiber", async () => {
    const calls: number[] = [];
    const fn = (v: number) => Effect.sync(() => calls.push(v));
    const d = createDebouncedEffect(fn, 200);
    d.trigger(1);
    d.destroy();
    vi.advanceTimersByTime(300);
    await Promise.resolve();
    expect(calls).toEqual([]);
  });
});

describe("createWikiAutosaveEffect — 800ms debounce + Schema decode + interrupt", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("decodes TipTap doc before save and debounces 800ms", async () => {
    const saved: unknown[] = [];
    const saveFn = (doc: ReturnType<typeof makeTipTapDoc>) => Effect.sync(() => saved.push(doc));
    const h = createWikiAutosaveEffect(saveFn as never, 800);
    const doc1 = makeTipTapDoc("first");
    const doc2 = makeTipTapDoc("second");
    h.trigger(doc1 as never);
    h.trigger(doc2 as never);
    vi.advanceTimersByTime(800);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10);
    expect(saved).toHaveLength(1);
    expect((saved[0] as { content: { content: { text: string }[] }[] }).content[0]!.content[0]!.text).toBe("second");
    h.destroy();
  });

  it("rejects invalid doc via Schema decode failure and does not call saveFn", async () => {
    const saved: unknown[] = [];
    const saveFn = (doc: import("../../shared/types").TipTapDoc) => Effect.sync(() => saved.push(doc)) as unknown as Effect.Effect<void, import("./effect-api").ApiError>;
    const h = createWikiAutosaveEffect(saveFn, 100);
    const invalid = { type: "doc", content: "not-array" } as unknown as import("../../shared/types").TipTapDoc;
    h.trigger(invalid);
    vi.advanceTimersByTime(100);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(20);
    expect(saved).toEqual([]);
    h.destroy();
  });

  it("fiber interrupt — second autosave cancels first", async () => {
    const started: string[] = [];
    const finished: string[] = [];
    const saveFn = (doc: ReturnType<typeof makeTipTapDoc>) =>
      Effect.gen(function* () {
        started.push(doc.content[0]!.content![0]!.text as string);
        yield* Effect.sleep(1000 as unknown as never);
        finished.push(doc.content[0]!.content![0]!.text as string);
      }) as unknown as Effect.Effect<void, never>;
    const h = createWikiAutosaveEffect(saveFn as never, 50);
    h.trigger(makeTipTapDoc("a") as never);
    vi.advanceTimersByTime(50);
    await Promise.resolve();
    expect(started).toEqual(["a"]);
    h.trigger(makeTipTapDoc("b") as never);
    vi.advanceTimersByTime(50);
    await Promise.resolve();
    expect(started).toEqual(["a", "b"]);
    vi.advanceTimersByTime(1200);
    await vi.advanceTimersByTimeAsync(10);
    expect(finished).toEqual(["b"]);
    h.destroy();
  });
});
