import { describe, expect, it, afterEach, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer, Context, Either } from "effect";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { Sqlite, initSqlite } from "../db/database";
import { CommentService } from "./comment.service";
import { CommentInvalid, CommentNotFound, CommentEditForbidden, CommentDeleteForbidden, TaskNotFound } from "../api/errors";
import type { AuthIdentityShape } from "../api/auth";
import type { TipTapDoc, Actor } from "../../shared/types";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

let dir: string;
let db: Database;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "lexa-comment-svc-"));
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
  db.prepare("INSERT INTO users (id, email, name, role) VALUES ('u1','maria@lexa.test','Maria','member'), ('u2','alex@lexa.test','Alex','member'), ('u3','carl@lexa.test','Carl','member')").run();
  // u2 is project admin for p1; u3 is plain member
  db.prepare("INSERT INTO user_project_roles (user_id, role, project_id) VALUES ('u2','admin','p1')").run();
  db.prepare("INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, created_at) VALUES ('t1','p1','c1','s1','T','a0','2026-01-01 10:00:00')").run();
}

function makeService(db: Database) {
  const layer = CommentService.Default.pipe(Layer.provide(Layer.succeed(Sqlite, db)));
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  return Context.get(ctx, CommentService);
}

const idOf = (userId: string | null): AuthIdentityShape => ({ keyId: "k1", keyName: "k1", userId, userName: userId ? "X" : null, role: "member" });
const maria: Actor = { kind: "user", label: "Maria", userId: "u1" };
const BODY: TipTapDoc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }] };
const EMPTY: TipTapDoc = { type: "doc", content: [] };

describe("CommentService", () => {
  it("create validates and appends activity in one tx", () => {
    seed(db);
    const svc = makeService(db);
    // empty doc → CommentInvalid
    const invalid = Effect.runSync(Effect.either(svc.create("t1", maria, EMPTY)));
    expect(Either.isLeft(invalid)).toBe(true);
    if (Either.isLeft(invalid)) expect(invalid.left).toBeInstanceOf(CommentInvalid);
    // missing task → TaskNotFound
    const missing = Effect.runSync(Effect.either(svc.create("nope", maria, BODY)));
    expect(Either.isLeft(missing)).toBe(true);
    if (Either.isLeft(missing)) expect(missing.left).toBeInstanceOf(TaskNotFound);
    // valid → comment + 'commented' activity
    const ok = Effect.runSync(Effect.either(svc.create("t1", maria, BODY)));
    expect(Either.isRight(ok)).toBe(true);
    if (Either.isRight(ok)) {
      expect(ok.right.comment.authorLabel).toBe("Maria");
      expect(ok.right.comment.body).toEqual(BODY);
      expect(ok.right.activity.type).toBe("commented");
      expect(ok.right.activity.message).toBe("Maria commented");
    }
    const rows = db.prepare("SELECT COUNT(*) AS n FROM task_activity WHERE type = 'commented'").get() as { n: number };
    expect(rows.n).toBe(1);
  });

  it("edit allows only the author", () => {
    seed(db);
    const svc = makeService(db);
    Effect.runSync(
      Effect.gen(function* () {
        const { comment } = yield* svc.create("t1", maria, BODY);
        // non-author → CommentEditForbidden
        const forbidden = yield* Effect.either(svc.edit(comment.id, idOf("u2"), BODY));
        expect(Either.isLeft(forbidden)).toBe(true);
        if (Either.isLeft(forbidden)) expect(forbidden.left).toBeInstanceOf(CommentEditForbidden);
        // author → editedAt set, no new activity row
        const edited = yield* Effect.either(svc.edit(comment.id, idOf("u1"), { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "edited" }] }] }));
        expect(Either.isRight(edited)).toBe(true);
        if (Either.isRight(edited)) expect(edited.right.editedAt).not.toBeNull();
        const commented = yield* Effect.either(svc.edit(comment.id, idOf("u1"), EMPTY));
        expect(Either.isLeft(commented)).toBe(true);
        if (Either.isLeft(commented)) expect(commented.left).toBeInstanceOf(CommentInvalid);
        const missing = yield* Effect.either(svc.edit(9999, idOf("u1"), BODY));
        expect(Either.isLeft(missing)).toBe(true);
        if (Either.isLeft(missing)) expect(missing.left).toBeInstanceOf(CommentNotFound);
        const count = (db.prepare("SELECT COUNT(*) AS n FROM task_activity WHERE type = 'commented'").get() as { n: number }).n;
        expect(count).toBe(1);
      })
    );
  });

  it("delete allows author or admin, soft-deletes, appends comment_deleted", () => {
    seed(db);
    const svc = makeService(db);
    Effect.runSync(
      Effect.gen(function* () {
        const { comment: c1 } = yield* svc.create("t1", maria, BODY);
        // plain member (u3) → CommentDeleteForbidden
        const forbidden = yield* Effect.either(svc.remove(c1.id, idOf("u3"), "p1"));
        expect(Either.isLeft(forbidden)).toBe(true);
        if (Either.isLeft(forbidden)) expect(forbidden.left).toBeInstanceOf(CommentDeleteForbidden);
        // project admin (u2) → ok, soft-deleted + 'comment_deleted' activity
        const removed = yield* Effect.either(svc.remove(c1.id, idOf("u2"), "p1"));
        expect(Either.isRight(removed)).toBe(true);
        if (Either.isRight(removed)) {
          expect(removed.right.comment.deletedAt).not.toBeNull();
          expect(removed.right.activity.type).toBe("comment_deleted");
          expect(removed.right.activity.message).toBe("X deleted a comment");
        }
        // author can delete her own
        const { comment: c2 } = yield* svc.create("t1", maria, BODY);
        const authorRemoved = yield* Effect.either(svc.remove(c2.id, idOf("u1"), "p1"));
        expect(Either.isRight(authorRemoved)).toBe(true);
        if (Either.isRight(authorRemoved)) expect(authorRemoved.right.comment.deletedAt).not.toBeNull();
        // missing id → CommentNotFound
        const missing = yield* Effect.either(svc.remove(9999, idOf("u1"), "p1"));
        expect(Either.isLeft(missing)).toBe(true);
        if (Either.isLeft(missing)) expect(missing.left).toBeInstanceOf(CommentNotFound);
        // agent identity (no userId) can never delete
        const { comment: c3 } = yield* svc.create("t1", maria, BODY);
        const agent = yield* Effect.either(svc.remove(c3.id, idOf(null), "p1"));
        expect(Either.isLeft(agent)).toBe(true);
        if (Either.isLeft(agent)) expect(agent.left).toBeInstanceOf(CommentDeleteForbidden);
      })
    );
  });
});
