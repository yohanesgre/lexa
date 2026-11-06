import { describe, expect, it, vi } from "vitest";
import { estimateTokens } from "./tiktoken";

vi.mock("tokenx", () => ({
  estimateTokenCount: (text: string) => {
    if (text === "explode") throw new Error("estimator failed");
    return 7;
  },
}));

// Cost-log fallback (gateway.service.ts): when the provider reports no usage,
// the estimate must be usable (positive) so `estimated` usage is recorded
// instead of a zero-cost row; empty input and an estimator failure stay zero
// so the caller falls back to chars/4.
describe("token estimate fallback", () => {
  it("estimates non-empty text, returns zero for empty text, and survives estimator failure", async () => {
    expect(await estimateTokens("hello world")).toBe(7);
    expect(await estimateTokens("")).toBe(0);
    expect(await estimateTokens("explode")).toBe(0);
  });
});
