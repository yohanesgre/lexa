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
import { WebhookEventRepo } from "../repos/webhook-event.repo";
import { TaskRepo } from "../repos/task.repo";
import { ProjectRepo } from "../repos/project.repo";
import { ProjectReposRepo } from "../repos/project-repos.repo";
import { ColumnRepo } from "../repos/column.repo";
import { TaskService } from "./task.service";
import { ProjectService } from "./project.service";
import { ActivityService } from "./activity.service";
import type { Actor } from "../../shared/types";

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

function makeService(db: Database, client: unknown = {}) {
  // `GitHubService.Default` bakes in `GitHubClient.Default` (the real client),
  // so an external `Layer.succeed(GitHubClient, ...)` cannot override it. Build
  // from `DefaultWithoutDependencies` and wire the deps explicitly to inject a
  // stub client. The Db layer is provided over the whole dep set so each
  // `.Default` repo/service layer resolves its Db requirement.
  const dbLayer = Layer.mergeAll(Layer.succeed(Sqlite, db), DbBunLive(db));
  const deps = Layer.mergeAll(
    Layer.succeed(GitHubClient, client as never),
    WebhookEventRepo.Default,
    TaskRepo.Default,
    ProjectRepo.Default,
    ProjectReposRepo.Default,
    ColumnRepo.Default,
    TaskService.Default,
    ProjectService.Default,
    ActivityService.Default,
  ).pipe(Layer.provideMerge(dbLayer));
  const layer = GitHubService.DefaultWithoutDependencies.pipe(Layer.provide(deps));
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

describe("GitHubService.createLinkedIssue link atomicity", () => {
  const actor: Actor = { kind: "agent", label: "bot" };

  function seedSecondTask() {
    db.prepare("INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, description, priority, type, position, created_at) VALUES ('t2','p1','c-todo','s1','T2','{\"type\":\"doc\",\"content\":[]}','prio-1','type-1','a1','2026-01-02 10:00:00')").run();
    db.prepare("INSERT INTO project_repos (id, project_id, repo, source_role, workspace_role) VALUES ('pr1','p1','owner/repo',0,1)").run();
  }

  it("links the created issue and appends github_linked in one batch", async () => {
    seed();
    seedSecondTask();
    const client = { createIssue: () => Effect.succeed({ nodeId: "ghi-new", number: 9 }) };
    const svc = makeService(db, client);

    const res = await Effect.runPromise(svc.createLinkedIssue(actor, "t2", "owner/repo"));
    expect(res.issueId).toBe("ghi-new");
    expect(res.activity).toHaveLength(1);
    expect(res.activity[0]!.type).toBe("github_linked");
    expect(db.prepare("SELECT COUNT(*) n FROM task_github_issues WHERE task_id = 't2'").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) n FROM task_activity WHERE task_id = 't2'").get()).toEqual({ n: 1 });
  });

  it("rolls back the link and the activity when the created issue is already linked elsewhere", async () => {
    seed(); // t1 already owns issue ghi1 — UNIQUE(issue_id) is the backstop
    seedSecondTask();
    const client = { createIssue: () => Effect.succeed({ nodeId: "ghi1", number: 8 }) };
    const svc = makeService(db, client);

    const res = await Effect.runPromise(Effect.either(svc.createLinkedIssue(actor, "t2", "owner/repo")));
    expect(res._tag).toBe("Left");
    if (res._tag === "Left") expect(res.left._tag).toBe("ConstraintViolation");

    // No partial link row and no activity row for the failed batch.
    expect(db.prepare("SELECT COUNT(*) n FROM task_github_issues WHERE task_id = 't2'").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) n FROM task_activity WHERE task_id = 't2'").get()).toEqual({ n: 0 });
  });
});
