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
