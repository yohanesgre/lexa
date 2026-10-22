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
import { PUBLIC_URL } from "../auth";

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
  db.prepare("INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, description, priority, type, position, created_at) VALUES ('t1','p1','c-todo','s1','T','# Existing\n\n- [x] done','prio-1','type-1','a0','2026-01-01 10:00:00')").run();
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

  it("does not reapply an unchanged fetched Markdown body", async () => {
    seed();
    db.prepare("UPDATE task_github_issues SET pushed_title = ?, pushed_body = ? WHERE task_id = 't1'")
      .run("T", "# Existing\r\n\r\n- [x] done");
    const svc = makeService(db, {
      getIssue: () => Effect.succeed({
        nodeId: "ghi1",
        number: 7,
        state: "open",
        title: "T",
        body: "# Existing\r\n\r\n- [x] done",
      }),
    });

    await Effect.runPromise(svc.handleWebhook("del-markdown-echo", "issues", { action: "edited", issue: { node_id: "ghi1", title: "T" } }));

    expect((db.prepare("SELECT title, description FROM tasks WHERE id = 't1'").get() as { title: string; description: string }))
      .toEqual({ title: "T", description: "# Existing\n\n- [x] done" });
    expect((db.prepare("SELECT COUNT(*) AS n FROM task_activity WHERE task_id = 't1'").get() as { n: number }).n).toBe(0);
    expect(deliveryCount("del-markdown-echo")).toBe(1);
  });

  it("stores changed fetched GitHub Markdown exactly", async () => {
    seed();
    const body = "## Remote\r\n\r\n` exact `  \r\n";
    const svc = makeService(db, {
      getIssue: () => Effect.succeed({
        nodeId: "ghi1",
        number: 7,
        state: "open",
        title: "Remote title",
        body,
      }),
    });

    await Effect.runPromise(svc.handleWebhook("del-markdown-change", "issues", { action: "edited", issue: { node_id: "ghi1", title: "Remote title" } }));

    expect((db.prepare("SELECT title, description FROM tasks WHERE id = 't1'").get() as { title: string; description: string }))
      .toEqual({ title: "Remote title", description: body });
    expect(deliveryCount("del-markdown-change")).toBe(1);
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

describe("GitHubService.syncContentFromLexa", () => {
  it("pushes exact Markdown, records successful body, and skips CRLF-only echo changes", async () => {
    seed();
    const body = "## Exact\r\n\r\n- [x] source  \n";
    db.prepare("UPDATE tasks SET title = ?, description = ? WHERE id = 't1'").run("New title", body);
    db.prepare("UPDATE task_github_issues SET pushed_title = ?, pushed_body = ? WHERE task_id = 't1'").run("Old title", "Old body");
    const calls: Array<{ title: string; body: string }> = [];
    const svc = makeService(db, {
      updateIssueContent: (_repo: string, _number: number, content: { title: string; body: string }) => {
        calls.push(content);
        return Effect.succeed(undefined);
      },
    });

    await Effect.runPromise(svc.syncContentFromLexa("t1"));

    expect(calls).toEqual([{ title: "New title", body }]);
    expect(db.prepare("SELECT pushed_title, pushed_body, push_failed FROM task_github_issues WHERE task_id = 't1'").get())
      .toEqual({ pushed_title: "New title", pushed_body: body, push_failed: 0 });

    db.prepare("UPDATE task_github_issues SET pushed_body = ? WHERE task_id = 't1'").run(body.replace(/\r\n/g, "\n"));
    await Effect.runPromise(svc.syncContentFromLexa("t1"));
    expect(calls).toHaveLength(1);
  });
  it("rewrites only parsed Lexa destinations and stores the exact pushed Markdown", async () => {
    seed();
    const attachment = "/api/attachments/123e4567-e89b-12d3-a456-426614174000";
    const source = [
      `[file](${attachment} "title") [task](/p1/board?task=t1) [wiki](</p1/wiki/guide> "title")`,
      `![image](${attachment})`,
      "[escaped wiki](/p1/wiki/getting\\-started)",
      `\`${attachment} /p1/board?task=t1 /p1/wiki/guide\``,
      "```md",
      `${attachment} /p1/board?task=t1 /p1/wiki/guide`,
      "```",
      `\\[escaped](/p1/board?task=t1)`,
      "[external](//outside.invalid/p1/wiki/guide)",
      "[backslash](/\\outside.invalid/p1/wiki/guide)",
      "[reference][task-link]",
      "",
      "[task-link]: /p1/board?task=t1",
    ].join("\n");
    db.prepare("UPDATE tasks SET description = ? WHERE id = 't1'").run(source);
    db.prepare("UPDATE task_github_issues SET pushed_title = ?, pushed_body = ? WHERE task_id = 't1'").run("Old title", "Old body");
    const calls: Array<{ title: string; body: string }> = [];
    const svc = makeService(db, {
      updateIssueContent: (_repo: string, _number: number, content: { title: string; body: string }) => {
        calls.push(content);
        return Effect.succeed(undefined);
      },
    });
    const attachmentUrl = new URL(attachment, PUBLIC_URL).href;
    const taskUrl = new URL("/p1/board?task=t1", PUBLIC_URL).href;
    const wikiUrl = new URL("/p1/wiki/guide", PUBLIC_URL).href;
    const expected = [
      `[file](${attachmentUrl} "title") [task](${taskUrl}) [wiki](<${wikiUrl}> "title")`,
      `![image](${attachmentUrl})`,
      `[escaped wiki](${new URL("/p1/wiki/getting-started", PUBLIC_URL).href})`,
      `\`${attachment} /p1/board?task=t1 /p1/wiki/guide\``,
      "```md",
      `${attachment} /p1/board?task=t1 /p1/wiki/guide`,
      "```",
      `\\[escaped](/p1/board?task=t1)`,
      "[external](//outside.invalid/p1/wiki/guide)",
      "[backslash](/\\outside.invalid/p1/wiki/guide)",
      "[reference][task-link]",
      "",
      `[task-link]: ${taskUrl}`,
    ].join("\n");

    await Effect.runPromise(svc.syncContentFromLexa("t1"));

    expect(calls).toEqual([{ title: "T", body: expected }]);
    expect(db.prepare("SELECT description FROM tasks WHERE id = 't1'").get()).toEqual({ description: source });
    expect(db.prepare("SELECT pushed_body FROM task_github_issues WHERE task_id = 't1'").get()).toEqual({ pushed_body: expected });

    await Effect.runPromise(svc.syncContentFromLexa("t1"));
    expect(calls).toHaveLength(1);
  });


  it("retries failed content pushes without replacing last successful bookkeeping", async () => {
    seed();
    const body = "## Retry\n\nSource stays exact.";
    db.prepare("UPDATE tasks SET title = ?, description = ? WHERE id = 't1'").run("Retry title", body);
    db.prepare("UPDATE task_github_issues SET pushed_title = ?, pushed_body = ? WHERE task_id = 't1'").run("Last title", "Last body");
    let attempts = 0;
    const svc = makeService(db, {
      updateIssueContent: () => {
        attempts += 1;
        return attempts === 1 ? Effect.fail(new Error("offline")) : Effect.succeed(undefined);
      },
    });

    await Effect.runPromise(svc.syncContentFromLexa("t1"));
    expect(db.prepare("SELECT pushed_title, pushed_body, push_failed FROM task_github_issues WHERE task_id = 't1'").get())
      .toEqual({ pushed_title: "Last title", pushed_body: "Last body", push_failed: 1 });

    await Effect.runPromise(svc.syncContentFromLexa("t1"));
    expect(attempts).toBe(2);
    expect(db.prepare("SELECT pushed_title, pushed_body, push_failed FROM task_github_issues WHERE task_id = 't1'").get())
      .toEqual({ pushed_title: "Retry title", pushed_body: body, push_failed: 0 });
  });
});

describe("GitHubService.createLinkedIssue link atomicity", () => {
  const actor: Actor = { kind: "agent", label: "bot" };

  function seedSecondTask() {
    db.prepare("INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, description, priority, type, position, created_at) VALUES ('t2','p1','c-todo','s1','T2','# Second\n\n- [ ] verify','prio-1','type-1','a1','2026-01-02 10:00:00')").run();
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
  it("pushes absolute Lexa links when creating an issue without changing source or code", async () => {
    seed();
    seedSecondTask();
    const attachment = "/api/attachments/123e4567-e89b-12d3-a456-426614174000";
    const source = [
      `See [file](${attachment}). [task](/p1/board?task=t2) [wiki](</p1/wiki/guide>).`,
      "`[task](/p1/board?task=t2)`",
      "```md",
      "[wiki](/p1/wiki/guide)",
      "```",
      "\\[escaped](/p1/board?task=t2)",
    ].join("\n");
    db.prepare("UPDATE tasks SET description = ? WHERE id = 't2'").run(source);
    let pushedBody = "";
    const client = {
      createIssue: (_repo: string, _title: string, body: string) => {
        pushedBody = body;
        return Effect.succeed({ nodeId: "ghi-attachment", number: 11 });
      },
    };
    const svc = makeService(db, client);

    await Effect.runPromise(svc.createLinkedIssue(actor, "t2", "owner/repo"));

    const attachmentUrl = new URL(attachment, PUBLIC_URL).href;
    const taskUrl = new URL("/p1/board?task=t2", PUBLIC_URL).href;
    const wikiUrl = new URL("/p1/wiki/guide", PUBLIC_URL).href;
    expect(pushedBody).toBe([
      `See [file](${attachmentUrl}). [task](${taskUrl}) [wiki](<${wikiUrl}>).`,
      "`[task](/p1/board?task=t2)`",
      "```md",
      "[wiki](/p1/wiki/guide)",
      "```",
      "\\[escaped](/p1/board?task=t2)",
    ].join("\n"));
    expect((db.prepare("SELECT description FROM tasks WHERE id = 't2'").get() as { description: string }).description).toBe(source);
  });
  it("imports GitHub issue body as exact Markdown source", async () => {
    seed();
    seedSecondTask();
    db.prepare("INSERT INTO priority_options (id, project_id, label, position) VALUES ('prio-default', 'p1', 'Medium', 0)").run();
    db.prepare("INSERT INTO type_options (id, project_id, label, position) VALUES ('type-default', 'p1', 'Task', 0)").run();
    const body = "## Imported\r\n\r\n`literal`  \n";
    const svc = makeService(db, {
      getIssue: () => Effect.succeed({
        nodeId: "ghi-import",
        number: 13,
        state: "open",
        title: "Imported title",
        body,
      }),
    });

    const result = await Effect.runPromise(svc.createTaskFromIssue(actor, "p1", "owner/repo", 13));

    expect((db.prepare("SELECT title, description FROM tasks WHERE id = ?").get(result.taskId) as { title: string; description: string }))
      .toEqual({ title: "Imported title", description: body });
    expect(db.prepare("SELECT issue_id, repo FROM task_github_issues WHERE task_id = ?").get(result.taskId))
      .toEqual({ issue_id: "ghi-import", repo: "owner/repo" });
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
