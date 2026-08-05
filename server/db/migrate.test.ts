import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { runMigrations } from "./migrate";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

let dirs: string[] = [];

function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "lexa-migrate-test-"));
  dirs.push(d);
  return d;
}

function appliedMigrations(dbPath: string): string[] {
  const db = new Database(dbPath);
  const rows = db.prepare("SELECT name FROM _migrations ORDER BY name").all() as { name: string }[];
  db.close();
  return rows.map((r) => r.name);
}

function tableExists(db: Database, name: string): boolean {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("runMigrations", () => {
  it("applies the real migrations dir and records _migrations", () => {
    const dbPath = join(tmpDir(), "app.db");
    runMigrations(dbPath, MIGRATIONS);
    expect(appliedMigrations(dbPath)).toEqual(["0001_init.sql", "0002_revoke_dev_seed_key.sql", "0003_machine_secret.sql"]);
    const db = new Database(dbPath);
    expect(tableExists(db, "tasks")).toBe(true);
    expect(tableExists(db, "_migrations")).toBe(true);
    db.close();
  });

  it("is a no-op on the second run", () => {
    const dbPath = join(tmpDir(), "app.db");
    runMigrations(dbPath, MIGRATIONS);
    runMigrations(dbPath, MIGRATIONS);
    expect(appliedMigrations(dbPath)).toEqual(["0001_init.sql", "0002_revoke_dev_seed_key.sql", "0003_machine_secret.sql"]);
  });

  it("rolls back a failed migration atomically (no partial schema, no _migrations row)", () => {
    const dir = tmpDir();
    writeFileSync(join(dir, "0001_ok.sql"), "CREATE TABLE t1 (id TEXT PRIMARY KEY);");
    writeFileSync(
      join(dir, "0002_bad.sql"),
      "CREATE TABLE t2 (id TEXT PRIMARY KEY); CREATE TABLE t1 (id TEXT PRIMARY KEY);"
    );
    const dbPath = join(dir, "app.db");
    expect(() => runMigrations(dbPath, dir)).toThrow();
    const db = new Database(dbPath);
    expect(tableExists(db, "t1")).toBe(true); // 0001 committed
    expect(tableExists(db, "t2")).toBe(false); // 0002 rolled back
    db.close();
    // 0001 recorded, failed 0002 leaves no _migrations row.
    expect(appliedMigrations(dbPath)).toEqual(["0001_ok.sql"]);
    // Fix the dir → re-run succeeds cleanly.
    rmSync(join(dir, "0002_bad.sql"));
    expect(() => runMigrations(dbPath, dir)).not.toThrow();
    expect(appliedMigrations(dbPath)).toEqual(["0001_ok.sql"]);
  });

  it("keeps the default migrations dir (prod behavior)", () => {
    const dbPath = join(tmpDir(), "app.db");
    runMigrations(dbPath);
    expect(appliedMigrations(dbPath)).toEqual(["0001_init.sql", "0002_revoke_dev_seed_key.sql", "0003_machine_secret.sql"]);
  });
});
