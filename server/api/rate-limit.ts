export interface RateLimiterOptions {
  max?: number; // default 600 requests per window
  windowMs?: number; // default 600_000 (10 min)
  sweepThreshold?: number; // default 10_000 — sweep expired buckets when size crosses this
}

export interface RateLimiter {
  check(key: string, now?: number): boolean;
  retryAfterMs(key: string, now?: number): number;
}

interface Bucket {
  windowStart: number;
  count: number;
}

export function createRateLimiter(opts?: RateLimiterOptions): RateLimiter {
  const max = opts?.max ?? 600;
  const windowMs = opts?.windowMs ?? 600_000;
  const sweepThreshold = opts?.sweepThreshold ?? 10_000;
  const buckets = new Map<string, Bucket>();

  return {
    check(key: string, now: number = Date.now()): boolean {
      if (buckets.size >= sweepThreshold) {
        for (const [k, b] of buckets) {
          if (b.windowStart + windowMs <= now) buckets.delete(k);
        }
      }
      const entry = buckets.get(key);
      if (!entry || entry.windowStart + windowMs <= now) {
        buckets.set(key, { windowStart: now, count: 1 });
        return true;
      }
      if (entry.count < max) {
        entry.count++;
        return true;
      }
      return false;
    },

    retryAfterMs(key: string, now: number = Date.now()): number {
      const entry = buckets.get(key);
      if (!entry || entry.windowStart + windowMs <= now || entry.count < max) return 0;
      return entry.windowStart + windowMs - now;
    },
  };
}
