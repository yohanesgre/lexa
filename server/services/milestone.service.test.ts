import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer, Context, Either } from "effect";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { Sqlite, initSqlite } from "../db/database";
import { MilestoneService } from "./milestone.service";
import { SwimlaneRepo } from "../repos/swimlane.repo";
import { TaskRepo } from "../repos/task.repo";
import { HasChildren, MilestoneNotFound, ProjectNotFound } from "../api/errors";
import type { Actor } from "../../shared/types";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

let dirs: string[] = [];
let dbs: Database[] = [];

function tmpDb(): Database {
  const dir = mkdtempSync(join(tmpdir(), "lexa-milestone-svc-"));
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
  db.prepare("INSERT INTO columns (id, project_id, name, position) VALUES ('c1','p1','Todo',0)").run();
  db.prepare("INSERT INTO swimlanes (id, project_id, name, position, kind) VALUES ('s-backlog','p1','Backlog',0,'backlog')").run();
  db.prepare("INSERT INTO users (id, email, name, role) VALUES ('u1','maria@lexa.test','Maria','member')").run();
}

function makeService(db: Database) {
  const layer = MilestoneService.Default.pipe(Layer.provide(Layer.succeed(Sqlite, db)));
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  return Context.get(ctx, MilestoneService);
}

function makeRepo<T>(db: Database, Repo: { Default: Layer.Layer<T, never, Sqlite> }): T {
  const layer = Repo.Default.pipe(Layer.provide(Layer.succeed(Sqlite, db)));
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  // test helper: Repo is an Effect.Service class; Default layer is typed with Sqlite dep
  return Context.get(ctx, Repo as unknown as Context.Tag<T, T>) as T;
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

describe("MilestoneService create/find", () => {
  it("creates a milestone appended after the last position; list filters archived", async () => {
    const db = tmpDb();
    seed(db);
    const svc = makeService(db);
    const m = await Effect.runPromise(svc.create({ projectId: "p1", name: "v1", description: "launch", dueAt: "2026-08-30" }));
    expect(m.name).toBe("v1");
    expect(m.position).toBe(0);
    expect(m.sprintCount).toBe(0);
    const list = await Effect.runPromise(svc.findByProject("p1"));
    expect(list.map((x) => x.id)).toEqual([m.id]);
    await Effect.runPromise(svc.archive(maria, m.id));
    const active = await Effect.runPromise(svc.findByProject("p1"));
    expect(active).toHaveLength(0);
    const all = await Effect.runPromise(svc.findByProject("p1", { includeArchived: true }));
    expect(all).toHaveLength(1);
  });

  it("rejects a missing project", async () => {
    const db = tmpDb();
    seed(db);
    const svc = makeService(db);
    const res = await Effect.runPromise(Effect.either(svc.create({ projectId: "nope", name: "x" })));
    expect(res).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "ProjectNotFound" }) });
  });

  it("getById/update surface MilestoneNotFound", async () => {
    const db = tmpDb();
    seed(db);
    const svc = makeService(db);
    const missing = await Effect.runPromise(Effect.either(svc.getById("nope")));
    expect(missing).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "MilestoneNotFound" }) });
    const upd = await Effect.runPromise(Effect.either(svc.update("nope", { name: "x" })));
    expect(upd).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "MilestoneNotFound" }) });
  });
});

describe("MilestoneService archive/restore", () => {
  it("create then archive cascades to sprints and tasks, with per-task activity rows", async () => {
    const db = tmpDb();
    seed(db);
    const svc = makeService(db);
    const swimlaneRepo = makeRepo<SwimlaneRepo>(db, SwimlaneRepo);
    const taskRepo = makeRepo<TaskRepo>(db, TaskRepo);
    const m = await Effect.runPromise(svc.create({ projectId: "p1", name: "v1" }));
    db.prepare(`INSERT INTO swimlanes (id, project_id, name, position, kind, milestone_id)
                VALUES ('sp1','p1','Sprint 1',0,'sprint','${m.id}')`).run();
    db.prepare(`INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position)
                VALUES ('t1','p1','c1','sp1','T1','a0')`).run();
    const res = await Effect.runPromise(svc.archive(maria, m.id));
    expect(res.milestone.archivedAt).not.toBeNull();
    const lane = await Effect.runPromise(swimlaneRepo.findById("sp1"));
    expect(lane.archivedAt).not.toBeNull();
    const task = await Effect.runPromise(taskRepo.findById("t1"));
    expect(task.archivedAt).not.toBeNull();
    expect(res.activity).toHaveLength(1); // per-task only (task_activity FK → tasks.id)
    expect(res.activity[0]!).toMatchObject({ type: "archived", taskId: "t1", actorLabel: "Maria" });
    // activity rows exist in the DB (emitted inside the same transaction)
    const rows = db.prepare("SELECT task_id, type FROM task_activity WHERE task_id = 't1'").all() as { task_id: string; type: string }[];
    expect(rows).toEqual([{ task_id: "t1", type: "archived" }]);
  });

  it("archive is idempotent", async () => {
    const db = tmpDb();
    seed(db);
    const svc = makeService(db);
    const m = await Effect.runPromise(svc.create({ projectId: "p1", name: "v1" }));
    const first = await Effect.runPromise(svc.archive(maria, m.id));
    expect(first.activity).toHaveLength(0);
    const second = await Effect.runPromise(svc.archive(maria, m.id));
    expect(second.activity).toEqual([]);
    expect(second.milestone.archivedAt).not.toBeNull();
  });

  it("archive only touches live tasks (archived ones stay untouched, no dup rows)", async () => {
    const db = tmpDb();
    seed(db);
    const svc = makeService(db);
    const taskRepo = makeRepo<TaskRepo>(db, TaskRepo);
    const m = await Effect.runPromise(svc.create({ projectId: "p1", name: "v1" }));
    db.prepare(`INSERT INTO swimlanes (id, project_id, name, position, kind, milestone_id)
                VALUES ('sp1','p1','Sprint 1',0,'sprint','${m.id}')`).run();
    db.prepare(`INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, archived_at)
                VALUES ('t-arch','p1','c1','sp1','Arch','a0','2026-01-01 10:00:00')`).run();
    const res = await Effect.runPromise(svc.archive(maria, m.id));
    expect(res.activity).toHaveLength(0);
    const arch = await Effect.runPromise(taskRepo.findById("t-arch"));
    expect(arch.archivedAt).toBe("2026-01-01 10:00:00");
  });

  it("restore brings the milestone back only; sprints stay archived", async () => {
    const db = tmpDb();
    seed(db);
    const svc = makeService(db);
    const swimlaneRepo = makeRepo<SwimlaneRepo>(db, SwimlaneRepo);
    const m = await Effect.runPromise(svc.create({ projectId: "p1", name: "v1" }));
    db.prepare(`INSERT INTO swimlanes (id, project_id, name, position, kind, milestone_id)
                VALUES ('sp1','p1','Sprint 1',0,'sprint','${m.id}')`).run();
    await Effect.runPromise(svc.archive(maria, m.id));
    const restored = await Effect.runPromise(svc.restore(maria, m.id));
    expect(restored.milestone.archivedAt).toBeNull();
    expect(restored.activity).toEqual([]);
    const lane = await Effect.runPromise(swimlaneRepo.findById("sp1"));
    expect(lane.archivedAt).not.toBeNull();
  });

  it("restore is idempotent", async () => {
    const db = tmpDb();
    seed(db);
    const svc = makeService(db);
    const m = await Effect.runPromise(svc.create({ projectId: "p1", name: "v1" }));
    const res = await Effect.runPromise(svc.restore(maria, m.id));
    expect(res.milestone.archivedAt).toBeNull();
    expect(res.activity).toEqual([]);
  });
});

describe("MilestoneService delete", () => {
  it("delete blocked while sprints exist → HasChildren", async () => {
    const db = tmpDb();
    seed(db);
    const svc = makeService(db);
    const m = await Effect.runPromise(svc.create({ projectId: "p1", name: "v1" }));
    db.prepare(`INSERT INTO swimlanes (id, project_id, name, position, kind, milestone_id)
                VALUES ('sp1','p1','Sprint 1',0,'sprint','${m.id}')`).run();
    const res = await Effect.runPromise(Effect.either(svc.delete(m.id)));
    expect(res).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "HasChildren" }) });
  });

  it("delete succeeds on an empty milestone; unknown id → MilestoneNotFound", async () => {
    const db = tmpDb();
    seed(db);
    const svc = makeService(db);
    const m = await Effect.runPromise(svc.create({ projectId: "p1", name: "v1" }));
    await Effect.runPromise(svc.delete(m.id));
    const list = await Effect.runPromise(svc.findByProject("p1"));
    expect(list).toHaveLength(0);
    const missing = await Effect.runPromise(Effect.either(svc.delete(m.id)));
    expect(missing).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "MilestoneNotFound" }) });
  });
});
