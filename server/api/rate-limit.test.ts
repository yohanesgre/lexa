import { describe, it, expect } from "vitest";
import { Database } from "bun:sqlite";
import { setSetting } from "../db/settings";
import { apiRateLimiter, createRateLimiter, DEFAULT_RATE_LIMIT_MAX, isPrivateIp, isRateLimitExemptPath, resolveRateLimitFromDbValues, syncRateLimitFromDb } from "./rate-limit";

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

  it("setLimits raises max mid-window: a denied key is allowed again", () => {
    const rl = createRateLimiter({ max: 1, windowMs: 1000 });
    expect(rl.check("a", 0)).toBe(true);
    expect(rl.check("a", 0)).toBe(false); // at max
    rl.setLimits({ max: 2, windowMs: 1000 });
    expect(rl.check("a", 0)).toBe(true); // same bucket, live max now 2
    expect(rl.check("a", 0)).toBe(false);
  });

  it("setLimits lowers max mid-window: an allowed key is denied again", () => {
    const rl = createRateLimiter({ max: 5, windowMs: 1000 });
    expect(rl.check("a", 0)).toBe(true);
    expect(rl.check("a", 0)).toBe(true);
    expect(rl.check("a", 0)).toBe(true);
    rl.setLimits({ max: 1, windowMs: 1000 });
    expect(rl.check("a", 0)).toBe(false); // count 3 > new max 1
  });

  it("setLimits keeps buckets; expiry uses the new windowMs", () => {
    const rl = createRateLimiter({ max: 1, windowMs: 1000 });
    rl.check("a", 0);
    rl.setLimits({ max: 1, windowMs: 500 });
    expect(rl.check("a", 400)).toBe(false); // still inside the (now shorter) window
    expect(rl.check("a", 500)).toBe(true); // windowStart + 500 <= 500 → reset
  });
});

describe("resolveRateLimitFromDbValues", () => {
  it("defaults when no settings rows exist", () => {
    expect(resolveRateLimitFromDbValues({ settingsMax: null, settingsWindowMs: null })).toEqual({
      max: 6000,
      windowMs: 600_000,
    });
  });

  it("reads valid settings values", () => {
    expect(resolveRateLimitFromDbValues({ settingsMax: "100", settingsWindowMs: "5000" })).toEqual({
      max: 100,
      windowMs: 5000,
    });
  });

  it("falls back per-key to defaults on invalid/missing settings (env is never consulted)", () => {
    expect(resolveRateLimitFromDbValues({ settingsMax: "abc", settingsWindowMs: "0" })).toEqual({
      max: 6000,
      windowMs: 600_000,
    });
    expect(resolveRateLimitFromDbValues({ settingsMax: "-5", settingsWindowMs: "1.5" })).toEqual({
      max: 6000,
      windowMs: 600_000,
    });
    expect(resolveRateLimitFromDbValues({ settingsMax: "", settingsWindowMs: null })).toEqual({
      max: 6000,
      windowMs: 600_000,
    });
  });
});

describe("syncRateLimitFromDb", () => {
  const freshDb = () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')))");
    return db;
  };

  it("applies DB settings to the shared limiter", () => {
    const db = freshDb();
    setSetting(db, "rate_limit_max", "2");
    setSetting(db, "rate_limit_window_ms", "1000");
    syncRateLimitFromDb(db);
    expect(apiRateLimiter.check("sync-probe", 0)).toBe(true);
    expect(apiRateLimiter.check("sync-probe", 0)).toBe(true);
    expect(apiRateLimiter.check("sync-probe", 0)).toBe(false); // live max is now 2
    db.close();
  });

  it("DB wins even when env vars are set (env is bootstrap-only, ignored at runtime)", () => {
    const savedMax = process.env.LXK_RATE_LIMIT_MAX;
    const savedWindow = process.env.LXK_RATE_LIMIT_WINDOW_MS;
    process.env.LXK_RATE_LIMIT_MAX = "1000";
    process.env.LXK_RATE_LIMIT_WINDOW_MS = "60000";
    try {
      const db = freshDb();
      setSetting(db, "rate_limit_max", "2");
      setSetting(db, "rate_limit_window_ms", "1000");
      syncRateLimitFromDb(db);
      expect(apiRateLimiter.check("sync-probe-env", 0)).toBe(true);
      expect(apiRateLimiter.check("sync-probe-env", 0)).toBe(true);
      expect(apiRateLimiter.check("sync-probe-env", 0)).toBe(false); // DB max 2, not env 1000
      db.close();
    } finally {
      if (savedMax !== undefined) process.env.LXK_RATE_LIMIT_MAX = savedMax; else delete process.env.LXK_RATE_LIMIT_MAX;
      if (savedWindow !== undefined) process.env.LXK_RATE_LIMIT_WINDOW_MS = savedWindow; else delete process.env.LXK_RATE_LIMIT_WINDOW_MS;
    }
  });

  it("env vars are ignored when the DB is empty (defaults apply)", () => {
    const savedMax = process.env.LXK_RATE_LIMIT_MAX;
    const savedWindow = process.env.LXK_RATE_LIMIT_WINDOW_MS;
    process.env.LXK_RATE_LIMIT_MAX = "1000";
    process.env.LXK_RATE_LIMIT_WINDOW_MS = "60000";
    try {
      const db = freshDb();
      syncRateLimitFromDb(db); // no rows → defaults (6000), env ignored
      for (let i = 0; i < DEFAULT_RATE_LIMIT_MAX; i++) {
        expect(apiRateLimiter.check("sync-probe-defaults", 0)).toBe(true);
      }
      expect(apiRateLimiter.check("sync-probe-defaults", 0)).toBe(false); // 6001st denied
      db.close();
    } finally {
      if (savedMax !== undefined) process.env.LXK_RATE_LIMIT_MAX = savedMax; else delete process.env.LXK_RATE_LIMIT_MAX;
      if (savedWindow !== undefined) process.env.LXK_RATE_LIMIT_WINDOW_MS = savedWindow; else delete process.env.LXK_RATE_LIMIT_WINDOW_MS;
    }
  });

  it("missing settings rows are a no-op (defaults, no throw)", () => {
    const db = freshDb();
    expect(() => syncRateLimitFromDb(db)).not.toThrow();
    db.close();
  });
});

describe("isRateLimitExemptPath", () => {
  it("exempts token-gated hearth machine surfaces", () => {
    expect(isRateLimitExemptPath("/api/hearth/daemon/tasks/abc/log")).toBe(true);
    expect(isRateLimitExemptPath("/api/hearth/runtimes/register")).toBe(true);
    expect(isRateLimitExemptPath("/api/hearth/machines/heartbeat")).toBe(true);
  });

  it("keeps everything else limited", () => {
    expect(isRateLimitExemptPath("/api/hearth/machines")).toBe(false);
    expect(isRateLimitExemptPath("/api/hearth/tasks/history")).toBe(false);
    expect(isRateLimitExemptPath("/api/projects")).toBe(false);
    expect(isRateLimitExemptPath("/api/setup")).toBe(false);
  });
});

describe("isPrivateIp", () => {
  it("accepts IPv4 loopback and RFC1918 ranges", () => {
    expect(isPrivateIp("127.0.0.1")).toBe(true);
    expect(isPrivateIp("10.0.0.1")).toBe(true);
    expect(isPrivateIp("172.16.0.1")).toBe(true);
    expect(isPrivateIp("172.31.255.255")).toBe(true);
    expect(isPrivateIp("192.168.1.1")).toBe(true);
  });

  it("rejects public IPv4 addresses", () => {
    expect(isPrivateIp("8.8.8.8")).toBe(false);
    expect(isPrivateIp("11.0.0.1")).toBe(false);
    expect(isPrivateIp("172.32.0.1")).toBe(false);
  });

  it("accepts IPv6 loopback and unique-local", () => {
    expect(isPrivateIp("::1")).toBe(true);
    expect(isPrivateIp("fc00::1")).toBe(true);
    expect(isPrivateIp("fd12:3456::1")).toBe(true);
    expect(isPrivateIp("::ffff:10.0.0.1")).toBe(true);
  });

  it("rejects IPv6-mapped public IPv4 and garbage input", () => {
    expect(isPrivateIp("::ffff:8.8.8.8")).toBe(false);
    expect(isPrivateIp("::ffff:11.0.0.1")).toBe(false);
    expect(isPrivateIp("")).toBe(false);
    expect(isPrivateIp("not-an-ip")).toBe(false);
    expect(isPrivateIp("999.1.1.1")).toBe(false);
    expect(isPrivateIp("::ffff:999.1.1.1")).toBe(false);
  });
});
