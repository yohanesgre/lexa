import { describe, expect, it, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer, Context, Either } from "effect";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { Sqlite, initSqlite } from "../db/database";
import { DbBunLive } from "../db/db";
import { SwimlaneService } from "./swimlane.service";
import {
  buildSwimlaneArchiveBatch,
  buildMilestoneArchiveBatch,
  buildSwimlaneRestoreBatch,
  buildMilestoneRestoreBatch,
} from "../repos/cascade-batch";
import type { BatchStmt } from "../repos/task-batch";
import {
  HasChildren,
  BacklogProtected,
  DeadlineAfterLane,
  InvalidArgs,
} from "../api/errors";
import type { Actor } from "../../shared/types";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

let dir: string;
let db: Database;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "lexa-swimlane-svc-"));
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
  db.prepare("INSERT INTO swimlanes (id, project_id, name, position, kind) VALUES ('s-backlog','p1','Backlog',0,'backlog')").run();
  db.prepare("INSERT INTO swimlanes (id, project_id, name, position, kind, due_at) VALUES ('m1','p1','Milestone 1',1,'sprint','2026-06-01')").run();
  db.prepare("INSERT INTO swimlanes (id, project_id, name, position) VALUES ('m2','p1','Milestone 2',2)").run();
  db.prepare("INSERT INTO columns (id, project_id, name, position) VALUES ('c1','p1','Todo',0)").run();
  db.prepare("INSERT INTO users (id, email, name, role) VALUES ('u1','maria@lexa.test','Maria','member')").run();
  db.prepare("INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, due_at, created_at) VALUES ('t1','p1','c1','m1','T1','a0','2026-07-01','2026-01-01 10:00:00')").run();
  db.prepare("INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, created_at) VALUES ('t2','p1','c1','m1','T2','a1','2026-01-01 10:00:00')").run();
}

function makeService(db: Database) {
  const layer = SwimlaneService.Default.pipe(Layer.provide(Layer.mergeAll(Layer.succeed(Sqlite, db), DbBunLive(db))));
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  return Context.get(ctx, SwimlaneService);
}

const maria: Actor = { kind: "user", label: "Maria", userId: "u1" };

describe("SwimlaneService create", () => {
  it("rejects startAt later than dueAt (INVALID_ARGS)", async () => {
    seed(db);
    const svc = makeService(db);
    const result = await Effect.runPromise(Effect.either(svc.create({ projectId: "p1", name: "Bad", startAt: "2026-09-01", dueAt: "2026-08-01" })));
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) expect(result.left).toBeInstanceOf(InvalidArgs);
  });

});

describe("SwimlaneService update", () => {
  it("rejects shrinking the deadline past a task's due date", async () => {
    seed(db);
    const svc = makeService(db);
    const result = await Effect.runPromise(Effect.either(svc.update("m1", { dueAt: "2026-06-15" })));
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(DeadlineAfterLane);
      const err = result.left as DeadlineAfterLane;
      expect(err.date).toBe("2026-06-15");
      expect(err.taskId).toBe("t1");
      expect(err.taskTitle).toBe("T1");
    }
    // The lane is unchanged.
    const lane = db.prepare("SELECT due_at FROM swimlanes WHERE id = 'm1'").get() as { due_at: string | null };
    expect(lane.due_at).toBe("2026-06-01");
  });

  it("backlog lane rejects deadline and startAt changes (BACKLOG_PROTECTED)", async () => {
    seed(db);
    const svc = makeService(db);
    for (const patch of [{ dueAt: "2026-01-01" }, { startAt: "2026-01-01" }]) {
      const result = await Effect.runPromise(Effect.either(svc.update("s-backlog", patch)));
      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left).toBeInstanceOf(BacklogProtected);
        expect((result.left as BacklogProtected).action).toBe("deadline");
      }
    }
  });

  it("update rejects startAt > dueAt on an existing lane (INVALID_ARGS)", async () => {
    seed(db);
    const svc = makeService(db);
    const result = await Effect.runPromise(Effect.either(svc.update("m1", { startAt: "2026-09-01", dueAt: "2026-08-01" })));
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) expect(result.left).toBeInstanceOf(InvalidArgs);
  });

  it("partial PATCH validates against the lane's other bound (startAt vs dueAt)", async () => {
    seed(db);
    const svc = makeService(db);
    // m2: no dates, no tasks → set a consistent range first.
    await Effect.runPromise(svc.update("m2", { startAt: "2026-08-10", dueAt: "2026-08-30" }));
    // Lone startAt later than the lane's dueAt → InvalidArgs.
    const startLate = await Effect.runPromise(Effect.either(svc.update("m2", { startAt: "2026-09-01" })));
    expect(Either.isLeft(startLate)).toBe(true);
    if (Either.isLeft(startLate)) expect(startLate.left).toBeInstanceOf(InvalidArgs);
    // Lone dueAt earlier than the lane's startAt → InvalidArgs.
    const dueEarly = await Effect.runPromise(Effect.either(svc.update("m2", { dueAt: "2026-07-01" })));
    expect(Either.isLeft(dueEarly)).toBe(true);
    if (Either.isLeft(dueEarly)) expect(dueEarly.left).toBeInstanceOf(InvalidArgs);
    // A valid lone startAt passes and persists.
    const ok = await Effect.runPromise(Effect.either(svc.update("m2", { startAt: "2026-07-15" })));
    expect(Either.isRight(ok)).toBe(true);
    if (Either.isRight(ok)) {
      expect(ok.right.startAt).toBe("2026-07-15");
      expect(ok.right.dueAt).toBe("2026-08-30");
    }
  });

});

describe("SwimlaneService delete", () => {
  it("rejects deleting a lane with tasks", async () => {
    seed(db);
    const svc = makeService(db);
    const result = await Effect.runPromise(Effect.either(svc.delete("m1")));
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(HasChildren);
      expect((result.left as HasChildren).count).toBe(2);
    }
  });

  it("deleting the backlog lane is rejected (BACKLOG_PROTECTED)", async () => {
    seed(db);
    const svc = makeService(db);
    const result = await Effect.runPromise(Effect.either(svc.delete("s-backlog")));
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(BacklogProtected);
      expect((result.left as BacklogProtected).action).toBe("delete");
    }
    const row = db.prepare("SELECT COUNT(*) AS n FROM swimlanes WHERE id = 's-backlog'").get() as { n: number };
    expect(row.n).toBe(1);
  });
});

describe("SwimlaneService archive", () => {
  it("rejects archiving the backlog lane", async () => {
    seed(db);
    const svc = makeService(db);
    const result = await Effect.runPromise(Effect.either(svc.archive(maria, "s-backlog")));
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(BacklogProtected);
      expect((result.left as BacklogProtected).action).toBe("archive");
    }
  });

  it("archives the lane and its live tasks, emitting one activity row per task", async () => {
    seed(db);
    const svc = makeService(db);
    await Effect.runPromise(
      Effect.gen(function* () {
        const { lane, activity } = yield* svc.archive(maria, "m1");
        expect(lane.archivedAt).not.toBeNull();
        expect(activity).toHaveLength(2);
        expect(activity.map((a) => a.type)).toEqual(["archived", "archived"]);
        expect(activity[0]!.message).toBe("Maria archived this task");
        const tasks = db.prepare("SELECT id, archived_at FROM tasks WHERE swimlane_id = 'm1' ORDER BY position").all() as { id: string; archived_at: string | null }[];
        expect(tasks.map((t) => t.archived_at)).toEqual([expect.anything(), expect.anything()]);
      })
    );
  });

  it("archiving an already-archived lane is idempotent", async () => {
    seed(db);
    const svc = makeService(db);
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* svc.archive(maria, "m1");
        const second = yield* svc.archive(maria, "m1");
        expect(second.activity).toEqual([]);
      })
    );
  });

  it("a failure mid-cascade rolls back the whole batch (no partial archive, no activity)", async () => {
    seed(db);
    const svc = makeService(db);
    db.exec(`CREATE TRIGGER block_lane_archive BEFORE UPDATE ON swimlanes
             WHEN NEW.archived_at IS NOT NULL AND NEW.id = 'm1'
             BEGIN SELECT RAISE(ABORT, 'blocked archive'); END`);
    try {
      const res = await Effect.runPromise(Effect.either(svc.archive(maria, "m1")));
      expect(Either.isLeft(res)).toBe(true);
      const lane = db.prepare("SELECT archived_at FROM swimlanes WHERE id = 'm1'").get() as { archived_at: string | null };
      expect(lane.archived_at).toBeNull();
      const tasks = db.prepare("SELECT COUNT(*) n FROM tasks WHERE swimlane_id = 'm1' AND archived_at IS NOT NULL").get() as { n: number };
      expect(tasks.n).toBe(0);
      const activity = db.prepare("SELECT COUNT(*) n FROM task_activity").get() as { n: number };
      expect(activity.n).toBe(0);
    } finally {
      db.exec("DROP TRIGGER block_lane_archive");
    }
  });
});

describe("SwimlaneService restore", () => {
  it("restores the lane and its cascaded tasks, with per-task activity, and is idempotent", async () => {
    seed(db);
    const svc = makeService(db);
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* svc.archive(maria, "m1");
        const { lane, activity } = yield* svc.restore(maria, "m1");
        expect(lane.archivedAt).toBeNull();
        expect(activity).toHaveLength(2);
        expect(activity.map((a) => a.type)).toEqual(["restored", "restored"]);
        expect(activity[0]!.message).toBe("Maria restored this task");
        const second = yield* svc.restore(maria, "m1");
        expect(second.lane.archivedAt).toBeNull();
        expect(second.activity).toEqual([]);
        // Restore cascades to the tasks the archive took down.
        const tasks = db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE swimlane_id = 'm1' AND archived_at IS NOT NULL").get() as { n: number };
        expect(tasks.n).toBe(0);
      })
    );
  });

});

describe("SwimlaneService queries", () => {
  it("findByProject hides archived lanes unless includeArchived", async () => {
    seed(db);
    const svc = makeService(db);
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* svc.archive(maria, "m1");
        const live = yield* svc.findByProject("p1");
        expect(live.map((l) => l.id)).toEqual(["s-backlog", "m2"]);
        const all = yield* svc.findByProject("p1", { includeArchived: true });
        expect(all.map((l) => l.id)).toEqual(["s-backlog", "m1", "m2"]);
      })
    );
  });
});

// Carried from the absorbed server/repos/cascade-batch.test.ts: archive stamps
// are scoped, so an individually-archived sprint survives a later milestone
// archive and its own restore cascades only its own tasks.
describe("cascade-batch archive stamps", () => {
  const actor = { actorKind: "user" as const, actorLabel: "Maria", actorUserId: "u1", message: "Maria archived this task", viaAssistant: false };

  function seedCascade(database: Database) {
    database.prepare("INSERT INTO projects (id, name, slug) VALUES ('p1','P','p1')").run();
    database.prepare("INSERT INTO columns (id, project_id, name, position) VALUES ('c1','p1','Todo',0)").run();
    database.prepare("INSERT INTO users (id, email, name, role) VALUES ('u1','maria@lexa.test','Maria','member')").run();
    database.prepare("INSERT INTO milestones (id, project_id, name, position) VALUES ('ms1','p1','M1',0)").run();
    database.prepare("INSERT INTO swimlanes (id, project_id, name, position, milestone_id) VALUES ('s-live','p1','Sprint live',1,'ms1'), ('s-old','p1','Sprint old',2,'ms1')").run();
    database.prepare(
      `INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, created_at) VALUES
        ('t-live','p1','c1','s-live','L','a0','2026-01-01 10:00:00'),
        ('t-old','p1','c1','s-old','O','a1','2026-01-01 10:00:00')`
    ).run();
  }

  it("an individually-archived sprint keeps its older stamp through the milestone archive, then restores on its own", () => {
    seedCascade(db);
    const T1 = "2026-01-01T00:00:00Z";
    const T2 = "2026-08-25T10:00:00Z";
    const run = (stmts: BatchStmt[]) =>
      db.transaction(() => {
        for (const s of stmts) db.prepare(s.sql).run(...s.params);
      })();
    const stamp = (id: string): string | null => {
      const row = db.query(`SELECT archived_at FROM swimlanes WHERE id = '${id}'`).get() as { archived_at: string | null };
      return row.archived_at;
    };
    const taskStamp = (id: string): string | null => {
      const row = db.query(`SELECT archived_at FROM tasks WHERE id = '${id}'`).get() as { archived_at: string | null };
      return row.archived_at;
    };
    const restoredIds = () =>
      (db.query("SELECT task_id FROM task_activity WHERE type = 'restored' ORDER BY id").all() as { task_id: string }[]).map((r) => r.task_id);

    // T1: archive s-old on its own → it and its task take T1.
    run(buildSwimlaneArchiveBatch({ swimlaneId: "s-old", archivedAt: T1, actor }));
    // T2: archive the milestone → the already-archived sprint is skipped, s-live takes T2.
    run(buildMilestoneArchiveBatch({ milestoneId: "ms1", archivedAt: T2, actor: { ...actor, viaAssistant: true } }));

    expect(stamp("s-old")).toBe(T1);
    expect(stamp("s-live")).toBe(T2);
    expect(taskStamp("t-old")).toBe(T1);
    expect(taskStamp("t-live")).toBe(T2);

    // Restore the milestone (T2 stamp) — only T2-stamped children return; a
    // second pass is a no-op (no duplicate activity).
    const milestoneRestore = buildMilestoneRestoreBatch({ milestoneId: "ms1", milestoneArchivedAt: T2, actor: { ...actor, message: "Maria restored this task" } });
    run(milestoneRestore);
    run(milestoneRestore);

    expect(restoredIds()).toEqual(["t-live"]);
    expect(stamp("s-old")).toBe(T1);
    expect(taskStamp("t-old")).toBe(T1);
    expect(stamp("s-live")).toBeNull();
    expect(taskStamp("t-live")).toBeNull();

    // Restoring the individually-archived sprint cascades its own T1-stamped task.
    run(buildSwimlaneRestoreBatch({ swimlaneId: "s-old", swimlaneArchivedAt: T1, actor: { ...actor, message: "Maria restored this task" } }));
    expect(stamp("s-old")).toBeNull();
    expect(taskStamp("t-old")).toBeNull();
    expect(restoredIds()).toEqual(["t-live", "t-old"]);
  });
});
