import { describe, expect, it, afterEach } from "vitest";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "./migrate";
import { backfillTaskKeys } from "./task-keys-backfill";

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
});