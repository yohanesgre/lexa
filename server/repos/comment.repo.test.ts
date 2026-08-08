import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer, Context } from "effect";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { Sqlite, initSqlite } from "../db/database";
import { CommentRepo } from "./comment.repo";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

let dirs: string[] = [];
let dbs: Database[] = [];

function tmpDb(): Database {
  const dir = mkdtempSync(join(tmpdir(), "lexa-comment-repo-"));
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
  db.prepare("INSERT INTO swimlanes (id, project_id, name, position) VALUES ('s1','p1','Default',0)").run();
  db.prepare("INSERT INTO users (id, email, name, role) VALUES ('u1','u1@example.com','U1','member')").run();
  db.prepare("INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, created_at) VALUES ('t1','p1','c1','s1','T','a0','2026-01-01 10:00:00')").run();
}

function makeRepo(db: Database) {
  const layer = CommentRepo.Default.pipe(Layer.provide(Layer.succeed(Sqlite, db)));
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  return Context.get(ctx, CommentRepo);
}

afterEach(() => {
  for (const db of dbs) {
    try { db.close(); } catch {}
  }
  dbs = [];
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("CommentRepo", () => {
  it("inserts, finds, updates, soft-deletes, and lists with keyset", () => {
    const db = tmpDb();
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
});
