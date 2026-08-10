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
const MEMBER_KEY = "lxk_" + "b".repeat(43);

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
  dir = mkdtempSync(join(tmpdir(), "lexa-mcp-swimlanes-"));
  const dbPath = join(dir, "test.db");
  runMigrations(dbPath, MIGRATIONS);
  const adminHash = await sha256(ADMIN_KEY);
  const memberHash = await sha256(MEMBER_KEY);
  const db = new Database(dbPath);
  db.exec(`
INSERT INTO projects (id, name, slug) VALUES ('p1', 'P', 'p1');
INSERT INTO columns (id, project_id, name, position) VALUES ('c1', 'p1', 'Todo', 0);
INSERT INTO swimlanes (id, project_id, name, position, kind) VALUES
  ('s1', 'p1', 'Main', 0, 'milestone'),
  ('s2', 'p1', 'Backlog', 1, 'backlog');
INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, priority, type, created_at) VALUES
  ('t1', 'p1', 'c1', 's1', 'Task One', 'a0', 'pr-1', 'tp-1', '2026-01-01 10:00:00'),
  ('t2', 'p1', 'c1', 's1', 'Task Two', 'a1', 'pr-1', 'tp-1', '2026-01-01 10:00:00'),
  ('t3', 'p1', 'c1', 's2', 'Backlog Task', 'a2', 'pr-1', 'tp-1', '2026-01-01 10:00:00');
INSERT INTO users (id, email, name, role) VALUES ('u1', 'member@lexa.test', 'Member', 'member');
INSERT INTO user_project_roles (user_id, role, project_id) VALUES ('u1', 'member', 'p1');
INSERT INTO api_keys (id, name, key_hash) VALUES ('k-admin', 'admin', '${adminHash}');
INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k-member', 'member', '${memberHash}', 'u1');
`);
  db.close();
  handler = createMcpHandler(dbPath);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("MCP swimlane archive/restore tools", () => {
  it("archive_swimlane archives the lane and its live tasks in one transaction", async () => {
    const res = await call("archive_swimlane", { project: "p1", swimlane: "Main" });
    expect(res.error).toBeUndefined();
    expect(toolResult(res).message).toBe('Archived swimlane "Main" (2 tasks archived)');
    // both tasks in the lane are archived
    const t1 = await call("get_task", { taskId: "t1" });
    expect(toolResult(t1).archivedAt).not.toBeNull();
    const t2 = await call("get_task", { taskId: "t2" });
    expect(toolResult(t2).archivedAt).not.toBeNull();
    // a task in another lane is untouched
    const t3 = await call("get_task", { taskId: "t3" });
    expect(toolResult(t3).archivedAt).toBeNull();
  });

  it("archive_swimlane on an archived lane is idempotent (0 tasks archived)", async () => {
    const res = await call("archive_swimlane", { project: "p1", swimlane: "Main" });
    expect(toolResult(res).message).toBe('Archived swimlane "Main" (0 tasks archived)');
  });

  it("archive_swimlane on the Backlog lane → BACKLOG_PROTECTED", async () => {
    const res = await call("archive_swimlane", { project: "p1", swimlane: "Backlog" });
    expect(res.result.isError).toBe(true);
    const err = toolError(res);
    expect(err.code).toBe("BACKLOG_PROTECTED");
    expect(err.details.action).toBe("archive");
  });

  it("archive_swimlane unknown lane → SWIMLANE_NOT_FOUND + availableSwimlanes", async () => {
    const res = await call("archive_swimlane", { project: "p1", swimlane: "Ghost" });
    expect(res.result.isError).toBe(true);
    const err = toolError(res);
    expect(err.code).toBe("SWIMLANE_NOT_FOUND");
    expect(err.details.availableSwimlanes).toEqual(["Main", "Backlog"]);
  });

  it("restore_swimlane brings the lane back but tasks stay archived", async () => {
    const res = await call("restore_swimlane", { project: "p1", swimlane: "Main" });
    expect(res.error).toBeUndefined();
    expect(toolResult(res).message).toBe('Restored swimlane "Main"');
    const t1 = await call("get_task", { taskId: "t1" });
    expect(toolResult(t1).archivedAt).not.toBeNull(); // lane only — tasks restore individually
    // idempotent restore
    const again = await call("restore_swimlane", { project: "p1", swimlane: "Main" });
    expect(toolResult(again).message).toBe('Restored swimlane "Main"');
  });

  it("archive_swimlane with a member key → FORBIDDEN (admin-only tool)", async () => {
    const res = await call("archive_swimlane", { project: "p1", swimlane: "Main" }, MEMBER_KEY);
    expect(res.result.isError).toBe(true);
    expect(toolError(res).code).toBe("FORBIDDEN");
    const restore = await call("restore_swimlane", { project: "p1", swimlane: "Main" }, MEMBER_KEY);
    expect(restore.result.isError).toBe(true);
    expect(toolError(restore).code).toBe("FORBIDDEN");
  });
});
