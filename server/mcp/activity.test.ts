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
  dir = mkdtempSync(join(tmpdir(), "lexa-mcp-activity-"));
  const dbPath = join(dir, "test.db");
  runMigrations(dbPath, MIGRATIONS);
  const adminHash = await sha256(ADMIN_KEY);
  const db = new Database(dbPath);
  db.exec(`
INSERT INTO projects (id, name, slug) VALUES ('p1', 'P', 'p1');
INSERT INTO columns (id, project_id, name, position) VALUES ('c1', 'p1', 'Todo', 0);
INSERT INTO swimlanes (id, project_id, name, position) VALUES ('s1', 'p1', 'Default', 0);
INSERT INTO api_keys (id, name, key_hash) VALUES ('k-admin', 'admin', '${adminHash}');
INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, priority, type, created_at) VALUES ('t1', 'p1', 'c1', 's1', 'T', 'a0', 'pr-1', 'tp-1', '2026-01-01 10:00:00');
INSERT INTO task_activity (task_id, actor_kind, actor_label, actor_user_id, type, message, created_at) VALUES ('t1', 'user', 'Maria', NULL, 'created', 'Maria created this task', '2026-01-01 10:00:00');
INSERT INTO task_comments (task_id, author_id, author_kind, author_label, body, created_at) VALUES ('t1', NULL, 'agent', 'opencode', '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"hi there"}]}]}', '2026-01-02 10:00:00');
`);
  db.close();
  handler = createMcpHandler(dbPath);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("MCP activity tools", () => {
  it("get_task_activity returns Markdown timeline", async () => {
    const res = await call("get_task_activity", { taskId: "t1" }, ADMIN_KEY);
    expect(res.error).toBeUndefined();
    const { activity } = toolResult(res);
    expect(activity.some((a: any) => a.message.includes("created this task"))).toBe(true);
    const c = activity.find((a: any) => a.comment);
    expect(c.comment.markdown).toContain("hi");
  });

  it("add_task_comment converts Markdown and attributes the key", async () => {
    const res = await call("add_task_comment", { taskId: "t1", comment: "**bold** note" }, ADMIN_KEY);
    expect(res.error).toBeUndefined();
    expect(toolResult(res).authorLabel).toBe("admin"); // ADMIN_KEY row name
    const list = await call("get_task_activity", { taskId: "t1" }, ADMIN_KEY);
    expect(toolResult(list).activity.at(-1).message).toBe("admin commented");
  });

  it("rejects empty comment", async () => {
    const res = await call("add_task_comment", { taskId: "t1", comment: "" }, ADMIN_KEY);
    const err = toolError(res);
    expect(err.code).toBe("COMMENT_INVALID");
  });

  it("get_task_activity on an unknown task → TASK_NOT_FOUND", async () => {
    const res = await call("get_task_activity", { taskId: "nope" }, ADMIN_KEY);
    const err = toolError(res);
    expect(err.code).toBe("TASK_NOT_FOUND");
  });
});
