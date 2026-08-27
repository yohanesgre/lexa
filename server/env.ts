// Runtime environment — the single source of truth for env-var reads in
// server/. On the Bun host, `getEnv()` returns a snapshot of `process.env`.
// On Cloudflare Workers, the Workers entry calls `getEnvFromWorkers(env)`
// once per request and passes the resulting `RuntimeEnv` into the request
// pipeline. No module in server/ should read `process.env.X` at module scope;
// they all take a `RuntimeEnv` argument.
//
// This keeps the Bun path (which has a single process-wide env) and the
// Workers path (which has a per-request `env` binding) on the same shape so
// the HTTP layer can construct its per-request runtime from either input.

import type { D1Database, KVNamespace, R2Bucket } from "@cloudflare/workers-types";

export interface RuntimeEnv {
  // Storage / runtime
  DATABASE_PATH?: string | undefined;
  PORT?: string | undefined;
  LXK_ENV?: string | undefined;
  LXK_PUBLIC_URL?: string | undefined;
  LXK_TRUSTED_ORIGINS?: string | undefined;
  LXK_ADMIN_EMAILS?: string | undefined;
  // Auth
  LXK_API_KEY?: string | undefined;
  // GitHub
  GITHUB_APP_ID?: string | undefined;
  GITHUB_PRIVATE_KEY?: string | undefined;
  GITHUB_PRIVATE_KEY_FILE?: string | undefined;
  GITHUB_WEBHOOK_SECRET?: string | undefined;
  // Storage drivers
  LXK_STORAGE_DRIVER?: string | undefined;
  LXK_STORAGE_FS_ROOT?: string | undefined;
  LXK_S3_BUCKET?: string | undefined;
  LXK_S3_ACCESS_KEY_ID?: string | undefined;
  LXK_S3_SECRET_ACCESS_KEY?: string | undefined;
  LXK_S3_ENDPOINT?: string | undefined;
  LXK_S3_REGION?: string | undefined;
  // Body / limits
  LXK_MAX_BODY_MB?: string | undefined;
  LXK_MAX_UPLOAD_MB?: string | undefined;
  // Hearth / daemon
  LXK_HEARTH_DAEMON_TOKEN?: string | undefined;
  LXK_HEARTH_REPO_CAP?: string | undefined;
  HEARTH_STALE_RUN_MIN?: string | undefined;
  // Logging
  LOG_LEVEL?: string | undefined;
  TANSTACK_AI_DEBUG?: string | undefined;
  TANSTACK_AI_JSON?: string | undefined;
  // Backups / seed
  LXK_BACKUP_ENABLED?: string | undefined;
  LXK_BACKUP_RETENTION?: string | undefined;
  LXK_SEED_DEV?: string | undefined;
  // Workers bindings (only present on the Workers path)
  DB?: D1Database | undefined;
  BLOB?: R2Bucket | undefined;
  KV?: KVNamespace | undefined;
  CRON_SECRET?: string | undefined;
}

export type ProcessEnvSource = Record<string, string | undefined>;

/**
 * Build a RuntimeEnv from a plain process-env-shaped object. Used by the Bun
 * host's `server/entry.ts` at boot — the snapshot is captured once and
 * threaded through the request pipeline (auth, storage, http) so the rest
 * of the code never touches `process.env` directly.
 */
export function getEnv(source: ProcessEnvSource = processEnvSafe()): RuntimeEnv {
  return {
    DATABASE_PATH: source.DATABASE_PATH,
    PORT: source.PORT,
    LXK_ENV: source.LXK_ENV,
    LXK_PUBLIC_URL: source.LXK_PUBLIC_URL,
    LXK_TRUSTED_ORIGINS: source.LXK_TRUSTED_ORIGINS,
    LXK_ADMIN_EMAILS: source.LXK_ADMIN_EMAILS,
    LXK_API_KEY: source.LXK_API_KEY,
    GITHUB_APP_ID: source.GITHUB_APP_ID,
    GITHUB_PRIVATE_KEY: source.GITHUB_PRIVATE_KEY,
    GITHUB_PRIVATE_KEY_FILE: source.GITHUB_PRIVATE_KEY_FILE,
    GITHUB_WEBHOOK_SECRET: source.GITHUB_WEBHOOK_SECRET,
    LXK_STORAGE_DRIVER: source.LXK_STORAGE_DRIVER,
    LXK_STORAGE_FS_ROOT: source.LXK_STORAGE_FS_ROOT,
    LXK_S3_BUCKET: source.LXK_S3_BUCKET,
    LXK_S3_ACCESS_KEY_ID: source.LXK_S3_ACCESS_KEY_ID,
    LXK_S3_SECRET_ACCESS_KEY: source.LXK_S3_SECRET_ACCESS_KEY,
    LXK_S3_ENDPOINT: source.LXK_S3_ENDPOINT,
    LXK_S3_REGION: source.LXK_S3_REGION,
    LXK_MAX_BODY_MB: source.LXK_MAX_BODY_MB,
    LXK_MAX_UPLOAD_MB: source.LXK_MAX_UPLOAD_MB,
    LXK_HEARTH_DAEMON_TOKEN: source.LXK_HEARTH_DAEMON_TOKEN,
    LXK_HEARTH_REPO_CAP: source.LXK_HEARTH_REPO_CAP,
    HEARTH_STALE_RUN_MIN: source.HEARTH_STALE_RUN_MIN,
    LOG_LEVEL: source.LOG_LEVEL,
    TANSTACK_AI_DEBUG: source.TANSTACK_AI_DEBUG ?? source.LXK_TANSTACK_AI_DEBUG,
    TANSTACK_AI_JSON: source.TANSTACK_AI_JSON ?? source.LXK_TANSTACK_AI_JSON,
    LXK_BACKUP_ENABLED: source.LXK_BACKUP_ENABLED,
    LXK_BACKUP_RETENTION: source.LXK_BACKUP_RETENTION,
    LXK_SEED_DEV: source.LXK_SEED_DEV,
  };
}

/**
 * Build a RuntimeEnv from a workerd `env` binding. The Workers fetch handler
 * calls this once per request; the result is the only env surface the rest
 * of the code sees.
 */
export function getEnvFromWorkers(env: Record<string, unknown>): RuntimeEnv {
  const s = (k: string): string | undefined => {
    const v = env[k];
    return typeof v === "string" ? v : undefined;
  };
  return {
    DATABASE_PATH: undefined, // not used on Workers — D1 binding
    PORT: undefined,
    LXK_ENV: s("LXK_ENV"),
    LXK_PUBLIC_URL: s("LXK_PUBLIC_URL"),
    LXK_TRUSTED_ORIGINS: s("LXK_TRUSTED_ORIGINS"),
    LXK_ADMIN_EMAILS: s("LXK_ADMIN_EMAILS"),
    LXK_API_KEY: s("LXK_API_KEY"),
    GITHUB_APP_ID: s("GITHUB_APP_ID"),
    GITHUB_PRIVATE_KEY: s("GITHUB_PRIVATE_KEY"),
    GITHUB_PRIVATE_KEY_FILE: s("GITHUB_PRIVATE_KEY_FILE"),
    GITHUB_WEBHOOK_SECRET: s("GITHUB_WEBHOOK_SECRET"),
    LXK_STORAGE_DRIVER: "r2",
    LXK_STORAGE_FS_ROOT: undefined,
    LXK_S3_BUCKET: undefined,
    LXK_S3_ACCESS_KEY_ID: undefined,
    LXK_S3_SECRET_ACCESS_KEY: undefined,
    LXK_S3_ENDPOINT: undefined,
    LXK_S3_REGION: undefined,
    LXK_MAX_BODY_MB: s("LXK_MAX_BODY_MB"),
    LXK_MAX_UPLOAD_MB: s("LXK_MAX_UPLOAD_MB"),
    LXK_HEARTH_DAEMON_TOKEN: s("LXK_HEARTH_DAEMON_TOKEN"),
    LXK_HEARTH_REPO_CAP: s("LXK_HEARTH_REPO_CAP"),
    HEARTH_STALE_RUN_MIN: s("HEARTH_STALE_RUN_MIN"),
    LOG_LEVEL: s("LOG_LEVEL"),
    TANSTACK_AI_DEBUG: s("TANSTACK_AI_DEBUG") ?? s("LXK_TANSTACK_AI_DEBUG"),
    TANSTACK_AI_JSON: s("TANSTACK_AI_JSON") ?? s("LXK_TANSTACK_AI_JSON"),
    LXK_BACKUP_ENABLED: s("LXK_BACKUP_ENABLED"),
    LXK_BACKUP_RETENTION: s("LXK_BACKUP_RETENTION"),
    LXK_SEED_DEV: s("LXK_SEED_DEV"),
    DB: env.DB as D1Database | undefined,
    BLOB: env.BLOB as R2Bucket | undefined,
    KV: env.KV as KVNamespace | undefined,
    CRON_SECRET: s("CRON_SECRET"),
  };
}

function processEnvSafe(): ProcessEnvSource {
  if (typeof process !== "undefined" && process.env) return process.env;
  return {};
}

// ─── Workers / Bun dispatch ──────────────────────────────────────────────
// `isWorkers()` returns true when the code is running inside a workerd
// isolate, false on the Bun host. The cheapest reliable signal is
// `caches.default`: workerd provides it, Bun does not. The check is
// tolerant of test environments that polyfill `caches` (the `.default`
// shape test rejects the bare DOM `CacheStorage` that some runtimes
// provide).
export function isWorkers(): boolean {
  if (typeof caches !== "undefined") {
    try {
      const c = caches as { default?: unknown };
      return typeof c.default === "object" && c.default !== null;
    } catch {
      // fall through
    }
  }
  return false;
}

// Cached runtime check — `isWorkers()` is stable for the lifetime of
// the isolate (Bun process or workerd isolate), so we evaluate it
// once at module load.
export const RUNTIME_IS_WORKERS: boolean = isWorkers();
