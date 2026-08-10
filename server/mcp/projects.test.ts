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
  dir = mkdtempSync(join(tmpdir(), "lexa-mcp-projects-"));
  const dbPath = join(dir, "test.db");
  runMigrations(dbPath, MIGRATIONS);
  const adminHash = await sha256(ADMIN_KEY);
  const memberHash = await sha256(MEMBER_KEY);
  const db = new Database(dbPath);
  db.exec(`
INSERT INTO projects (id, name, slug) VALUES ('p1', 'Project One', 'p1'), ('p2', 'Project Two', 'p2');
INSERT INTO columns (id, project_id, name, position, wip_limit, required_fields, github_state) VALUES
  ('c1', 'p1', 'Todo', 0, 4, '[]', NULL),
  ('c2', 'p1', 'Done', 1, NULL, '["description"]', 'closed');
INSERT INTO swimlanes (id, project_id, name, position) VALUES ('s1', 'p1', 'Main', 0);
INSERT INTO priority_options (id, project_id, label, color, position) VALUES ('pr-high', 'p1', 'High', '#FF4444', 0), ('pr-low', 'p1', 'Low', '#6B6560', 1);
INSERT INTO type_options (id, project_id, label, color, position) VALUES ('tp-feature', 'p1', 'Feature', '#4ADE80', 0), ('tp-bug', 'p1', 'Bug', '#FF4444', 1);
INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, priority, type, created_at) VALUES
  ('t1', 'p1', 'c1', 's1', 'Task One', 'a0', 'pr-high', 'tp-feature', '2026-01-01 10:00:00'),
  ('t2', 'p1', 'c1', 's1', 'Task Two', 'a1', 'pr-high', 'tp-feature', '2026-01-01 10:00:00');
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

describe("MCP project tools", () => {
  it("get_project returns columns, swimlanes, and the field-config", async () => {
    const res = await call("get_project", { slug: "p1" });
    expect(res.error).toBeUndefined();
    const out = toolResult(res);
    expect(out.name).toBe("Project One");
    expect(out.slug).toBe("p1");
    expect(out.columns).toEqual([
      { name: "Todo", wipLimit: 4, requiredFields: [], githubState: null },
      { name: "Done", wipLimit: null, requiredFields: ["description"], githubState: "closed" },
    ]);
    expect(out.swimlanes).toEqual([{ name: "Main" }]);
    expect(out.priorities.map((o: any) => o.label)).toEqual(["High", "Low"]);
    expect(out.types.map((o: any) => o.label)).toEqual(["Feature", "Bug"]);
  });

  it("get_project unknown slug → PROJECT_NOT_FOUND + availableProjects", async () => {
    const res = await call("get_project", { slug: "ghost" });
    expect(res.result.isError).toBe(true);
    const err = toolError(res);
    expect(err.code).toBe("PROJECT_NOT_FOUND");
    expect(err.details.availableProjects).toEqual(["p1", "p2"]);
  });

  it("get_project_status reports per-column counts and totalTasks", async () => {
    const res = await call("get_project_status", { slug: "p1" });
    const out = toolResult(res);
    expect(out.columns).toEqual([
      { name: "Todo", count: 2, wipLimit: 4 },
      { name: "Done", count: 0, wipLimit: null },
    ]);
    expect(out.totalTasks).toBe(2);
  });

  it("get_project_status unknown slug → PROJECT_NOT_FOUND + availableProjects", async () => {
    const res = await call("get_project_status", { slug: "ghost" });
    expect(res.result.isError).toBe(true);
    const err = toolError(res);
    expect(err.code).toBe("PROJECT_NOT_FOUND");
    expect(err.details.availableProjects).toEqual(["p1", "p2"]);
  });

  it("list_projects: admin sees all projects with taskCount; member sees only granted", async () => {
    const admin = await call("list_projects", {});
    const all = toolResult(admin);
    expect(all.projects).toHaveLength(2);
    const p1 = all.projects.find((p: any) => p.slug === "p1");
    expect(p1.taskCount).toBe(2);
    const member = await call("list_projects", {}, MEMBER_KEY);
    const visible = toolResult(member);
    expect(visible.projects.map((p: any) => p.slug)).toEqual(["p1"]);
  });

  it("member key on get_project/get_project_status for a project without access → FORBIDDEN", async () => {
    const proj = await call("get_project", { slug: "p2" }, MEMBER_KEY);
    expect(proj.result.isError).toBe(true);
    expect(toolError(proj).code).toBe("FORBIDDEN");
    const status = await call("get_project_status", { slug: "p2" }, MEMBER_KEY);
    expect(status.result.isError).toBe(true);
    expect(toolError(status).code).toBe("FORBIDDEN");
  });
});
