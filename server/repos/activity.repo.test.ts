import { describe, expect, it, afterEach, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer, Context, Either } from "effect";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { Sqlite, initSqlite, ConstraintViolation } from "../db/database";
import { ActivityRepo } from "./activity.repo";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

let dir: string;
let db: Database;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "lexa-activity-repo-"));
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
  db.prepare("INSERT INTO columns (id, project_id, name, position) VALUES ('c1','p1','Todo',0)").run();
  db.prepare("INSERT INTO swimlanes (id, project_id, name, position) VALUES ('s1','p1','Default',0)").run();
  db.prepare("INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, created_at) VALUES ('t1','p1','c1','s1','T','a0','2026-01-01 10:00:00')").run();
}

function makeRepo(db: Database) {
  const layer = ActivityRepo.Default.pipe(Layer.provide(Layer.succeed(Sqlite, db)));
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  return Context.get(ctx, ActivityRepo);
}

describe("ActivityRepo", () => {
  it("inserts and lists rows with keyset cursor", () => {
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        const a = yield* repo.insert({ taskId: "t1", actorKind: "user", actorLabel: "Maria", actorUserId: null, type: "created", message: "Maria created this task" });
        const b = yield* repo.insert({ taskId: "t1", actorKind: "user", actorLabel: "Maria", actorUserId: null, type: "moved", message: "Maria moved from Todo to Done" });
        expect(a.id).toBeLessThan(b.id);
        // DESC keyset, no cursor → both, newest first
        const all = yield* repo.listByTaskKeyset("t1", null, 10);
        expect(all.map((x) => x.type)).toEqual(["moved", "created"]);
        // cursor at the newest → only older rows remain
        const rest = yield* repo.listByTaskKeyset("t1", { createdAt: b.createdAt, id: b.id }, 10);
        expect(rest.map((x) => x.type)).toEqual(["created"]);
        // cursor at the oldest → nothing older remains
        const none = yield* repo.listByTaskKeyset("t1", { createdAt: a.createdAt, id: a.id }, 10);
        expect(none).toEqual([]);
      })
    );
  });

  it("insert with nonexistent task_id fails with tagged ConstraintViolation (not a defect)", () => {
    seed(db);
    const repo = makeRepo(db);
    const result = Effect.runSync(Effect.either(
      repo.insert({ taskId: "nope", actorKind: "user", actorLabel: "Maria", actorUserId: null, type: "created", message: "x" })
    ));
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) expect(result.left).toBeInstanceOf(ConstraintViolation);
  });
});
