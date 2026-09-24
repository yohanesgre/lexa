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
import { GitHubClient } from "../github/client";
import { GitHubService } from "./github.service";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

let dir: string;
let db: Database;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "lexa-github-svc-"));
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

function seed() {
  db.prepare("INSERT INTO projects (id, name, slug, key) VALUES ('p1','P','p1','EG')").run();
  db.prepare("INSERT INTO columns (id, project_id, name, position, github_state) VALUES ('c-todo','p1','Todo',0,'open'), ('c-done','p1','Done',1,'closed')").run();
  db.prepare("INSERT INTO swimlanes (id, project_id, name, position, kind) VALUES ('s1','p1','Default',0,'backlog')").run();
  db.prepare("INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, description, priority, type, position, created_at) VALUES ('t1','p1','c-todo','s1','T','{\"type\":\"doc\",\"content\":[]}','prio-1','type-1','a0','2026-01-01 10:00:00')").run();
  db.prepare("INSERT INTO task_github_issues (task_id, issue_id, issue_number, repo, synced_state) VALUES ('t1','ghi1',7,'owner/repo','closed')").run();
}

function makeService(db: Database) {
  const layer = GitHubService.Default.pipe(Layer.provide(Layer.mergeAll(
    Layer.succeed(Sqlite, db),
    DbBunLive(db),
    Layer.succeed(GitHubClient, {} as unknown as never),
  )));
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  return Context.get(ctx, GitHubService);
}

function deliveryCount(deliveryId: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM webhook_events WHERE delivery_id = ?").get(deliveryId) as { n: number }).n;
}

describe("GitHubService.handleWebhook delivery recording", () => {
  it("records an echo delivery and does not re-process it", async () => {
    seed();
    const svc = makeService(db);
    await Effect.runPromise(svc.handleWebhook("del-echo", "issues", { action: "closed", issue: { node_id: "ghi1" } }));
    expect(deliveryCount("del-echo")).toBe(1);
    // Echo: the pushed state matches the incoming one → task untouched.
    expect((db.prepare("SELECT column_id FROM tasks WHERE id = 't1'").get() as { column_id: string }).column_id).toBe("c-todo");
    expect((db.prepare("SELECT COUNT(*) AS n FROM task_activity WHERE task_id = 't1'").get() as { n: number }).n).toBe(0);
    // Re-delivery is short-circuited by isSeen and stays recorded once.
    await Effect.runPromise(svc.handleWebhook("del-echo", "issues", { action: "closed", issue: { node_id: "ghi1" } }));
    expect(deliveryCount("del-echo")).toBe(1);
  });

  it("records a delivery that has no mapped target column", async () => {
    seed();
    db.prepare("UPDATE task_github_issues SET synced_state = 'open' WHERE task_id = 't1'").run();
    db.prepare("UPDATE columns SET github_state = NULL WHERE id = 'c-done'").run();
    const svc = makeService(db);
    await Effect.runPromise(svc.handleWebhook("del-notarget", "issues", { action: "closed", issue: { node_id: "ghi1" } }));
    expect(deliveryCount("del-notarget")).toBe(1);
    expect((db.prepare("SELECT column_id FROM tasks WHERE id = 't1'").get() as { column_id: string }).column_id).toBe("c-todo");
  });
});
