import { describe, expect, it, afterAll, beforeAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer, Context, Either } from "effect";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { Sqlite, initSqlite } from "../db/database";
import { DbBunLive } from "../db/db";
import { SourceService } from "./source.service";
import { SourceNotFound } from "../api/errors";
import type { Actor } from "../../shared/types";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

let dir: string;
let db: Database;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "lexa-source-svc-"));
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
  db.prepare("INSERT INTO wiki_pages (id, project_id, title, slug, content) VALUES ('w1','p1','Page','page','{\"type\":\"doc\",\"content\":[]}')").run();
}

function makeService(db: Database) {
  const layer = SourceService.Default.pipe(Layer.provide(Layer.mergeAll(Layer.succeed(Sqlite, db), DbBunLive(db))));
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  return Context.get(ctx, SourceService);
}

const actor: Actor = { kind: "agent", label: "bot" };

describe("SourceService", () => {
  it("add (task + wiki kind) writes the source and its source_added activity in one batch", async () => {
    seed(db);
    const svc = makeService(db);

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

    const rows = db.prepare("SELECT COUNT(*) AS n FROM document_sources WHERE document_id = 't1'").get() as { n: number };
    expect(rows.n).toBe(1);
    const acts = db.prepare("SELECT COUNT(*) AS n FROM task_activity WHERE task_id = 't1' AND type = 'source_added'").get() as { n: number };
    expect(acts.n).toBe(1);
  });

  it("add for a wiki document emits no task activity", async () => {
    seed(db);
    const svc = makeService(db);

    const { activity } = await Effect.runPromise(svc.add(actor, {
      projectId: "p1",
      documentType: "wiki",
      documentId: "w1",
      kind: "wiki",
      ref: "page",
    }));

    expect(activity).toEqual([]);
    const acts = db.prepare("SELECT COUNT(*) AS n FROM task_activity").get() as { n: number };
    expect(acts.n).toBe(0);
  });

  it("remove an existing task source writes the source_removed activity and deletes the row in one batch", async () => {
    seed(db);
    const svc = makeService(db);
    const { source } = await Effect.runPromise(svc.add(actor, {
      projectId: "p1",
      documentType: "task",
      documentId: "t1",
      kind: "wiki",
      ref: "page",
    }));

    const { activity } = await Effect.runPromise(svc.remove(actor, "p1", source.id));
    expect(activity).toHaveLength(1);
    expect(activity[0]!.type).toBe("source_removed");

    const gone = db.prepare("SELECT COUNT(*) AS n FROM document_sources WHERE id = ?").get(source.id) as { n: number };
    expect(gone.n).toBe(0);
    const acts = db.prepare("SELECT COUNT(*) AS n FROM task_activity WHERE task_id = 't1' AND type = 'source_removed'").get() as { n: number };
    expect(acts.n).toBe(1);
  });

  it("remove a wiki source deletes the row and emits no task activity", async () => {
    seed(db);
    const svc = makeService(db);
    const { source } = await Effect.runPromise(svc.add(actor, {
      projectId: "p1",
      documentType: "wiki",
      documentId: "w1",
      kind: "wiki",
      ref: "page",
    }));

    const { activity } = await Effect.runPromise(svc.remove(actor, "p1", source.id));
    expect(activity).toEqual([]);
    const gone = db.prepare("SELECT COUNT(*) AS n FROM document_sources WHERE id = ?").get(source.id) as { n: number };
    expect(gone.n).toBe(0);
    const acts = db.prepare("SELECT COUNT(*) AS n FROM task_activity").get() as { n: number };
    expect(acts.n).toBe(0);
  });

  it("remove after the row is gone → SourceNotFound with zero orphan activity", async () => {
    seed(db);
    const svc = makeService(db);
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
