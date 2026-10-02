import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer, Context } from "effect";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { Sqlite } from "../db/database";
import { DbBunLive } from "../db/db";
import { MilestoneRepo } from "./milestone.repo";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

let dir: string;
let db: Database;
let repo: MilestoneRepo;

afterEach(() => { try { db?.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });

function setup() {
  dir = mkdtempSync(join(tmpdir(), "lexa-milestone-repo-"));
  const path = join(dir, "test.db");
  runMigrations(path, MIGRATIONS);
  db = new Database(path);
  const layer = MilestoneRepo.Default.pipe(Layer.provide(Layer.mergeAll(Layer.succeed(Sqlite, db), DbBunLive(db))));
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  repo = Context.get(ctx, MilestoneRepo);
  db.exec(`INSERT INTO projects (id, name, slug) VALUES ('p1','P','p1')`);
}

describe("MilestoneRepo", () => {
  it("creates, reads back with zero counts, updates, archives", async () => {
    setup();
    const created = await Effect.runPromise(repo.create({ id: "ms1", projectId: "p1", name: "v1", position: 0 }));
    expect(created.name).toBe("v1");
    const found = await Effect.runPromise(repo.findByProject("p1"));
    expect(found).toHaveLength(1);
    expect(found[0]!.sprintCount).toBe(0);
    const updated = await Effect.runPromise(repo.update("ms1", { name: "v1.0", dueAt: "2026-08-30" }));
    expect(updated.name).toBe("v1.0");
    expect(updated.dueAt).toBe("2026-08-30");
    const archived = await Effect.runPromise(repo.setArchived("ms1", "2026-09-01 00:00:00"));
    expect(archived.archivedAt).toBe("2026-09-01 00:00:00");
  });

  it("findByProject reports sprint counts including archived", async () => {
    setup();
    await Effect.runPromise(repo.create({ id: "ms1", projectId: "p1", name: "v1", position: 0 }));
    db.exec(`INSERT INTO swimlanes (id, project_id, name, position, kind, milestone_id, archived_at)
             VALUES ('sp1','p1','Sprint 1',0,'sprint','ms1',NULL),
                    ('sp2','p1','Sprint 2',1,'sprint','ms1','2026-09-01 00:00:00')`);
    const found = await Effect.runPromise(repo.findByProject("p1"));
    expect(found[0]!.sprintCount).toBe(2);
    expect(found[0]!.archivedSprintCount).toBe(1);
  });

  it("findByProject aggregates tasksTotal/tasksDone across sprints, archived included", async () => {
    setup();
    await Effect.runPromise(repo.create({ id: "ms1", projectId: "p1", name: "v1", position: 0 }));
    db.exec(`
      INSERT INTO columns (id, project_id, name, position, is_done) VALUES ('c1','p1','Todo',0,0), ('c2','p1','Done',1,1);
      INSERT INTO swimlanes (id, project_id, name, position, kind, milestone_id, archived_at)
        VALUES ('sp1','p1','Sprint 1',0,'sprint','ms1',NULL),
               ('sp2','p1','Sprint 2',1,'sprint','ms1','2026-09-01 00:00:00'),
               ('loose','p1','Loose',2,'sprint',NULL,NULL);
      INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, created_at) VALUES
        ('ta','p1','c1','sp1','A','a0','2026-01-01 10:00:00'),
        ('tb','p1','c1','sp1','B','a1','2026-01-01 10:00:00'),
        ('tc','p1','c2','sp1','C','a0','2026-01-01 10:00:00'),
        ('td','p1','c1','sp2','D','a2','2026-01-01 10:00:00'),
        ('te','p1','c1','sp2','E','a3','2026-01-01 10:00:00'),
        ('tf','p1','c1','loose','F','a4','2026-01-01 10:00:00');
      UPDATE tasks SET archived_at = '2026-02-01 00:00:00' WHERE id IN ('tb','te');
    `);
    const found = await Effect.runPromise(repo.findByProject("p1"));
    // All five tasks across sp1+sp2 count; the loose lane's task is excluded.
    expect(found[0]!.tasksTotal).toBe(5);
    // tb archived, tc in done column, te archived → 3 done.
    expect(found[0]!.tasksDone).toBe(3);
  });

  it("findByProject and findByMilestone carry task counts across archived sprints", async () => {
    setup();
    await Effect.runPromise(repo.create({ id: "ms1", projectId: "p1", name: "v1", position: 0 }));
    db.exec(`INSERT INTO columns (id, project_id, name, position, is_done) VALUES ('c1','p1','Todo',0,0), ('c2','p1','Done',1,1)`);
    db.exec(`INSERT INTO swimlanes (id, project_id, name, position, kind, milestone_id, archived_at)
             VALUES ('sp1','p1','Sprint 1',0,'sprint','ms1',NULL),
                    ('sp2','p1','Sprint 2',1,'sprint','ms1','2026-09-01 00:00:00')`);
    db.exec(`INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, archived_at, created_at) VALUES
               ('t1','p1','c1','sp1','T1','a0',NULL,'2026-01-01 10:00:00'),
               ('t2','p1','c2','sp1','T2','a1',NULL,'2026-01-01 10:00:00'),
               ('t3','p1','c1','sp2','T3','a2','2026-02-01 10:00:00','2026-01-01 10:00:00'),
               ('t4','p1','c2','sp2','T4','a2',NULL,'2026-01-01 10:00:00')`);
    const found = await Effect.runPromise(repo.findByProject("p1"));
    expect(found[0]).toMatchObject({ sprintCount: 2, archivedSprintCount: 1, tasksDone: 3, tasksTotal: 4 });
    const lanes = await Effect.runPromise(repo.findByMilestone("ms1"));
    expect(lanes.find((l) => l.id === "sp1")).toMatchObject({ tasksDone: 1, tasksTotal: 2 });
    expect(lanes.find((l) => l.id === "sp2")).toMatchObject({ tasksDone: 2, tasksTotal: 2 });
  });

  it("countSprints and findByMilestone see loose + scoped lanes", async () => {
    setup();
    await Effect.runPromise(repo.create({ id: "ms1", projectId: "p1", name: "v1", position: 0 }));
    db.exec(`INSERT INTO swimlanes (id, project_id, name, position, kind, milestone_id)
             VALUES ('sp1','p1','Sprint 1',0,'sprint','ms1'),
                    ('loose','p1','Loose',1,'sprint',NULL),
                    ('b1','p1','Backlog',0,'backlog',NULL)`);
    expect(await Effect.runPromise(repo.countSprints("ms1"))).toBe(1);
    const lanes = await Effect.runPromise(repo.findByMilestone("ms1"));
    expect(lanes.map((l) => l.id)).toEqual(["sp1"]);
    expect(lanes[0]!.milestoneId).toBe("ms1");
  });

  it("update with no fields is a no-op read; unknown id → RowNotFound", async () => {
    setup();
    await Effect.runPromise(repo.create({ id: "ms1", projectId: "p1", name: "v1", position: 0 }));
    const unchanged = await Effect.runPromise(repo.update("ms1", {}));
    expect(unchanged.name).toBe("v1");
    const res = await Effect.runPromise(Effect.either(repo.findById("nope")));
    expect(res).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "RowNotFound" }) });
  });

  it("update and setArchived readbacks carry real sprint counts", async () => {
    setup();
    await Effect.runPromise(repo.create({ id: "ms1", projectId: "p1", name: "v1", position: 0 }));
    db.exec(`INSERT INTO swimlanes (id, project_id, name, position, kind, milestone_id, archived_at)
             VALUES ('sp1','p1','Sprint 1',0,'sprint','ms1',NULL),
                    ('sp2','p1','Sprint 2',1,'sprint','ms1','2026-09-01 00:00:00')`);
    const updated = await Effect.runPromise(repo.update("ms1", { name: "v1.0" }));
    expect(updated.sprintCount).toBe(2);
    expect(updated.archivedSprintCount).toBe(1);
    const archived = await Effect.runPromise(repo.setArchived("ms1", "2026-09-02 00:00:00"));
    expect(archived.archivedAt).toBe("2026-09-02 00:00:00");
    expect(archived.sprintCount).toBe(2);
    expect(archived.archivedSprintCount).toBe(1);
    const noop = await Effect.runPromise(repo.update("ms1", {}));
    expect(noop.sprintCount).toBe(2);
    expect(noop.archivedSprintCount).toBe(1);
  });

  it("delete removes the row; maxPosition tracks ordering", async () => {
    setup();
    await Effect.runPromise(repo.create({ id: "ms1", projectId: "p1", name: "v1", position: 0 }));
    await Effect.runPromise(repo.create({ id: "ms2", projectId: "p1", name: "v2", position: 1 }));
    expect(await Effect.runPromise(repo.maxPosition("p1"))).toBe(1);
    await Effect.runPromise(repo.delete("ms1"));
    const found = await Effect.runPromise(repo.findByProject("p1"));
    expect(found.map((m) => m.id)).toEqual(["ms2"]);
  });
});
