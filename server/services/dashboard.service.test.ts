import { describe, expect, it, afterAll, beforeAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer, Context } from "effect";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { Sqlite, initSqlite } from "../db/database";
import { DbBunLive } from "../db/db";
import { DashboardService } from "./dashboard.service";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

let dir: string;
let db: Database;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "lexa-dashboard-svc-"));
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

function makeService(db: Database) {
  const layer = DashboardService.Default.pipe(Layer.provide(Layer.mergeAll(Layer.succeed(Sqlite, db), DbBunLive(db))));
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  return Context.get(ctx, DashboardService);
}

function seed(db: Database) {
  db.prepare("INSERT INTO projects (id, name, slug) VALUES ('p1','P','p1')").run();
  db.prepare("INSERT INTO priority_options (id, project_id, label, color, position) VALUES ('prio-1','p1','Medium','#888',0)").run();
  db.prepare("INSERT INTO type_options (id, project_id, label, color, position) VALUES ('type-1','p1','Bug','#f00',0)").run();
  db.prepare("INSERT INTO swimlanes (id, project_id, name, position, kind) VALUES ('s1','p1','Backlog',0,'backlog')").run();
  db.prepare(`INSERT INTO columns (id, project_id, name, position, wip_limit, github_state) VALUES
                ('c-empty','p1','Empty',0,NULL,NULL),
                ('c-ok','p1','Ok',1,2,NULL),
                ('c-approach','p1','Approach',2,3,NULL),
                ('c-exceed','p1','Exceed',3,1,NULL)`).run();
  db.prepare(`INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, description, priority, type, position, created_at) VALUES
                ('t-ok','p1','c-ok','s1','Ok','{"type":"doc","content":[]}','prio-1','type-1','a0','2026-01-01 10:00:00'),
                ('t-ok-arch','p1','c-ok','s1','Archived','{"type":"doc","content":[]}','prio-1','type-1','a1','2026-01-02 10:00:00'),
                ('t-a1','p1','c-approach','s1','A1','{"type":"doc","content":[]}','prio-1','type-1','b0','2026-01-03 10:00:00'),
                ('t-a2','p1','c-approach','s1','A2','{"type":"doc","content":[]}','prio-1','type-1','b1','2026-01-04 10:00:00'),
                ('t-a3','p1','c-approach','s1','A3','{"type":"doc","content":[]}','prio-1','type-1','b2','2026-01-05 10:00:00'),
                ('t-e1','p1','c-exceed','s1','E1','{"type":"doc","content":[]}','prio-1','type-1','c0','2026-01-06 10:00:00'),
                ('t-e2','p1','c-exceed','s1','E2','{"type":"doc","content":[]}','prio-1','type-1','c1','2026-01-07 10:00:00')`).run();
  db.prepare("UPDATE tasks SET archived_at = '2026-01-08 10:00:00' WHERE id = 't-ok-arch'").run();
}

describe("DashboardService.getDashboard wipSegments", () => {
  it("derives per-column state/flex from batched counts and excludes archived tasks", async () => {
    seed(db);
    const svc = makeService(db);
    const dashboard = await Effect.runPromise(svc.getDashboard());
    const project = dashboard.projects.find((p) => p.project.id === "p1");
    expect(project).toBeDefined();
    // findByProject orders by position: c-empty, c-ok, c-approach, c-exceed.
    expect(project!.wipSegments.map((s) => s.state)).toEqual(["empty", "ok", "approaching", "exceeded"]);
    expect(project!.wipSegments.map((s) => s.flex)).toEqual([1, 1, 3, 2]);
  });

  it("counts a zero-task column as 0 (empty), never a batched-map miss", async () => {
    seed(db);
    const svc = makeService(db);
    const dashboard = await Effect.runPromise(svc.getDashboard());
    const project = dashboard.projects.find((p) => p.project.id === "p1")!;
    const empty = project.wipSegments[0]!;
    expect(empty.state).toBe("empty");
    expect(empty.flex).toBe(1);
  });
});
