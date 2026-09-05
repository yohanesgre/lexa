import { describe, expect, it, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { Effect } from "effect";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { createBunSqliteDriver } from "../db/drivers/bun-sqlite";
import { createD1Driver, type D1Like } from "../db/drivers/d1";
import { batch, queryFirst, run, type DbDriver } from "../db/db";
import { BatchTimeout, ConstraintViolation } from "../db/driver";
import { resolveApiKeyIdentityAsync } from "./auth-key";
import {
  apiRateLimiter,
  DEFAULT_RATE_LIMIT_MAX,
  DEFAULT_RATE_LIMIT_WINDOW_MS,
  syncRateLimitFromDbAsync,
} from "./rate-limit";
import {
  d1DatabaseToD1Like,
  deleteSettingAsync,
  getSettingAsync,
  mirrorSettingsFromEnvAsync,
  setSettingAsync,
  stringEnvFromRuntimeEnv,
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

const runEff = <A, E>(eff: Effect.Effect<A, E>) => Effect.runPromise(eff);

function runStmt(driver: DbDriver, sql: string, ...params: (string | number | null)[]) {
  return run(driver, sql, ...(params as never[]));
}

describe("resolveApiKeyIdentityAsync", () => {
  it("resolves an unowned key as admin", async () => {
    const driver = tmpDriver();
    await runEff(runStmt(driver, "INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k1', 'cli', ?, NULL)", KEY_HASH));
    const res = await runEff(resolveApiKeyIdentityAsync(driver, `Bearer ${RAW_KEY}`));
    expect(res).toMatchObject({ keyId: "k1", keyName: "cli", userId: null, role: "admin" });
  });

  it("maps a member-owned key to the member role", async () => {
    const driver = tmpDriver();
    await runEff(runStmt(driver, "INSERT INTO users (id, email, name, role) VALUES ('u1', 'm@lexa.test', 'M', 'member')"));
    await runEff(runStmt(driver, "INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k1', 'cli', ?, 'u1')", KEY_HASH));
    const res = await runEff(resolveApiKeyIdentityAsync(driver, `Bearer ${RAW_KEY}`));
    expect(res).toMatchObject({ userId: "u1", userName: "M", role: "member" });
  });

  it("returns null for unknown, malformed, and dangling keys", async () => {
    const driver = tmpDriver();
    expect(await runEff(resolveApiKeyIdentityAsync(driver, `Bearer lxk_${"z".repeat(43)}`))).toBeNull();
    expect(await runEff(resolveApiKeyIdentityAsync(driver, "Basic abc"))).toBeNull();
    expect(await runEff(resolveApiKeyIdentityAsync(driver, "Bearer short"))).toBeNull();
    await runEff(run(driver, "PRAGMA foreign_keys = OFF"));
    await runEff(runStmt(driver, "INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k9', 'cli', ?, 'ghost')", KEY_HASH));
    expect(await runEff(resolveApiKeyIdentityAsync(driver, `Bearer ${RAW_KEY}`))).toBeNull();
  });
});

describe("syncRateLimitFromDbAsync", () => {
  it("applies DB-configured limits to the shared singleton", async () => {
    const driver = tmpDriver();
    await runEff(setSettingAsync(driver, "rate_limit_max", "2"));
    await runEff(setSettingAsync(driver, "rate_limit_window_ms", "1000"));
    await runEff(syncRateLimitFromDbAsync(driver));
    expect(apiRateLimiter.check("w4", 0)).toBe(true);
    expect(apiRateLimiter.check("w4", 0)).toBe(true);
    expect(apiRateLimiter.check("w4", 0)).toBe(false);
  });

  it("falls back to defaults when rows are missing", async () => {
    const driver = tmpDriver();
    apiRateLimiter.setLimits({ max: 1, windowMs: 1000 });
    await runEff(syncRateLimitFromDbAsync(driver));
    expect(apiRateLimiter.check("w4b", 0)).toBe(true);
    expect(apiRateLimiter.check("w4b", 1)).toBe(true);
  });
});

describe("async settings", () => {
  it("get/set/delete round-trip with upsert overwrite", async () => {
    const driver = tmpDriver();
    expect(await runEff(getSettingAsync(driver, "k"))).toBeNull();
    await runEff(setSettingAsync(driver, "k", "v1"));
    expect(await runEff(getSettingAsync(driver, "k"))).toBe("v1");
    await runEff(setSettingAsync(driver, "k", "v2"));
    expect(await runEff(getSettingAsync(driver, "k"))).toBe("v2");
    await runEff(deleteSettingAsync(driver, "k"));
    expect(await runEff(getSettingAsync(driver, "k"))).toBeNull();
  });
});

describe("mirrorSettingsFromEnvAsync", () => {
  it("mirrors absent keys and reports them", async () => {
    const driver = tmpDriver();
    const mirrored = await runEff(
      mirrorSettingsFromEnvAsync(driver, { GITHUB_APP_ID: "123", LXK_RATE_LIMIT_MAX: "77" })
    );
    expect(mirrored.sort()).toEqual(["github_app_id", "rate_limit_max"]);
    expect(await runEff(getSettingAsync(driver, "github_app_id"))).toBe("123");
  });

  it("never overwrites existing DB values", async () => {
    const driver = tmpDriver();
    await runEff(setSettingAsync(driver, "github_app_id", "db-wins"));
    const mirrored = await runEff(mirrorSettingsFromEnvAsync(driver, { GITHUB_APP_ID: "env-loses" }));
    expect(mirrored).toEqual([]);
    expect(await runEff(getSettingAsync(driver, "github_app_id"))).toBe("db-wins");
  });

  it("inline private key wins; FILE branch warns and skips without a reader", async () => {
    const driver = tmpDriver();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const mirrored = await runEff(
        mirrorSettingsFromEnvAsync(driver, { GITHUB_PRIVATE_KEY_FILE: "/nope.pem" })
      );
      expect(mirrored).toEqual([]);
      expect(warn).toHaveBeenCalledOnce();
      await runEff(mirrorSettingsFromEnvAsync(driver, { GITHUB_PRIVATE_KEY: "inline", GITHUB_PRIVATE_KEY_FILE: "/nope.pem" }));
      expect(await runEff(getSettingAsync(driver, "github_private_key"))).toBe("inline");
    } finally {
      warn.mockRestore();
    }
  });

  it("FILE branch mirrors content when a reader is provided", async () => {
    const driver = tmpDriver();
    const mirrored = await runEff(
      mirrorSettingsFromEnvAsync(
        driver,
        { GITHUB_PRIVATE_KEY_FILE: "/app/key.pem" },
        () => "file-pem"
      )
    );
    expect(mirrored).toEqual(["github_private_key"]);
    expect(await runEff(getSettingAsync(driver, "github_private_key"))).toBe("file-pem");
  });
});

describe("stringEnvFromRuntimeEnv", () => {
  it("projects string keys only, dropping bindings and undefined", () => {
    const out = stringEnvFromRuntimeEnv({
      GITHUB_APP_ID: "1",
      LXK_RATE_LIMIT_MAX: undefined,
      DB: { prepare: () => undefined } as never,
      BLOB: undefined,
      LXK_ENV: "production",
    });
    expect(out).toEqual({ GITHUB_APP_ID: "1" });
  });
});

describe("d1DatabaseToD1Like", () => {
  it("shapes batch items into prepared statements and maps results", async () => {
    const preparedSql: string[] = [];
    const preparedParams: unknown[][] = [];
    const binding = {
      prepare: (sql: string) => {
        preparedSql.push(sql);
        const stmt = {
          bind(...p: unknown[]) { preparedParams.push(p); return stmt; },
          all: () => Promise.resolve({ results: [] }),
          first: () => Promise.resolve(null),
          run: () => Promise.resolve({ success: true, meta: { changes: 1 } }),
        };
        return stmt;
      },
      batch: () => Promise.resolve([
        { success: true, meta: { duration: 2 }, results: undefined },
        { success: true, meta: { duration: 3 }, results: undefined },
      ]),
    };
    const like: D1Like = d1DatabaseToD1Like(binding as never);
    const driver = createD1Driver(like);
    await Effect.runPromise(batch(driver, [
      { sql: "INSERT INTO t (a) VALUES (?)", params: ["x"] },
      { sql: "DELETE FROM t WHERE a = ?", params: ["y"] },
    ]));
    expect(preparedSql).toEqual(["INSERT INTO t (a) VALUES (?)", "DELETE FROM t WHERE a = ?"]);
    expect(preparedParams).toEqual([["x"], ["y"]]);
  });

  it("translates a batch throw into ConstraintViolation with isPositionConflict", async () => {
    const binding = {
      prepare: (sql: string) => {
        const stmt = {
          bind: () => stmt,
          all: () => Promise.resolve({ results: [] }),
          first: () => Promise.resolve(null),
          run: () => Promise.resolve({ success: true, meta: { changes: 1 } }),
        };
        return stmt;
      },
      batch: () => Promise.reject(
        new Error("D1_ERROR: UNIQUE constraint failed: tasks.column_id, tasks.position")
      ),
    };
    const driver = createD1Driver(d1DatabaseToD1Like(binding as never));
    const err = await Effect.runPromise(Effect.flip(batch(driver, [{ sql: "INSERT INTO t (a) VALUES (1)", params: [] }])));
    expect(err).toBeInstanceOf(ConstraintViolation);
    expect((err as ConstraintViolation).isPositionConflict).toBe(true);
  });

  it("translates a single-statement throw into ConstraintViolation", async () => {
    const binding = {
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
    };
    const driver = createD1Driver(d1DatabaseToD1Like(binding as never));
    const err = await Effect.runPromise(Effect.flip(run(driver, "INSERT INTO t (a) VALUES (1)")));
    expect(err).toBeInstanceOf(ConstraintViolation);
    expect((err as ConstraintViolation).isPositionConflict).toBe(false);
  });

  it("raises BatchTimeout when summed durations exceed the budget", async () => {
    const binding = {
      prepare: (sql: string) => {
        const stmt = {
          bind: () => stmt,
          all: () => Promise.resolve({ results: [] }),
          first: () => Promise.resolve(null),
          run: () => Promise.resolve({ success: true, meta: { changes: 1 } }),
        };
        return stmt;
      },
      batch: () => Promise.resolve([{ success: true, meta: { duration: 29_000 }, results: undefined }]),
    };
    const like = d1DatabaseToD1Like(binding as never);
    await expect(like.batch([{ sql: "SELECT 1", params: [] }])).rejects.toBeInstanceOf(BatchTimeout);
  });

  it("delegates first() through bind", async () => {
    const binding = {
      prepare: () => {
        const stmt = {
          bind: (...p: unknown[]) => {
            expect(p).toEqual(["k"]);
            return stmt;
          },
          all: () => Promise.resolve({ results: [] }),
          first: () => Promise.resolve({ value: "v" }),
          run: () => Promise.resolve({ success: true, meta: { changes: 1 } }),
        };
        return stmt;
      },
      batch: () => Promise.resolve([]),
    };
    const driver = createD1Driver(d1DatabaseToD1Like(binding as never));
    const row = await Effect.runPromise(queryFirst<{ value: string }>(driver, "SELECT value FROM settings WHERE key = ?", "k"));
    expect(row.value).toBe("v");
  });
});
