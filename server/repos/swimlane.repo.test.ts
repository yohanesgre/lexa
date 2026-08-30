import { describe, expect, it, afterEach, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer, Context, Either } from "effect";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { Sqlite, initSqlite, ConstraintViolation, RowNotFound } from "../db/database";
import { SwimlaneRepo } from "./swimlane.repo";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

let dir: string;
let db: Database;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "lexa-swimlane-repo-"));
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
  db.prepare("INSERT INTO projects (id, name, slug) VALUES ('p2','P2','p2')").run();
  db.prepare("INSERT INTO swimlanes (id, project_id, name, position, kind) VALUES ('s-backlog','p1','Backlog',0,'backlog')").run();
  db.prepare("INSERT INTO swimlanes (id, project_id, name, position, kind, due_at) VALUES ('m1','p1','Milestone 1',1,'sprint','2026-06-01')").run();
  db.prepare("INSERT INTO swimlanes (id, project_id, name, position) VALUES ('m2','p1','Milestone 2',2)").run();
  db.prepare("INSERT INTO columns (id, project_id, name, position) VALUES ('c1','p1','Todo',0)").run();
  db.prepare("INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, due_at, created_at) VALUES ('t1','p1','c1','m1','T1','a0','2026-07-01','2026-01-01 10:00:00')").run();
  db.prepare("INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, due_at, created_at) VALUES ('t2','p1','c1','m1','T2','a1','2026-05-01','2026-01-01 10:00:00')").run();
  db.prepare("INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, due_at, archived_at, created_at) VALUES ('t3','p1','c1','m1','T3','a2','2026-08-01','2026-02-01 10:00:00','2026-01-01 10:00:00')").run();
  db.prepare("INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, created_at) VALUES ('t4','p1','c1','m1','T4','a3','2026-01-01 10:00:00')").run();
}

function makeRepo(db: Database) {
  const layer = SwimlaneRepo.Default.pipe(Layer.provide(Layer.succeed(Sqlite, db)));
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  return Context.get(ctx, SwimlaneRepo);
}

describe("SwimlaneRepo CRUD", () => {
  it("create inserts and returns the row with kind/dueAt/description", () => {
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        const lane = yield* repo.create({ id: "m3", projectId: "p1", name: "M3", description: "d", position: 3, kind: "sprint", dueAt: "2026-09-01" });
        expect(lane.id).toBe("m3");
        expect(lane.name).toBe("M3");
        expect(lane.description).toBe("d");
        expect(lane.kind).toBe("sprint");
        expect(lane.dueAt).toBe("2026-09-01");
        expect(lane.position).toBe(3);
      })
    );
  });

  it("findById returns the row; missing → RowNotFound", () => {
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        const lane = yield* repo.findById("m1");
        expect(lane.name).toBe("Milestone 1");
        const missing = yield* Effect.either(repo.findById("nope"));
        expect(Either.isLeft(missing)).toBe(true);
        if (Either.isLeft(missing)) expect(missing.left).toBeInstanceOf(RowNotFound);
      })
    );
  });

  it("findByProject returns lanes ordered by position", () => {
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        const lanes = yield* repo.findByProject("p1");
        expect(lanes.map((l) => l.id)).toEqual(["s-backlog", "m1", "m2"]);
      })
    );
  });

  it("findBacklog returns the backlog lane; missing → RowNotFound", () => {
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        const lane = yield* repo.findBacklog("p1");
        expect(lane.id).toBe("s-backlog");
        expect(lane.kind).toBe("backlog");
        const missing = yield* Effect.either(repo.findBacklog("p2"));
        expect(Either.isLeft(missing)).toBe(true);
        if (Either.isLeft(missing)) expect(missing.left).toBeInstanceOf(RowNotFound);
      })
    );
  });

  it("update mutates name/description/position/dueAt; empty input returns the row unchanged", () => {
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        const lane = yield* repo.update("m2", { name: "Renamed", description: "new", position: 9, dueAt: "2026-10-01" });
        expect(lane.name).toBe("Renamed");
        expect(lane.description).toBe("new");
        expect(lane.position).toBe(9);
        expect(lane.dueAt).toBe("2026-10-01");
        const untouched = yield* repo.update("m2", {});
        expect(untouched.name).toBe("Renamed");
        expect(untouched.position).toBe(9);
      })
    );
  });

  it("setArchived sets and clears archived_at; missing id → RowNotFound", () => {
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        const archived = yield* repo.setArchived("m2", "2026-03-01T00:00:00.000Z");
        expect(archived.archivedAt).toBe("2026-03-01T00:00:00.000Z");
        const restored = yield* repo.setArchived("m2", null);
        expect(restored.archivedAt).toBeNull();
        const missing = yield* Effect.either(repo.setArchived("nope", null));
        expect(Either.isLeft(missing)).toBe(true);
        if (Either.isLeft(missing)) expect(missing.left).toBeInstanceOf(RowNotFound);
      })
    );
  });

  it("maxPosition is -1 for an empty project and max+1 after inserts", () => {
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        expect(yield* repo.maxPosition("p2")).toBe(-1);
        expect(yield* repo.maxPosition("p1")).toBe(2);
      })
    );
  });
});

describe("SwimlaneRepo due-date queries", () => {
  it("countTasks counts every task in the lane", () => {
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        expect(yield* repo.countTasks("m1")).toBe(4);
        expect(yield* repo.countTasks("m2")).toBe(0);
      })
    );
  });

  it("countDueAfter counts only live tasks with a due date strictly after", () => {
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        // t1 (07-01) only — t2 (05-01) earlier, t3 archived, t4 no due date.
        expect(yield* repo.countDueAfter("m1", "2026-06-01")).toBe(1);
        // t1 + t2
        expect(yield* repo.countDueAfter("m1", "2026-04-01")).toBe(2);
        // Nothing later than 08-01.
        expect(yield* repo.countDueAfter("m1", "2026-12-01")).toBe(0);
      })
    );
  });

});

describe("SwimlaneRepo constraints", () => {
  it("delete removes an empty lane; deleting a lane with tasks hits the FK constraint", () => {
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        const blocked = yield* Effect.either(repo.delete("m1"));
        expect(Either.isLeft(blocked)).toBe(true);
        if (Either.isLeft(blocked)) {
          expect(blocked.left).toBeInstanceOf(ConstraintViolation);
          expect((blocked.left as ConstraintViolation).isPositionConflict).toBe(false);
        }
        yield* repo.delete("m2");
        const row = db.prepare("SELECT COUNT(*) AS n FROM swimlanes WHERE id = 'm2'").get() as { n: number };
        expect(row.n).toBe(0);
      })
    );
  });

  it("the partial unique index allows at most one backlog per project", () => {
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        // Second backlog in p1 → constraint violation, classified by the repo.
        const dup = yield* Effect.either(repo.create({ id: "b2", projectId: "p1", name: "B2", position: 9, kind: "backlog" }));
        expect(Either.isLeft(dup)).toBe(true);
        if (Either.isLeft(dup)) {
          expect(dup.left).toBeInstanceOf(ConstraintViolation);
          expect((dup.left as ConstraintViolation).isPositionConflict).toBe(false);
        }
        // A backlog in another project is fine.
        const other = yield* Effect.either(repo.create({ id: "b3", projectId: "p2", name: "B3", position: 0, kind: "backlog" }));
        expect(Either.isRight(other)).toBe(true);
      })
    );
  });
});
