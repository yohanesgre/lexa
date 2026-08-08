import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, copyFileSync, readdirSync } from "node:fs";
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
    expect(appliedMigrations(dbPath)).toEqual([
      "0001_init.sql",
      "0002_revoke_dev_seed_key.sql",
      "0003_machine_secret.sql",
      "0004_task_activity.sql",
      "0005_milestone_deadlines.sql",
    ]);
    const db = new Database(dbPath);
    expect(tableExists(db, "tasks")).toBe(true);
    expect(tableExists(db, "_migrations")).toBe(true);
    db.close();
  });

  it("is a no-op on the second run", () => {
    const dbPath = join(tmpDir(), "app.db");
    runMigrations(dbPath, MIGRATIONS);
    runMigrations(dbPath, MIGRATIONS);
    expect(appliedMigrations(dbPath)).toEqual([
      "0001_init.sql",
      "0002_revoke_dev_seed_key.sql",
      "0003_machine_secret.sql",
      "0004_task_activity.sql",
      "0005_milestone_deadlines.sql",
    ]);
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
    expect(appliedMigrations(dbPath)).toEqual([
      "0001_init.sql",
      "0002_revoke_dev_seed_key.sql",
      "0003_machine_secret.sql",
      "0004_task_activity.sql",
      "0005_milestone_deadlines.sql",
    ]);
  });
});

describe("0004_task_activity", () => {
  it("creates tables and backfills created/archived rows", () => {
    // Phase the backfill like prod: apply 0001–0003, seed tasks, then apply
    // 0004 so its backfill sees the tasks that existed before the migration.
    const dir = tmpDir();
    for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql"))) {
      if (f !== "0004_task_activity.sql") copyFileSync(join(MIGRATIONS, f), join(dir, f));
    }
    const dbPath = join(dir, "app.db");
    runMigrations(dbPath, dir);
    const db = new Database(dbPath);
    db.prepare("INSERT INTO projects (id, name, slug) VALUES ('p1','P','p1')").run();
    db.prepare("INSERT INTO columns (id, project_id, name, position) VALUES ('c1','p1','Todo',0)").run();
    db.prepare("INSERT INTO swimlanes (id, project_id, name, position) VALUES ('s1','p1','Default',0)").run();
    db.prepare(`INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, created_at, archived_at)
                VALUES ('t1','p1','c1','s1','Old','a0','2026-01-01 10:00:00', '2026-02-01 10:00:00')`).run();
    db.prepare(`INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, created_at)
                VALUES ('t2','p1','c1','s1','Live','a1','2026-01-02 10:00:00')`).run();
    db.close();

    copyFileSync(join(MIGRATIONS, "0004_task_activity.sql"), join(dir, "0004_task_activity.sql"));
    runMigrations(dbPath, dir);

    const db2 = new Database(dbPath);
    const rows = db2.prepare("SELECT task_id, type, message, actor_kind FROM task_activity ORDER BY task_id, id").all() as any[];
    expect(rows).toEqual([
      { task_id: "t1", type: "created", message: "Task created", actor_kind: "system" },
      { task_id: "t1", type: "archived", message: "Task archived", actor_kind: "system" },
      { task_id: "t2", type: "created", message: "Task created", actor_kind: "system" },
    ]);
    const cols = db2.prepare("SELECT name FROM pragma_table_info('task_comments')").all() as any[];
    expect(cols.map((c: any) => c.name)).toEqual(
      expect.arrayContaining(["id", "task_id", "author_id", "author_kind", "author_label", "body", "edited_at", "deleted_at", "created_at"])
    );
    db2.close();
  });
});

describe("0005_milestone_deadlines", () => {
  it("adds columns, converts Default lanes to Backlog, backfills missing backlog lanes", () => {
    // Phase like prod: apply 0001–0004, seed projects, then apply 0005 so its
    // backfill sees the lanes that existed before the migration.
    const dir = tmpDir();
    for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql"))) {
      if (f !== "0005_milestone_deadlines.sql") copyFileSync(join(MIGRATIONS, f), join(dir, f));
    }
    const dbPath = join(dir, "app.db");
    runMigrations(dbPath, dir);
    const db = new Database(dbPath);
    // p1 has a 'Default' lane (becomes Backlog); p2 renamed its lane historically
    // ('Sprint 1' — no backlog lane); p3 already has a 'Backlog' lane but no kind.
    db.prepare("INSERT INTO projects (id, name, slug) VALUES ('p1','P1','p1'), ('p2','P2','p2'), ('p3','P3','p3')").run();
    db.prepare("INSERT INTO swimlanes (id, project_id, name, position) VALUES ('s1','p1','Default',0)").run();
    db.prepare("INSERT INTO swimlanes (id, project_id, name, position) VALUES ('s2','p2','Sprint 1',0)").run();
    db.prepare("INSERT INTO swimlanes (id, project_id, name, position) VALUES ('s3','p3','Backlog',0), ('s4','p3','Sprint 1',1)").run();
    db.close();

    copyFileSync(join(MIGRATIONS, "0005_milestone_deadlines.sql"), join(dir, "0005_milestone_deadlines.sql"));
    runMigrations(dbPath, dir);

    const db2 = new Database(dbPath);
    const cols = db2.prepare("SELECT name FROM pragma_table_info('swimlanes')").all() as any[];
    expect(cols.map((c: any) => c.name)).toEqual(
      expect.arrayContaining(["due_at", "archived_at", "kind"])
    );
    const taskCols = db2.prepare("SELECT name FROM pragma_table_info('tasks')").all() as any[];
    expect(taskCols.map((c: any) => c.name)).toContain("due_at");
    const rows = db2.prepare("SELECT project_id, name, kind FROM swimlanes ORDER BY project_id, position").all() as any[];
    expect(rows).toEqual([
      { project_id: "p1", name: "Backlog", kind: "backlog" },           // 'Default' converted
      { project_id: "p2", name: "Sprint 1", kind: "milestone" },
      { project_id: "p2", name: "Backlog", kind: "backlog" },           // backfilled
      { project_id: "p3", name: "Backlog", kind: "milestone" },         // pre-existing name, kind untouched
      { project_id: "p3", name: "Sprint 1", kind: "milestone" },
      { project_id: "p3", name: "Backlog", kind: "backlog" },           // backfilled — identity is kind, not name
    ]);
    const backlogCounts = db2.prepare("SELECT project_id, COUNT(*) as c FROM swimlanes WHERE kind = 'backlog' GROUP BY project_id").all() as any[];
    expect(backlogCounts).toEqual([
      { project_id: "p1", c: 1 },
      { project_id: "p2", c: 1 },
      { project_id: "p3", c: 1 },
    ]);
    db2.close();
  });
});
