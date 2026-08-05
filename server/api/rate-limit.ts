export interface RateLimiterOptions {
  max?: number; // default 600 requests per window
  windowMs?: number; // default 600_000 (10 min)
  sweepThreshold?: number; // default 10_000 — sweep expired buckets when size crosses this
}

export interface RateLimiter {
  check(key: string, now?: number): boolean;
  retryAfterMs(key: string, now?: number): number;
}

export function isPrivateIp(ip: string): boolean {
  const v6mapped = ip.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  const candidate = v6mapped ? v6mapped[1] : ip;
  if (candidate.includes(":")) {
    if (candidate === "::1") return true;
    return candidate.startsWith("fc") || candidate.startsWith("fd");
  }
  const parts = candidate.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return false;
  const [a, b] = parts;
  if (a === 127) return true;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
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

// Shared instance across surfaces (API middleware + entry's /mcp path) so
// buckets count traffic from the same IP against one window.
export const apiRateLimiter = createRateLimiter();
