import { describe, it, expect } from "vitest";
import { Database } from "bun:sqlite";
import { setSetting } from "../db/settings";
import { apiRateLimiter, createRateLimiter, DEFAULT_RATE_LIMIT_MAX, isRateLimitExemptPath, isTrustedProxyPeer, resolveClientIp, resolveRateLimitFromDbValues, syncRateLimitFromDb } from "./rate-limit";

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
  it("exempts token-gated runtime machine surfaces", () => {
    expect(isRateLimitExemptPath("/api/runtimes/daemon/tasks/abc/log")).toBe(true);
    expect(isRateLimitExemptPath("/api/runtimes/register")).toBe(true);
    expect(isRateLimitExemptPath("/api/runtimes/machines/heartbeat")).toBe(true);
  });

  it("keeps everything else limited", () => {
    expect(isRateLimitExemptPath("/api/runtimes/machines")).toBe(false);
    expect(isRateLimitExemptPath("/api/runtimes/tasks/history")).toBe(false);
    expect(isRateLimitExemptPath("/api/projects")).toBe(false);
    expect(isRateLimitExemptPath("/api/setup")).toBe(false);
  });
});

describe("isTrustedProxyPeer", () => {
  it("trusts loopback peers (v4, v6, mapped)", () => {
    expect(isTrustedProxyPeer("127.0.0.1")).toBe(true);
    expect(isTrustedProxyPeer("::1")).toBe(true);
    expect(isTrustedProxyPeer("::ffff:127.0.0.1")).toBe(true);
  });

  it("parses embedded IPv4 after '::' (::1.2.3.4 and 2001:db8::1.2.3.4)", () => {
    expect(isTrustedProxyPeer("::1.2.3.4", ["::1.2.3.4"])).toBe(true);
    expect(isTrustedProxyPeer("2001:db8::1.2.3.4", ["2001:db8::1.2.3.4"])).toBe(true);
    expect(isTrustedProxyPeer("2001:db8::1.2.3.4", ["2001:db8::/32"])).toBe(true);
  });

  it("matches a v4-mapped peer against a v4 CIDR", () => {
    expect(isTrustedProxyPeer("::ffff:10.0.0.5", ["10.0.0.0/8"])).toBe(true);
    expect(isTrustedProxyPeer("::ffff:192.168.1.9", ["10.0.0.0/8"])).toBe(false);
  });

  it("ignores non-loopback private peers unless a CIDR matches them", () => {
    expect(isTrustedProxyPeer("10.0.0.5")).toBe(false);
    expect(isTrustedProxyPeer("192.168.1.9")).toBe(false);
    expect(isTrustedProxyPeer("10.0.0.5", ["10.0.0.0/8"])).toBe(true);
    expect(isTrustedProxyPeer("192.168.1.9", ["10.0.0.0/8"])).toBe(false);
    expect(isTrustedProxyPeer("10.0.0.5", ["10.0.0.5"])).toBe(true);
    expect(isTrustedProxyPeer("10.0.0.6", ["10.0.0.5"])).toBe(false);
  });

  it("matches IPv6 CIDRs (bare and prefixed)", () => {
    expect(isTrustedProxyPeer("fd00:1234::5", ["fd00:1234::/32"])).toBe(true);
    expect(isTrustedProxyPeer("fd00:1234::5", ["fd00:1234::"])).toBe(false);
    expect(isTrustedProxyPeer("fd00:1234::5", ["fd00:1234::5"])).toBe(true);
  });

  it("ignores malformed CIDR entries and garbage peers", () => {
    expect(isTrustedProxyPeer("10.0.0.5", ["not-a-cidr", "10.0.0.0/99", "10.0.0.0/"])).toBe(false);
    expect(isTrustedProxyPeer("not-an-ip", ["0.0.0.0/0"])).toBe(false);
    expect(isTrustedProxyPeer("", [])).toBe(false);
  });
});

describe("resolveClientIp", () => {
  it("honors the forwarding header from a loopback peer", () => {
    expect(resolveClientIp("127.0.0.1", "203.0.113.7", [])).toBe("203.0.113.7");
    expect(resolveClientIp("::1", "203.0.113.7", [])).toBe("203.0.113.7");
    expect(resolveClientIp("::ffff:127.0.0.1", "203.0.113.7", [])).toBe("203.0.113.7");
  });

  it("ignores the forwarding header from a private non-loopback peer", () => {
    expect(resolveClientIp("10.0.0.5", "203.0.113.7", [])).toBe("10.0.0.5");
    expect(resolveClientIp("192.168.1.9", "203.0.113.7", ["10.0.0.0/8"])).toBe("192.168.1.9");
  });

  it("honors the header when a configured CIDR matches the peer", () => {
    expect(resolveClientIp("10.0.0.5", "203.0.113.7", ["10.0.0.0/8"])).toBe("203.0.113.7");
    expect(resolveClientIp("172.18.0.4", "203.0.113.7", ["172.16.0.0/12"])).toBe("203.0.113.7");
  });

  it("handles malformed config safely (peer wins, no throw)", () => {
    expect(() => resolveClientIp("10.0.0.5", "203.0.113.7", ["garbage"])).not.toThrow();
    expect(resolveClientIp("10.0.0.5", "203.0.113.7", ["garbage"])).toBe("10.0.0.5");
  });

  it("falls back when either side is absent", () => {
    expect(resolveClientIp("10.0.0.5", "", [])).toBe("10.0.0.5");
    expect(resolveClientIp("10.0.0.5", null, [])).toBe("10.0.0.5");
    expect(resolveClientIp("", "203.0.113.7", [])).toBe("203.0.113.7");
    expect(resolveClientIp("", "", [])).toBe("unknown");
  });
});
