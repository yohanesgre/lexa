import { describe, expect, it, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer, Context, Either } from "effect";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { Sqlite } from "../db/database";
import { DbBunLive, batch } from "../db/db";
import { createBunSqliteDriver } from "../db/drivers/bun-sqlite";
import { ProjectRepo } from "./project.repo";
import { buildTaskCreateBatch } from "./task-batch";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

let dir: string;
let dbPath: string;
let db: Database;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "lexa-project-repo-"));
  dbPath = join(dir, "test.db");
  runMigrations(dbPath, MIGRATIONS);
  db = new Database(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
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

function makeRepo(db: Database) {
  const layer = ProjectRepo.Default.pipe(Layer.provide(Layer.mergeAll(Layer.succeed(Sqlite, db), DbBunLive(db))));
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  return Context.get(ctx, ProjectRepo);
}

const base = { name: "Emberfall", slug: "emberfall", key: "EG", description: "" };

describe("ProjectRepo", () => {
  it("create round-trips key/slug/description and is found by id and slug", async () => {
    const repo = makeRepo(db);
    await Effect.runPromise(repo.create({ id: "p1", ...base }));

    const byId = await Effect.runPromise(repo.findById("p1"));
    expect(byId).toMatchObject({ id: "p1", name: "Emberfall", slug: "emberfall", key: "EG", description: "", teamId: null });
    const bySlug = await Effect.runPromise(repo.findBySlug("emberfall"));
    expect(bySlug.id).toBe("p1");
    expect(byId.createdAt).toBeTruthy();
    expect(await Effect.runPromise(repo.listKeys())).toEqual(["EG"]);
  });

  it("findById and findBySlug surface RowNotFound for unknown values", async () => {
    const repo = makeRepo(db);
    const byId = await Effect.runPromise(Effect.either(repo.findById("nope")));
    expect(Either.isLeft(byId)).toBe(true);
    if (Either.isLeft(byId)) expect(byId.left._tag).toBe("RowNotFound");
    const bySlug = await Effect.runPromise(Effect.either(repo.findBySlug("nope")));
    expect(Either.isLeft(bySlug)).toBe(true);
    if (Either.isLeft(bySlug)) expect(bySlug.left._tag).toBe("RowNotFound");
  });

  it("update mutates provided fields, bumps updated_at, and no-op update reads back", async () => {
    const repo = makeRepo(db);
    await Effect.runPromise(repo.create({ id: "p1", ...base }));
    db.prepare("UPDATE projects SET updated_at = '2000-01-01 00:00:00' WHERE id = 'p1'").run();

    const updated = await Effect.runPromise(repo.update("p1", { name: "Emberfall v2", description: "d", teamId: null }));
    expect(updated).toMatchObject({ name: "Emberfall v2", description: "d", teamId: null });
    expect(updated.updatedAt).not.toBe("2000-01-01 00:00:00");

    const noop = await Effect.runPromise(repo.update("p1", {}));
    expect(noop.name).toBe("Emberfall v2");
  });

  it("rejects a duplicate slug and a duplicate id with ConstraintViolation", async () => {
    const repo = makeRepo(db);
    await Effect.runPromise(repo.create({ id: "p1", ...base }));

    const dupSlug = await Effect.runPromise(Effect.either(repo.create({ id: "p2", name: "Other", slug: "emberfall", key: "OT", description: "" })));
    expect(Either.isLeft(dupSlug)).toBe(true);
    if (Either.isLeft(dupSlug)) expect(dupSlug.left._tag).toBe("ConstraintViolation");

    const dupId = await Effect.runPromise(Effect.either(repo.create({ id: "p1", name: "Other", slug: "other", key: "OT", description: "" })));
    expect(Either.isLeft(dupId)).toBe(true);
    if (Either.isLeft(dupId)) expect(dupId.left._tag).toBe("ConstraintViolation");
  });

  // DB-level assertion of the create batch (`buildTaskCreateBatch`): the
  // counter increment and the INSERT that reads it are one transaction, so a
  // failed insert rolls the increment back (no burned numbers). TaskService
  // consumes the same builder.
  it("the create batch increments the counter and computes number/key atomically; a failed insert rolls back the increment", async () => {
    const repo = makeRepo(db);
    await Effect.runPromise(repo.create({ id: "p1", ...base }));
    db.prepare("INSERT INTO columns (id, project_id, name, position, github_state) VALUES ('c1','p1','Todo',0,'open')").run();
    db.prepare("INSERT INTO swimlanes (id, project_id, name, position, kind) VALUES ('s1','p1','Default',0,'backlog')").run();
    const driver = createBunSqliteDriver(db);
    const mk = (id: string, position: string) => buildTaskCreateBatch({
      id, projectId: "p1", columnId: "c1", swimlaneId: "s1", title: "T", description: "{}",
      priority: "pr", type: "ty", position, dueAt: null, projectKey: "EG", assignees: [], activity: [],
    });

    await Effect.runPromise(batch(driver, mk("t1", "a0")));
    const first = db.query("SELECT number, key FROM tasks WHERE id='t1'").get() as { number: number; key: string };
    expect(first).toEqual({ number: 1, key: "EG-1" });

    // Duplicate id → the INSERT fails → the whole batch (counter included) rolls back.
    const failed = await Effect.runPromise(Effect.either(batch(driver, mk("t1", "a1"))));
    expect(Either.isLeft(failed)).toBe(true);
    const after = db.query("SELECT next_task_number FROM projects WHERE id='p1'").get() as { next_task_number: number };
    expect(after.next_task_number).toBe(1);
    expect(db.query("SELECT COUNT(*) c FROM tasks WHERE id='t1'").get()).toEqual({ c: 1 });
  });

  it("list orders by created_at DESC and listKeys skips NULL keys", async () => {
    const repo = makeRepo(db);
    await Effect.runPromise(repo.create({ id: "p-old", name: "Old", slug: "old", key: "OL", description: "" }));
    await Effect.runPromise(repo.create({ id: "p-new", name: "New", slug: "new", key: "NW", description: "" }));
    db.prepare("UPDATE projects SET created_at = '2000-01-01 00:00:00' WHERE id = 'p-old'").run();
    db.prepare("UPDATE projects SET created_at = '2030-01-01 00:00:00' WHERE id = 'p-new'").run();
    db.prepare("INSERT INTO projects (id, name, slug, key, description) VALUES ('p-null','Null','null-key',NULL,'')").run();
    db.prepare("UPDATE projects SET created_at = '1990-01-01 00:00:00' WHERE id = 'p-null'").run();

    const listed = await Effect.runPromise(repo.list());
    expect(listed.map((p) => p.id)).toEqual(["p-new", "p-old", "p-null"]);
    expect((await Effect.runPromise(repo.listKeys())).sort()).toEqual(["NW", "OL"]);
  });
});
