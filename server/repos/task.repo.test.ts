import { describe, expect, it, afterEach, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer, Context } from "effect";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { Sqlite, initSqlite } from "../db/database";
import { TaskRepo } from "./task.repo";
import { TaskService } from "../services/task.service";
import type { Actor } from "../../shared/types";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

let dir: string;
let db: Database;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "lexa-task-repo-"));
  const path = join(dir, "test.db");
  runMigrations(path, MIGRATIONS);
  const ctx = Effect.runSync(Effect.scoped(Layer.build(initSqlite(path))));
  db = Context.get(ctx, Sqlite);
});

afterAll(() => {
  try { db.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

function cleanDb(db: Database) {
  db.exec("PRAGMA foreign_keys = OFF");
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '_migrations' AND name NOT LIKE '%fts%'").all() as { name: string }[];
  for (const { name } of tables) {
    try { db.exec(`DELETE FROM "${name}"`); } catch {}
  }
  try { db.exec("DELETE FROM sqlite_sequence"); } catch {}
  db.exec("PRAGMA foreign_keys = ON");
}

beforeEach(() => {
  cleanDb(db);
});


function seed(db: Database) {
  db.prepare("INSERT INTO projects (id, name, slug) VALUES ('p1','P','p1')").run();
  db.prepare("INSERT INTO columns (id, project_id, name, position, github_state) VALUES ('c1','p1','Todo',0,'open')").run();
  db.prepare("INSERT INTO swimlanes (id, project_id, name, position, kind) VALUES ('s1','p1','Backlog',0,'backlog')").run();
  db.prepare("INSERT INTO users (id, email, name, role) VALUES ('u1','maria@lexa.test','Maria','member')").run();
  db.prepare("INSERT INTO priority_options (id, project_id, label, color, position) VALUES ('prio-1','p1','Medium','#888',0)").run();
  db.prepare("INSERT INTO type_options (id, project_id, label, color, position) VALUES ('type-1','p1','Bug','#f00',0)").run();
  // Live task at a0, ARCHIVED task at the position AFTER it (a1) — the old
  // anchor (last live = a0) would regenerate keyAfter('a0') = 'a1' and
  // collide with the archived row.
  db.prepare(`INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, description, priority, type, position, created_at)
              VALUES ('t-live','p1','c1','s1','Live','{"type":"doc","content":[]}','prio-1','type-1','a0','2026-01-01 10:00:00'),
                     ('t-arch','p1','c1','s1','Archived','{"type":"doc","content":[]}','prio-1','type-1','a1','2026-01-02 10:00:00')`).run();
  db.prepare("UPDATE tasks SET archived_at = '2026-01-03 10:00:00' WHERE id = 't-arch'").run();
}

function makeRepo(db: Database) {
  const layer = TaskRepo.Default.pipe(Layer.provide(Layer.succeed(Sqlite, db)));
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  return Context.get(ctx, TaskRepo);
}

function makeService(db: Database) {
  const layer = TaskService.Default.pipe(Layer.provide(Layer.succeed(Sqlite, db)));
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  return Context.get(ctx, TaskService);
}

const maria: Actor = { kind: "user", label: "Maria", userId: "u1" };

describe("TaskRepo.findLastInColumn", () => {
  it("anchors on the max position including archived tasks", () => {
    seed(db);
    const repo = makeRepo(db);
    const last = Effect.runSync(repo.findLastInColumn("p1", "c1"));
    expect(last.id).toBe("t-arch");
    expect(last.archivedAt).not.toBeNull();
    expect(last.position).toBe("a1");
  });
});

describe("create after archived last position", () => {
  it("creates a task in a column whose last position is an archived task", () => {
    seed(db);
    const svc = makeService(db);
    const { task } = Effect.runSync(
      svc.create(maria, { projectId: "p1", columnId: "c1", title: "New", priority: "prio-1", type: "type-1" })
    );
    expect(task.position > "a1").toBe(true);
    const positions = db.prepare("SELECT position FROM tasks WHERE column_id = 'c1' ORDER BY position").all() as { position: string }[];
    expect(positions.map((r) => r.position)).toEqual(["a0", "a1", task.position]);
  });
});

describe("TaskRepo.findUrgentAcrossAllProjects", () => {
  it("excludes tasks in a closed (done) column but keeps unmapped and open ones", () => {
    seed(db);
    db.prepare("INSERT INTO columns (id, project_id, name, position, github_state) VALUES ('c2','p1','Done',1,'closed')").run();
    db.prepare("INSERT INTO columns (id, project_id, name, position, github_state) VALUES ('c3','p1','Later',2,NULL)").run();
    db.prepare(`INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, description, priority, type, position, created_at)
                VALUES ('t-done','p1','c2','s1','Done urgent','{"type":"doc","content":[]}','prio-1','type-1','b0','2026-01-04 10:00:00'),
                       ('t-later','p1','c3','s1','Later urgent','{"type":"doc","content":[]}','prio-1','type-1','c0','2026-01-05 10:00:00')`).run();
    const repo = makeRepo(db);
    const urgent = Effect.runSync(repo.findUrgentAcrossAllProjects(50));
    expect(urgent.map((t) => t.id).sort()).toEqual(["t-later", "t-live"]);
  });
});
