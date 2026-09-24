import { describe, expect, it, afterEach } from "vitest";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { runMigrations } from "./migrate";
import { backfillTaskKeys, backfillTaskKeysDriver } from "./task-keys-backfill";
import { createBunSqliteDriver } from "./drivers/bun-sqlite";

let dirs: string[] = [];

function freshDb(): Database {
  const dir = mkdtempSync(join(tmpdir(), "lexa-backfill-test-"));
  dirs.push(dir);
  const dbPath = join(dir, "app.db");
  runMigrations(dbPath);
  return new Database(dbPath);
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function seedLegacy(db: Database) {
  db.exec(`
    INSERT INTO projects (id, name, slug) VALUES ('p1', 'Emberfall Godot', 'emberfall-godot');
    INSERT INTO projects (id, name, slug) VALUES ('p2', 'Web Client', 'web-client');
    INSERT INTO projects (id, name, slug) VALUES ('p3', 'Web Crawler', 'web-crawler');
    INSERT INTO columns (id, project_id, name, position, color) VALUES ('c1', 'p1', 'Todo', 1, '#000');
    INSERT INTO swimlanes (id, project_id, name, position, kind) VALUES ('s1', 'p1', 'Backlog', 0, 'backlog');
    INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position) VALUES ('t1', 'p1', 'c1', 's1', 'A', 'a0');
    INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position) VALUES ('t2', 'p1', 'c1', 's1', 'B', 'a1');
    INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position) VALUES ('t3', 'p2', 'c1', 's1', 'C', 'a2');
  `);
}

describe("backfillTaskKeys", () => {
  it("assigns collision-resolved keys and per-project numbers", () => {
    const db = freshDb();
    seedLegacy(db);
    backfillTaskKeys(db);
    const projects = db.query("SELECT slug, key FROM projects ORDER BY created_at").all() as { slug: string; key: string }[];
    expect(projects.map((p) => p.key)).toEqual(["EG", "WC", "WCR"]);
    const tasks = db.query("SELECT id, number, key FROM tasks ORDER BY created_at").all() as { id: string; number: number; key: string }[];
    expect(tasks).toEqual([
      { id: "t1", number: 1, key: "EG-1" },
      { id: "t2", number: 2, key: "EG-2" },
      { id: "t3", number: 1, key: "WC-1" },
    ]);
  });
  it("is idempotent", () => {
    const db = freshDb();
    seedLegacy(db);
    backfillTaskKeys(db);
    backfillTaskKeys(db);
    const n = db.query("SELECT COUNT(*) AS n FROM tasks WHERE key IS NULL").get() as { n: number };
    expect(n.n).toBe(0);
  });

  it("resumes from already-assigned numbers without reuse or unique violation", () => {
    const db = freshDb();
    db.exec(`
      INSERT INTO projects (id, name, slug, key, next_task_number) VALUES ('p1', 'Emberfall Godot', 'emberfall-godot', 'EG', 2);
      INSERT INTO columns (id, project_id, name, position, color) VALUES ('c1', 'p1', 'Todo', 1, '#000');
      INSERT INTO swimlanes (id, project_id, name, position, kind) VALUES ('s1', 'p1', 'Backlog', 0, 'backlog');
      INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, number, key) VALUES ('t1', 'p1', 'c1', 's1', 'A', 'a0', 1, 'EG-1');
      INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, number, key) VALUES ('t2', 'p1', 'c1', 's1', 'B', 'a1', 5, 'EG-5');
      INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position) VALUES ('t3', 'p1', 'c1', 's1', 'C', 'a2');
    `);
    backfillTaskKeys(db);
    const tasks = db.query("SELECT id, number, key FROM tasks ORDER BY id").all() as { id: string; number: number; key: string }[];
    expect(tasks).toEqual([
      { id: "t1", number: 1, key: "EG-1" },
      { id: "t2", number: 5, key: "EG-5" },
      { id: "t3", number: 6, key: "EG-6" },
    ]);
    const project = db.query("SELECT next_task_number FROM projects WHERE id = 'p1'").get() as { next_task_number: number };
    expect(project.next_task_number).toBe(6);
  });

  it("driver variant resumes from already-assigned numbers without reuse", async () => {
    const db = freshDb();
    db.exec(`
      INSERT INTO projects (id, name, slug, key, next_task_number) VALUES ('p1', 'Emberfall Godot', 'emberfall-godot', 'EG', 2);
      INSERT INTO columns (id, project_id, name, position, color) VALUES ('c1', 'p1', 'Todo', 1, '#000');
      INSERT INTO swimlanes (id, project_id, name, position, kind) VALUES ('s1', 'p1', 'Backlog', 0, 'backlog');
      INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, number, key) VALUES ('t1', 'p1', 'c1', 's1', 'A', 'a0', 1, 'EG-1');
      INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, number, key) VALUES ('t2', 'p1', 'c1', 's1', 'B', 'a1', 5, 'EG-5');
      INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position) VALUES ('t3', 'p1', 'c1', 's1', 'C', 'a2');
    `);
    const driver = createBunSqliteDriver(db);
    await Effect.runPromise(backfillTaskKeysDriver(driver) as Effect.Effect<void, never>);
    const tasks = db.query("SELECT id, number, key FROM tasks ORDER BY id").all() as { id: string; number: number; key: string }[];
    expect(tasks).toEqual([
      { id: "t1", number: 1, key: "EG-1" },
      { id: "t2", number: 5, key: "EG-5" },
      { id: "t3", number: 6, key: "EG-6" },
    ]);
    const project = db.query("SELECT next_task_number FROM projects WHERE id = 'p1'").get() as { next_task_number: number };
    expect(project.next_task_number).toBe(6);
  });

  it("fills a NULL key on a task that already carries a number without reusing it", () => {
    const db = freshDb();
    db.exec(`
      INSERT INTO projects (id, name, slug, key, next_task_number) VALUES ('p1', 'Emberfall Godot', 'emberfall-godot', 'EG', 3);
      INSERT INTO columns (id, project_id, name, position, color) VALUES ('c1', 'p1', 'Todo', 1, '#000');
      INSERT INTO swimlanes (id, project_id, name, position, kind) VALUES ('s1', 'p1', 'Backlog', 0, 'backlog');
      INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, number, key) VALUES ('t1', 'p1', 'c1', 's1', 'A', 'a0', 1, 'EG-1');
      INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, number) VALUES ('t2', 'p1', 'c1', 's1', 'B', 'a1', 2);
    `);
    backfillTaskKeys(db);
    const tasks = db.query("SELECT id, number, key FROM tasks ORDER BY id").all() as { id: string; number: number; key: string }[];
    for (const t of tasks) {
      expect(t.number).not.toBeNull();
      expect(t.key).toBe(`EG-${t.number}`);
    }
    // The pre-assigned number 2 must not be handed to another task.
    expect(tasks.find((t) => t.id === "t2")!.number).not.toBe(1);
    const dup = db.query("SELECT number, COUNT(*) c FROM tasks GROUP BY project_id, number HAVING c > 1").all();
    expect(dup).toEqual([]);
    const keys = tasks.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
    // UNIQUE(project_id, number) still guards reuse after backfill.
    expect(() =>
      db.prepare("INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, number, key) VALUES ('t3', 'p1', 'c1', 's1', 'C', 'a2', 1, 'EG-X')").run()
    ).toThrow();
    const project = db.query("SELECT next_task_number FROM projects WHERE id = 'p1'").get() as { next_task_number: number };
    expect(project.next_task_number).toBeGreaterThanOrEqual(1);
  });
});