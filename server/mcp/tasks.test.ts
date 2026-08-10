import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { createMcpHandler } from "./server";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

const ADMIN_KEY = "lxk_" + "a".repeat(43);

async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

let dir: string;
let handler: (req: Request) => Promise<Response>;

async function call(method: string, params: unknown, key: string | null = ADMIN_KEY) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (key !== null) headers.Authorization = `Bearer ${key}`;
  const res = await handler(new Request("http://lexa.test/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: method, arguments: params } }),
  }));
  return (await res.json()) as any;
}

function toolResult(body: any): any {
  const text = body.result?.content?.[0]?.text;
  return typeof text === "string" ? JSON.parse(text) : null;
}

function toolError(body: any): any {
  const text = body.result?.content?.[0]?.text;
  return typeof text === "string" ? JSON.parse(text) : null;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "lexa-mcp-tasks-"));
  const dbPath = join(dir, "test.db");
  runMigrations(dbPath, MIGRATIONS);
  const adminHash = await sha256(ADMIN_KEY);
  const db = new Database(dbPath);
  db.exec(`
INSERT INTO projects (id, name, slug) VALUES ('p1', 'P', 'p1');
INSERT INTO columns (id, project_id, name, position, wip_limit, required_fields, github_state) VALUES
  ('c1', 'p1', 'Todo', 0, 1, '[]', NULL),
  ('c2', 'p1', 'Done', 1, NULL, '["description"]', 'closed'),
  ('c3', 'p1', 'Review', 2, NULL, '[]', NULL);
INSERT INTO swimlanes (id, project_id, name, position, kind) VALUES
  ('s1', 'p1', 'Main', 0, 'milestone'),
  ('s2', 'p1', 'Backlog', 1, 'backlog');
INSERT INTO priority_options (id, project_id, label, color, position) VALUES ('pr-high', 'p1', 'High', '#FF4444', 0), ('pr-low', 'p1', 'Low', '#6B6560', 1);
INSERT INTO type_options (id, project_id, label, color, position) VALUES ('tp-feature', 'p1', 'Feature', '#4ADE80', 0), ('tp-bug', 'p1', 'Bug', '#FF4444', 1);
INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, priority, type, created_at) VALUES
  ('t1', 'p1', 'c1', 's1', 'Task One', 'a0', 'pr-high', 'tp-feature', '2026-01-01 10:00:00'),
  ('t2', 'p1', 'c1', 's1', 'Task Two', 'a1', 'pr-high', 'tp-feature', '2026-01-01 10:00:00'),
  ('t3', 'p1', 'c1', 's1', 'Task Three', 'a2', 'pr-low', 'tp-bug', '2026-01-01 10:00:00');
INSERT INTO task_github_issues (task_id, issue_id, issue_number, repo, synced_state) VALUES ('t1', 'ghi1', 7, 'owner/repo', 'open');
INSERT INTO api_keys (id, name, key_hash) VALUES ('k-admin', 'admin', '${adminHash}');
`);
  db.close();
  handler = createMcpHandler(dbPath);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("MCP task tools", () => {
  it("list_tasks returns all tasks and paginates with cursor", async () => {
    const all = await call("list_tasks", { project: "p1" });
    const page1 = toolResult(all);
    expect(page1.tasks).toHaveLength(3);
    expect(page1.nextCursor).toBeNull();
    // limit 2 → nextCursor; second page returns the remainder
    const limited = await call("list_tasks", { project: "p1", limit: 2 });
    const first = toolResult(limited);
    expect(first.tasks).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await call("list_tasks", { project: "p1", limit: 2, cursor: first.nextCursor });
    const rest = toolResult(second);
    expect(rest.tasks).toHaveLength(1);
    expect(rest.nextCursor).toBeNull();
    expect([...first.tasks, ...rest.tasks].map((t: any) => t.id)).toEqual(["t1", "t2", "t3"]);
  });

  it("list_tasks filters by column, type, and includes archived only on request", async () => {
    const byColumn = await call("list_tasks", { project: "p1", column: "Done" });
    expect(toolResult(byColumn).tasks).toHaveLength(0);
    const byType = await call("list_tasks", { project: "p1", type: "Bug" });
    expect(toolResult(byType).tasks.map((t: any) => t.id)).toEqual(["t3"]);
    const badType = await call("list_tasks", { project: "p1", type: "Bogus" });
    const typeErr = toolError(badType);
    expect(typeErr.code).toBe("INVALID_OPTION");
    expect(typeErr.details.availableTypes).toEqual(["Feature", "Bug"]);
    // archive t2, then confirm the default list hides it and includeArchived shows it
    const archived = await call("archive_task", { taskId: "t2" });
    expect(toolResult(archived).archivedAt).not.toBeNull();
    const live = await call("list_tasks", { project: "p1" });
    expect(toolResult(live).tasks.map((t: any) => t.id)).not.toContain("t2");
    const withArchived = await call("list_tasks", { project: "p1", includeArchived: true });
    expect(toolResult(withArchived).tasks.map((t: any) => t.id)).toContain("t2");
    const restored = await call("restore_task", { taskId: "t2" });
    expect(toolResult(restored).archivedAt).toBeNull();
  });

  it("get_task unknown id → TASK_NOT_FOUND", async () => {
    const res = await call("get_task", { taskId: "ghost" });
    expect(res.result.isError).toBe(true);
    expect(toolError(res).code).toBe("TASK_NOT_FOUND");
  });

  it("create_task lands in the Backlog lane when swimlane is omitted and uses first option defaults", async () => {
    const res = await call("create_task", {
      project: "p1", column: "Todo", title: "Brand New", description: "**bold** desc",
    });
    expect(res.error).toBeUndefined();
    const out = toolResult(res);
    expect(out.title).toBe("Brand New");
    expect(out.column).toBe("Todo");
    expect(out.swimlane).toBe("Backlog"); // omitted swimlane → project Backlog lane
    expect(out.priority).toBe("High");    // omitted priority → first option (position 0)
    expect(out.type).toBe("Feature");
    expect(out.assignees).toEqual([]);
    // round-trip through get_task — description comes back as Markdown
    const got = await call("get_task", { taskId: out.id });
    expect(toolResult(got).description).toContain("**bold**");
  });

  it("create_task unknown column → COLUMN_NOT_FOUND + availableColumns", async () => {
    const res = await call("create_task", { project: "p1", column: "Nope", title: "X" });
    expect(res.result.isError).toBe(true);
    const err = toolError(res);
    expect(err.code).toBe("COLUMN_NOT_FOUND");
    expect(err.details.availableColumns).toEqual(["Todo", "Done", "Review"]);
  });

  it("create_task unknown swimlane → SWIMLANE_NOT_FOUND + availableSwimlanes", async () => {
    const res = await call("create_task", { project: "p1", column: "Todo", swimlane: "Nope", title: "X" });
    expect(res.result.isError).toBe(true);
    const err = toolError(res);
    expect(err.code).toBe("SWIMLANE_NOT_FOUND");
    expect(err.details.availableSwimlanes).toEqual(["Main", "Backlog"]);
  });

  it("create_task unknown project → PROJECT_NOT_FOUND + availableProjects", async () => {
    const res = await call("create_task", { project: "ghost", column: "Todo", title: "X" });
    expect(res.result.isError).toBe(true);
    const err = toolError(res);
    expect(err.code).toBe("PROJECT_NOT_FOUND");
    expect(err.details.availableProjects).toEqual(["p1"]);
  });

  it("update_task edits fields and rejects unknown priority labels with availablePriorities", async () => {
    const ok = await call("update_task", { taskId: "t3", title: "Renamed", priority: "Low", type: "Bug", assignees: ["Maria"] });
    const out = toolResult(ok);
    expect(out.title).toBe("Renamed");
    expect(out.priority).toBe("Low");
    expect(out.assignees).toEqual(["Maria"]);
    const bad = await call("update_task", { taskId: "t3", priority: "Bogus" });
    expect(bad.result.isError).toBe(true);
    const err = toolError(bad);
    expect(err.code).toBe("INVALID_OPTION");
    expect(err.details.availablePriorities).toEqual(["High", "Low"]);
  });

  it("move_task moves across columns and within-column reorder never fails WIP", async () => {
    // fresh task with a description so the Done column's required_fields pass
    const created = await call("create_task", { project: "p1", column: "Todo", title: "Mover", description: "has body" });
    const y = toolResult(created);
    const moved = await call("move_task", { taskId: y.id, column: "Done" });
    expect(toolResult(moved).column).toBe("Done");
    // same-column no-op move at an at-limit column (Todo has wip_limit 1) — never fails WIP
    const noop = await call("move_task", { taskId: y.id, column: "Done" });
    expect(toolResult(noop).column).toBe("Done");
  });

  it("move_task to a column at WIP limit → WIP_LIMIT with current in details", async () => {
    // c1 (Todo) has wip_limit 1 and holds t1 + t2 → move t3 (in c3) back in is blocked
    const out = await call("move_task", { taskId: "t3", column: "Review" });
    expect(toolResult(out).column).toBe("Review");
    const res = await call("move_task", { taskId: "t3", column: "Todo" });
    expect(res.result.isError).toBe(true);
    const err = toolError(res);
    expect(err.code).toBe("WIP_LIMIT");
    expect(err.details.column).toBe("Todo");
    expect(err.details.limit).toBe(1);
    expect(err.details.current).toBeGreaterThanOrEqual(2); // seeded t1+t2 plus any created tasks
  });

  it("move_task to a column with required_fields → REQUIRED_FIELD with field and column", async () => {
    // t1 has an empty description; Done requires description
    const res = await call("move_task", { taskId: "t1", column: "Done" });
    expect(res.result.isError).toBe(true);
    const err = toolError(res);
    expect(err.code).toBe("REQUIRED_FIELD");
    expect(err.details).toEqual({ field: "description", column: "Done" });
  });

  it("move_task to unknown column → COLUMN_NOT_FOUND + availableColumns", async () => {
    const res = await call("move_task", { taskId: "t2", column: "Nope" });
    expect(res.result.isError).toBe(true);
    const err = toolError(res);
    expect(err.code).toBe("COLUMN_NOT_FOUND");
    expect(err.details.availableColumns).toEqual(["Todo", "Done", "Review"]);
  });

  it("move_task of a GitHub-linked task into a githubState column succeeds and marks outOfSync", async () => {
    // t1 is linked to owner/repo#7 (synced open); Done maps to github_state closed.
    // The best-effort GitHub sync fails (no app configured) but never fails the move.
    await call("update_task", { taskId: "t1", description: "now has a body" });
    const moved = await call("move_task", { taskId: "t1", column: "Done" });
    expect(moved.result.isError).toBeUndefined();
    const out = toolResult(moved);
    expect(out.column).toBe("Done");
    expect(out.githubIssues).toEqual([
      { number: 7, repo: "owner/repo", url: "https://github.com/owner/repo/issues/7", outOfSync: true },
    ]);
  });

  it("delete_task removes the task; later lookups → TASK_NOT_FOUND", async () => {
    const res = await call("delete_task", { taskId: "t3" });
    expect(toolResult(res)).toEqual({ deleted: true });
    const gone = await call("get_task", { taskId: "t3" });
    expect(toolError(gone).code).toBe("TASK_NOT_FOUND");
    const missing = await call("delete_task", { taskId: "t3" });
    expect(toolError(missing).code).toBe("TASK_NOT_FOUND");
  });
});
