import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { Effect } from "effect";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { createBunSqliteDriver } from "../db/drivers/bun-sqlite";
import { createD1Driver } from "../db/drivers/d1";
import { batch, batchResults, queryFirst, run, type DbDriver } from "../db/db";
import { BatchTimeout, ConstraintViolation } from "../db/driver";
import { createWorkersApiHandler } from "./assistant-api";
import type { StorageConfigShape } from "../storage/config";
import type { ApiAuthHooksShape } from "./auth-hooks";
import { resolveApiKeyIdentityAsync } from "./auth-key";
import {
  apiRateLimiter,
  DEFAULT_RATE_LIMIT_MAX,
  DEFAULT_RATE_LIMIT_WINDOW_MS,
} from "./rate-limit";
import {
  d1DatabaseToD1Like,
  deleteSettingAsync,
  getSettingAsync,
  resetSettingsCache,
  setSettingAsync,
} from "./workers-ports";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));
const RAW_KEY = "lxk_" + "w".repeat(43);
const KEY_HASH = createHash("sha256").update(RAW_KEY).digest("hex");

let dirs: string[] = [];
let dbs: Database[] = [];

function tmpDriver(): DbDriver {
  const dir = mkdtempSync(join(tmpdir(), "lexa-workers-ports-"));
  dirs.push(dir);
  const path = join(dir, "test.db");
  runMigrations(path, MIGRATIONS);
  const db = new Database(path);
  db.exec("PRAGMA foreign_keys = ON");
  dbs.push(db);
  return createBunSqliteDriver(db);
}

afterEach(() => {
  for (const db of dbs) {
    try { db.close(); } catch {}
  }
  dbs = [];
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
  apiRateLimiter.setLimits({ max: DEFAULT_RATE_LIMIT_MAX, windowMs: DEFAULT_RATE_LIMIT_WINDOW_MS });
});

beforeEach(() => {
  resetSettingsCache();
});

const runEff = <A, E>(eff: Effect.Effect<A, E>) => Effect.runPromise(eff);

function runStmt(driver: DbDriver, sql: string, ...params: (string | number | null)[]) {
  return run(driver, sql, ...(params as never[]));
}

describe("resolveApiKeyIdentityAsync", () => {
  it("resolves unowned/member-owned keys and returns null for unknown, malformed, and dangling keys", async () => {
    const driver = tmpDriver();
    await runEff(runStmt(driver, "INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k1', 'cli', ?, NULL)", KEY_HASH));
    expect(await runEff(resolveApiKeyIdentityAsync(driver, `Bearer ${RAW_KEY}`))).toMatchObject({ keyId: "k1", keyName: "cli", userId: null, role: "admin" });

    const driver2 = tmpDriver();
    await runEff(runStmt(driver2, "INSERT INTO users (id, email, name, role) VALUES ('u1', 'm@lexa.test', 'M', 'member')"));
    await runEff(runStmt(driver2, "INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k1', 'cli', ?, 'u1')", KEY_HASH));
    expect(await runEff(resolveApiKeyIdentityAsync(driver2, `Bearer ${RAW_KEY}`))).toMatchObject({ userId: "u1", userName: "M", role: "member" });

    const driver3 = tmpDriver();
    expect(await runEff(resolveApiKeyIdentityAsync(driver3, `Bearer lxk_${"z".repeat(43)}`))).toBeNull();
    expect(await runEff(resolveApiKeyIdentityAsync(driver3, "Basic abc"))).toBeNull();
    await runEff(run(driver3, "PRAGMA foreign_keys = OFF"));
    await runEff(runStmt(driver3, "INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k9', 'cli', ?, 'ghost')", KEY_HASH));
    expect(await runEff(resolveApiKeyIdentityAsync(driver3, `Bearer ${RAW_KEY}`))).toBeNull();
  });
});

describe("async settings", () => {
  it("get/set/delete round-trips, serves cached reads until invalidated, re-queries after the 30s TTL, and never caches a non-RowNotFound DbError", async () => {
    const driver = tmpDriver();
    expect(await runEff(getSettingAsync(driver, "k"))).toBeNull();
    await runEff(setSettingAsync(driver, "k", "v1"));
    expect(await runEff(getSettingAsync(driver, "k"))).toBe("v1");
    await runEff(setSettingAsync(driver, "k", "v2"));
    expect(await runEff(getSettingAsync(driver, "k"))).toBe("v2");
    await runEff(deleteSettingAsync(driver, "k"));
    expect(await runEff(getSettingAsync(driver, "k"))).toBeNull();

    const cached = tmpDriver();
    await runEff(setSettingAsync(cached, "k", "v1"));
    expect(await runEff(getSettingAsync(cached, "k"))).toBe("v1");
    await runEff(run(cached, "UPDATE settings SET value = 'raw' WHERE key = 'k'"));
    expect(await runEff(getSettingAsync(cached, "k"))).toBe("v1"); // cache
    resetSettingsCache();
    expect(await runEff(getSettingAsync(cached, "k"))).toBe("raw");

    const ttl = tmpDriver();
    await runEff(setSettingAsync(ttl, "k", "v1"));
    expect(await runEff(getSettingAsync(ttl, "k"))).toBe("v1");
    vi.useFakeTimers();
    try {
      await runEff(run(ttl, "UPDATE settings SET value = 'v2' WHERE key = 'k'"));
      expect(await runEff(getSettingAsync(ttl, "k"))).toBe("v1");
      vi.advanceTimersByTime(30_000);
      expect(await runEff(getSettingAsync(ttl, "k"))).toBe("v2");
    } finally {
      vi.useRealTimers();
    }

    let firstCalls = 0;
    resetSettingsCache();
    const failing = {
      prepare: () => ({
        all: () => Promise.resolve([]),
        first: () => {
          firstCalls++;
          return Promise.reject(new Error("disk torn"));
        },
        run: () => Promise.resolve({ changes: 0 }),
      }),
      batch: () => Promise.resolve(),
      transaction: () => Promise.reject(new Error("no interactive tx")),
      close: () => {},
    } as unknown as DbDriver;
    expect(await runEff(getSettingAsync(failing, "k"))).toBeNull();
    expect(await runEff(getSettingAsync(failing, "k"))).toBeNull();
    expect(firstCalls).toBe(2);
  });
});

describe("d1DatabaseToD1Like", () => {
  it("shapes batch items (positional + RETURNING + first()), and translates batch/single throws into ConstraintViolation (isPositionConflict for the position case) and raises BatchTimeout past the budget", async () => {
    const preparedSql: string[] = [];
    const preparedParams: unknown[][] = [];
    const binding = {
      prepare: (sql: string) => {
        preparedSql.push(sql);
        const stmt = {
          bind(...p: unknown[]) { preparedParams.push(p); return stmt; },
          all: () => Promise.resolve({ results: [] }),
          first: () => Promise.resolve({ value: "v" }),
          run: () => Promise.resolve({ success: true, meta: { changes: 1 } }),
        };
        return stmt;
      },
      batch: () => Promise.resolve([
        { success: true, meta: { changes: 1, duration: 2, last_row_id: 7 }, results: [{ id: "a" }] },
        { success: true, meta: { changes: 0, duration: 3 }, results: [] },
      ]),
    };
    const driver = createD1Driver(d1DatabaseToD1Like(binding as never));
    const out = await Effect.runPromise(batchResults(driver, [
      { sql: "INSERT INTO t (a) VALUES (?) RETURNING id", params: ["x"] },
      { sql: "DELETE FROM t WHERE a = ?", params: ["y"] },
    ]));
    expect(preparedSql).toEqual(["INSERT INTO t (a) VALUES (?) RETURNING id", "DELETE FROM t WHERE a = ?"]);
    expect(preparedParams).toEqual([["x"], ["y"]]);
    expect(out).toEqual([
      { results: [{ id: "a" }], changes: 1, lastInsertRowid: 7 },
      { results: [], changes: 0, lastInsertRowid: undefined },
    ]);

    const returning = {
      prepare: () => {
        const stmt = {
          bind: () => stmt,
          all: () => Promise.resolve({ results: [] }),
          first: () => Promise.resolve(null),
          run: () => Promise.resolve({ success: true, meta: { changes: 1 } }),
        };
        return stmt;
      },
      batch: () => Promise.resolve([{ success: true, meta: { changes: 1, duration: 1 }, results: [{ id: "r1", v: 9 }] }]),
    };
    const driver2 = createD1Driver(d1DatabaseToD1Like(returning as never));
    const [row2] = await driver2.batch([{ sql: "INSERT INTO t (id, v) VALUES (?, ?) RETURNING id, v", params: ["r1", 9] }]);
    expect(row2!.results).toEqual([{ id: "r1", v: 9 }]);

    const first = {
      prepare: () => {
        const stmt = {
          bind: (...p: unknown[]) => { expect(p).toEqual(["k"]); return stmt; },
          all: () => Promise.resolve({ results: [] }),
          first: () => Promise.resolve({ value: "v" }),
          run: () => Promise.resolve({ success: true, meta: { changes: 1 } }),
        };
        return stmt;
      },
      batch: () => Promise.resolve([]),
    };
    const driver3 = createD1Driver(d1DatabaseToD1Like(first as never));
    const row = await Effect.runPromise(queryFirst<{ value: string }>(driver3, "SELECT value FROM settings WHERE key = ?", "k"));
    expect(row.value).toBe("v");

    const okStmt = {
      bind: () => okStmt,
      all: () => Promise.resolve({ results: [] }),
      first: () => Promise.resolve(null),
      run: () => Promise.resolve({ success: true, meta: { changes: 1 } }),
    };
    const batchThrow = createD1Driver(d1DatabaseToD1Like({
      prepare: () => okStmt,
      batch: () => Promise.reject(new Error("D1_ERROR: UNIQUE constraint failed: tasks.column_id, tasks.position")),
    } as never));
    const err = await Effect.runPromise(Effect.flip(batch(batchThrow, [{ sql: "INSERT INTO t (a) VALUES (1)", params: [] }])));
    expect(err).toBeInstanceOf(ConstraintViolation);
    expect((err as ConstraintViolation).isPositionConflict).toBe(true);

    const singleThrow = createD1Driver(d1DatabaseToD1Like({
      prepare: () => {
        const stmt = {
          bind: () => stmt,
          all: () => Promise.resolve({ results: [] }),
          first: () => Promise.resolve(null),
          run: () => Promise.reject(new Error("UNIQUE constraint failed: api_keys.key_hash")),
        };
        return stmt;
      },
      batch: () => Promise.resolve([]),
    } as never));
    const err2 = await Effect.runPromise(Effect.flip(run(singleThrow, "INSERT INTO t (a) VALUES (1)")));
    expect(err2).toBeInstanceOf(ConstraintViolation);
    expect((err2 as ConstraintViolation).isPositionConflict).toBe(false);

    const slow = createD1Driver(d1DatabaseToD1Like({
      prepare: () => okStmt,
      batch: () => Promise.resolve([{ success: true, meta: { duration: 29_000 }, results: [] }]),
    } as never));
    await expect(slow.batch([{ sql: "SELECT 1", params: [] }])).rejects.toBeInstanceOf(BatchTimeout);
  });
});

// --- carried: Workers /api/sessions via injected auth hooks ---------------
// (absorbed from sessions-workers.test.ts)
//
// Regression: the Workers factory must serve /api/sessions through the
// injected per-request auth hooks, never the Bun-host better-auth singleton
// (whose bun:sqlite constructor throws on workerd → 500).

const SESSION_A = {
  id: "s-a",
  token: "tok-a",
  ipAddress: "10.0.0.1",
  userAgent: null,
  expiresAt: "2026-01-02T00:00:00.000Z",
  createdAt: "2026-01-02T00:00:00.000Z",
};

const SESSION_B = {
  id: "s-b",
  token: "tok-b",
  ipAddress: null,
  userAgent: "curl/8",
  expiresAt: "2026-01-01T00:00:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
};

function buildWorkersHandler() {
  const db = new Database(":memory:");
  // The middleware re-reads `users.role` per session request; seed the minimal
  // row so the injected session identity resolves (a missing row → 401).
  db.exec("CREATE TABLE users (id TEXT PRIMARY KEY, role TEXT NOT NULL DEFAULT 'member')");
  db.prepare("INSERT INTO users (id, role) VALUES ('u1', 'member')").run();
  const fsRoot = mkdtempSync(join(tmpdir(), "lexa-sessions-workers-"));
  const storage: StorageConfigShape = { driver: "fs", fsRoot, s3: null, r2: null, maxUploadBytes: 25 * 1024 * 1024 };
  const listSessions = vi.fn(async (_headers: Headers) => [SESSION_A, SESSION_B]);
  const revokeSession = vi.fn(async (_input: { token: string; headers: Headers }) => ({ ok: true }));
  const authHooks: ApiAuthHooksShape = {
    createUser: async () => { throw new Error("unused"); },
    listSessions,
    revokeSession,
  };
  const handler = createWorkersApiHandler({
    driver: createBunSqliteDriver(db),
    runtimeEnv: { LXK_ENV: "dev" },
    storage,
    authHooks,
    getSession: async () => ({ user: { id: "u1", name: "Test", role: "member" } }),
  });
  return { handler, listSessions, revokeSession, fsRoot, db };
}

const callWorkers = (handler: (req: Request) => Promise<Response>, method: string, path: string) =>
  handler(new Request(`http://lexa.test${path}`, { method, headers: { cookie: "better-auth.session_token=fake" } }));

describe("workers sessions via auth hooks", () => {
  it("lists through the injected hooks sorted desc, resolves a revoke id → token, and 404s an unknown id", async () => {
    const { handler, listSessions, revokeSession, fsRoot, db } = buildWorkersHandler();
    try {
      const res = await callWorkers(handler, "GET", "/api/sessions");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        data: [
          { id: "s-a", ipAddress: "10.0.0.1", userAgent: null, expiresAt: "2026-01-02T00:00:00.000Z", createdAt: "2026-01-02T00:00:00.000Z" },
          { id: "s-b", ipAddress: null, userAgent: "curl/8", expiresAt: "2026-01-01T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z" },
        ],
      });
      expect(listSessions).toHaveBeenCalledTimes(1);

      const revoke = await callWorkers(handler, "POST", `/api/sessions/${SESSION_B.id}/revoke`);
      expect(revoke.status).toBe(204);
      expect(revokeSession).toHaveBeenCalledTimes(1);
      expect(revokeSession.mock.calls[0]![0]).toMatchObject({ token: SESSION_B.token });

      const unknown = await callWorkers(handler, "POST", "/api/sessions/nope/revoke");
      expect(unknown.status).toBe(404);
      expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe("SESSION_NOT_FOUND");
    } finally {
      rmSync(fsRoot, { recursive: true, force: true });
      db.close();
    }
  });
});
