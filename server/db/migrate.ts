import { Database } from "bun:sqlite";
import { readdirSync, readFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// import.meta.dir is bun-only; fall back for non-bun runtimes (vitest workers).
const DEFAULT_MIGRATIONS_DIR = import.meta.dir
  ? join(import.meta.dir, "../../migrations")
  : fileURLToPath(new URL("../../migrations", import.meta.url));

export function runMigrations(dbPath: string, migrationsDir = DEFAULT_MIGRATIONS_DIR) {
  const db = new Database(dbPath) as any;
  try { chmodSync(dbPath, 0o600); } catch {}
  (db as any).exec("PRAGMA busy_timeout = 5000");
  // FK enforcement OFF during migrations, matching bun:sqlite's production
  // default (the vitest shim defaults it ON). Rebuilds like 0004/0005 drop
  // parent tables that children still reference — defer_foreign_keys cannot
  // help (the implicit DELETE is re-checked at COMMIT), so enforcement is
  // disabled for the whole run. Apps re-enable it via initSqlite.
  (db as any).exec("PRAGMA foreign_keys = OFF");

  (db as any).run("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT DEFAULT (datetime('now')))");

  const files = readdirSync(migrationsDir).filter((f: string) => f.endsWith(".sql")).sort();

  for (const file of files) {
    const row = (db as any).query("SELECT name FROM _migrations WHERE name = ?").get(file) as { name: string } | null;
    if (row) continue;

    const sql = readFileSync(join(migrationsDir, file), "utf-8");
    // Atomic per-file apply: migration + its record in one transaction. A
    // failed migration leaves no partial schema and no _migrations row.
    (db as any).exec("BEGIN");
    try {
      (db as any).run(sql);
      (db as any).run("INSERT INTO _migrations (name) VALUES (?)", [file]);
      (db as any).exec("COMMIT");
    } catch (e) {
      (db as any).exec("ROLLBACK");
      throw e;
    }
    console.log(`Applied migration: ${file}`);
  }

  // Populate sqlite_stat1 so the planner picks indexes instead of coin-flipping.
  (db as any).exec("ANALYZE");

  db.close();
}

const dbPath = (import.meta as any).main ? process.argv[2] : null;
if (dbPath) {
  runMigrations(dbPath);
  console.log("Migrations complete");
}
// ─── D1 migration entry (Phase 8) ─────────────────────────────────────────
//
// The Bun path above iterates the migrations directory in one process
// via `bun:sqlite` synchronous transactions. The Workers path uses
// `wrangler d1 migrations apply --local|remote` (CLI) OR the runtime
// helper below, which iterates the same directory and applies each
// file via a single `db.batch([...stmts])` call. The D1 features used
// by Lexa migrations (per Cloudflare D1 limits, 2026-08) and confirmed
// at `https://developers.cloudflare.com/d1/platform/limits/`:
//   * FTS5 virtual tables + `INSERT OR REPLACE` triggers
//   * Partial unique indexes (`CREATE UNIQUE INDEX ... WHERE ...`)
//   * `ON DELETE SET NULL` / `ON DELETE CASCADE` foreign keys
//   * `CHECK (...)` constraints
//   * `WITHOUT ROWID` tables
//   * Generated columns (`GENERATED ALWAYS AS ... STORED`)
// D1 does NOT support: `ALTER COLUMN`, `RENAME COLUMN`, `DROP COLUMN`.
// Migrations that need those use the table-rebuild pattern (see 0004
// and 0005 — they create a new table, copy, drop the old, rename).
export interface D1PreparedStmt {
  bind(...params: unknown[]): D1PreparedStmt;
  all<T>(): Promise<T[]>;
  first<T>(): Promise<T | null>;
  run(): Promise<{ success: boolean; meta: { changes: number; duration?: number } }>;
}

export interface D1MigrationRunner {
  prepare(sql: string): D1PreparedStmt;
  batch(stmts: { sql: string; params?: unknown[] }[]): Promise<{
    success: boolean;
    duration: number;
    results: unknown[];
    length: number;
  }>;
}

export interface D1MigrationResult {
  applied: string[];
  alreadyApplied: string[];
  totalDurationMs: number;
}

export async function runMigrationsD1(
  d1: D1MigrationRunner,
  migrationsDir: string = DEFAULT_MIGRATIONS_DIR
): Promise<D1MigrationResult> {
  const applied: string[] = [];
  const alreadyApplied: string[] = [];
  const start = Date.now();

  // D1 has no schema; use a row in a tracking table for the migration
  // registry. CREATE TABLE IF NOT EXISTS is idempotent.
  await d1.batch([
    { sql: `CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT DEFAULT (datetime('now')))` },
  ]);

  const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();

  for (const file of files) {
    const row = await d1
      .prepare("SELECT name FROM _migrations WHERE name = ?")
      .bind(file)
      .first<{ name: string }>();
    if (row) {
      alreadyApplied.push(file);
      continue;
    }

    const sql = readFileSync(join(migrationsDir, file), "utf-8");
    // Per-file atomicity: the migration + the registry row in one
    // batch. D1's batch fails atomically on the first error and
    // returns success=false. The registry row INSERT must follow the
    // migration's DDL/DML so the next apply skips cleanly.
    const result = await d1.batch([
      { sql },
      { sql: "INSERT INTO _migrations (name) VALUES (?)", params: [file] },
    ]);
    if (!result.success) {
      throw new Error(`D1 migration ${file} failed (duration ${result.duration}ms)`);
    }
    applied.push(file);
  }

  return { applied, alreadyApplied, totalDurationMs: Date.now() - start };
}
