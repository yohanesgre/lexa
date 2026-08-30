import { describe, expect, it, afterEach, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer, Context, Either } from "effect";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { Sqlite, initSqlite, withTx, DbError } from "../db/database";
import { ActivityService } from "./activity.service";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

let dir: string;
let db: Database;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "lexa-activity-svc-"));
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
  db.prepare("INSERT INTO users (id, email, name, role) VALUES ('u1','maria@lexa.test','Maria','member')").run();
  db.prepare("INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, created_at) VALUES ('t1','p1','c1','s1','T','a0','2026-01-01 10:00:00')").run();
}

function makeService(db: Database) {
  const layer = ActivityService.Default.pipe(Layer.provide(Layer.succeed(Sqlite, db)));
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  return Context.get(ctx, ActivityService);
}

describe("ActivityService", () => {
  it("append inserts an activity row with the actor fields", () => {
    seed(db);
    const svc = makeService(db);
    Effect.runSync(
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
  });

  it("merges events and comments chronologically with keyset pagination", () => {
    seed(db);
    // Explicit created_at so ordering is deterministic: event 01-01 (oldest),
    // comment 01-02, event 01-03 (newest).
    db.prepare("INSERT INTO task_activity (task_id, actor_kind, actor_label, actor_user_id, type, message, created_at) VALUES ('t1','user','Maria','u1','created','old event','2026-01-01 10:00:00')").run();
    db.prepare("INSERT INTO task_comments (task_id, author_id, author_kind, author_label, body, created_at) VALUES ('t1','u1','user','Maria','{\"type\":\"doc\",\"content\":[]}','2026-01-02 10:00:00')").run();
    db.prepare("INSERT INTO task_activity (task_id, actor_kind, actor_label, actor_user_id, type, message, created_at) VALUES ('t1','user','Maria','u1','moved','new event','2026-01-03 10:00:00')").run();
    const svc = makeService(db);
    Effect.runSync(
      Effect.gen(function* () {
        // page 1 limit 2, ascending: [comment 01-02, event 01-03] — newest two
        const page1 = yield* svc.listMerged("t1", null, 2);
        expect(page1.items.map((i) => i.kind)).toEqual(["comment", "event"]);
        expect(page1.items[0]!.kind === "comment" && page1.items[0]!.authorLabel === "Maria").toBe(true);
        expect(page1.items[1]!.kind === "event" && page1.items[1]!.type === "moved").toBe(true);
        expect(page1.nextCursor).not.toBeNull();
        expect(page1.nextCursor!.endsWith("|comment")).toBe(true);
        // page 2: the remaining oldest event
        const page2 = yield* svc.listMerged("t1", page1.nextCursor, 2);
        expect(page2.items.map((i) => i.kind)).toEqual(["event"]);
        expect(page2.items[0]!.kind === "event" && page2.items[0]!.type === "created").toBe(true);
        expect(page2.nextCursor).toBeNull();
      })
    );
  });

  it("append is nested-transaction-safe", () => {
    seed(db);
    const svc = makeService(db);
    const result = Effect.runSync(
      Effect.either(
        withTx(db, Effect.gen(function* () {
          yield* svc.append("t1", { kind: "system", label: "system", userId: null }, "archived", "Task archived");
          yield* Effect.fail(new DbError({ message: "boom" }));
        }))
      )
    );
    expect(Either.isLeft(result)).toBe(true);
    const count = (db.prepare("SELECT COUNT(*) AS n FROM task_activity WHERE task_id = 't1'").get() as { n: number }).n;
    expect(count).toBe(0);
  });
});
