import { Database } from "bun:sqlite";
import { getSetting } from "../db/settings";

export interface RateLimiterOptions {
  max?: number; // default 6000 requests per window (self-hosted; Forge agents are chatty)
  windowMs?: number; // default 600_000 (10 min)
  sweepThreshold?: number; // default 10_000 — sweep expired buckets when size crosses this
}

export const DEFAULT_RATE_LIMIT_MAX = 6000;
export const DEFAULT_RATE_LIMIT_WINDOW_MS = 600_000;

// Same positive-integer rule the env mirror used to apply, now applied to the
// settings rows only — missing/invalid fall back to the code-level defaults.
function parsePositiveIntSetting(value: string | null): number | null {
  if (value === null) return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// DB-only resolution: the settings table is the single source of truth at
// runtime (env is mirrored into it once at boot — see mirrorSettingsFromDb).
// Missing/empty/invalid rows fall back to the defaults; env is never consulted.
export function resolveRateLimitFromDbValues(opts: {
  settingsMax: string | null;
  settingsWindowMs: string | null;
}): { max: number; windowMs: number } {
  return {
    max: parsePositiveIntSetting(opts.settingsMax) ?? DEFAULT_RATE_LIMIT_MAX,
    windowMs: parsePositiveIntSetting(opts.settingsWindowMs) ?? DEFAULT_RATE_LIMIT_WINDOW_MS,
  };
}

// Applies the DB-configured limits (DB only; defaults as code-level fallback)
// to the shared singleton — called at boot and after every
// PUT /api/settings/rate-limit. Never throws on missing values (settings rows
// are optional).
export function syncRateLimitFromDb(db: Database): void {
  const { max, windowMs } = resolveRateLimitFromDbValues({
    settingsMax: getSetting(db, "rate_limit_max"),
    settingsWindowMs: getSetting(db, "rate_limit_window_ms"),
  });
  apiRateLimiter.setLimits({ max, windowMs });
}

// Forge machine surfaces are key/token-gated and chatty by design — the
// daemon's log POSTs, runtime registration, and the listener's 3s heartbeat
// must never 429. Same policy as before, now covering machines/heartbeat.
export function isRateLimitExemptPath(path: string): boolean {
  return (
    path.startsWith("/api/forge/daemon/") ||
    path === "/api/forge/runtimes/register" ||
    path === "/api/forge/machines/heartbeat"
  );
}

export interface RateLimiter {
  check(key: string, now?: number): boolean;
  retryAfterMs(key: string, now?: number): number;
  setLimits(limits: { max: number; windowMs: number }): void;
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
  let max = opts?.max ?? 600;
  let windowMs = opts?.windowMs ?? 600_000;
  const sweepThreshold = opts?.sweepThreshold ?? 10_000;
  const buckets = new Map<string, Bucket>();

  return {
    // Live mutation: existing buckets keep their windowStart and expire
    // naturally against the new windowMs; check reads the new max.
    setLimits(limits: { max: number; windowMs: number }): void {
      max = limits.max;
      windowMs = limits.windowMs;
    },

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

// Shared instance across surfaces (API middleware) so buckets count traffic
// from the same IP against one window. Initialized with the code-level
// defaults; the boot sync applies the DB-configured limits before serving.
export const apiRateLimiter = createRateLimiter({ max: DEFAULT_RATE_LIMIT_MAX, windowMs: DEFAULT_RATE_LIMIT_WINDOW_MS });
