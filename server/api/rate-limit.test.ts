import { describe, it, expect } from "vitest";
import { createRateLimiter } from "./rate-limit";

describe("createRateLimiter", () => {
  it("allows up to max, denies max+1 in the same window", () => {
    const rl = createRateLimiter({ max: 3, windowMs: 1000 });
    expect(rl.check("a", 0)).toBe(true);
    expect(rl.check("a", 1)).toBe(true);
    expect(rl.check("a", 2)).toBe(true);
    expect(rl.check("a", 3)).toBe(false);
  });

  it("resets the window at exactly windowMs", () => {
    const rl = createRateLimiter({ max: 2, windowMs: 1000 });
    expect(rl.check("a", 0)).toBe(true);
    expect(rl.check("a", 0)).toBe(true);
    expect(rl.check("a", 0)).toBe(false);
    expect(rl.check("a", 1000)).toBe(true);
  });

  it("keeps keys independent", () => {
    const rl = createRateLimiter({ max: 2, windowMs: 1000 });
    expect(rl.check("a", 0)).toBe(true);
    expect(rl.check("a", 0)).toBe(true);
    expect(rl.check("a", 0)).toBe(false);
    expect(rl.check("b", 0)).toBe(true);
    expect(rl.check("b", 0)).toBe(true);
    expect(rl.check("b", 1)).toBe(false);
  });

  it("retryAfterMs is 0 when allowed, else remaining ms in window", () => {
    const rl = createRateLimiter({ max: 1, windowMs: 1000 });
    expect(rl.retryAfterMs("a", 0)).toBe(0);
    expect(rl.check("a", 0)).toBe(true);
    expect(rl.retryAfterMs("a", 100)).toBe(900); // at max → next check denied
    expect(rl.check("a", 100)).toBe(false); // denied now
    expect(rl.retryAfterMs("a", 100)).toBe(900);
    expect(rl.check("a", 500)).toBe(false);
    expect(rl.retryAfterMs("a", 500)).toBe(500);
    expect(rl.retryAfterMs("a", 999)).toBe(1);
    expect(rl.check("a", 1000)).toBe(true); // window reset
    expect(rl.retryAfterMs("a", 1000)).toBe(1000); // fresh bucket, count already at max
  });

  it("sweeps expired buckets when size crosses sweepThreshold", () => {
    const rl = createRateLimiter({ max: 1, windowMs: 1000, sweepThreshold: 2 });
    rl.check("a", 0);
    rl.check("b", 0);
    rl.check("c", 0);
    expect(rl.check("a", 0)).toBe(false); // a at max, still alive
    expect(rl.retryAfterMs("a", 0)).toBe(1000);
    expect(rl.check("d", 2000)).toBe(true); // size >= threshold → sweep evicts a/b/c
    expect(rl.retryAfterMs("a", 2000)).toBe(0); // evicted → fresh bucket → allowed
    expect(rl.check("a", 2000)).toBe(true);
    expect(rl.check("b", 2000)).toBe(true);
  });
});
