import { describe, it, expect } from "vitest";
import { estimateTokens } from "./tiktoken";

describe("tiktoken", () => {
  it("empty string → 0", async () => {
    expect(await estimateTokens("")).toBe(0);
  });
  it("hello world encodes deterministically via cl100k_base", async () => {
    const n = await estimateTokens("hello world");
    expect(n).toBeGreaterThan(0);
    expect(await estimateTokens("hello world")).toBe(n);
  });
  it("longer text yields more tokens", async () => {
    const a = await estimateTokens("hi");
    const b = await estimateTokens("hello world, this is a much longer sentence with many words");
    expect(b).toBeGreaterThan(a);
  });
  it("cl100k_base: hello world ≈ 2 tokens", async () => {
    expect(await estimateTokens("hello world")).toBe(2);
  });
});
