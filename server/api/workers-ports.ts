// Workers ports — the async, D1-backed counterparts of the Bun host's
// raw-sync `Database` users (B2 report concern #1). Everything here runs
// over a `DbDriver`, so it works unchanged on Bun (DbBunLive) and Workers
// (DbD1Live). The sync originals stay the Bun hot paths; these ports are
// additive and behavior-identical by construction (same SQL, same mapping,
// same precedence).
//
// Import-safety: this module (and everything it imports) must stay free of
// `bun:sqlite`, `node:fs`, and `better-auth` VALUE imports — workers-entry.ts
// bundles it for workerd, where none of those exist. `server/db/settings.ts`
// and `server/db/migrate.ts` are lane-frozen, so the settings SQL is
// mirrored here verbatim (cited) instead of imported.

import { Effect } from "effect";
import type { D1Database } from "@cloudflare/workers-types";
import { mapDbError, queryFirst, run, type BatchStmt, type DbDriver, type SqlParam } from "../db/db";
import { ConstraintViolation, DbError, RowNotFound } from "../db/driver";
import type { D1BatchItem, D1BatchItemResult, D1Like, D1PreparedLike } from "../db/drivers/d1";
import type { RuntimeEnv } from "../env";

// ─── D1 binding → D1Like adapter (B1 concern #3) ──────────────────────────
// The real D1 binding differs from the `D1Like` test shape in two ways:
// `batch()` takes prepared statements (not { sql, params }) and returns a
// positional `D1Result[]`. Critically, it THROWS on constraint violation
// instead of returning success=false; the throw is translated to a typed
// error (ConstraintViolation incl. the isPositionConflict bit, else DbError)
// so the async `batch()` atomic-rollback detection and the position-conflict
// retry-once (invariant #4) read it correctly. The driver owns the
// duration/success checks and positional mapping.
interface RealD1Prepared {
  bind(...params: unknown[]): RealD1Prepared;
  all<T>(): Promise<{ results: T[] }>;
  first<T>(): Promise<T | null>;
  run(): Promise<{ success: boolean; meta: { changes: number; duration?: number } }>;
}

interface RealD1Database {
  prepare(query: string): RealD1Prepared;
  batch(statements: RealD1Prepared[]): Promise<D1BatchItemResult[]>;
}

function translateThrow(e: unknown): ConstraintViolation | DbError {
  return mapDbError(e);
}

export function d1DatabaseToD1Like(db: D1Database): D1Like {
  const real = db as unknown as RealD1Database;
  const wrapPrepared = (stmt: RealD1Prepared): D1PreparedLike => ({
    bind(...params: unknown[]): D1PreparedLike {
      return wrapPrepared(stmt.bind(...params));
    },
    all<T = Record<string, unknown>>(): Promise<{ results: T[]; success: boolean; meta: unknown }> {
      return stmt.all<T>().then(
        (r) => ({ results: r.results, success: true, meta: {} }),
        (e: unknown) => { throw translateThrow(e); }
      );
    },
    first<T = Record<string, unknown>>(): Promise<T | null> {
      return stmt.first<T>().then(
        (r) => r,
        (e: unknown) => { throw translateThrow(e); }
      );
    },
    run(): Promise<{ success: boolean; meta: { changes: number; duration?: number; last_row_id?: number } }> {
      return stmt.run().then(
        (r) => ({
          success: r.success,
          meta: r.meta.duration === undefined ? { changes: r.meta.changes } : { changes: r.meta.changes, duration: r.meta.duration },
        }),
        (e: unknown) => { throw translateThrow(e); }
      );
    },
  });
  return {
    prepare(query: string): D1PreparedLike {
      return wrapPrepared(real.prepare(query));
    },
    async batch(statements: D1BatchItem[]): Promise<D1BatchItemResult[]> {
      const prepared = statements.map((s) => real.prepare(s.sql).bind(...(s.params ?? [])));
      try {
        return await real.batch(prepared);
      } catch (e: unknown) {
        throw translateThrow(e);
      }
    },
  };
}

// ─── Async settings (mirrors server/db/settings.ts verbatim) ─────────────
// Module-scope TTL cache. The cache-served read is the admin GET of the
// rate-limit settings; the per-request limiter itself is in-memory and does
// not read settings. A worker process serves a single D1 database, so the
// cache is keyed by setting key alone. Invalidation covers same-process
// writers that go through setSettingAsync/deleteSettingAsync; writes from
// other modules (e.g. server/github/config-store.ts) and from other worker
// isolates are bounded by the 30s TTL only. Tests and tooling that open more
// than one database must call resetSettingsCache() between databases.
const SETTINGS_CACHE_TTL_MS = 30_000;

interface SettingsCacheEntry {
  value: string | null;
  expiresAt: number;
}

const settingsCache = new Map<string, SettingsCacheEntry>();

// Bumped on every invalidation/reset so an in-flight read cannot repopulate
// the cache with a value read before the invalidation.
let settingsCacheGeneration = 0;

export function resetSettingsCache(): void {
  settingsCache.clear();
  settingsCacheGeneration++;
}

/** Drop specific keys after a commit that bypassed the set/delete helpers
 *  (e.g. an atomic `batch()` write). Bumps the generation so an in-flight
 *  read cannot repopulate a stale value. */
export function invalidateSettingsCache(keys: readonly string[]): void {
  for (const key of keys) settingsCache.delete(key);
  settingsCacheGeneration++;
}

const SETTING_UPSERT_SQL =
  "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')";

export const settingUpsertStmt = (key: string, value: string): BatchStmt => ({
  sql: SETTING_UPSERT_SQL,
  params: [key, value],
});

export const settingDeleteStmt = (key: string): BatchStmt => ({
  sql: "DELETE FROM settings WHERE key = ?",
  params: [key],
});

export function getSettingAsync(
  driver: DbDriver,
  key: string
): Effect.Effect<string | null, DbError> {
  const cached = settingsCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return Effect.succeed(cached.value);
  const generation = settingsCacheGeneration;
  return queryFirst<{ value: string }>(driver, "SELECT value FROM settings WHERE key = ?", key).pipe(
    Effect.map((row) => row.value),
    Effect.tap((value) =>
      Effect.sync(() => {
        if (settingsCacheGeneration === generation) {
          settingsCache.set(key, { value, expiresAt: Date.now() + SETTINGS_CACHE_TTL_MS });
        }
      })
    ),
    Effect.catchAll((e) => {
      if (e._tag === "RowNotFound" && settingsCacheGeneration === generation) {
        settingsCache.set(key, { value: null, expiresAt: Date.now() + SETTINGS_CACHE_TTL_MS });
      }
      return Effect.succeed(null);
    })
  );
}

export function setSettingAsync(
  driver: DbDriver,
  key: string,
  value: string
): Effect.Effect<void, ConstraintViolation | DbError> {
  return run(
    driver,
    SETTING_UPSERT_SQL,
    key,
    value
  ).pipe(
    Effect.asVoid,
    Effect.tap(() => Effect.sync(() => invalidateSettingsCache([key])))
  );
}

export function deleteSettingAsync(
  driver: DbDriver,
  key: string
): Effect.Effect<void, ConstraintViolation | DbError> {
  return run(driver, "DELETE FROM settings WHERE key = ?", key).pipe(
    Effect.asVoid,
    Effect.tap(() => Effect.sync(() => invalidateSettingsCache([key])))
  );
}

// ─── String-only env projection (B3 concern #4) ───────────────────────────
// `mirrorSettingsFromEnv` takes Record<string, string|undefined> but
// RuntimeEnv carries D1/R2/KV bindings — project the string keys only.
const STRING_ENV_KEYS = [
  "LXK_RATE_LIMIT_MAX",
  "LXK_RATE_LIMIT_WINDOW_MS",
  "LXK_ASSISTANT_REPO_CAP",
] as const;

export function stringEnvFromRuntimeEnv(env: RuntimeEnv): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const key of STRING_ENV_KEYS) {
    const value = env[key];
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

// ─── Env → settings-DB bootstrap mirror (async) ───────────────────────────
// Same semantics as mirrorSettingsFromEnv in server/db/settings.ts: the DB
// is the single source of truth at runtime; env only provisions first boot.
// Each mapping is written when the DB key is absent/empty AND the env value
// is truthy — existing DB values are NEVER overwritten. GitHub config is
// never mirrored: it is written only by the web app. Returns the mirrored
// keys (for boot logging).
export function mirrorSettingsFromEnvAsync(
  driver: DbDriver,
  env: Record<string, string | undefined>
): Effect.Effect<string[], ConstraintViolation | DbError> {
  return Effect.gen(function* () {
    const mirrored: string[] = [];
    const isAbsent = (key: string): Effect.Effect<boolean, DbError> =>
      getSettingAsync(driver, key).pipe(Effect.map((v) => v === null || v === ""));
    const mirror = (dbKey: string, value: string | undefined): Effect.Effect<void, ConstraintViolation | DbError> => {
      if (!value) return Effect.void;
      return isAbsent(dbKey).pipe(
        Effect.flatMap((absent) => {
          if (!absent) return Effect.void;
          return setSettingAsync(driver, dbKey, value).pipe(
            Effect.tap(() => Effect.sync(() => { mirrored.push(dbKey); }))
          );
        })
      );
    };

    yield* mirror("rate_limit_max", env.LXK_RATE_LIMIT_MAX);
    yield* mirror("rate_limit_window_ms", env.LXK_RATE_LIMIT_WINDOW_MS);
    yield* mirror("assistant_repo_cap", env.LXK_ASSISTANT_REPO_CAP);
    return mirrored;
  });
}

export type { BatchStmt, SqlParam };
