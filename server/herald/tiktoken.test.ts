import { describe, it, expect } from "vitest";
import { estimateTokens } from "./tiktoken";

describe("tiktoken", () => {
  it("empty string → 0", () => {
    expect(estimateTokens("")).toBe(0);
  });
  it("hello world encodes deterministically via cl100k_base", () => {
    const n = estimateTokens("hello world");
    expect(n).toBeGreaterThan(0);
    expect(estimateTokens("hello world")).toBe(n);
  });
  it("longer text yields more tokens", () => {
    const a = estimateTokens("hi");
    const b = estimateTokens("hello world, this is a much longer sentence with many words");
    expect(b).toBeGreaterThan(a);
  });
  it("cl100k_base: hello world ≈ 2 tokens", () => {
    expect(estimateTokens("hello world")).toBe(2);
  });
});
