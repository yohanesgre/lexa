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

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "lexa-mcp-test-"));
  const dbPath = join(dir, "test.db");
  runMigrations(dbPath, MIGRATIONS);
  const adminHash = await sha256(ADMIN_KEY);
  const memberHash = await sha256(MEMBER_KEY);
  const db = new Database(dbPath);
  db.exec(`
INSERT INTO projects (id, name, slug) VALUES ('p1', 'Project One', 'p1');
INSERT INTO projects (id, name, slug) VALUES ('p2', 'Project Two', 'p2');
INSERT INTO columns (id, project_id, name, position) VALUES ('c1', 'p1', 'Todo', 0);
INSERT INTO columns (id, project_id, name, position) VALUES ('c2', 'p1', 'Done', 1);
INSERT INTO swimlanes (id, project_id, name, position) VALUES ('s1', 'p1', 'Main', 0);
INSERT INTO priority_options (id, project_id, label, color, position) VALUES ('pr-high', 'p1', 'High', '#FF4444', 0);
INSERT INTO priority_options (id, project_id, label, color, position) VALUES ('pr-low', 'p1', 'Low', '#6B6560', 1);
INSERT INTO type_options (id, project_id, label, color, position) VALUES ('tp-feature', 'p1', 'Feature', '#4ADE80', 0);
INSERT INTO type_options (id, project_id, label, color, position) VALUES ('tp-bug', 'p1', 'Bug', '#FF4444', 1);
INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, priority, type) VALUES ('t1', 'p1', 'c1', 's1', 'Task One', 'a0', 'pr-high', 'tp-feature');
INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, priority, type) VALUES ('t2', 'p1', 'c1', 's1', 'Task Two', 'a1', 'pr-high', 'tp-feature');
INSERT INTO users (id, email, name, role) VALUES ('u1', 'member@lexa.test', 'Member', 'member');
INSERT INTO users (id, email, name, role) VALUES ('u2', 'admin@lexa.test', 'Admin', 'admin');
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

async function call(method: string, params: unknown, key: string | null = ADMIN_KEY) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (key !== null) headers.Authorization = `Bearer ${key}`;
  const res = await handler(new Request("http://lexa.test/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }));
  return { status: res.status, body: (await res.json()) as any };
}

function toolError(body: any): any {
  const text = body.result?.content?.[0]?.text;
  return typeof text === "string" ? JSON.parse(text) : null;
}

describe("MCP server", () => {
  it("tools/list returns all 35 tools", async () => {
    const { status, body } = await call("tools/list", {});
    expect(status).toBe(200);
    expect(body.result.tools).toHaveLength(35);
  });

  it("valid admin key → create_project works", async () => {
    const { status, body } = await call("tools/call", {
      name: "create_project",
      arguments: { name: "New Project", slug: "new-proj" },
    });
    expect(status).toBe(200);
    expect(body.result.isError).toBeUndefined();
    expect(JSON.parse(body.result.content[0].text).slug).toBe("new-proj");
  });

  it("missing/malformed key → HTTP 401 with JSON-RPC -32001", async () => {
    const missing = await call("tools/list", {}, null);
    expect(missing.status).toBe(401);
    expect(missing.body.error.code).toBe(-32001);
    expect(missing.body.error.message).toBe("Missing authorization");

    const invalid = await call("tools/list", {}, "lxk_short");
    expect(invalid.status).toBe(401);
    expect(invalid.body.error.code).toBe(-32001);
    expect(invalid.body.error.message).toBe("Invalid API key");
  });

  it("member key on admin-only tool → FORBIDDEN tool envelope, not HTTP 500", async () => {
    const { status, body } = await call(
      "tools/call",
      { name: "create_project", arguments: { name: "Nope" } },
      MEMBER_KEY
    );
    expect(status).toBe(200);
    expect(body.result.isError).toBe(true);
    expect(toolError(body).code).toBe("FORBIDDEN");
  });

  it("member key on project without access → FORBIDDEN tool envelope", async () => {
    const { status, body } = await call(
      "tools/call",
      { name: "list_tasks", arguments: { project: "p2" } },
      MEMBER_KEY
    );
    expect(status).toBe(200);
    expect(body.result.isError).toBe(true);
    expect(toolError(body).code).toBe("FORBIDDEN");
  });

  it("create_task with invalid priority → INVALID_OPTION + availablePriorities", async () => {
    const { body } = await call("tools/call", {
      name: "create_task",
      arguments: { project: "p1", column: "Todo", swimlane: "Main", title: "X", priority: "Bogus" },
    });
    expect(body.result.isError).toBe(true);
    const err = toolError(body);
    expect(err.code).toBe("INVALID_OPTION");
    expect(err.details.availablePriorities).toEqual(["High", "Low"]);
  });

  it("update_task with unknown task id → TASK_NOT_FOUND", async () => {
    const { body } = await call("tools/call", {
      name: "update_task",
      arguments: { taskId: "ghost" },
    });
    expect(body.result.isError).toBe(true);
    expect(toolError(body).code).toBe("TASK_NOT_FOUND");
  });

  it("unknown method → -32601; batch request → -32600", async () => {
    const unknown = await call("bogus_method", {});
    expect(unknown.body.error.code).toBe(-32601);

    const res = await handler(new Request("http://lexa.test/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ADMIN_KEY}` },
      body: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "tools/list" }]),
    }));
    const batchBody = (await res.json()) as any;
    expect(batchBody.error.code).toBe(-32600);
  });

  it("move_task with nonexistent beforeTaskId → TASK_NOT_FOUND", async () => {
    const { body } = await call("tools/call", {
      name: "move_task",
      arguments: { taskId: "t1", column: "Todo", beforeTaskId: "ghost" },
    });
    expect(body.result.isError).toBe(true);
    expect(toolError(body).code).toBe("TASK_NOT_FOUND");
  });
});
