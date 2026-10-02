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
import { TaskLinkService } from "./task-link.service";
import { TaskLinkNotFound } from "../api/errors";
import type { Actor } from "../../shared/types";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

let dir: string;
let db: Database;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "lexa-task-link-svc-"));
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
  db.prepare("INSERT INTO projects (id, name, slug, key, next_task_number) VALUES ('p1','P','p1','EG',1)").run();
  db.prepare("INSERT INTO columns (id, project_id, name, position) VALUES ('c1','p1','Todo',0), ('c2','p1','Doing',1)").run();
  db.prepare("INSERT INTO swimlanes (id, project_id, name, position) VALUES ('s1','p1','Default',0)").run();
  db.prepare("INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, created_at, key, number) VALUES ('t1','p1','c1','s1','T1','a0','2026-01-01 10:00:00','EG-1',1)").run();
  db.prepare("INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, created_at, key, number) VALUES ('t2','p1','c2','s1','T2','a1','2026-01-01 10:00:00','EG-2',2)").run();
}

function makeService(db: Database) {
  const layer = TaskLinkService.Default.pipe(Layer.provide(Layer.mergeAll(Layer.succeed(Sqlite, db), DbBunLive(db))));
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  return Context.get(ctx, TaskLinkService);
}

const actor: Actor = { kind: "agent", label: "bot" };

describe("TaskLinkService.add", () => {
  it("inserts the link and its link_added activity in one batch", async () => {
    seed(db);
    const svc = makeService(db);

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

    const links = db.prepare("SELECT COUNT(*) AS n FROM task_links WHERE id = ?").get(link.id) as { n: number };
    expect(links.n).toBe(1);
    const acts = db.prepare("SELECT COUNT(*) AS n FROM task_activity WHERE task_id = 't1' AND type = 'link_added'").get() as { n: number };
    expect(acts.n).toBe(1);
  });

  it("a subtask_of link moves the child into the parent's column in the same batch", async () => {
    seed(db);
    const svc = makeService(db);

    const { link } = await Effect.runPromise(svc.add(actor, {
      projectId: "p1",
      fromTaskId: "t1",
      toTaskId: "t2",
      relation: "subtask_of",
    }));

    expect(link.relation).toBe("subtask_of");
    const child = db.prepare("SELECT column_id FROM tasks WHERE id = 't1'").get() as { column_id: string };
    expect(child.column_id).toBe("c2");
  });
});

describe("TaskLinkService.remove", () => {
  it("deletes the link and emits link_removed in one batch", async () => {
    seed(db);
    const svc = makeService(db);
    const { link } = await Effect.runPromise(svc.add(actor, {
      projectId: "p1",
      fromTaskId: "t1",
      toTaskId: "t2",
      relation: "related_to",
    }));

    const { activity } = await Effect.runPromise(svc.remove(actor, "t1", link.id));
    expect(activity).toHaveLength(1);
    expect(activity[0]!.type).toBe("link_removed");

    const gone = db.prepare("SELECT COUNT(*) AS n FROM task_links WHERE id = ?").get(link.id) as { n: number };
    expect(gone.n).toBe(0);
  });

  it("remove after the link is gone → TaskLinkNotFound with zero orphan activity", async () => {
    seed(db);
    const svc = makeService(db);
    const { link } = await Effect.runPromise(svc.add(actor, {
      projectId: "p1",
      fromTaskId: "t1",
      toTaskId: "t2",
      relation: "related_to",
    }));
    db.prepare("DELETE FROM task_links WHERE id = ?").run(link.id);

    const removed = await Effect.runPromise(Effect.either(svc.remove(actor, "t1", link.id)));
    expect(Either.isLeft(removed)).toBe(true);
    if (Either.isLeft(removed)) expect(removed.left).toBeInstanceOf(TaskLinkNotFound);

    const removedActivity = db.prepare("SELECT COUNT(*) AS n FROM task_activity WHERE type = 'link_removed'").get() as { n: number };
    expect(removedActivity.n).toBe(0);
  });
});
