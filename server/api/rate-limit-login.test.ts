import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../db/migrate";
import { loginLimiter, authIpLimiter } from "../auth";

// R17: 5 failed login attempts per email per 60s, then a 15-minute lockout.
// Memory storage (single process) — the better-auth rateLimit plugin does not
// exist in 1.6.27 (declared deviation; wired in server/entry.ts around
// POST /api/auth/sign-in/email).
describe("loginLimiter", () => {
  it("allows attempts under the budget and locks after 5 failures", () => {
    const email = "victim@lexa.dev";
    expect(loginLimiter.check(email).ok).toBe(true);
    for (let i = 0; i < 4; i++) loginLimiter.recordFailure(email);
    expect(loginLimiter.check(email).ok).toBe(true);
    loginLimiter.recordFailure(email);
    const verdict = loginLimiter.check(email);
    expect(verdict.ok).toBe(false);
    expect(verdict.retryAfterSec).toBeGreaterThan(14 * 60);
  });

  it("a success clears the budget", () => {
    const email = "recovered@lexa.dev";
    for (let i = 0; i < 5; i++) loginLimiter.recordFailure(email);
    expect(loginLimiter.check(email).ok).toBe(false);
    loginLimiter.recordSuccess(email);
    expect(loginLimiter.check(email).ok).toBe(true);
  });

  it("is per-email and case-insensitive", () => {
    const a = "person@lexa.dev";
    for (let i = 0; i < 5; i++) loginLimiter.recordFailure(a);
    expect(loginLimiter.check("PERSON@lexa.dev").ok).toBe(false);
    expect(loginLimiter.check("other@lexa.dev").ok).toBe(true);
    loginLimiter.recordSuccess(a);
  });
});

// Per-IP throttle for the keyless /api/auth/* surface (guards scrypt-cost
// sign-in spam across many emails from one IP; the per-email budget alone
// cannot).
describe("authIpLimiter", () => {
  it("allows the burst window and throttles beyond 120/min", () => {
    for (let i = 0; i < 120; i++) {
      expect(authIpLimiter("1.2.3.4").ok).toBe(true);
    }
    const verdict = authIpLimiter("1.2.3.4");
    expect(verdict.ok).toBe(false);
    expect(verdict.retryAfterSec).toBeGreaterThan(0);
    // other IPs unaffected
    expect(authIpLimiter("5.6.7.8").ok).toBe(true);
  });

  it("counts unknown ips too", () => {
    for (let i = 0; i < 121; i++) authIpLimiter("unknown");
    expect(authIpLimiter("unknown").ok).toBe(false);
  });
});
