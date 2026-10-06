import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const state = vi.hoisted(() => ({ attempts: 0, failures: 0 }));

vi.mock("js-tiktoken/lite", () => ({
  Tiktoken: class {
    constructor() {
      state.attempts += 1;
      if (state.attempts <= state.failures) throw new Error("load failed");
    }
    encode(text: string): number[] {
      return new Array(text.length).fill(0);
    }
  },
}));

let estimateTokens: typeof import("./tiktoken").estimateTokens;

describe("tiktoken load failure", () => {
  beforeEach(async () => {
    vi.resetModules();
    state.attempts = 0;
    state.failures = 0;
    ({ estimateTokens } = await import("./tiktoken"));
  });

  afterEach(() => vi.restoreAllMocks());

  it("returns 0 and warns once when the encoder fails to load", async () => {
    state.failures = 2;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await estimateTokens("hello world")).toBe(0);
    expect(await estimateTokens("hello world again")).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("retries after a rejected load instead of caching the rejection", async () => {
    state.failures = 1;
    expect(await estimateTokens("hello world")).toBe(0);
    expect(await estimateTokens("hello world")).toBeGreaterThan(0);
  });

  it("memoizes a successful load", async () => {
    state.failures = 0;
    await estimateTokens("hello world");
    const before = state.attempts;
    await estimateTokens("hello world");
    expect(state.attempts).toBe(before);
  });

  it("shares a single rejected load across concurrent callers", async () => {
    state.failures = 1;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const results = await Promise.all([
      estimateTokens("a"),
      estimateTokens("b"),
      estimateTokens("c"),
    ]);
    expect(results).toEqual([0, 0, 0]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(await estimateTokens("hello world")).toBeGreaterThan(0);
  });
});
