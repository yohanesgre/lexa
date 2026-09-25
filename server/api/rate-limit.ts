import type { Database } from "bun:sqlite";
import { Effect } from "effect";
import { queryFirst, type DbDriver } from "../db/db";

export interface RateLimiterOptions {
  max?: number; // default 6000 requests per window (self-hosted; Runtime agents are chatty)
  windowMs?: number; // default 600_000 (10 min)
  sweepThreshold?: number; // default 10_000 — sweep expired buckets when size crosses this
}

export const DEFAULT_RATE_LIMIT_MAX = 6000;
export const DEFAULT_RATE_LIMIT_WINDOW_MS = 600_000;

// Sync settings read over a sync Database (Bun path). Mirrors
// server/db/settings.ts getSetting verbatim — kept local so this module
// stays importable on Workers (settings.ts pulls node:fs).
function getSettingSync(db: Database, key: string): string | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | null;
  return row?.value ?? null;
}

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
    settingsMax: getSettingSync(db, "rate_limit_max"),
    settingsWindowMs: getSettingSync(db, "rate_limit_window_ms"),
  });
  apiRateLimiter.setLimits({ max, windowMs });
}

// Async port of syncRateLimitFromDb over a DbDriver (Workers/D1 path).
// Same resolution, same singleton — never throws on missing rows.
export function syncRateLimitFromDbAsync(driver: DbDriver): Effect.Effect<void, never> {
  const read = (key: string): Effect.Effect<string | null, never> =>
    queryFirst<{ value: string }>(driver, "SELECT value FROM settings WHERE key = ?", key).pipe(
      Effect.map((row) => row.value),
      Effect.catchAll(() => Effect.succeed(null))
    );
  return Effect.gen(function* () {
    const settingsMax = yield* read("rate_limit_max");
    const settingsWindowMs = yield* read("rate_limit_window_ms");
    const { max, windowMs } = resolveRateLimitFromDbValues({ settingsMax, settingsWindowMs });
    apiRateLimiter.setLimits({ max, windowMs });
  });
}

// Runtime machine surfaces are key/token-gated and chatty by design — the
// daemon's log POSTs, runtime registration, and the listener's 3s heartbeat
// must never 429. Same policy as before, now covering machines/heartbeat.
export function isRateLimitExemptPath(path: string): boolean {
  return (
    path.startsWith("/api/runtimes/daemon/") ||
    path === "/api/runtimes/register" ||
    path === "/api/runtimes/machines/heartbeat"
  );
}

export interface RateLimiter {
  check(key: string, now?: number): boolean;
  retryAfterMs(key: string, now?: number): number;
  setLimits(limits: { max: number; windowMs: number }): void;
}

// ─── Client-IP resolution (cf-connecting-ip trust) ──────────────────────
// The socket peer IP is the only trustworthy source on the Bun host: any
// client that reaches the socket directly can spoof a forwarding header.
// `cf-connecting-ip` is therefore honored only when the peer is loopback
// (cloudflared / local sidecar) or matches an explicitly configured proxy
// CIDR (LXK_TRUSTED_PROXY_CIDRS). When there is no peer IP at all (Workers
// has no socket address), the header is the only source — Cloudflare's edge
// sets it — so it is used as-is.

function parseIpv4(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

function parseIpv6(raw: string): number[] | null {
  const zone = raw.indexOf("%");
  let s = zone >= 0 ? raw.slice(0, zone) : raw;
  if (!s.includes(":")) return null;

  let v4: number[] | null = null;
  const lastColon = s.lastIndexOf(":");
  const tail = s.slice(lastColon + 1);
  if (tail.includes(".")) {
    v4 = parseIpv4(tail);
    if (!v4) return null;
    // Drop the embedded v4 segment: after "::" the text may follow the "::"
    // directly ("::1.2.3.4") or a group ("::ffff:1.2.3.4").
    const dc = s.indexOf("::");
    s = dc >= 0 && lastColon === dc + 1 ? s.slice(0, dc + 2) : s.slice(0, lastColon);
  }

  const dc = s.indexOf("::");
  let groups: string[];
  if (dc >= 0) {
    if (s.indexOf("::", dc + 2) >= 0) return null;
    const head = s.slice(0, dc);
    const after = s.slice(dc + 2);
    const headGroups = head === "" ? [] : head.split(":");
    const tailGroups = after === "" ? [] : after.split(":");
    const missing = 8 - headGroups.length - tailGroups.length - (v4 ? 2 : 0);
    if (missing < 0) return null;
    groups = [...headGroups, ...new Array<string>(missing).fill("0"), ...tailGroups];
  } else {
    if (s.startsWith(":") || s.endsWith(":")) return null;
    groups = s.split(":");
  }

  const bytes: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    const n = parseInt(g, 16);
    bytes.push((n >> 8) & 0xff, n & 0xff);
  }
  if (v4) bytes.push(...v4);
  return bytes.length === 16 ? bytes : null;
}

function parseIp(ip: string): number[] | null {
  return parseIpv4(ip) ?? parseIpv6(ip);
}

function isV4MappedV6(bytes: number[]): boolean {
  if (bytes.length !== 16) return false;
  for (let i = 0; i < 10; i++) if (bytes[i] !== 0) return false;
  return bytes[10] === 0xff && bytes[11] === 0xff;
}

function isLoopback(bytes: number[]): boolean {
  if (isV4MappedV6(bytes)) return isLoopback(bytes.slice(12));
  if (bytes.length === 4) return bytes[0] === 127;
  if (bytes.length === 16) {
    for (let i = 0; i < 15; i++) if (bytes[i] !== 0) return false;
    return bytes[15] === 1;
  }
  return false;
}

interface ParsedCidr {
  bytes: number[];
  prefix: number;
}

function parseCidr(entry: string): ParsedCidr | null {
  const slash = entry.indexOf("/");
  const addr = slash >= 0 ? entry.slice(0, slash) : entry;
  const prefixRaw = slash >= 0 ? entry.slice(slash + 1) : null;
  const v4 = parseIpv4(addr);
  const v6 = v4 ? null : parseIpv6(addr);
  const bytes = v4 ?? v6;
  if (!bytes) return null;
  const max = bytes.length * 8;
  const prefix = prefixRaw === null ? max : /^\d+$/.test(prefixRaw) ? Number(prefixRaw) : Number.NaN;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) return null;
  return { bytes, prefix };
}

function ipInCidr(peer: number[], cidr: ParsedCidr): boolean {
  const bare = isV4MappedV6(cidr.bytes);
  const net = bare ? cidr.bytes.slice(12) : cidr.bytes;
  const mappedPeer = isV4MappedV6(peer) ? peer.slice(12) : peer;
  if (net.length !== mappedPeer.length) return false;
  const prefix = bare ? Math.max(0, cidr.prefix - 96) : cidr.prefix;
  const full = Math.floor(prefix / 8);
  const rem = prefix % 8;
  for (let i = 0; i < full; i++) if (net[i] !== mappedPeer[i]) return false;
  if (rem > 0) {
    const mask = (0xff << (8 - rem)) & 0xff;
    if ((net[full]! & mask) !== (mappedPeer[full]! & mask)) return false;
  }
  return true;
}

export function isTrustedProxyPeer(peerIp: string, trustedProxyCidrs?: readonly string[] | undefined): boolean {
  const peer = parseIp(peerIp);
  if (!peer) return false;
  if (isLoopback(peer)) return true;
  for (const entry of trustedProxyCidrs ?? []) {
    const cidr = parseCidr(entry);
    if (cidr && ipInCidr(peer, cidr)) return true;
  }
  return false;
}

// Resolve the rate-limit key from the stamp/socket peer and the forwarding
// header. The forwarding header wins only for a trusted peer; otherwise the
// peer (or "unknown") is used, so a spoofed header cannot pick a fresh bucket.
export function resolveClientIp(
  peerIp: string | null | undefined,
  forwardedIp: string | null | undefined,
  trustedProxyCidrs?: readonly string[] | undefined
): string {
  const peer = (peerIp ?? "").trim();
  const forwarded = (forwardedIp ?? "").trim();
  if (!forwarded) return peer || "unknown";
  if (!peer) return forwarded;
  return isTrustedProxyPeer(peer, trustedProxyCidrs) ? forwarded : peer;
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

// Public /api/share/* surface: unauthenticated by design, so a much stricter
// fixed per-IP bucket applies (abuse magnet). Deliberately NOT DB-configurable
// and NOT shared with the general API bucket — a flood on share links must not
// degrade authenticated traffic, and vice versa.
export const SHARE_RATE_LIMIT_MAX = 30;
export const SHARE_RATE_LIMIT_WINDOW_MS = 60_000;
export const shareRateLimiter = createRateLimiter({ max: SHARE_RATE_LIMIT_MAX, windowMs: SHARE_RATE_LIMIT_WINDOW_MS });
