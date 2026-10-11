import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { setSetting } from "../db/settings";
import { createApiHandler, workersClientIp } from "./http";
import { resetSettingsCache } from "./workers-ports";
import { loginLimiter, authIpLimiter } from "../auth";
import {
  apiRateLimiter,
  createRateLimiter,
  DEFAULT_RATE_LIMIT_MAX,
  DEFAULT_RATE_LIMIT_WINDOW_MS,
  isRateLimitExemptPath,
  isTrustedProxyPeer,
  resolveClientIp,
  resolveRateLimitFromDbValues,
  syncRateLimitFromDb,
} from "./rate-limit";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));
const ADMIN_KEY = "lxk_" + "a".repeat(43);
const MEMBER_KEY = "lxk_" + "m".repeat(43);

describe("createRateLimiter", () => {
  it("allows up to max, resets at exactly windowMs, and setLimits raises/lowers max mid-window", () => {
    const rl = createRateLimiter({ max: 2, windowMs: 1000 });
    expect(rl.check("a", 0)).toBe(true);
    expect(rl.check("a", 0)).toBe(true);
    expect(rl.check("a", 0)).toBe(false);
    expect(rl.check("a", 1000)).toBe(true); // window reset
    expect(rl.check("b", 0)).toBe(true); // independent key

    const live = createRateLimiter({ max: 1, windowMs: 1000 });
    expect(live.check("a", 0)).toBe(true);
    expect(live.check("a", 0)).toBe(false); // at max
    live.setLimits({ max: 2, windowMs: 1000 });
    expect(live.check("a", 0)).toBe(true); // live max now 2
    live.setLimits({ max: 1, windowMs: 1000 });
    expect(live.check("a", 0)).toBe(false); // count 2 > new max 1
  });
});

describe("resolveRateLimitFromDbValues", () => {
  it("defaults, reads valid values, and falls back per-key on invalid (env never consulted)", () => {
    expect(resolveRateLimitFromDbValues({ settingsMax: null, settingsWindowMs: null })).toEqual({ max: 6000, windowMs: 600_000 });
    expect(resolveRateLimitFromDbValues({ settingsMax: "100", settingsWindowMs: "5000" })).toEqual({ max: 100, windowMs: 5000 });
    expect(resolveRateLimitFromDbValues({ settingsMax: "abc", settingsWindowMs: "0" })).toEqual({ max: 6000, windowMs: 600_000 });
    expect(resolveRateLimitFromDbValues({ settingsMax: "-5", settingsWindowMs: "1.5" })).toEqual({ max: 6000, windowMs: 600_000 });
  });
});

describe("syncRateLimitFromDb", () => {
  const freshDb = () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')))");
    return db;
  };

  it("applies DB settings to the shared limiter and DB wins over env (env is bootstrap-only)", () => {
    const savedMax = process.env.LXK_RATE_LIMIT_MAX;
    process.env.LXK_RATE_LIMIT_MAX = "1000";
    try {
      const db = freshDb();
      setSetting(db, "rate_limit_max", "2");
      setSetting(db, "rate_limit_window_ms", "1000");
      syncRateLimitFromDb(db);
      expect(apiRateLimiter.check("sync-probe", 0)).toBe(true);
      expect(apiRateLimiter.check("sync-probe", 0)).toBe(true);
      expect(apiRateLimiter.check("sync-probe", 0)).toBe(false); // DB max 2, not env 1000
      db.close();
    } finally {
      if (savedMax !== undefined) process.env.LXK_RATE_LIMIT_MAX = savedMax; else delete process.env.LXK_RATE_LIMIT_MAX;
    }
  });
});

describe("proxy/IP resolution", () => {
  it("trusts loopback/CIDRs, ignores malformed entries, honors the forwarding header only from a trusted peer, and exempts nothing", () => {
    expect(isTrustedProxyPeer("127.0.0.1")).toBe(true);
    expect(isTrustedProxyPeer("::1")).toBe(true);
    expect(isTrustedProxyPeer("::ffff:127.0.0.1")).toBe(true);
    expect(isTrustedProxyPeer("::ffff:10.0.0.5", ["10.0.0.0/8"])).toBe(true);
    expect(isTrustedProxyPeer("2001:db8::1.2.3.4", ["2001:db8::/32"])).toBe(true);
    expect(isTrustedProxyPeer("fd00:1234::5", ["fd00:1234::/32"])).toBe(true);
    expect(isTrustedProxyPeer("10.0.0.5")).toBe(false);
    expect(isTrustedProxyPeer("192.168.1.9", ["10.0.0.0/8"])).toBe(false);
    expect(isTrustedProxyPeer("10.0.0.5", ["not-a-cidr", "10.0.0.0/99"])).toBe(false);
    expect(isTrustedProxyPeer("not-an-ip", ["0.0.0.0/0"])).toBe(false);

    expect(resolveClientIp("127.0.0.1", "203.0.113.7", [])).toBe("203.0.113.7");
    expect(resolveClientIp("10.0.0.5", "203.0.113.7", [])).toBe("10.0.0.5");
    expect(resolveClientIp("10.0.0.5", "203.0.113.7", ["10.0.0.0/8"])).toBe("203.0.113.7");
    expect(resolveClientIp("10.0.0.5", "203.0.113.7", ["garbage"])).toBe("10.0.0.5");
    expect(resolveClientIp("", "", [])).toBe("unknown");

    // Nothing is exempt now that the runtime daemon surfaces are gone.
    expect(isRateLimitExemptPath("/api/runtimes/daemon/tasks/abc/log")).toBe(false);
    expect(isRateLimitExemptPath("/api/runtimes/register")).toBe(false);
    expect(isRateLimitExemptPath("/api/projects")).toBe(false);
    expect(isRateLimitExemptPath("/api/setup")).toBe(false);
  });
});

// R17: 5 failed login attempts per email per 60s, then a 15-minute lockout.
// Memory storage (single process) — the better-auth rateLimit plugin does not
// exist in 1.6.27 (declared deviation; wired in server/entry.ts around
// POST /api/auth/sign-in/email).
describe("loginLimiter + authIpLimiter", () => {
  it("locks after 5 failures for 15min (per-email, case-insensitive, success clears); keyless IP budget is 120/min and isolated", () => {
    const email = "victim@lexa.dev";
    expect(loginLimiter.check(email).ok).toBe(true);
    for (let i = 0; i < 5; i++) loginLimiter.recordFailure(email);
    const verdict = loginLimiter.check(email);
    expect(verdict.ok).toBe(false);
    expect(verdict.retryAfterSec).toBeGreaterThan(14 * 60);
    // case-insensitive, per-email
    expect(loginLimiter.check("VICTIM@lexa.dev").ok).toBe(false);
    expect(loginLimiter.check("other@lexa.dev").ok).toBe(true);
    loginLimiter.recordSuccess(email);
    expect(loginLimiter.check(email).ok).toBe(true);

    for (let i = 0; i < 120; i++) expect(authIpLimiter("1.2.3.4").ok).toBe(true);
    const ipVerdict = authIpLimiter("1.2.3.4");
    expect(ipVerdict.ok).toBe(false);
    expect(ipVerdict.retryAfterSec).toBeGreaterThan(0);
    expect(authIpLimiter("5.6.7.8").ok).toBe(true);
    for (let i = 0; i < 121; i++) authIpLimiter("unknown");
    expect(authIpLimiter("unknown").ok).toBe(false);
  });
});

// The Workers path has no socket IP, so `cf-connecting-ip` is the only source.
describe("workersClientIp", () => {
  it("honors cf-connecting-ip while ignoring/deleting a spoofed x-lexa-remote-ip, else unknown", () => {
    expect(workersClientIp({ "x-lexa-remote-ip": "10.0.0.5", "cf-connecting-ip": "203.0.113.7" })).toBe("203.0.113.7");
    expect(workersClientIp({ "x-lexa-remote-ip": "127.0.0.1" })).toBe("unknown");
    expect(workersClientIp({})).toBe("unknown");
  });
});

// --- carried: /api/settings/rate-limit (absorbed from
// http-rate-limit-settings.test.ts) ---------------------------------------

async function sha256(text: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

let dir: string;
let db: Database;
let handler: (req: Request) => Promise<Response>;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "lexa-rate-limit-api-"));
  const dbPath = join(dir, "test.db");
  runMigrations(dbPath, MIGRATIONS);
  const adminHash = await sha256(ADMIN_KEY);
  const memberHash = await sha256(MEMBER_KEY);
  db = new Database(dbPath);
  db.exec(`
INSERT INTO users (id, email, name, role) VALUES ('u1', 'maria@lexa.test', 'Maria', 'member');
INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k1', 'test-admin', '${adminHash}', NULL);
INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k2', 'test-member', '${memberHash}', 'u1');
`);
  handler = createApiHandler(dbPath);
});

afterAll(() => {
  // Restore the shared limiter and drop the global settings rows so this
  // file's mutations don't leak into later tests in the same worker.
  apiRateLimiter.setLimits({ max: DEFAULT_RATE_LIMIT_MAX, windowMs: DEFAULT_RATE_LIMIT_WINDOW_MS });
  db.exec("DELETE FROM settings WHERE key IN ('rate_limit_max', 'rate_limit_window_ms')");
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  resetSettingsCache();
});

const json = (method: string, path: string, body?: unknown, key: string = ADMIN_KEY) =>
  new Request(`http://lexa.test${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

describe("settings rate-limit endpoints", () => {
  it("GET defaults (env bootstrap-only); PUT valid saves/applies and GET reflects; invalid body → 422", async () => {
    const saved = process.env.LXK_RATE_LIMIT_MAX;
    process.env.LXK_RATE_LIMIT_MAX = "1000";
    try {
      db.exec("DELETE FROM settings WHERE key IN ('rate_limit_max', 'rate_limit_window_ms')");
      apiRateLimiter.setLimits({ max: DEFAULT_RATE_LIMIT_MAX, windowMs: DEFAULT_RATE_LIMIT_WINDOW_MS });
      const defaults = await handler(json("GET", "/api/settings/rate-limit"));
      expect(defaults.status).toBe(200);
      expect(await defaults.json()).toEqual({ max: 6000, windowMs: 600_000, envOverride: false });
    } finally {
      if (saved !== undefined) process.env.LXK_RATE_LIMIT_MAX = saved; else delete process.env.LXK_RATE_LIMIT_MAX;
    }

    const res = await handler(json("PUT", "/api/settings/rate-limit", { max: 100, windowMs: 5000 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ max: 100, windowMs: 5000, envOverride: false });
    const get = await handler(json("GET", "/api/settings/rate-limit"));
    expect(await get.json()).toEqual({ max: 100, windowMs: 5000, envOverride: false });
    expect(db.prepare("SELECT value FROM settings WHERE key = 'rate_limit_max'").get()).toEqual({ value: "100" });

    for (const body of [{ max: 0, windowMs: 5000 }, { max: -1, windowMs: 5000 }, { max: 1.5, windowMs: 5000 }, { max: 100 }, { windowMs: 5000 }]) {
      const bad = await handler(json("PUT", "/api/settings/rate-limit", body));
      expect(bad.status).toBe(422);
      expect((await bad.json()).error.code).toBe("INVALID_RATE_LIMIT");
    }
  });
});
