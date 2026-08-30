import { describe, expect, it, afterEach, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer, Context, Either } from "effect";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { Sqlite, initSqlite, RowNotFound, ConstraintViolation } from "../db/database";
import { CommentRepo } from "./comment.repo";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

let dir: string;
let db: Database;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "lexa-comment-repo-"));
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
  db.prepare("INSERT INTO users (id, email, name, role) VALUES ('u1','u1@example.com','U1','member')").run();
  db.prepare("INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, created_at) VALUES ('t1','p1','c1','s1','T','a0','2026-01-01 10:00:00')").run();
}

function makeRepo(db: Database) {
  const layer = CommentRepo.Default.pipe(Layer.provide(Layer.succeed(Sqlite, db)));
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  return Context.get(ctx, CommentRepo);
}

describe("CommentRepo", () => {
  it("inserts, finds, updates, soft-deletes, and lists with keyset", () => {
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        const c = yield* repo.insert({ taskId: "t1", authorId: "u1", authorKind: "user", authorLabel: "Maria", body: JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }] }) });
        expect(c.id).toBeGreaterThan(0);
        const found = yield* repo.findById(c.id);
        expect(found?.authorLabel).toBe("Maria");
        const updated = yield* repo.updateBody(c.id, JSON.stringify({ type: "doc", content: [] }));
        expect(updated.editedAt).not.toBeNull();
        const listed = yield* repo.listByTaskKeyset("t1", null, 10);
        expect(listed).toHaveLength(1);
        yield* repo.softDelete(c.id);
        const hidden = yield* repo.listByTaskKeyset("t1", null, 10);
        expect(hidden).toEqual([]);
      })
    );
  });

  it("insert with nonexistent task_id fails with tagged ConstraintViolation (not a defect)", () => {
    seed(db);
    const repo = makeRepo(db);
    const result = Effect.runSync(Effect.either(
      repo.insert({ taskId: "nope", authorId: null, authorKind: "system", authorLabel: "system", body: JSON.stringify({ type: "doc", content: [] }) })
    ));
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) expect(result.left).toBeInstanceOf(ConstraintViolation);
  });

  it("updateBody on missing id fails with RowNotFound", () => {
    seed(db);
    const repo = makeRepo(db);
    const result = Effect.runSync(Effect.either(
      repo.updateBody(999, JSON.stringify({ type: "doc", content: [] }))
    ));
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) expect(result.left).toBeInstanceOf(RowNotFound);
  });

  it("softDelete on missing id fails with RowNotFound", () => {
    seed(db);
    const repo = makeRepo(db);
    const result = Effect.runSync(Effect.either(repo.softDelete(999)));
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) expect(result.left).toBeInstanceOf(RowNotFound);
  });

  it("updateBody on an already-deleted comment fails with RowNotFound", () => {
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        const c = yield* repo.insert({ taskId: "t1", authorId: "u1", authorKind: "user", authorLabel: "Maria", body: JSON.stringify({ type: "doc", content: [] }) });
        yield* repo.softDelete(c.id);
        const result = yield* Effect.either(repo.updateBody(c.id, JSON.stringify({ type: "doc", content: [] })));
        expect(Either.isLeft(result)).toBe(true);
        if (Either.isLeft(result)) expect(result.left).toBeInstanceOf(RowNotFound);
      })
    );
  });

  it("softDelete on an already-deleted comment fails with RowNotFound", () => {
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        const c = yield* repo.insert({ taskId: "t1", authorId: "u1", authorKind: "user", authorLabel: "Maria", body: JSON.stringify({ type: "doc", content: [] }) });
        yield* repo.softDelete(c.id);
        const result = yield* Effect.either(repo.softDelete(c.id));
        expect(Either.isLeft(result)).toBe(true);
        if (Either.isLeft(result)) expect(result.left).toBeInstanceOf(RowNotFound);
      })
    );
  });
});
