import { describe, it, expect, vi, afterEach } from "vitest";

const state = vi.hoisted(() => ({ attempts: 0, failures: 2 }));

vi.mock("js-tiktoken/lite", () => ({
  Tiktoken: class {
    constructor() {
      state.attempts += 1;
      if (state.failures > 0) {
        state.failures -= 1;
        throw new Error("load failed");
      }
    }
    encode(text: string): number[] {
      return new Array(text.length).fill(0);
    }
  },
}));

import { estimateTokens } from "./tiktoken";

describe("tiktoken load failure", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns 0 and warns once when the encoder fails to load", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await estimateTokens("hello world")).toBe(0);
    expect(await estimateTokens("hello world again")).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("retries after a rejected load instead of caching the rejection", async () => {
    expect(await estimateTokens("hello world")).toBeGreaterThan(0);
  });

  it("memoizes a successful load", async () => {
    const before = state.attempts;
    await estimateTokens("hello world");
    expect(state.attempts).toBe(before);
  });
});
