import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer, Context } from "effect";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { Sqlite, initSqlite } from "../db/database";
import { TaskService } from "./task.service";
import type { Actor } from "../../shared/types";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

let dirs: string[] = [];
let dbs: Database[] = [];

function tmpDb(): Database {
  const dir = mkdtempSync(join(tmpdir(), "lexa-task-svc-"));
  dirs.push(dir);
  const path = join(dir, "test.db");
  runMigrations(path, MIGRATIONS);
  const ctx = Effect.runSync(Effect.scoped(Layer.build(initSqlite(path))));
  const db = Context.get(ctx, Sqlite);
  dbs.push(db);
  return db;
}

function seed(db: Database) {
  db.prepare("INSERT INTO projects (id, name, slug) VALUES ('p1','P','p1')").run();
  db.prepare("INSERT INTO columns (id, project_id, name, position, github_state) VALUES ('c-todo','p1','Todo',0,'open'), ('c-done','p1','Done',1,'closed')").run();
  db.prepare("INSERT INTO swimlanes (id, project_id, name, position) VALUES ('s1','p1','Default',0)").run();
  db.prepare("INSERT INTO users (id, email, name, role) VALUES ('u1','maria@lexa.test','Maria','member')").run();
  db.prepare("INSERT INTO priority_options (id, project_id, label, color, position) VALUES ('prio-1','p1','Medium','#888',0), ('prio-2','p1','High','#f00',1)").run();
  db.prepare("INSERT INTO type_options (id, project_id, label, color, position) VALUES ('type-1','p1','Bug','#f00',0), ('type-2','p1','Feature','#0f0',1)").run();
  db.prepare("INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, description, priority, type, position, created_at) VALUES ('t1','p1','c-todo','s1','T','{\"type\":\"doc\",\"content\":[]}','prio-1','type-1','a0','2026-01-01 10:00:00')").run();
}

function makeService(db: Database) {
  const layer = TaskService.Default.pipe(Layer.provide(Layer.succeed(Sqlite, db)));
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  return Context.get(ctx, TaskService);
}

const maria: Actor = { kind: "user", label: "Maria", userId: "u1" };

afterEach(() => {
  for (const db of dbs) {
    try { db.close(); } catch {}
  }
  dbs = [];
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("TaskService emission", () => {
  it("update emits field_changed rows for each changed field", () => {
    const db = tmpDb();
    seed(db);
    const svc = makeService(db);
    Effect.runSync(
      Effect.gen(function* () {
        const { task, activity } = yield* svc.update(maria, "t1", { title: "New title", priority: "prio-2" });
        expect(task.title).toBe("New title");
        expect(activity.map((a) => a.type)).toEqual(["field_changed", "field_changed"]);
        expect(activity.map((a) => a.message)).toEqual(["Maria changed the title", "Priority changed: Medium → High"]);
      })
    );
  });

  it("move emits moved with old/new column names", () => {
    const db = tmpDb();
    seed(db);
    const svc = makeService(db);
    Effect.runSync(
      Effect.gen(function* () {
        const { task, activity } = yield* svc.move(maria, "t1", { columnId: "c-done", swimlaneId: "s1" });
        expect(task.columnId).toBe("c-done");
        expect(activity.map((a) => a.type)).toEqual(["moved"]);
        expect(activity[0]!.message).toBe("Maria moved from Todo to Done");
        // position-only reorder in the same column → NO activity row
        const { activity: reorder } = yield* svc.move(maria, "t1", { columnId: "c-done", swimlaneId: "s1" });
        expect(reorder).toEqual([]);
      })
    );
  });

  it("moveFromWebhook emits github_synced, not moved", () => {
    const db = tmpDb();
    seed(db);
    db.prepare("INSERT INTO task_github_issues (task_id, issue_id, issue_number, repo) VALUES ('t1','ghi1',7,'owner/repo')").run();
    const svc = makeService(db);
    Effect.runSync(
      Effect.gen(function* () {
        const task = yield* svc.moveFromWebhook("ghi1", "c-done", "closed");
        expect(task.columnId).toBe("c-done");
      })
    );
    const rows = db.prepare("SELECT type, message, actor_kind, actor_label FROM task_activity WHERE task_id = 't1'").all() as { type: string; message: string; actor_kind: string; actor_label: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe("github_synced");
    expect(rows[0]!.message).toBe("Issue #7 closed on GitHub — task moved to Done");
    expect(rows[0]!.actor_kind).toBe("system");
    expect(rows[0]!.actor_label).toBe("github");
  });

  it("create and archive emit created/archived rows", () => {
    const db = tmpDb();
    seed(db);
    const svc = makeService(db);
    Effect.runSync(
      Effect.gen(function* () {
        const { task, activity } = yield* svc.create(maria, {
          projectId: "p1", columnId: "c-todo", swimlaneId: "s1",
          title: "New task", priority: "prio-1", type: "type-1",
        });
        expect(activity.map((a) => a.type)).toEqual(["created"]);
        expect(activity[0]!.message).toBe("Maria created this task");
        const { activity: archived } = yield* svc.archive(maria, task.id);
        expect(archived.map((a) => a.type)).toEqual(["archived"]);
        const { activity: restored } = yield* svc.restore(maria, task.id);
        expect(restored.map((a) => a.type)).toEqual(["restored"]);
      })
    );
  });
});
