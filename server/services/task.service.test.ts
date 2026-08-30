import { describe, expect, it, afterEach, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer, Context, Either } from "effect";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { Sqlite, initSqlite, ConstraintViolation } from "../db/database";
import { TaskService, isEmptyDoc } from "./task.service";
import { WipLimitExceeded, RequiredFieldMissing, DeadlineAfterLane, SwimlaneNotFound } from "../api/errors";
import type { Actor, TipTapDoc } from "../../shared/types";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

let dir: string;
let db: Database;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "lexa-task-svc-"));
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
  db.prepare("INSERT INTO projects (id, name, slug, key) VALUES ('p1','P','p1','EG')").run();
  db.prepare("INSERT INTO projects (id, name, slug, key) VALUES ('p2','P2','p2','WC')").run();
  db.prepare("INSERT INTO columns (id, project_id, name, position, github_state) VALUES ('c-todo','p1','Todo',0,'open'), ('c-done','p1','Done',1,'closed'), ('c-p2','p2','Todo',0,'open')").run();
  db.prepare("INSERT INTO swimlanes (id, project_id, name, position, kind) VALUES ('s1','p1','Default',0,'backlog')").run();
  db.prepare("INSERT INTO swimlanes (id, project_id, name, position, kind) VALUES ('s-p2','p2','Backlog',0,'backlog')").run();
  db.prepare("INSERT INTO users (id, email, name, role) VALUES ('u1','maria@lexa.test','Maria','member')").run();
  db.prepare("INSERT INTO priority_options (id, project_id, label, color, position) VALUES ('prio-1','p1','Medium','#888',0), ('prio-2','p1','High','#f00',1), ('prio-p2','p2','Medium','#888',0)").run();
  db.prepare("INSERT INTO type_options (id, project_id, label, color, position) VALUES ('type-1','p1','Bug','#f00',0), ('type-2','p1','Feature','#0f0',1), ('type-p2','p2','Task','#0f0',0)").run();
  db.prepare("INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, description, priority, type, position, created_at) VALUES ('t1','p1','c-todo','s1','T','{\"type\":\"doc\",\"content\":[]}','prio-1','type-1','a0','2026-01-01 10:00:00')").run();
}

function makeService(db: Database) {
  const layer = TaskService.Default.pipe(Layer.provide(Layer.succeed(Sqlite, db)));
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  return Context.get(ctx, TaskService);
}

const maria: Actor = { kind: "user", label: "Maria", userId: "u1" };

describe("TaskService emission", () => {
  it("update emits field_changed rows for each changed field", () => {
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

  it("move emits moved with old/new column names; a same-cell move emits nothing", () => {
    seed(db);
    const svc = makeService(db);
    Effect.runSync(
      Effect.gen(function* () {
        const { task, activity } = yield* svc.move(maria, "t1", { columnId: "c-done", swimlaneId: "s1" });
        expect(task.columnId).toBe("c-done");
        expect(activity.map((a) => a.type)).toEqual(["moved"]);
        expect(activity[0]!.message).toBe("Maria moved from Todo to Done");
        // Same cell + no anchors → the service short-circuits before any move.
        const { activity: reorder } = yield* svc.move(maria, "t1", { columnId: "c-done", swimlaneId: "s1" });
        expect(reorder).toEqual([]);
      })
    );
  });

  it("moveFromWebhook emits github_synced, not moved", () => {
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

const REAL_DESC: TipTapDoc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }] };
const EMPTY_DOC: TipTapDoc = { type: "doc", content: [] };
const WS_DOC: TipTapDoc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "  " }] }] };

// c-todo: WIP limit 1, no required fields. c-done: no limit, no required.
function seedWip(db: Database) {
  db.prepare("INSERT INTO projects (id, name, slug) VALUES ('p1','P','p1')").run();
  db.prepare("INSERT INTO columns (id, project_id, name, position, wip_limit, github_state) VALUES ('c-todo','p1','Todo',0,1,'open'), ('c-done','p1','Done',1,NULL,'closed')").run();
  db.prepare("INSERT INTO swimlanes (id, project_id, name, position) VALUES ('s1','p1','Default',0)").run();
  db.prepare("INSERT INTO users (id, email, name, role) VALUES ('u1','maria@lexa.test','Maria','member')").run();
  db.prepare("INSERT INTO priority_options (id, project_id, label, color, position) VALUES ('prio-1','p1','Medium','#888',0)").run();
  db.prepare("INSERT INTO type_options (id, project_id, label, color, position) VALUES ('type-1','p1','Bug','#f00',0)").run();
  db.prepare("INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, description, priority, type, position, created_at) VALUES ('t1','p1','c-todo','s1','T1','{\"type\":\"doc\",\"content\":[{\"type\":\"paragraph\",\"content\":[{\"type\":\"text\",\"text\":\"hi\"}]}]}','prio-1','type-1','a0','2026-01-01 10:00:00')").run();
  db.prepare("INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, description, priority, type, position, created_at) VALUES ('t3','p1','c-todo','s1','T3','{\"type\":\"doc\",\"content\":[]}','prio-1','type-1','a1','2026-01-01 10:00:00')").run();
  db.prepare("INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, description, priority, type, position, created_at) VALUES ('t2','p1','c-done','s1','T2','{\"type\":\"doc\",\"content\":[{\"type\":\"paragraph\",\"content\":[{\"type\":\"text\",\"text\":\"hi\"}]}]}','prio-1','type-1','a0','2026-01-01 10:00:00')").run();
}

// c-todo requires description; c-done requires assignee.
function seedRequired(db: Database) {
  db.prepare("INSERT INTO projects (id, name, slug) VALUES ('p1','P','p1')").run();
  db.prepare("INSERT INTO columns (id, project_id, name, position, required_fields, github_state) VALUES ('c-todo','p1','Todo',0,'[\"description\"]','open'), ('c-done','p1','Done',1,'[\"assignee\"]','closed')").run();
  db.prepare("INSERT INTO swimlanes (id, project_id, name, position) VALUES ('s1','p1','Default',0)").run();
  db.prepare("INSERT INTO users (id, email, name, role) VALUES ('u1','maria@lexa.test','Maria','member')").run();
  db.prepare("INSERT INTO priority_options (id, project_id, label, color, position) VALUES ('prio-1','p1','Medium','#888',0)").run();
  db.prepare("INSERT INTO type_options (id, project_id, label, color, position) VALUES ('type-1','p1','Bug','#f00',0)").run();
  db.prepare("INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, description, priority, type, position, created_at) VALUES ('t1','p1','c-todo','s1','T1','{\"type\":\"doc\",\"content\":[{\"type\":\"paragraph\",\"content\":[{\"type\":\"text\",\"text\":\"hi\"}]}]}','prio-1','type-1','a0','2026-01-01 10:00:00')").run();
  db.prepare("INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, description, priority, type, position, created_at) VALUES ('t2','p1','c-done','s1','T2','{\"type\":\"doc\",\"content\":[]}','prio-1','type-1','a0','2026-01-01 10:00:00')").run();
}

// s-backlog (backlog, no deadline) + m1 (milestone, due 2026-06-01).
function seedDeadline(db: Database) {
  db.prepare("INSERT INTO projects (id, name, slug) VALUES ('p1','P','p1')").run();
  db.prepare("INSERT INTO columns (id, project_id, name, position, github_state) VALUES ('c-todo','p1','Todo',0,'open')").run();
  db.prepare("INSERT INTO swimlanes (id, project_id, name, position, kind) VALUES ('s-backlog','p1','Backlog',0,'backlog')").run();
  db.prepare("INSERT INTO swimlanes (id, project_id, name, position, kind, due_at) VALUES ('m1','p1','Milestone',1,'sprint','2026-06-01')").run();
  db.prepare("INSERT INTO users (id, email, name, role) VALUES ('u1','maria@lexa.test','Maria','member')").run();
  db.prepare("INSERT INTO priority_options (id, project_id, label, color, position) VALUES ('prio-1','p1','Medium','#888',0)").run();
  db.prepare("INSERT INTO type_options (id, project_id, label, color, position) VALUES ('type-1','p1','Bug','#f00',0)").run();
  db.prepare("INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, description, priority, type, position, created_at) VALUES ('t1','p1','c-todo','m1','T1','{\"type\":\"doc\",\"content\":[]}','prio-1','type-1','a0','2026-01-01 10:00:00')").run();
  db.prepare("INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, description, priority, type, position, due_at, created_at) VALUES ('t2','p1','c-todo','s-backlog','T2','{\"type\":\"doc\",\"content\":[]}','prio-1','type-1','a1','2026-07-01','2026-01-01 10:00:00')").run();
}

describe("TaskService WIP + positions", () => {
  it("move into a column at its WIP limit is rejected atomically", () => {
    seedWip(db);
    const svc = makeService(db);
    Effect.runSync(
      Effect.gen(function* () {
        const result = yield* Effect.either(svc.move(maria, "t2", { columnId: "c-todo", swimlaneId: "s1" }));
        expect(Either.isLeft(result)).toBe(true);
        if (Either.isLeft(result)) {
          expect(result.left).toBeInstanceOf(WipLimitExceeded);
          const wip = result.left as WipLimitExceeded;
          expect(wip.columnName).toBe("Todo");
          expect(wip.limit).toBe(1);
          expect(wip.current).toBe(2); // t1 + t3 occupy c-todo
        }
        // The task was not moved.
        const row = db.prepare("SELECT column_id FROM tasks WHERE id = 't2'").get() as { column_id: string };
        expect(row.column_id).toBe("c-done");
        // No activity row for the failed move.
        const n = (db.prepare("SELECT COUNT(*) AS n FROM task_activity WHERE task_id = 't2'").get() as { n: number }).n;
        expect(n).toBe(0);
      })
    );
  });

  it("within-column reorder is allowed even at the WIP limit", () => {
    seedWip(db);
    const svc = makeService(db);
    Effect.runSync(
      Effect.gen(function* () {
        // c-todo holds t1 (a0) + t3 (a1) with limit 1 — reordering inside the
        // same column must short-circuit the count check.
        const { task, activity } = yield* svc.move(maria, "t1", { columnId: "c-todo", swimlaneId: "s1", beforeTaskId: "t3" });
        expect(task.position).toBe("a2");
        expect(activity).toEqual([]); // position-only reorder emits nothing
        const t3 = db.prepare("SELECT position FROM tasks WHERE id = 't3'").get() as { position: string };
        expect(t3.position < task.position).toBe(true);
      })
    );
  });

  it("neighborless move appends to the end of the target column", () => {
    seedWip(db);
    // c-done already holds t2 (a0) + d1 (a1) — the new task must land after d1.
    db.prepare("INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, created_at) VALUES ('d1','p1','c-done','s1','D1','a1','2026-01-01 10:00:00')").run();
    const svc = makeService(db);
    Effect.runSync(
      Effect.gen(function* () {
        const { task } = yield* svc.move(maria, "t1", { columnId: "c-done", swimlaneId: "s1" });
        expect(task.position).toBe("a2"); // keyAfter('a1')
        expect(task.position > "a1").toBe(true);
      })
    );
  });

  it("a position conflict surfaces as ConstraintViolation after the one-shot retry", () => {
    seedWip(db);
    // d2 occupies exactly the key keyBetween('a1','a2') would generate.
    db.prepare("INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, created_at) VALUES ('d1','p1','c-done','s1','D1','a1','2026-01-01 10:00:00')").run();
    db.prepare("INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, created_at) VALUES ('d2','p1','c-done','s1','D2','a1V','2026-01-01 10:00:00')").run();
    db.prepare("INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, created_at) VALUES ('d3','p1','c-done','s1','D3','a2','2026-01-01 10:00:00')").run();
    const svc = makeService(db);
    Effect.runSync(
      Effect.gen(function* () {
        const result = yield* Effect.either(svc.move(maria, "t1", { columnId: "c-done", swimlaneId: "s1", afterTaskId: "d1", beforeTaskId: "d3" }));
        expect(Either.isLeft(result)).toBe(true);
        if (Either.isLeft(result)) {
          expect(result.left).toBeInstanceOf(ConstraintViolation);
          expect((result.left as ConstraintViolation).isPositionConflict).toBe(true);
        }
        // t1 stayed put — the failed move was rolled back.
        const row = db.prepare("SELECT column_id, position FROM tasks WHERE id = 't1'").get() as { column_id: string; position: string };
        expect(row.column_id).toBe("c-todo");
        expect(row.position).toBe("a0");
      })
    );
  });

  it("move succeeds when it exactly fills the last free slot (count = limit - 1)", () => {
    seedWip(db);
    // c-todo holds 2 tasks (t1, t3); a limit of 3 leaves exactly one free slot.
    db.prepare("UPDATE columns SET wip_limit = 3 WHERE id = 'c-todo'").run();
    const svc = makeService(db);
    Effect.runSync(
      Effect.gen(function* () {
        const result = yield* Effect.either(svc.move(maria, "t2", { columnId: "c-todo", swimlaneId: "s1" }));
        expect(Either.isRight(result)).toBe(true);
        if (Either.isRight(result)) {
          expect(result.right.task.columnId).toBe("c-todo");
          expect(result.right.task.position).toBe("a2"); // keyAfter(t3 'a1')
        }
      })
    );
  });

  it("a reorder between two existing neighbors emits no activity", () => {
    seedWip(db);
    // c-todo: t1 (a0), t3 (a1), t4 (a2). Reorder t1 between t3 and t4.
    db.prepare("INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, created_at) VALUES ('t4','p1','c-todo','s1','T4','a2','2026-01-01 10:00:00')").run();
    const svc = makeService(db);
    Effect.runSync(
      Effect.gen(function* () {
        const { task, activity } = yield* svc.move(maria, "t1", { columnId: "c-todo", swimlaneId: "s1", afterTaskId: "t3", beforeTaskId: "t4" });
        expect(task.position).toBe("a1V"); // keyBetween('a1','a2')
        expect(activity).toEqual([]); // position-only reorder emits nothing
        const t3 = db.prepare("SELECT position FROM tasks WHERE id = 't3'").get() as { position: string };
        const t4 = db.prepare("SELECT position FROM tasks WHERE id = 't4'").get() as { position: string };
        expect(t3.position < task.position).toBe(true);
        expect(task.position < t4.position).toBe(true);
      })
    );
  });
});

describe("TaskService required fields", () => {
  it("isEmptyDoc treats an image-only description as non-empty", () => {
    const IMG_DOC: TipTapDoc = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "image", attrs: { src: "https://x.com/i.png" } }] }],
    };
    expect(isEmptyDoc(IMG_DOC)).toBe(false);
    expect(isEmptyDoc(EMPTY_DOC)).toBe(true);
  });

  it("create rejects an empty or whitespace-only description (TipTap-aware)", () => {
    seedRequired(db);
    const svc = makeService(db);
    Effect.runSync(
      Effect.gen(function* () {
        const empty = yield* Effect.either(svc.create(maria, { projectId: "p1", columnId: "c-todo", swimlaneId: "s1", title: "X", description: EMPTY_DOC }));
        expect(Either.isLeft(empty)).toBe(true);
        if (Either.isLeft(empty)) {
          expect(empty.left).toBeInstanceOf(RequiredFieldMissing);
          const req = empty.left as RequiredFieldMissing;
          expect(req.field).toBe("description");
          expect(req.columnName).toBe("Todo");
        }
        const ws = yield* Effect.either(svc.create(maria, { projectId: "p1", columnId: "c-todo", swimlaneId: "s1", title: "X", description: WS_DOC }));
        expect(Either.isLeft(ws)).toBe(true);
        if (Either.isLeft(ws)) expect(ws.left).toBeInstanceOf(RequiredFieldMissing);
        const ok = yield* Effect.either(svc.create(maria, { projectId: "p1", columnId: "c-todo", swimlaneId: "s1", title: "X", description: REAL_DESC }));
        expect(Either.isRight(ok)).toBe(true);
      })
    );
  });

  it("move validates required fields against the target column", () => {
    seedRequired(db);
    const svc = makeService(db);
    Effect.runSync(
      Effect.gen(function* () {
        // t1 has no assignees — moving into c-done (requires assignee) fails.
        const blocked = yield* Effect.either(svc.move(maria, "t1", { columnId: "c-done", swimlaneId: "s1" }));
        expect(Either.isLeft(blocked)).toBe(true);
        if (Either.isLeft(blocked)) {
          expect(blocked.left).toBeInstanceOf(RequiredFieldMissing);
          expect((blocked.left as RequiredFieldMissing).field).toBe("assignee");
        }
        yield* svc.update(maria, "t1", { assignees: ["Maria"] });
        const ok = yield* Effect.either(svc.move(maria, "t1", { columnId: "c-done", swimlaneId: "s1" }));
        expect(Either.isRight(ok)).toBe(true);
      })
    );
  });

  it("update rejects clearing a required description", () => {
    seedRequired(db);
    const svc = makeService(db);
    Effect.runSync(
      Effect.gen(function* () {
        const result = yield* Effect.either(svc.update(maria, "t1", { description: EMPTY_DOC }));
        expect(Either.isLeft(result)).toBe(true);
        if (Either.isLeft(result)) {
          expect(result.left).toBeInstanceOf(RequiredFieldMissing);
          expect((result.left as RequiredFieldMissing).field).toBe("description");
        }
        const ok = yield* Effect.either(svc.update(maria, "t1", { title: "Renamed" }));
        expect(Either.isRight(ok)).toBe(true);
      })
    );
  });
});

describe("TaskService swimlane + deadline", () => {
  it("create without swimlaneId lands in the project's backlog lane", () => {
    seedDeadline(db);
    const svc = makeService(db);
    Effect.runSync(
      Effect.gen(function* () {
        const { task } = yield* svc.create(maria, { projectId: "p1", columnId: "c-todo", title: "New task" });
        expect(task.swimlaneId).toBe("s-backlog");
      })
    );
  });

  it("create rejects a due date later than the lane's deadline", () => {
    seedDeadline(db);
    const svc = makeService(db);
    Effect.runSync(
      Effect.gen(function* () {
        const late = yield* Effect.either(svc.create(maria, { projectId: "p1", columnId: "c-todo", swimlaneId: "m1", title: "Late", dueAt: "2026-07-01" }));
        expect(Either.isLeft(late)).toBe(true);
        if (Either.isLeft(late)) {
          expect(late.left).toBeInstanceOf(DeadlineAfterLane);
          expect((late.left as DeadlineAfterLane).date).toBe("2026-06-01");
        }
        const ok = yield* Effect.either(svc.create(maria, { projectId: "p1", columnId: "c-todo", swimlaneId: "m1", title: "Ok", dueAt: "2026-05-01" }));
        expect(Either.isRight(ok)).toBe(true);
        if (Either.isRight(ok)) expect(ok.right.task.dueAt).toBe("2026-05-01");
      })
    );
  });

  it("update rejects a due date later than the lane's deadline", () => {
    seedDeadline(db);
    const svc = makeService(db);
    Effect.runSync(
      Effect.gen(function* () {
        // t1 lives in m1 (due 2026-06-01).
        const late = yield* Effect.either(svc.update(maria, "t1", { dueAt: "2026-07-01" }));
        expect(Either.isLeft(late)).toBe(true);
        if (Either.isLeft(late)) {
          expect(late.left).toBeInstanceOf(DeadlineAfterLane);
          expect((late.left as DeadlineAfterLane).date).toBe("2026-06-01");
        }
        const ok = yield* Effect.either(svc.update(maria, "t1", { dueAt: "2026-05-01" }));
        expect(Either.isRight(ok)).toBe(true);
        if (Either.isRight(ok)) expect(ok.right.task.dueAt).toBe("2026-05-01");
      })
    );
  });

  it("move rejects when the task's due date exceeds the target lane's deadline; clearDueAt bypasses", () => {
    seedDeadline(db);
    const svc = makeService(db);
    Effect.runSync(
      Effect.gen(function* () {
        // t2 (due 2026-07-01) in the backlog; m1's deadline is 2026-06-01.
        const blocked = yield* Effect.either(svc.move(maria, "t2", { columnId: "c-todo", swimlaneId: "m1" }));
        expect(Either.isLeft(blocked)).toBe(true);
        if (Either.isLeft(blocked)) {
          expect(blocked.left).toBeInstanceOf(DeadlineAfterLane);
          expect((blocked.left as DeadlineAfterLane).date).toBe("2026-06-01");
        }
        const cleared = yield* Effect.either(svc.move(maria, "t2", { columnId: "c-todo", swimlaneId: "m1", clearDueAt: true }));
        expect(Either.isRight(cleared)).toBe(true);
        if (Either.isRight(cleared)) expect(cleared.right.task.dueAt).toBeNull();
      })
    );
  });

  it("a dueAt exactly equal to the lane's deadline is allowed on create, update, and move", () => {
    seedDeadline(db);
    const svc = makeService(db);
    Effect.runSync(
      Effect.gen(function* () {
        // create: dueAt === lane dueAt (2026-06-01) → allowed (guard is strictly-after)
        const created = yield* Effect.either(svc.create(maria, { projectId: "p1", columnId: "c-todo", swimlaneId: "m1", title: "Equal", dueAt: "2026-06-01" }));
        expect(Either.isRight(created)).toBe(true);
        // update: t1 lives in m1; setting dueAt to the lane deadline → allowed
        const updated = yield* Effect.either(svc.update(maria, "t1", { dueAt: "2026-06-01" }));
        expect(Either.isRight(updated)).toBe(true);
        if (Either.isRight(updated)) expect(updated.right.task.dueAt).toBe("2026-06-01");
        // move: t3 (dueAt equal to m1's deadline) moves into m1 → allowed
        db.prepare("INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, due_at, created_at) VALUES ('t3','p1','c-todo','s-backlog','T3','a5','2026-06-01','2026-01-01 10:00:00')").run();
        const moved = yield* Effect.either(svc.move(maria, "t3", { columnId: "c-todo", swimlaneId: "m1" }));
        expect(Either.isRight(moved)).toBe(true);
        if (Either.isRight(moved)) expect(moved.right.task.dueAt).toBe("2026-06-01");
      })
    );
  });

  it("update with dueAt: null clears the deadline even when the lane has one", () => {
    seedDeadline(db);
    db.prepare("UPDATE tasks SET due_at = '2026-06-01' WHERE id = 't1'").run();
    const svc = makeService(db);
    Effect.runSync(
      Effect.gen(function* () {
        const result = yield* Effect.either(svc.update(maria, "t1", { dueAt: null }));
        expect(Either.isRight(result)).toBe(true);
        if (Either.isRight(result)) expect(result.right.task.dueAt).toBeNull();
      })
    );
  });

  it("move into an archived lane is rejected", () => {
    seedDeadline(db);
    db.prepare("UPDATE swimlanes SET archived_at = '2026-03-01T00:00:00.000Z' WHERE id = 'm1'").run();
    const svc = makeService(db);
    Effect.runSync(
      Effect.gen(function* () {
        const result = yield* Effect.either(svc.move(maria, "t2", { columnId: "c-todo", swimlaneId: "m1" }));
        expect(Either.isLeft(result)).toBe(true);
        if (Either.isLeft(result)) {
          expect(result.left).toBeInstanceOf(SwimlaneNotFound);
          expect((result.left as SwimlaneNotFound).id).toBe("m1");
        }
      })
    );
  });
});

describe("TaskService ticket keys", () => {
  it("assigns sequential per-project numbers with composed keys", () => {
    seed(db);
    const svc = makeService(db);
    Effect.runSync(
      Effect.gen(function* () {
        const { task: t1 } = yield* svc.create(maria, { projectId: "p1", columnId: "c-todo", title: "One" });
        const { task: t2 } = yield* svc.create(maria, { projectId: "p1", columnId: "c-todo", title: "Two" });
        expect(t1.key).toBe("EG-1");
        expect(t2.key).toBe("EG-2");
      })
    );
  });

  it("numbers are per-project", () => {
    seed(db);
    const svc = makeService(db);
    Effect.runSync(
      Effect.gen(function* () {
        const { task: t } = yield* svc.create(maria, { projectId: "p2", columnId: "c-p2", title: "Other" });
        expect(t.key).toBe("WC-1");
      })
    );
  });
});
