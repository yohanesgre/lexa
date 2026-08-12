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
let savedAppId: string | undefined;
let savedKey: string | undefined;
let savedKeyFile: string | undefined;

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
  // Force the unconfigured-GitHub guard path — the layer captures env at boot.
  savedAppId = process.env.GITHUB_APP_ID;
  savedKey = process.env.GITHUB_PRIVATE_KEY;
  savedKeyFile = process.env.GITHUB_PRIVATE_KEY_FILE;
  delete process.env.GITHUB_APP_ID;
  delete process.env.GITHUB_PRIVATE_KEY;
  delete process.env.GITHUB_PRIVATE_KEY_FILE;

  dir = mkdtempSync(join(tmpdir(), "lexa-mcp-github-"));
  const dbPath = join(dir, "test.db");
  runMigrations(dbPath, MIGRATIONS);
  const adminHash = await sha256(ADMIN_KEY);
  const db = new Database(dbPath);
  db.exec(`
INSERT INTO projects (id, name, slug) VALUES ('p1', 'P', 'p1');
INSERT INTO columns (id, project_id, name, position) VALUES ('c1', 'p1', 'Todo', 0);
INSERT INTO swimlanes (id, project_id, name, position) VALUES ('s1', 'p1', 'Main', 0);
INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, priority, type, created_at) VALUES
  ('t1', 'p1', 'c1', 's1', 'Linked Task', 'a0', 'pr-1', 'tp-1', '2026-01-01 10:00:00'),
  ('t2', 'p1', 'c1', 's1', 'Plain Task', 'a1', 'pr-1', 'tp-1', '2026-01-01 10:00:00');
INSERT INTO task_github_issues (task_id, issue_id, issue_number, repo, synced_state) VALUES ('t1', 'ghi1', 7, 'owner/repo', 'open');
INSERT INTO project_repos (id, project_id, repo, source_role, workspace_role) VALUES ('pr1', 'p1', 'owner/repo', 1, 1);
INSERT INTO api_keys (id, name, key_hash) VALUES ('k-admin', 'admin', '${adminHash}');
`);
  db.close();
  handler = createMcpHandler(dbPath);
});

afterAll(() => {
  if (savedAppId !== undefined) process.env.GITHUB_APP_ID = savedAppId; else delete process.env.GITHUB_APP_ID;
  if (savedKey !== undefined) process.env.GITHUB_PRIVATE_KEY = savedKey; else delete process.env.GITHUB_PRIVATE_KEY;
  if (savedKeyFile !== undefined) process.env.GITHUB_PRIVATE_KEY_FILE = savedKeyFile; else delete process.env.GITHUB_PRIVATE_KEY_FILE;
  rmSync(dir, { recursive: true, force: true });
});

describe("MCP github link tools", () => {
  it("link_github_issue without a configured GitHub App → GITHUB_API_ERROR (guard, no network)", async () => {
    const res = await call("link_github_issue", { taskId: "t2", repo: "owner/repo" });
    expect(res.result.isError).toBe(true);
    const err = toolError(res);
    expect(err.code).toBe("GITHUB_API_ERROR");
    // buildToolError preserves the underlying Error message (non-enumerable
    // `message` is copied before the spread) — agents see why it failed.
    expect(err.message).toContain("GitHub App is not configured");
    expect(err.details.message).toContain("GitHub App is not configured");
  });

  it("link_github_issue on a repo already linked to the task → ALREADY_LINKED", async () => {
    const res = await call("link_github_issue", { taskId: "t1", repo: "owner/repo" });
    expect(res.result.isError).toBe(true);
    expect(toolError(res).code).toBe("ALREADY_LINKED");
  });

  it("link_github_issue unknown task → TASK_NOT_FOUND", async () => {
    const res = await call("link_github_issue", { taskId: "ghost", repo: "owner/repo" });
    expect(res.result.isError).toBe(true);
    expect(toolError(res).code).toBe("TASK_NOT_FOUND");
  });

  it("unlink_github_issue removes the link and records github_unlinked activity", async () => {
    const res = await call("unlink_github_issue", { taskId: "t1", issueId: "ghi1" });
    expect(res.error).toBeUndefined();
    expect(toolResult(res)).toEqual({ unlinked: true });
    const activity = await call("get_task_activity", { taskId: "t1" });
    const events = toolResult(activity).activity;
    expect(events.some((a: any) => a.message === "Unlinked GitHub issue owner/repo #7")).toBe(true);
  });

  it("unlink_github_issue of a non-linked issue is a no-op success (no error documented)", async () => {
    const res = await call("unlink_github_issue", { taskId: "t2", issueId: "ghi-ghost" });
    expect(res.error).toBeUndefined();
    expect(toolResult(res)).toEqual({ unlinked: true });
  });

  it("unlink_github_issue unknown task → TASK_NOT_FOUND", async () => {
    const res = await call("unlink_github_issue", { taskId: "ghost", issueId: "ghi1" });
    expect(res.result.isError).toBe(true);
    expect(toolError(res).code).toBe("TASK_NOT_FOUND");
  });
});
