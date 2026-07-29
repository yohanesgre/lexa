import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function runMigrations(dbPath: string) {
  const db = new Database(dbPath) as any;
  
  (db as any).run("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT DEFAULT (datetime('now')))");
  
  const dir = join(import.meta.dir, "../../migrations");
  const files = readdirSync(dir).filter((f: string) => f.endsWith(".sql")).sort();

  for (const file of files) {
    const row = (db as any).query("SELECT name FROM _migrations WHERE name = ?").get(file) as { name: string } | null;
    if (row) continue;

    const sql = readFileSync(join(dir, file), "utf-8");
    (db as any).run(sql);
    (db as any).run("INSERT INTO _migrations (name) VALUES (?)", [file]);
    console.log(`Applied migration: ${file}`);
  }
  
  db.close();
}

const dbPath = (import.meta as any).main ? process.argv[2] : null;
if (dbPath) {
  runMigrations(dbPath);
  console.log("Migrations complete");
}
