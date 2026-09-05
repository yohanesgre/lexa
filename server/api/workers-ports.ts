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
import { BatchTimeout, ConstraintViolation, DbError } from "../db/driver";
import type { D1BatchItem, D1Like, D1PreparedLike } from "../db/drivers/d1";
import type { RuntimeEnv } from "../env";

// ─── D1 binding → D1Like adapter (B1 concern #3) ──────────────────────────
// The real D1 binding differs from the `D1Like` test shape in two ways:
// `batch()` takes prepared statements (not { sql, params }) and returns
// `D1Result[]` (not { success, duration, results }) — and, critically, it
// THROWS on constraint violation instead of returning success=false. The
// throw is translated to a typed error (ConstraintViolation incl. the
// isPositionConflict bit, else DbError) so the async `batch()` atomic-
// rollback detection and the position-conflict retry-once (invariant #4)
// read it correctly.
interface RealD1Prepared {
  bind(...params: unknown[]): RealD1Prepared;
  all<T>(): Promise<{ results: T[] }>;
  first<T>(): Promise<T | null>;
  run(): Promise<{ success: boolean; meta: { changes: number; duration?: number } }>;
}

interface RealD1Database {
  prepare(query: string): RealD1Prepared;
  batch<T>(statements: RealD1Prepared[]): Promise<Array<{ success: boolean; meta?: { duration?: number } | undefined; results?: T }>>;
}

function translateThrow(e: unknown): ConstraintViolation | DbError | BatchTimeout {
  const mapped = mapDbError(e);
  return mapped;
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
    async batch<T = unknown>(statements: D1BatchItem[]): Promise<{ length: number; duration: number; results: T[]; success: boolean }> {
      const prepared = statements.map((s) => real.prepare(s.sql).bind(...(s.params ?? [])));
      let results: Array<{ success: boolean; meta?: { duration?: number } | undefined; results?: T }>;
      try {
        results = await real.batch<T>(prepared);
      } catch (e: unknown) {
        throw translateThrow(e);
      }
      const duration = results.reduce((sum, r) => sum + (r.meta?.duration ?? 0), 0);
      if (duration > 28_000) {
        throw new BatchTimeout({ message: `D1 batch exceeded 28s budget (${duration}ms)` });
      }
      if (results.some((r) => !r.success)) {
        throw new DbError({ message: "D1 batch returned success=false" });
      }
      return { length: results.length, duration, results: results.map((r) => r.results as T), success: true };
    },
  };
}

// ─── Async settings (mirrors server/db/settings.ts verbatim) ─────────────

export function getSettingAsync(
  driver: DbDriver,
  key: string
): Effect.Effect<string | null, DbError> {
  return queryFirst<{ value: string }>(driver, "SELECT value FROM settings WHERE key = ?", key).pipe(
    Effect.map((row) => row.value),
    Effect.catchAll(() => Effect.succeed(null))
  );
}

export function setSettingAsync(
  driver: DbDriver,
  key: string,
  value: string
): Effect.Effect<void, ConstraintViolation | DbError> {
  return run(
    driver,
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')",
    key,
    value
  ).pipe(Effect.asVoid);
}

export function deleteSettingAsync(
  driver: DbDriver,
  key: string
): Effect.Effect<void, ConstraintViolation | DbError> {
  return run(driver, "DELETE FROM settings WHERE key = ?", key).pipe(Effect.asVoid);
}

// ─── String-only env projection (B3 concern #4) ───────────────────────────
// `mirrorSettingsFromEnv` takes Record<string, string|undefined> but
// RuntimeEnv carries D1/R2/KV bindings — project the string keys only.
const STRING_ENV_KEYS = [
  "GITHUB_APP_ID",
  "GITHUB_PRIVATE_KEY",
  "GITHUB_PRIVATE_KEY_FILE",
  "GITHUB_WEBHOOK_SECRET",
  "LXK_RATE_LIMIT_MAX",
  "LXK_RATE_LIMIT_WINDOW_MS",
  "LXK_HEARTH_REPO_CAP",
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
// is truthy — existing DB values are NEVER overwritten. Inline
// GITHUB_PRIVATE_KEY wins over the file when both are set.
//
// Workers difference (platform, not behavior): GITHUB_PRIVATE_KEY_FILE is
// impossible on Workers (no filesystem), so the file branch only runs when
// the caller passes a readFile — workers-entry.ts omits it and logs a warn
// when the var is set. Returns the mirrored keys (for boot logging).
export function mirrorSettingsFromEnvAsync(
  driver: DbDriver,
  env: Record<string, string | undefined>,
  readFile?: (path: string) => string
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

    yield* mirror("github_app_id", env.GITHUB_APP_ID);
    yield* mirror("github_webhook_secret", env.GITHUB_WEBHOOK_SECRET);
    if (env.GITHUB_PRIVATE_KEY) {
      yield* mirror("github_private_key", env.GITHUB_PRIVATE_KEY);
    } else if (env.GITHUB_PRIVATE_KEY_FILE) {
      if (yield* isAbsent("github_private_key")) {
        if (!readFile) {
          yield* Effect.sync(() =>
            console.warn("[Settings] GITHUB_PRIVATE_KEY_FILE is set but unreadable here (no filesystem) — set inline GITHUB_PRIVATE_KEY instead")
          );
        } else {
          const content = yield* Effect.try({
            try: () => readFile(env.GITHUB_PRIVATE_KEY_FILE as string),
            catch: () => new DbError({ message: "unreadable" }),
          }).pipe(Effect.catchAll(() => Effect.succeed(null)));
          if (content === null) {
            yield* Effect.sync(() =>
              console.warn(`[Settings] GITHUB_PRIVATE_KEY_FILE unreadable (${env.GITHUB_PRIVATE_KEY_FILE}) — skipping mirror`)
            );
          } else {
            yield* mirror("github_private_key", content);
          }
        }
      }
    }
    yield* mirror("rate_limit_max", env.LXK_RATE_LIMIT_MAX);
    yield* mirror("rate_limit_window_ms", env.LXK_RATE_LIMIT_WINDOW_MS);
    yield* mirror("hearth_repo_cap", env.LXK_HEARTH_REPO_CAP);
    return mirrored;
  });
}

export type { BatchStmt, SqlParam };
