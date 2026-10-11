import { describe, expect, it, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer, Context, Either } from "effect";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { Sqlite, initSqlite, ConstraintViolation } from "../db/database";
import { DbBunLive } from "../db/db";
import { TaskService } from "./task.service";
import { TaskRepo } from "../repos/task.repo";
import { WipLimitExceeded, RequiredFieldMissing, DeadlineAfterLane } from "../api/errors";
import type { Actor, TipTapDoc } from "../../shared/types";
import { generateTaskKey, parseTaskKey } from "../task-key";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

let dir: string;
let dbPath: string;
let db: Database;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "lexa-task-svc-"));
  dbPath = join(dir, "test.db");
  runMigrations(dbPath, MIGRATIONS);
  const ctx = Effect.runSync(Effect.scoped(Layer.build(initSqlite(dbPath))));
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
  const layer = TaskService.Default.pipe(Layer.provide(Layer.mergeAll(Layer.succeed(Sqlite, db), DbBunLive(db))));
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  return Context.get(ctx, TaskService);
}

// The repo-level carries (findIdsForProject chunking, the GitHub title
// aggregate) have no service surface, so they drive TaskRepo directly on the
// same migrated database.
function makeRepo(db: Database) {
  const layer = TaskRepo.Default.pipe(Layer.provide(Layer.mergeAll(Layer.succeed(Sqlite, db), DbBunLive(db))));
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  return Context.get(ctx, TaskRepo);
}

const maria: Actor = { kind: "user", label: "Maria", userId: "u1" };

describe("TaskService emission", () => {
  it("update emits field_changed rows for each changed field", async () => {
    seed(db);
    const svc = makeService(db);
    await Effect.runPromise(
      Effect.gen(function* () {
        const { task, activity } = yield* svc.update(maria, "t1", { title: "New title", priority: "prio-2" });
        expect(task.title).toBe("New title");
        expect(activity.map((a) => a.type)).toEqual(["field_changed", "field_changed"]);
        expect(activity.map((a) => a.message)).toEqual(["Maria changed the title", "Priority changed: Medium → High"]);
      })
    );
  });

  it("move emits moved with old/new column names; a same-cell move emits nothing", async () => {
    seed(db);
    const svc = makeService(db);
    await Effect.runPromise(
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

  it("moveFromWebhook emits github_synced, not moved", async () => {
    seed(db);
    db.prepare("INSERT INTO task_github_issues (task_id, issue_id, issue_number, repo) VALUES ('t1','ghi1',7,'owner/repo')").run();
    const svc = makeService(db);
    await Effect.runPromise(
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

  it("create and archive emit created/archived rows", async () => {
    seed(db);
    const svc = makeService(db);
    await Effect.runPromise(
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
  it("move into a column at its WIP limit is rejected atomically", async () => {
    seedWip(db);
    const svc = makeService(db);
    await Effect.runPromise(
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

  it("within-column reorder is allowed even at the WIP limit", async () => {
    seedWip(db);
    const svc = makeService(db);
    await Effect.runPromise(
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

  it("a position conflict surfaces as ConstraintViolation after the one-shot retry", async () => {
    seedWip(db);
    // d2 occupies exactly the key keyBetween('a1','a2') would generate.
    db.prepare("INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, created_at) VALUES ('d1','p1','c-done','s1','D1','a1','2026-01-01 10:00:00')").run();
    db.prepare("INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, created_at) VALUES ('d2','p1','c-done','s1','D2','a1V','2026-01-01 10:00:00')").run();
    db.prepare("INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, created_at) VALUES ('d3','p1','c-done','s1','D3','a2','2026-01-01 10:00:00')").run();
    const svc = makeService(db);
    await Effect.runPromise(
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

});

describe("TaskService required fields", () => {
  it("create rejects an empty or whitespace-only description (TipTap-aware)", async () => {
    seedRequired(db);
    const svc = makeService(db);
    await Effect.runPromise(
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

  it("move validates required fields against the target column", async () => {
    seedRequired(db);
    const svc = makeService(db);
    await Effect.runPromise(
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

  it("update rejects clearing a required description", async () => {
    seedRequired(db);
    const svc = makeService(db);
    await Effect.runPromise(
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
  it("create rejects a due date later than the lane's deadline", async () => {
    seedDeadline(db);
    const svc = makeService(db);
    await Effect.runPromise(
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

  it("update rejects a due date later than the lane's deadline", async () => {
    seedDeadline(db);
    const svc = makeService(db);
    await Effect.runPromise(
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

  it("move rejects when the task's due date exceeds the target lane's deadline; clearDueAt bypasses", async () => {
    seedDeadline(db);
    const svc = makeService(db);
    await Effect.runPromise(
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

  it("same-cell move with clearDueAt emits a due-date field_changed row; a reorder still emits nothing", async () => {
    seedDeadline(db);
    const svc = makeService(db);
    await Effect.runPromise(
      Effect.gen(function* () {
        // t2 (due 2026-07-01) stays in c-todo/s-backlog — clearing the due
        // date must still be audited even though no column/lane changed.
        const { task, activity } = yield* svc.move(maria, "t2", { columnId: "c-todo", swimlaneId: "s-backlog", clearDueAt: true });
        expect(task.dueAt).toBeNull();
        expect(activity.map((a) => a.type)).toEqual(["field_changed"]);
        expect(activity[0]!.message).toBe("Due date cleared");
        // Position-only reorder must not add an activity row.
        const { activity: reorder } = yield* svc.move(maria, "t2", { columnId: "c-todo", swimlaneId: "s-backlog", beforeTaskId: "t1" });
        expect(reorder).toEqual([]);
      })
    );
  });

});

describe("TaskService ticket keys", () => {
  it("assigns sequential per-project numbers with composed keys", async () => {
    seed(db);
    const svc = makeService(db);
    await Effect.runPromise(
      Effect.gen(function* () {
        const { task: t1 } = yield* svc.create(maria, { projectId: "p1", columnId: "c-todo", title: "One" });
        const { task: t2 } = yield* svc.create(maria, { projectId: "p1", columnId: "c-todo", title: "Two" });
        expect(t1.key).toBe("EG-1");
        expect(t2.key).toBe("EG-2");
      })
    );
  });

  it("numbers are per-project", async () => {
    seed(db);
    const svc = makeService(db);
    await Effect.runPromise(
      Effect.gen(function* () {
        const { task: t } = yield* svc.create(maria, { projectId: "p2", columnId: "c-p2", title: "Other" });
        expect(t.key).toBe("WC-1");
      })
    );
  });

  it("a failed insert rolls back the counter increment (no burned number)", async () => {
    seed(db);
    // Pin the counter so the incremented value collides with an existing
    // ticket number: the INSERT fails and the whole batch must roll back.
    db.prepare("UPDATE projects SET next_task_number = 0 WHERE id = 'p1'").run();
    db.prepare(
      `INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, description, priority, type, position, number, key)
       VALUES ('blocker','p1','c-todo','s1','B','{}','prio-1','type-1','a1',1,'EG-1')`
    ).run();
    const svc = makeService(db);
    await Effect.runPromise(
      Effect.gen(function* () {
        const res = yield* Effect.either(svc.create(maria, { projectId: "p1", columnId: "c-todo", title: "X" }));
        expect(Either.isLeft(res)).toBe(true);
        if (Either.isLeft(res)) expect(res.left._tag).toBe("ConstraintViolation");
      })
    );
    const project = db.prepare("SELECT next_task_number FROM projects WHERE id = 'p1'").get() as { next_task_number: number };
    expect(project.next_task_number).toBe(0);
    const created = db.prepare("SELECT COUNT(*) c FROM tasks WHERE title = 'X'").get() as { c: number };
    expect(created.c).toBe(0);
  });

  it("concurrent creates from two connections allocate distinct, unique keys", async () => {
    seed(db);
    const second = new Database(dbPath);
    second.exec("PRAGMA busy_timeout = 5000");
    second.exec("PRAGMA foreign_keys = ON");
    try {
      const svcA = makeService(db);
      const svcB = makeService(second);
      const [a, b] = await Effect.runPromise(
        Effect.all(
          [
            svcA.create(maria, { projectId: "p1", columnId: "c-todo", title: "A" }),
            svcB.create(maria, { projectId: "p1", columnId: "c-todo", title: "B" }),
          ],
          { concurrency: 2 }
        )
      );
      const keys = [a.task.key, b.task.key].sort();
      expect(keys).toEqual(["EG-1", "EG-2"]);
      const rows = db.prepare("SELECT number FROM tasks WHERE project_id = 'p1' AND number IS NOT NULL ORDER BY number").all() as { number: number }[];
      expect(rows.map((r) => r.number)).toEqual([1, 2]);
    } finally {
      second.close();
    }
  });
});

// Carried from the absorbed server/repos/task.repo.test.ts: the archived-anchor
// collision (a new task must not reuse an archived task's position), the
// GitHub issue-title round-trip through the JSON aggregate, and the D1
// 100-bound-param chunking of findByIdsForProject.
describe("TaskRepo carries — archived anchor, GitHub title, D1 chunk bound", () => {
  it("creates a task after an archived last position instead of colliding with it", async () => {
    seed(db);
    db.prepare(
      `INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, description, priority, type, position, created_at, archived_at)
       VALUES ('t-arch','p1','c-todo','s1','Archived','{"type":"doc","content":[]}','prio-1','type-1','a1','2026-01-02 10:00:00','2026-01-03 10:00:00')`
    ).run();
    const svc = makeService(db);
    const { task } = await Effect.runPromise(
      svc.create(maria, { projectId: "p1", columnId: "c-todo", title: "New", priority: "prio-1", type: "type-1" })
    );
    expect(task.position > "a1").toBe(true);
    const positions = db.prepare("SELECT position FROM tasks WHERE column_id = 'c-todo' ORDER BY position").all() as { position: string }[];
    expect(positions.map((r) => r.position)).toEqual(["a0", "a1", task.position]);
  });

  it("round-trips a GitHub issue title containing || and commas through the SQL aggregate", async () => {
    seed(db);
    const repo = makeRepo(db);
    await Effect.runPromise(
      repo.setGithubLink("t1", { issueId: "ghi9", issueNumber: 9, repo: "owner/repo", title: "a || b, c" })
    );
    const svc = makeService(db);
    const task = await Effect.runPromise(svc.getById("t1"));
    expect(task.githubs).toHaveLength(1);
    expect(task.githubs[0]!.title).toBe("a || b, c");
  });

  it("chunks findByIdsForProject at the D1 100-param bound and returns every row once", async () => {
    seed(db);
    const insert = db.prepare(
      `INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, description, priority, type, position, created_at)
       VALUES (?, 'p1', 'c-todo', 's1', ?, '{"type":"doc","content":[]}', 'prio-1', 'type-1', ?, '2026-01-01 10:00:00')`
    );
    const ids = Array.from({ length: 120 }, (_, i) => `chunk-${i}`);
    for (let i = 0; i < ids.length; i++) insert.run(ids[i]!, `Chunk ${i}`, `k${String(i).padStart(3, "0")}`);
    const repo = makeRepo(db);
    // 120 ids span two chunks — every id must come back exactly once.
    const rows = await Effect.runPromise(repo.findByIdsForProject("p1", ids));
    expect(rows).toHaveLength(120);
    expect(new Set(rows.map((r) => r.id)).size).toBe(120);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get("chunk-0")!.description).toEqual({ type: "doc", content: [] });
    expect(byId.get("chunk-119")!.title).toBe("Chunk 119");
  });
});

describe("generateTaskKey", () => {
  it("multi-word slug → word initials", () => {
    expect(generateTaskKey("emberfall-godot", () => false)).toBe("EG");
    expect(generateTaskKey("web-client", () => false)).toBe("WC");
    expect(generateTaskKey("project-management-tool", () => false)).toBe("PMT");
  });
  it("single word → first letter + consonants", () => {
    expect(generateTaskKey("platform", () => false)).toBe("PLT");
    expect(generateTaskKey("api", () => false)).toBe("AP");
    expect(generateTaskKey("web", () => false)).toBe("WB");
  });
  it("collision → extend with next letters of last word", () => {
    const taken = new Set(["WC"]);
    expect(generateTaskKey("web-crawler", (c) => taken.has(c))).toBe("WCR");
  });
  it("exhausted extension → digit suffix", () => {
    const taken = new Set(["PLT", "PLTL", "PLTLA", "PLTLAT", "PLTLATF", "PLTLATFO", "PLTLATFOR", "PLTLATFORM"]);
    expect(generateTaskKey("platform", (c) => taken.has(c))).toBe("PLT2");
  });
  it("digits in slug skipped for initials", () => {
    expect(generateTaskKey("game-jam-2026", () => false)).toBe("GJ");
  });
});

describe("parseTaskKey", () => {
  it("parses valid keys, case-insensitive", () => {
    expect(parseTaskKey("EMB-12")).toEqual({ prefix: "EMB", number: 12 });
    expect(parseTaskKey("emb-12")).toEqual({ prefix: "EMB", number: 12 });
  });
  it("rejects malformed", () => {
    expect(parseTaskKey("EMB-")).toBeNull();
    expect(parseTaskKey("EMB-abc")).toBeNull();
    expect(parseTaskKey("EMB-0")).toEqual({ prefix: "EMB", number: 0 });
    expect(parseTaskKey("a-1")).toBeNull();       // prefix too short
    expect(parseTaskKey("ABCDEFG-1")).toBeNull(); // prefix too long
    expect(parseTaskKey("t1")).toBeNull();        // UUID-ish, not a key
  });
});
