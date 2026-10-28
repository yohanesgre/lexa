import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { Database } from "bun:sqlite";
import type { SendEmail } from "@cloudflare/workers-types";
import { runMigrations } from "./db/migrate";
import { createBunSqliteDriver } from "./db/drivers/bun-sqlite";
import type { DbDriver } from "./db/db";
import { admitRecoveryRequest, RECOVERY_ACK_MESSAGE, handlePasswordRecoveryRequest } from "./auth-recovery";
import type { RuntimeEnv } from "./env";

const MIGRATIONS = fileURLToPath(new URL("../migrations", import.meta.url));

let dir: string;
let dbPath: string;
let sqlite: Database;
let driver: DbDriver;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "lexa-recovery-"));
  dbPath = join(dir, "test.db");
  runMigrations(dbPath, MIGRATIONS);
  sqlite = new Database(dbPath);
  driver = createBunSqliteDriver(sqlite);
});

afterAll(() => {
  try {
    sqlite.close();
  } catch {}
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  sqlite.exec("DELETE FROM recovery_requests");
  sqlite.exec("DELETE FROM verification");
  sqlite.exec("DELETE FROM users");
});

// Wrapper tests never submit mail (the native issuer is a seam); the binding
// only has to be present for the configured capability.
const emailBinding = { send: async () => ({ messageId: "test-message" }) } as unknown as SendEmail;

function recoveryEnv(overrides: Partial<RuntimeEnv> = {}): RuntimeEnv {
  return {
    LXK_ENV: "dev",
    LXK_PUBLIC_URL: "http://localhost:5173",
    LXK_EMAIL_FROM: "noreply@example.test",
    EMAIL: emailBinding,
    ...overrides,
  };
}

function insertUser(id: string, email: string, banned = 0): void {
  sqlite.prepare("INSERT INTO users (id, email, name, role, banned) VALUES (?, ?, ?, 'member', ?)").run(id, email, id, banned);
}

function admit(addressHash: string, ipHash: string, now: number) {
  return Effect.runPromise(
    admitRecoveryRequest(driver, { addressHash, ipHash, now, id: crypto.randomUUID() })
  );
}

describe("recovery admission (atomic rolling windows)", () => {
  it("enforces 1/address/60s, 5/address/hour, and 10/IP/10min in one admitted-only ledger", async () => {
    const t = 1_700_000_000;
    expect((await admit("addr-hour", "ip-1", t)).admitted).toBe(true);

    const minuteBlocked = await admit("addr-hour", "ip-2", t + 59);
    expect(minuteBlocked.admitted).toBe(false);
    expect(minuteBlocked.retryAfterSec).toBe(1);

    expect((await admit("addr-hour", "ip-3", t + 60)).admitted).toBe(true);
    expect((await admit("addr-hour", "ip-4", t + 120)).admitted).toBe(true);
    expect((await admit("addr-hour", "ip-5", t + 180)).admitted).toBe(true);
    expect((await admit("addr-hour", "ip-6", t + 240)).admitted).toBe(true);

    // Five accepted rows inside the rolling hour: the sixth is denied until
    // the oldest one leaves the window, and the rejected attempt adds no row.
    const hourBlocked = await admit("addr-hour", "ip-7", t + 300);
    expect(hourBlocked.admitted).toBe(false);
    expect(hourBlocked.retryAfterSec).toBe(3300);
    const count = sqlite.prepare("SELECT COUNT(*) AS n FROM recovery_requests WHERE address_hash = ?").get("addr-hour") as { n: number };
    expect(count.n).toBe(5);
    expect((await admit("addr-hour", "ip-8", t + 3600)).admitted).toBe(true);

    // Ten accepted requests from one IP in ten minutes; the eleventh waits for
    // the oldest row, then succeeds because rejected attempts were not stored.
    for (let i = 0; i < 10; i++) {
      expect((await admit(`ip-addr-${i}`, "shared-ip", t)).admitted).toBe(true);
    }
    const ipBlocked = await admit("ip-addr-10", "shared-ip", t);
    expect(ipBlocked.admitted).toBe(false);
    expect(ipBlocked.retryAfterSec).toBe(600);
    expect((await admit("ip-addr-11", "shared-ip", t + 600)).admitted).toBe(true);
  });
});

describe("handlePasswordRecoveryRequest", () => {
  function deps(env: RuntimeEnv = recoveryEnv()) {
    const issued: string[] = [];
    const pending: Promise<unknown>[] = [];
    return {
      issued,
      deps: {
        env,
        driver,
        maxBodyBytes: 4096,
        ctx: { waitUntil: (p: Promise<unknown>) => pending.push(p) },
        auth: {
          api: {
            requestPasswordReset: async ({ body }: { body: { email: string } }) => {
              issued.push(body.email);
            },
          },
        },
      },
      flush: () => Promise.all(pending.splice(0)),
    };
  }

  const request = (body: string, headers: Record<string, string> = {}) =>
    new Request("http://lexa.test/api/auth/request-password-reset", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    });

  it("acknowledges uniformly before lookup, issues only for active accounts, and throttles the address", async () => {
    insertUser("u-active", "active@lexa.test");
    insertUser("u-banned", "banned@lexa.test", 1);
    const ctx = deps();

    const active = await handlePasswordRecoveryRequest(request(JSON.stringify({ email: "Active@Lexa.Test" })), ctx.deps);
    expect(active.status).toBe(200);
    expect(await active.json()).toEqual({ status: true, message: RECOVERY_ACK_MESSAGE });
    await ctx.flush();
    expect(ctx.issued).toEqual(["active@lexa.test"]);

    const unknown = await handlePasswordRecoveryRequest(request(JSON.stringify({ email: "nobody@lexa.test" })), ctx.deps);
    expect(unknown.status).toBe(200);
    expect(await unknown.json()).toEqual({ status: true, message: RECOVERY_ACK_MESSAGE });
    await ctx.flush();

    const banned = await handlePasswordRecoveryRequest(request(JSON.stringify({ email: "banned@lexa.test" })), ctx.deps);
    expect(banned.status).toBe(200);
    expect(await banned.json()).toEqual({ status: true, message: RECOVERY_ACK_MESSAGE });
    await ctx.flush();
    expect(ctx.issued).toEqual(["active@lexa.test"]);

    const throttled = await handlePasswordRecoveryRequest(request(JSON.stringify({ email: "active@lexa.test" })), ctx.deps);
    expect(throttled.status).toBe(429);
    expect(Number(throttled.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
  });

  it("rejects malformed bodies, disallowed origins, and unconfigured delivery without admitting", async () => {
    const ctx = deps();
    expect((await handlePasswordRecoveryRequest(request("{"), ctx.deps)).status).toBe(400);
    expect((await handlePasswordRecoveryRequest(request(JSON.stringify({ email: "not-an-email" })), ctx.deps)).status).toBe(400);
    const badOrigin = await handlePasswordRecoveryRequest(
      request(JSON.stringify({ email: "active@lexa.test" }), { origin: "https://evil.test" }),
      ctx.deps
    );
    expect(badOrigin.status).toBe(403);

    const unavailable = deps(recoveryEnv({ EMAIL: undefined }));
    const res = await handlePasswordRecoveryRequest(request(JSON.stringify({ email: "active@lexa.test" })), unavailable.deps);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("RESET_PASSWORD_DISABLED");
    const count = sqlite.prepare("SELECT COUNT(*) AS n FROM recovery_requests").get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("returns a sanitized 500 when admission storage fails, never a throttled response", async () => {
    const ctx = deps();
    sqlite.exec("DROP TABLE recovery_requests");
    try {
      const res = await handlePasswordRecoveryRequest(request(JSON.stringify({ email: "active@lexa.test" })), ctx.deps);
      expect(res.status).toBe(500);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("INTERNAL");
      expect(res.headers.get("Retry-After")).toBeNull();
    } finally {
      sqlite.exec(
        "CREATE TABLE recovery_requests (id TEXT PRIMARY KEY, address_hash TEXT NOT NULL, ip_hash TEXT NOT NULL, requested_at INTEGER NOT NULL)"
      );
      sqlite.exec("CREATE INDEX recovery_requests_address_time_idx ON recovery_requests(address_hash, requested_at)");
      sqlite.exec("CREATE INDEX recovery_requests_ip_time_idx ON recovery_requests(ip_hash, requested_at)");
      sqlite.exec("CREATE INDEX recovery_requests_time_idx ON recovery_requests(requested_at)");
    }
  });
});
