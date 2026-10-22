import { describe, expect, it, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer, Context, Either } from "effect";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { Sqlite, initSqlite, withTx, DbError } from "../db/database";
import { Db, DbBunLive, type DbDriver } from "../db/db";
import { createBunSqliteDriver } from "../db/drivers/bun-sqlite";
import { ActivityService } from "./activity.service";
import { SourceService } from "./source.service";
import { TaskLinkService } from "./task-link.service";
import { CommentService } from "./comment.service";
import { SourceNotFound, TaskLinkNotFound, CommentInvalid, CommentNotFound, CommentEditForbidden, CommentDeleteForbidden, TaskNotFound } from "../api/errors";
import type { AuthIdentityShape } from "../api/auth";
import type { Actor } from "../../shared/types";

// Invariant #12 cluster: every one of these services writes its task_activity
// rows in the same transaction/batch as the data write. Folded from
// activity.service.test.ts / source.service.test.ts / task-link.service.test.ts.

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

let dir: string;
let db: Database;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "lexa-emission-svc-"));
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

const actor: Actor = { kind: "agent", label: "bot" };

// ── ActivityService ────────────────────────────────────────────────────────

function seedActivity(db: Database) {
  db.prepare("INSERT INTO projects (id, name, slug) VALUES ('p1','P','p1')").run();
  db.prepare("INSERT INTO columns (id, project_id, name, position) VALUES ('c1','p1','Todo',0)").run();
  db.prepare("INSERT INTO swimlanes (id, project_id, name, position) VALUES ('s1','p1','Default',0)").run();
  db.prepare("INSERT INTO users (id, email, name, role) VALUES ('u1','maria@lexa.test','Maria','member')").run();
  db.prepare("INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, created_at) VALUES ('t1','p1','c1','s1','T','a0','2026-01-01 10:00:00')").run();
}

function makeActivityService(db: Database) {
  const layer = ActivityService.Default.pipe(Layer.provide(Layer.mergeAll(Layer.succeed(Sqlite, db), DbBunLive(db))));
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  return Context.get(ctx, ActivityService);
}

describe("ActivityService", () => {
  it("append inserts an activity row with the actor fields and is nested-transaction-safe", async () => {
    seedActivity(db);
    const svc = makeActivityService(db);
    await Effect.runPromise(
      Effect.gen(function* () {
        const ev = yield* svc.append("t1", { kind: "user", label: "Maria", userId: "u1" }, "created", "Maria created this task");
        expect(ev.id).toBeGreaterThan(0);
        expect(ev.taskId).toBe("t1");
        expect(ev.actorKind).toBe("user");
        expect(ev.actorLabel).toBe("Maria");
        expect(ev.actorUserId).toBe("u1");
        expect(ev.type).toBe("created");
        expect(ev.message).toBe("Maria created this task");
      })
    );

    // Nested in an outer tx that then fails → only the committed row survives.
    const result = await Effect.runPromise(
      Effect.either(
        withTx(db, Effect.gen(function* () {
          yield* svc.append("t1", { kind: "system", label: "system", userId: null }, "archived", "Task archived");
          yield* Effect.fail(new DbError({ message: "boom" }));
        }))
      )
    );
    expect(Either.isLeft(result)).toBe(true);
    const count = (db.prepare("SELECT COUNT(*) AS n FROM task_activity WHERE task_id = 't1'").get() as { n: number }).n;
    expect(count).toBe(1);
  });
});

// ── SourceService ──────────────────────────────────────────────────────────

function seedSource(db: Database) {
  db.prepare("INSERT INTO projects (id, name, slug) VALUES ('p1','P','p1')").run();
  db.prepare("INSERT INTO columns (id, project_id, name, position) VALUES ('c1','p1','Todo',0)").run();
  db.prepare("INSERT INTO swimlanes (id, project_id, name, position) VALUES ('s1','p1','Default',0)").run();
  db.prepare("INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, created_at) VALUES ('t1','p1','c1','s1','T','a0','2026-01-01 10:00:00')").run();
  db.prepare("INSERT INTO wiki_pages (id, project_id, title, slug, content) VALUES ('w1','p1','Page','page','{\"type\":\"doc\",\"content\":[]}')").run();
}

function makeSourceService(db: Database) {
  const layer = SourceService.Default.pipe(Layer.provide(Layer.mergeAll(Layer.succeed(Sqlite, db), DbBunLive(db))));
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  return Context.get(ctx, SourceService);
}

describe("SourceService", () => {
  it("add writes the source plus source_added for a task, and no task activity for a wiki document", async () => {
    seedSource(db);
    const svc = makeSourceService(db);

    const { source, activity } = await Effect.runPromise(svc.add(actor, {
      projectId: "p1",
      documentType: "task",
      documentId: "t1",
      kind: "wiki",
      ref: "page",
    }));
    expect(source.documentId).toBe("t1");
    expect(source.kind).toBe("wiki");
    expect(source.title).toBe("Page");
    expect(activity).toHaveLength(1);
    expect(activity[0]!.type).toBe("source_added");
    expect((db.prepare("SELECT COUNT(*) AS n FROM document_sources WHERE document_id = 't1'").get() as { n: number }).n).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS n FROM task_activity WHERE task_id = 't1' AND type = 'source_added'").get() as { n: number }).n).toBe(1);

    const wiki = await Effect.runPromise(svc.add(actor, {
      projectId: "p1",
      documentType: "wiki",
      documentId: "w1",
      kind: "wiki",
      ref: "page",
    }));
    expect(wiki.activity).toEqual([]);
    expect((db.prepare("SELECT COUNT(*) AS n FROM document_sources WHERE document_id = 'w1'").get() as { n: number }).n).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS n FROM task_activity").get() as { n: number }).n).toBe(1);
  });

  it("remove writes source_removed (and deletes the row) for a task source, and no task activity for a wiki source", async () => {
    seedSource(db);
    const svc = makeSourceService(db);
    const taskSource = await Effect.runPromise(svc.add(actor, {
      projectId: "p1",
      documentType: "task",
      documentId: "t1",
      kind: "wiki",
      ref: "page",
    }));

    const { activity } = await Effect.runPromise(svc.remove(actor, "p1", taskSource.source.id));
    expect(activity).toHaveLength(1);
    expect(activity[0]!.type).toBe("source_removed");
    expect((db.prepare("SELECT COUNT(*) AS n FROM document_sources WHERE id = ?").get(taskSource.source.id) as { n: number }).n).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM task_activity WHERE task_id = 't1' AND type = 'source_removed'").get() as { n: number }).n).toBe(1);

    const wikiSource = await Effect.runPromise(svc.add(actor, {
      projectId: "p1",
      documentType: "wiki",
      documentId: "w1",
      kind: "wiki",
      ref: "page",
    }));
    const wikiRemoved = await Effect.runPromise(svc.remove(actor, "p1", wikiSource.source.id));
    expect(wikiRemoved.activity).toEqual([]);
    expect((db.prepare("SELECT COUNT(*) AS n FROM document_sources WHERE id = ?").get(wikiSource.source.id) as { n: number }).n).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM task_activity").get() as { n: number }).n).toBe(2);
  });

  it("remove after the row is gone → SourceNotFound with zero orphan activity", async () => {
    seedSource(db);
    const svc = makeSourceService(db);
    const { source } = await Effect.runPromise(svc.add(actor, {
      projectId: "p1",
      documentType: "task",
      documentId: "t1",
      kind: "wiki",
      ref: "page",
    }));

    // Another writer removes the source before this call's pre-read.
    db.prepare("DELETE FROM document_sources WHERE id = ?").run(source.id);

    const removed = await Effect.runPromise(Effect.either(svc.remove(actor, "p1", source.id)));
    expect(Either.isLeft(removed)).toBe(true);
    if (Either.isLeft(removed)) expect(removed.left).toBeInstanceOf(SourceNotFound);

    const removedActivity = db.prepare("SELECT COUNT(*) AS n FROM task_activity WHERE type = 'source_removed'").get() as { n: number };
    expect(removedActivity.n).toBe(0);
    const addedActivity = db.prepare("SELECT COUNT(*) AS n FROM task_activity WHERE type = 'source_added'").get() as { n: number };
    expect(addedActivity.n).toBe(1);
  });
});

// ── TaskLinkService ────────────────────────────────────────────────────────

function seedLinks(db: Database) {
  db.prepare("INSERT INTO projects (id, name, slug, key, next_task_number) VALUES ('p1','P','p1','EG',1)").run();
  db.prepare("INSERT INTO columns (id, project_id, name, position) VALUES ('c1','p1','Todo',0), ('c2','p1','Doing',1)").run();
  db.prepare("INSERT INTO swimlanes (id, project_id, name, position) VALUES ('s1','p1','Default',0)").run();
  db.prepare("INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, created_at, key, number) VALUES ('t1','p1','c1','s1','T1','a0','2026-01-01 10:00:00','EG-1',1)").run();
  db.prepare("INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, created_at, key, number) VALUES ('t2','p1','c2','s1','T2','a1','2026-01-01 10:00:00','EG-2',2)").run();
}

function makeTaskLinkService(db: Database) {
  const layer = TaskLinkService.Default.pipe(Layer.provide(Layer.mergeAll(Layer.succeed(Sqlite, db), DbBunLive(db))));
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  return Context.get(ctx, TaskLinkService);
}

describe("TaskLinkService.add", () => {
  it("inserts the link plus its link_added activity in one batch, and a subtask_of link moves the child in the same batch", async () => {
    seedLinks(db);
    const svc = makeTaskLinkService(db);

    const { link, activity } = await Effect.runPromise(svc.add(actor, {
      projectId: "p1",
      fromTaskId: "t1",
      toTaskId: "t2",
      relation: "related_to",
    }));
    expect(link.fromTaskId).toBe("t1");
    expect(link.toTaskId).toBe("t2");
    expect(link.relation).toBe("related_to");
    expect(activity).toHaveLength(1);
    expect(activity[0]!.type).toBe("link_added");
    expect((db.prepare("SELECT COUNT(*) AS n FROM task_links WHERE id = ?").get(link.id) as { n: number }).n).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS n FROM task_activity WHERE task_id = 't1' AND type = 'link_added'").get() as { n: number }).n).toBe(1);

    const { link: subtask } = await Effect.runPromise(svc.add(actor, {
      projectId: "p1",
      fromTaskId: "t1",
      toTaskId: "t2",
      relation: "subtask_of",
    }));
    expect(subtask.relation).toBe("subtask_of");
    const child = db.prepare("SELECT column_id FROM tasks WHERE id = 't1'").get() as { column_id: string };
    expect(child.column_id).toBe("c2");
  });
});

describe("TaskLinkService.remove", () => {
  it("deletes the link and emits link_removed, and a link gone before the batch yields TaskLinkNotFound with zero orphan activity", async () => {
    seedLinks(db);
    const svc = makeTaskLinkService(db);
    const { link } = await Effect.runPromise(svc.add(actor, {
      projectId: "p1",
      fromTaskId: "t1",
      toTaskId: "t2",
      relation: "related_to",
    }));

    const { activity } = await Effect.runPromise(svc.remove(actor, "t1", link.id));
    expect(activity).toHaveLength(1);
    expect(activity[0]!.type).toBe("link_removed");
    expect((db.prepare("SELECT COUNT(*) AS n FROM task_links WHERE id = ?").get(link.id) as { n: number }).n).toBe(0);

    // Another writer removes the link before this call's pre-read.
    const { link: second } = await Effect.runPromise(svc.add(actor, {
      projectId: "p1",
      fromTaskId: "t1",
      toTaskId: "t2",
      relation: "related_to",
    }));
    db.prepare("DELETE FROM task_links WHERE id = ?").run(second.id);
    const removed = await Effect.runPromise(Effect.either(svc.remove(actor, "t1", second.id)));
    expect(Either.isLeft(removed)).toBe(true);
    if (Either.isLeft(removed)) expect(removed.left).toBeInstanceOf(TaskLinkNotFound);
    expect((db.prepare("SELECT COUNT(*) AS n FROM task_activity WHERE type = 'link_removed'").get() as { n: number }).n).toBe(1);
  });
});

// Carried from the absorbed server/repos/task-link.repo.test.ts: search() feeds
// the @-link autocomplete, so a user-typed wildcard must be a literal.
describe("TaskLinkService.search LIKE escaping", () => {
  function seedTitles(database: Database) {
    database.prepare(
      `INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, created_at, key, number) VALUES
        ('e1','p1','c1','s1','Progress 50% done','b0','2026-01-01 10:00:00','EG-3',3),
        ('e2','p1','c1','s1','under_score name','b1','2026-01-01 10:00:00','EG-4',4),
        ('e3','p1','c1','s1','back\\slash name','b2','2026-01-01 10:00:00','EG-5',5),
        ('e4','p1','c1','s1','plain title','b3','2026-01-01 10:00:00','EG-6',6)`
    ).run();
  }

  it("treats % as a literal character — does not match all rows", async () => {
    seedLinks(db);
    seedTitles(db);
    const svc = makeTaskLinkService(db);
    const rows = await Effect.runPromise(svc.search("p1", "%", "none"));
    expect(rows.map((r) => r.title)).toEqual(["Progress 50% done"]);
  });

  it("treats _ as a literal character — does not match all rows", async () => {
    seedLinks(db);
    seedTitles(db);
    const svc = makeTaskLinkService(db);
    const rows = await Effect.runPromise(svc.search("p1", "_", "none"));
    expect(rows.map((r) => r.title)).toEqual(["under_score name"]);
  });

  it("treats backslash as a literal character", async () => {
    seedLinks(db);
    seedTitles(db);
    const svc = makeTaskLinkService(db);
    const rows = await Effect.runPromise(svc.search("p1", "\\", "none"));
    expect(rows.map((r) => r.title)).toEqual(["back\\slash name"]);
  });

  it("plain substring search still works and excludes the given task id", async () => {
    seedLinks(db);
    seedTitles(db);
    const svc = makeTaskLinkService(db);
    const rows = await Effect.runPromise(svc.search("p1", "plain", "none"));
    expect(rows.map((r) => r.title)).toEqual(["plain title"]);
    const excluded = await Effect.runPromise(svc.search("p1", "plain", "e4"));
    expect(excluded).toEqual([]);
  });
});

// ── CommentService (folded from comment.service.test.ts) ───────────────────

const commentIdOf = (userId: string | null): AuthIdentityShape => ({ keyId: "k1", keyName: "k1", userId, userName: userId ? "X" : null, role: "member" });
const maria: Actor = { kind: "user", label: "Maria", userId: "u1" };
const COMMENT_BODY = "hi";
const COMMENT_EMPTY = "";

function seedComments(database: Database) {
  database.prepare("INSERT INTO projects (id, name, slug) VALUES ('p1','P','p1')").run();
  database.prepare("INSERT INTO columns (id, project_id, name, position) VALUES ('c1','p1','Todo',0)").run();
  database.prepare("INSERT INTO swimlanes (id, project_id, name, position) VALUES ('s1','p1','Default',0)").run();
  database.prepare("INSERT INTO users (id, email, name, role) VALUES ('u1','maria@lexa.test','Maria','member'), ('u2','alex@lexa.test','Alex','member'), ('u3','carl@lexa.test','Carl','member')").run();
  database.prepare("INSERT INTO user_project_roles (user_id, role, project_id) VALUES ('u2','admin','p1')").run();
  database.prepare("INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, created_at) VALUES ('t1','p1','c1','s1','T','a0','2026-01-01 10:00:00')").run();
}

function makeCommentService(database: Database) {
  const layer = CommentService.Default.pipe(Layer.provide(Layer.mergeAll(Layer.succeed(Sqlite, database), DbBunLive(database))));
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  return Context.get(ctx, CommentService);
}

describe("CommentService", () => {
  it("create validates and appends activity in one tx, and a row deleted before the batch yields CommentNotFound with zero orphan activity", async () => {
    seedComments(db);
    const svc = makeCommentService(db);

    const invalid = await Effect.runPromise(Effect.either(svc.create("t1", maria, COMMENT_EMPTY)));
    expect(Either.isLeft(invalid)).toBe(true);
    if (Either.isLeft(invalid)) expect(invalid.left).toBeInstanceOf(CommentInvalid);
    const missingTask = await Effect.runPromise(Effect.either(svc.create("nope", maria, COMMENT_BODY)));
    expect(Either.isLeft(missingTask)).toBe(true);
    if (Either.isLeft(missingTask)) expect(missingTask.left).toBeInstanceOf(TaskNotFound);

    const ok = await Effect.runPromise(Effect.either(svc.create("t1", maria, COMMENT_BODY)));
    expect(Either.isRight(ok)).toBe(true);
    if (Either.isRight(ok)) {
      expect(ok.right.comment.authorLabel).toBe("Maria");
      expect(ok.right.comment.body).toEqual(COMMENT_BODY);
      expect(ok.right.activity.type).toBe("commented");
      expect(ok.right.activity.message).toBe("Maria commented");
    }
    expect((db.prepare("SELECT COUNT(*) AS n FROM task_activity WHERE type = 'commented'").get() as { n: number }).n).toBe(1);

    // Force the race the SQL guard exists for: the pre-read sees a live row,
    // then another writer deletes it immediately before the batch. The activity
    // INSERT ... WHERE EXISTS must select nothing and the soft-delete must match
    // nothing — no orphan comment_deleted row.
    const { comment } = await Effect.runPromise(svc.create("t1", maria, COMMENT_BODY));
    const base = createBunSqliteDriver(db);
    let fired = false;
    const hooked: DbDriver = {
      ...base,
      batch: async (stmts) => {
        if (!fired) {
          fired = true;
          db.prepare("DELETE FROM task_comments WHERE id = ?").run(comment.id);
        }
        return base.batch(stmts);
      },
    };
    const hookedLayer = CommentService.Default.pipe(
      Layer.provide(Layer.mergeAll(Layer.succeed(Sqlite, db), Layer.succeed(Db, hooked)))
    );
    const hookedSvc = Context.get(Effect.runSync(Effect.scoped(Layer.build(hookedLayer))), CommentService);
    const removed = await Effect.runPromise(Effect.either(hookedSvc.remove(comment.id, commentIdOf("u1"), "p1", "t1")));
    expect(Either.isLeft(removed)).toBe(true);
    if (Either.isLeft(removed)) expect(removed.left).toBeInstanceOf(CommentNotFound);
    expect((db.prepare("SELECT COUNT(*) AS n FROM task_activity WHERE type = 'comment_deleted'").get() as { n: number }).n).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM task_activity WHERE type = 'commented'").get() as { n: number }).n).toBe(2);
  });

  it("edit allows only the author, and delete allows author or admin (soft-delete + comment_deleted)", async () => {
    seedComments(db);
    const svc = makeCommentService(db);
    await Effect.runPromise(
      Effect.gen(function* () {
        const { comment } = yield* svc.create("t1", maria, COMMENT_BODY);
        const forbidden = yield* Effect.either(svc.edit(comment.id, commentIdOf("u2"), COMMENT_BODY, "t1"));
        expect(Either.isLeft(forbidden)).toBe(true);
        if (Either.isLeft(forbidden)) expect(forbidden.left).toBeInstanceOf(CommentEditForbidden);
        const wrongTask = yield* Effect.either(svc.edit(comment.id, commentIdOf("u1"), COMMENT_BODY, "t2"));
        expect(Either.isLeft(wrongTask)).toBe(true);
        if (Either.isLeft(wrongTask)) expect(wrongTask.left).toBeInstanceOf(CommentNotFound);
        const edited = yield* Effect.either(svc.edit(comment.id, commentIdOf("u1"), "edited", "t1"));
        expect(Either.isRight(edited)).toBe(true);
        if (Either.isRight(edited)) expect(edited.right.editedAt).not.toBeNull();
        const empty = yield* Effect.either(svc.edit(comment.id, commentIdOf("u1"), COMMENT_EMPTY, "t1"));
        expect(Either.isLeft(empty)).toBe(true);
        if (Either.isLeft(empty)) expect(empty.left).toBeInstanceOf(CommentInvalid);
        const missingEdit = yield* Effect.either(svc.edit(9999, commentIdOf("u1"), COMMENT_BODY, "t1"));
        expect(Either.isLeft(missingEdit)).toBe(true);
        if (Either.isLeft(missingEdit)) expect(missingEdit.left).toBeInstanceOf(CommentNotFound);
        expect((db.prepare("SELECT COUNT(*) AS n FROM task_activity WHERE type = 'commented'").get() as { n: number }).n).toBe(1);

        // plain member (u3) → CommentDeleteForbidden; project admin (u2) → ok.
        const deleteForbidden = yield* Effect.either(svc.remove(comment.id, commentIdOf("u3"), "p1", "t1"));
        expect(Either.isLeft(deleteForbidden)).toBe(true);
        if (Either.isLeft(deleteForbidden)) expect(deleteForbidden.left).toBeInstanceOf(CommentDeleteForbidden);
        const removed = yield* Effect.either(svc.remove(comment.id, commentIdOf("u2"), "p1", "t1"));
        expect(Either.isRight(removed)).toBe(true);
        if (Either.isRight(removed)) {
          expect(removed.right.comment.deletedAt).not.toBeNull();
          expect(removed.right.activity.type).toBe("comment_deleted");
          expect(removed.right.activity.message).toBe("X deleted a comment");
        }
        // author can delete her own; a different task → CommentNotFound; agent cannot.
        const { comment: c2 } = yield* svc.create("t1", maria, COMMENT_BODY);
        const authorRemoved = yield* Effect.either(svc.remove(c2.id, commentIdOf("u1"), "p1", "t1"));
        expect(Either.isRight(authorRemoved)).toBe(true);
        const wrongTaskRemove = yield* Effect.either(svc.remove(c2.id, commentIdOf("u1"), "p1", "t2"));
        expect(Either.isLeft(wrongTaskRemove)).toBe(true);
        if (Either.isLeft(wrongTaskRemove)) expect(wrongTaskRemove.left).toBeInstanceOf(CommentNotFound);
        const { comment: c3 } = yield* svc.create("t1", maria, COMMENT_BODY);
        const agent = yield* Effect.either(svc.remove(c3.id, commentIdOf(null), "p1", "t1"));
        expect(Either.isLeft(agent)).toBe(true);
        if (Either.isLeft(agent)) expect(agent.left).toBeInstanceOf(CommentDeleteForbidden);
      })
    );
  });
});
