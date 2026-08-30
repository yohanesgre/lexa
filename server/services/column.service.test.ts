import { describe, expect, it, afterEach, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer, Context, Either } from "effect";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { Sqlite, initSqlite } from "../db/database";
import { ColumnService } from "./column.service";
import { ProjectNotFound, ColumnNotFound, HasChildren } from "../api/errors";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

let dir: string;
let db: Database;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "lexa-column-svc-"));
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
  db.prepare("INSERT INTO projects (id, name, slug) VALUES ('p1','P','p1'), ('p2','P2','p2')").run();
}

function makeService(db: Database) {
  const layer = ColumnService.Default.pipe(Layer.provide(Layer.succeed(Sqlite, db)));
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  return Context.get(ctx, ColumnService);
}

describe("ColumnService.create", () => {
  it("appends at the end of an empty project (position 0) and after existing columns", () => {
    seed(db);
    db.prepare("INSERT INTO columns (id, project_id, name, position) VALUES ('c0','p2','Existing',0)").run();
    const svc = makeService(db);
    const first = Effect.runSync(Effect.either(svc.create({ projectId: "p1", name: "Todo" })));
    expect(Either.isRight(first)).toBe(true);
    if (Either.isRight(first)) expect(first.right.position).toBe(0);
    const second = Effect.runSync(Effect.either(svc.create({ projectId: "p2", name: "Done" })));
    expect(Either.isRight(second)).toBe(true);
    if (Either.isRight(second)) expect(second.right.position).toBe(1);
  });

  it("stores wipLimit, requiredFields, color, and githubState", () => {
    seed(db);
    const svc = makeService(db);
    const res = Effect.runSync(
      Effect.either(svc.create({
        projectId: "p1",
        name: "In Progress",
        wipLimit: 4,
        requiredFields: ["description"],
        color: "#3b82f6",
        githubState: "open",
      }))
    );
    expect(Either.isRight(res)).toBe(true);
    if (Either.isRight(res)) {
      expect(res.right.wipLimit).toBe(4);
      expect(res.right.requiredFields).toEqual(["description"]);
      expect(res.right.color).toBe("#3b82f6");
      expect(res.right.githubState).toBe("open");
      const raw = db.prepare("SELECT required_fields, github_state FROM columns WHERE id = ?").get(res.right.id) as { required_fields: string; github_state: string | null };
      expect(JSON.parse(raw.required_fields)).toEqual(["description"]);
    }
  });

  it("unknown project → ProjectNotFound", () => {
    seed(db);
    const svc = makeService(db);
    const res = Effect.runSync(Effect.either(svc.create({ projectId: "nope", name: "X" })));
    expect(Either.isLeft(res)).toBe(true);
    if (Either.isLeft(res)) expect(res.left).toBeInstanceOf(ProjectNotFound);
  });
});

describe("ColumnService.read", () => {
  it("findByProject returns columns ordered by position", () => {
    seed(db);
    db.prepare("INSERT INTO columns (id, project_id, name, position) VALUES ('c1','p1','Done',2), ('c2','p1','Todo',1)").run();
    const svc = makeService(db);
    const cols = Effect.runSync(svc.findByProject("p1"));
    expect(cols.map((c) => c.name)).toEqual(["Todo", "Done"]);
  });

  it("getById missing → ColumnNotFound; findByProject missing project → ProjectNotFound", () => {
    seed(db);
    const svc = makeService(db);
    const missing = Effect.runSync(Effect.either(svc.getById("nope")));
    expect(Either.isLeft(missing)).toBe(true);
    if (Either.isLeft(missing)) expect(missing.left).toBeInstanceOf(ColumnNotFound);
    const noProject = Effect.runSync(Effect.either(svc.findByProject("nope")));
    expect(Either.isLeft(noProject)).toBe(true);
    if (Either.isLeft(noProject)) expect(noProject.left).toBeInstanceOf(ProjectNotFound);
  });
});

describe("ColumnService.update", () => {
  it("updates name, position, color, wipLimit, requiredFields, githubState", () => {
    seed(db);
    db.prepare("INSERT INTO columns (id, project_id, name, position) VALUES ('c1','p1','Todo',0)").run();
    const svc = makeService(db);
    const res = Effect.runSync(
      Effect.either(svc.update("c1", {
        name: "Blocked",
        position: 9,
        color: "#ef4444",
        wipLimit: 3,
        requiredFields: ["description", "assignee"],
        githubState: "closed",
      }))
    );
    expect(Either.isRight(res)).toBe(true);
    if (Either.isRight(res)) {
      expect(res.right.name).toBe("Blocked");
      expect(res.right.position).toBe(9);
      expect(res.right.color).toBe("#ef4444");
      expect(res.right.wipLimit).toBe(3);
      expect(res.right.requiredFields).toEqual(["description", "assignee"]);
      expect(res.right.githubState).toBe("closed");
    }
    // null clears wipLimit and githubState
    const cleared = Effect.runSync(Effect.either(svc.update("c1", { wipLimit: null, githubState: null })));
    expect(Either.isRight(cleared)).toBe(true);
    if (Either.isRight(cleared)) {
      expect(cleared.right.wipLimit).toBeNull();
      expect(cleared.right.githubState).toBeNull();
    }
  });

  it("missing id → ColumnNotFound", () => {
    seed(db);
    const svc = makeService(db);
    const res = Effect.runSync(Effect.either(svc.update("nope", { name: "X" })));
    expect(Either.isLeft(res)).toBe(true);
    if (Either.isLeft(res)) expect(res.left).toBeInstanceOf(ColumnNotFound);
  });

  it("update sets and clears isDone", () => {
    seed(db);
    db.prepare("INSERT INTO columns (id, project_id, name, position) VALUES ('c1','p1','Done',0)").run();
    const svc = makeService(db);
    const set = Effect.runSync(Effect.either(svc.update("c1", { isDone: true })));
    expect(Either.isRight(set)).toBe(true);
    if (Either.isRight(set)) expect(set.right.isDone).toBe(true);
    const cleared = Effect.runSync(Effect.either(svc.update("c1", { isDone: false })));
    expect(Either.isRight(cleared)).toBe(true);
    if (Either.isRight(cleared)) expect(cleared.right.isDone).toBe(false);
  });
});

describe("ColumnService.delete", () => {
  it("deletes an empty column", () => {
    seed(db);
    db.prepare("INSERT INTO columns (id, project_id, name, position) VALUES ('c1','p1','Todo',0)").run();
    const svc = makeService(db);
    const res = Effect.runSync(Effect.either(svc.delete("c1")));
    expect(Either.isRight(res)).toBe(true);
    const n = (db.prepare("SELECT COUNT(*) AS n FROM columns WHERE id = 'c1'").get() as { n: number }).n;
    expect(n).toBe(0);
  });

  it("non-empty column → HasChildren with the task count", () => {
    seed(db);
    db.prepare("INSERT INTO columns (id, project_id, name, position) VALUES ('c1','p1','Todo',0), ('c2','p1','Done',1)").run();
    db.prepare("INSERT INTO swimlanes (id, project_id, name, position) VALUES ('s1','p1','Default',0)").run();
    db.prepare("INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, created_at) VALUES ('t1','p1','c1','s1','T','a0','2026-01-01 10:00:00'), ('t2','p1','c1','s1','T2','a1','2026-01-01 10:00:00')").run();
    const svc = makeService(db);
    const blocked = Effect.runSync(Effect.either(svc.delete("c1")));
    expect(Either.isLeft(blocked)).toBe(true);
    if (Either.isLeft(blocked)) {
      expect(blocked.left).toBeInstanceOf(HasChildren);
      if (blocked.left instanceof HasChildren) expect(blocked.left.count).toBe(2);
    }
    // still there
    const n = (db.prepare("SELECT COUNT(*) AS n FROM columns WHERE id = 'c1'").get() as { n: number }).n;
    expect(n).toBe(1);
  });

  it("missing id → ColumnNotFound", () => {
    seed(db);
    const svc = makeService(db);
    const res = Effect.runSync(Effect.either(svc.delete("nope")));
    expect(Either.isLeft(res)).toBe(true);
    if (Either.isLeft(res)) expect(res.left).toBeInstanceOf(ColumnNotFound);
  });
});
