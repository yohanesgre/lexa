import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer, Context } from "effect";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { Sqlite, initSqlite } from "../db/database";
import { ActivityRepo } from "./activity.repo";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

let dirs: string[] = [];
let dbs: Database[] = [];

function tmpDb(): Database {
  const dir = mkdtempSync(join(tmpdir(), "lexa-activity-repo-"));
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
  db.prepare("INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, created_at) VALUES ('t1','p1','c1','s1','T','a0','2026-01-01 10:00:00')").run();
}

function makeRepo(db: Database) {
  const layer = ActivityRepo.Default.pipe(Layer.provide(Layer.succeed(Sqlite, db)));
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  return Context.get(ctx, ActivityRepo);
}

afterEach(() => {
  for (const db of dbs) {
    try { db.close(); } catch {}
  }
  dbs = [];
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("ActivityRepo", () => {
  it("inserts and lists rows with keyset cursor", () => {
    const db = tmpDb();
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
});
