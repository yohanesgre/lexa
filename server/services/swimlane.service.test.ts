import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer, Context, Either } from "effect";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { Sqlite, initSqlite } from "../db/database";
import { SwimlaneService } from "./swimlane.service";
import {
  SwimlaneNotFound,
  ProjectNotFound,
  HasChildren,
  BacklogProtected,
  DeadlineAfterLane,
  MilestoneNotFound,
  InvalidArgs,
} from "../api/errors";
import type { Actor } from "../../shared/types";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

let dirs: string[] = [];
let dbs: Database[] = [];

function tmpDb(): Database {
  const dir = mkdtempSync(join(tmpdir(), "lexa-swimlane-svc-"));
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
  db.prepare("INSERT INTO swimlanes (id, project_id, name, position, kind) VALUES ('s-backlog','p1','Backlog',0,'backlog')").run();
  db.prepare("INSERT INTO swimlanes (id, project_id, name, position, kind, due_at) VALUES ('m1','p1','Milestone 1',1,'sprint','2026-06-01')").run();
  db.prepare("INSERT INTO swimlanes (id, project_id, name, position) VALUES ('m2','p1','Milestone 2',2)").run();
  db.prepare("INSERT INTO columns (id, project_id, name, position) VALUES ('c1','p1','Todo',0)").run();
  db.prepare("INSERT INTO users (id, email, name, role) VALUES ('u1','maria@lexa.test','Maria','member')").run();
  db.prepare("INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, due_at, created_at) VALUES ('t1','p1','c1','m1','T1','a0','2026-07-01','2026-01-01 10:00:00')").run();
  db.prepare("INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, created_at) VALUES ('t2','p1','c1','m1','T2','a1','2026-01-01 10:00:00')").run();
}

function makeService(db: Database) {
  const layer = SwimlaneService.Default.pipe(Layer.provide(Layer.succeed(Sqlite, db)));
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  return Context.get(ctx, SwimlaneService);
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

describe("SwimlaneService create", () => {
  it("creates a sprint lane with dueAt appended after the last position", () => {
    const db = tmpDb();
    seed(db);
    const svc = makeService(db);
    Effect.runSync(
      Effect.gen(function* () {
        const lane = yield* svc.create({ projectId: "p1", name: "Sprint 3", dueAt: "2026-08-01" });
        expect(lane.kind).toBe("sprint");
        expect(lane.dueAt).toBe("2026-08-01");
        expect(lane.position).toBe(3);
        expect(lane.projectId).toBe("p1");
      })
    );
  });

  it("creates a loose sprint by default; milestoneId + startAt persist when given", () => {
    const db = tmpDb();
    seed(db);
    const svc = makeService(db);
    db.prepare("INSERT INTO milestones (id, project_id, name, position) VALUES ('ms1','p1','v1',0)").run();
    Effect.runSync(
      Effect.gen(function* () {
        const lane = yield* svc.create({ projectId: "p1", name: "Sprint A", startAt: "2026-08-10", dueAt: "2026-08-30", milestoneId: "ms1" });
        expect(lane.kind).toBe("sprint");
        expect(lane.startAt).toBe("2026-08-10");
        expect(lane.milestoneId).toBe("ms1");
        const loose = yield* svc.create({ projectId: "p1", name: "Loose" });
        expect(loose.milestoneId).toBeNull();
        expect(loose.startAt).toBeNull();
      })
    );
  });

  it("rejects startAt later than dueAt (INVALID_ARGS)", () => {
    const db = tmpDb();
    seed(db);
    const svc = makeService(db);
    const result = Effect.runSync(Effect.either(svc.create({ projectId: "p1", name: "Bad", startAt: "2026-09-01", dueAt: "2026-08-01" })));
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) expect(result.left).toBeInstanceOf(InvalidArgs);
  });

  it("rejects an unknown or cross-project milestoneId (MILESTONE_NOT_FOUND)", () => {
    const db = tmpDb();
    seed(db);
    const svc = makeService(db);
    db.prepare("INSERT INTO projects (id, name, slug) VALUES ('p2','P2','p2')").run();
    db.prepare("INSERT INTO milestones (id, project_id, name, position) VALUES ('ms-p2','p2','other',0)").run();
    const unknown = Effect.runSync(Effect.either(svc.create({ projectId: "p1", name: "S", milestoneId: "nope" })));
    expect(Either.isLeft(unknown)).toBe(true);
    if (Either.isLeft(unknown)) expect(unknown.left).toBeInstanceOf(MilestoneNotFound);
    const cross = Effect.runSync(Effect.either(svc.create({ projectId: "p1", name: "S", milestoneId: "ms-p2" })));
    expect(Either.isLeft(cross)).toBe(true);
    if (Either.isLeft(cross)) expect(cross.left).toBeInstanceOf(MilestoneNotFound);
  });

  it("rejects a missing project", () => {
    const db = tmpDb();
    seed(db);
    const svc = makeService(db);
    const result = Effect.runSync(Effect.either(svc.create({ projectId: "nope", name: "X" })));
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) expect(result.left).toBeInstanceOf(ProjectNotFound);
  });
});

describe("SwimlaneService update", () => {
  it("rejects shrinking the deadline past a task's due date", () => {
    const db = tmpDb();
    seed(db);
    const svc = makeService(db);
    const result = Effect.runSync(Effect.either(svc.update("m1", { dueAt: "2026-06-15" })));
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

  it("allows moving the deadline after all task due dates", () => {
    const db = tmpDb();
    seed(db);
    const svc = makeService(db);
    Effect.runSync(
      Effect.gen(function* () {
        const lane = yield* svc.update("m1", { dueAt: "2026-08-01" });
        expect(lane.dueAt).toBe("2026-08-01");
      })
    );
  });

  it("rejects setting a deadline on the backlog lane", () => {
    const db = tmpDb();
    seed(db);
    const svc = makeService(db);
    const result = Effect.runSync(Effect.either(svc.update("s-backlog", { dueAt: "2026-01-01" })));
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(BacklogProtected);
      expect((result.left as BacklogProtected).action).toBe("deadline");
    }
  });

  it("rejects updating a missing lane", () => {
    const db = tmpDb();
    seed(db);
    const svc = makeService(db);
    const result = Effect.runSync(Effect.either(svc.update("nope", { name: "X" })));
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) expect(result.left).toBeInstanceOf(SwimlaneNotFound);
  });

  it("updates name and position", () => {
    const db = tmpDb();
    seed(db);
    const svc = makeService(db);
    Effect.runSync(
      Effect.gen(function* () {
        const lane = yield* svc.update("m2", { name: "Renamed", position: 5 });
        expect(lane.name).toBe("Renamed");
        expect(lane.position).toBe(5);
      })
    );
  });

  it("update rejects startAt > dueAt on an existing lane (INVALID_ARGS)", () => {
    const db = tmpDb();
    seed(db);
    const svc = makeService(db);
    const result = Effect.runSync(Effect.either(svc.update("m1", { startAt: "2026-09-01", dueAt: "2026-08-01" })));
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) expect(result.left).toBeInstanceOf(InvalidArgs);
  });

  it("partial PATCH validates against the lane's other bound (startAt vs dueAt)", () => {
    const db = tmpDb();
    seed(db);
    const svc = makeService(db);
    // m2: no dates, no tasks → set a consistent range first.
    Effect.runSync(svc.update("m2", { startAt: "2026-08-10", dueAt: "2026-08-30" }));
    // Lone startAt later than the lane's dueAt → InvalidArgs.
    const startLate = Effect.runSync(Effect.either(svc.update("m2", { startAt: "2026-09-01" })));
    expect(Either.isLeft(startLate)).toBe(true);
    if (Either.isLeft(startLate)) expect(startLate.left).toBeInstanceOf(InvalidArgs);
    // Lone dueAt earlier than the lane's startAt → InvalidArgs.
    const dueEarly = Effect.runSync(Effect.either(svc.update("m2", { dueAt: "2026-07-01" })));
    expect(Either.isLeft(dueEarly)).toBe(true);
    if (Either.isLeft(dueEarly)) expect(dueEarly.left).toBeInstanceOf(InvalidArgs);
    // A valid lone startAt passes and persists.
    const ok = Effect.runSync(Effect.either(svc.update("m2", { startAt: "2026-07-15" })));
    expect(Either.isRight(ok)).toBe(true);
    if (Either.isRight(ok)) {
      expect(ok.right.startAt).toBe("2026-07-15");
      expect(ok.right.dueAt).toBe("2026-08-30");
    }
  });

  it("update persists startAt/milestoneId and clears them with null", () => {
    const db = tmpDb();
    seed(db);
    const svc = makeService(db);
    db.prepare("INSERT INTO milestones (id, project_id, name, position) VALUES ('ms1','p1','v1',0)").run();
    Effect.runSync(
      Effect.gen(function* () {
        const lane = yield* svc.update("m1", { startAt: "2026-05-10", milestoneId: "ms1" });
        expect(lane.startAt).toBe("2026-05-10");
        expect(lane.milestoneId).toBe("ms1");
        const cleared = yield* svc.update("m1", { startAt: null, milestoneId: null });
        expect(cleared.startAt).toBeNull();
        expect(cleared.milestoneId).toBeNull();
      })
    );
  });

  it("update rejects unknown milestoneId on an existing lane", () => {
    const db = tmpDb();
    seed(db);
    const svc = makeService(db);
    const result = Effect.runSync(Effect.either(svc.update("m1", { milestoneId: "nope" })));
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) expect(result.left).toBeInstanceOf(MilestoneNotFound);
  });

  it("backlog lane rejects startAt/milestoneId too (BACKLOG_PROTECTED)", () => {
    const db = tmpDb();
    seed(db);
    const svc = makeService(db);
    const result = Effect.runSync(Effect.either(svc.update("s-backlog", { startAt: "2026-01-01" })));
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(BacklogProtected);
      expect((result.left as BacklogProtected).action).toBe("deadline");
    }
  });
});

describe("SwimlaneService delete", () => {
  it("rejects deleting a lane with tasks", () => {
    const db = tmpDb();
    seed(db);
    const svc = makeService(db);
    const result = Effect.runSync(Effect.either(svc.delete("m1")));
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(HasChildren);
      expect((result.left as HasChildren).count).toBe(2);
    }
  });

  it("deletes an empty milestone lane", () => {
    const db = tmpDb();
    seed(db);
    const svc = makeService(db);
    Effect.runSync(svc.delete("m2"));
    const row = db.prepare("SELECT COUNT(*) AS n FROM swimlanes WHERE id = 'm2'").get() as { n: number };
    expect(row.n).toBe(0);
  });

  it("deleting the backlog lane is rejected (BACKLOG_PROTECTED)", () => {
    const db = tmpDb();
    seed(db);
    const svc = makeService(db);
    const result = Effect.runSync(Effect.either(svc.delete("s-backlog")));
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(BacklogProtected);
      expect((result.left as BacklogProtected).action).toBe("delete");
    }
    const row = db.prepare("SELECT COUNT(*) AS n FROM swimlanes WHERE id = 's-backlog'").get() as { n: number };
    expect(row.n).toBe(1);
  });

  it("rejects deleting a missing lane", () => {
    const db = tmpDb();
    seed(db);
    const svc = makeService(db);
    const result = Effect.runSync(Effect.either(svc.delete("nope")));
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) expect(result.left).toBeInstanceOf(SwimlaneNotFound);
  });
});

describe("SwimlaneService archive", () => {
  it("rejects archiving the backlog lane", () => {
    const db = tmpDb();
    seed(db);
    const svc = makeService(db);
    const result = Effect.runSync(Effect.either(svc.archive(maria, "s-backlog")));
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(BacklogProtected);
      expect((result.left as BacklogProtected).action).toBe("archive");
    }
  });

  it("archives the lane and its live tasks, emitting one activity row per task", () => {
    const db = tmpDb();
    seed(db);
    const svc = makeService(db);
    Effect.runSync(
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

  it("archiving an already-archived lane is idempotent", () => {
    const db = tmpDb();
    seed(db);
    const svc = makeService(db);
    Effect.runSync(
      Effect.gen(function* () {
        yield* svc.archive(maria, "m1");
        const second = yield* svc.archive(maria, "m1");
        expect(second.activity).toEqual([]);
      })
    );
  });

  it("rejects archiving a missing lane", () => {
    const db = tmpDb();
    seed(db);
    const svc = makeService(db);
    const result = Effect.runSync(Effect.either(svc.archive(maria, "nope")));
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) expect(result.left).toBeInstanceOf(SwimlaneNotFound);
  });
});

describe("SwimlaneService restore", () => {
  it("restores the lane and is idempotent; tasks stay archived", () => {
    const db = tmpDb();
    seed(db);
    const svc = makeService(db);
    Effect.runSync(
      Effect.gen(function* () {
        yield* svc.archive(maria, "m1");
        const { lane, activity } = yield* svc.restore(maria, "m1");
        expect(lane.archivedAt).toBeNull();
        expect(activity).toEqual([]);
        const second = yield* svc.restore(maria, "m1");
        expect(second.lane.archivedAt).toBeNull();
        expect(second.activity).toEqual([]);
        // Restore only clears the lane — archived tasks stay archived.
        const tasks = db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE swimlane_id = 'm1' AND archived_at IS NOT NULL").get() as { n: number };
        expect(tasks.n).toBe(2);
      })
    );
  });

  it("rejects restoring a missing lane", () => {
    const db = tmpDb();
    seed(db);
    const svc = makeService(db);
    const result = Effect.runSync(Effect.either(svc.restore(maria, "nope")));
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) expect(result.left).toBeInstanceOf(SwimlaneNotFound);
  });
});

describe("SwimlaneService queries", () => {
  it("getById returns the lane; missing → SwimlaneNotFound", () => {
    const db = tmpDb();
    seed(db);
    const svc = makeService(db);
    Effect.runSync(
      Effect.gen(function* () {
        const lane = yield* svc.getById("m1");
        expect(lane.kind).toBe("sprint");
        const missing = yield* Effect.either(svc.getById("nope"));
        expect(Either.isLeft(missing)).toBe(true);
        if (Either.isLeft(missing)) expect(missing.left).toBeInstanceOf(SwimlaneNotFound);
      })
    );
  });

  it("findByProject hides archived lanes unless includeArchived", () => {
    const db = tmpDb();
    seed(db);
    const svc = makeService(db);
    Effect.runSync(
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
