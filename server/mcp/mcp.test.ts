import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { createApiHandler } from "../api/http";
import { resolveApiKeyIdentity } from "../api/auth-key";
import { syncRateLimitFromDb } from "../api/rate-limit";
import type { RuntimeEnv } from "../env";
import { handleMcpRequest, type McpBoundaryDeps } from "./http";
import { createRestDispatch } from "./rest";

// Inbound MCP boundary + catalog contract (docs/API.md → Inbound MCP server).
// The suite drives the real boundary over real REST operations against a real
// migrated DB: auth/revocation, Origin semantics, the exact 22-tool catalog,
// persisted tool results, domain-error mapping, per-user isolation, the shared
// rate bucket (no double charge), and the transport body cap.

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

const ADMIN_KEY = "lxk_" + "a".repeat(43);
const MEMBER1_KEY = "lxk_" + "b".repeat(43);
const MEMBER2_KEY = "lxk_" + "c".repeat(43);
const LEGACY_KEY = "lxk_" + "d".repeat(43);
const REVOKE_KEY = "lxk_" + "e".repeat(43);

const EXPECTED_TOOLS = [
  "lexa_list_projects",
  "lexa_get_project",
  "lexa_get_board",
  "lexa_list_columns",
  "lexa_list_swimlanes",
  "lexa_list_milestones",
  "lexa_get_field_config",
  "lexa_list_project_members",
  "lexa_list_tasks",
  "lexa_get_task",
  "lexa_create_task",
  "lexa_update_task",
  "lexa_move_task",
  "lexa_archive_task",
  "lexa_restore_task",
  "lexa_get_task_activity",
  "lexa_create_comment",
  "lexa_list_wiki_pages",
  "lexa_get_wiki_page",
  "lexa_search_wiki",
  "lexa_create_wiki_page",
  "lexa_update_wiki_page",
];

const TEST_ENV: RuntimeEnv = { LXK_PUBLIC_URL: "https://lexa.test" };
const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "vitest", version: "1.0.0" } },
};

interface RpcResponse {
  jsonrpc: string;
  id: number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

let dir: string;
let dbPath: string;
let db: Database;
let handler: (req: Request) => Promise<Response>;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "lexa-mcp-"));
  dbPath = join(dir, "test.db");
  runMigrations(dbPath, MIGRATIONS);
  db = new Database(dbPath);
  db.exec("PRAGMA busy_timeout = 5000");
  const hashes = await Promise.all(
    [ADMIN_KEY, MEMBER1_KEY, MEMBER2_KEY, LEGACY_KEY, REVOKE_KEY].map((key) => sha256(key))
  );
  db.exec(`
INSERT INTO users (id, email, name, role) VALUES
  ('u-admin', 'root@lexa.test', 'Root', 'superadmin'),
  ('u1', 'one@lexa.test', 'One', 'member'),
  ('u2', 'two@lexa.test', 'Two', 'member');
INSERT INTO api_keys (id, name, key_hash, user_id) VALUES
  ('k-admin', 'admin', '${hashes[0]}', 'u-admin'),
  ('k-1', 'one', '${hashes[1]}', 'u1'),
  ('k-2', 'two', '${hashes[2]}', 'u2'),
  ('k-legacy', 'legacy', '${hashes[3]}', NULL),
  ('k-rev', 'revoked', '${hashes[4]}', 'u1');
INSERT INTO projects (id, name, slug, key, next_task_number) VALUES
  ('p1', 'Project One', 'p1', 'EG', 1),
  ('p2', 'Project Two', 'p2', 'P2', 0);
INSERT INTO user_project_roles (user_id, role, project_id) VALUES ('u1', 'member', 'p1'), ('u2', 'member', 'p2');
INSERT INTO columns (id, project_id, name, position, wip_limit) VALUES
  ('c1', 'p1', 'Todo', 0, NULL),
  ('c2', 'p1', 'Blocked', 1, 0),
  ('c3', 'p2', 'Todo', 0, NULL);
INSERT INTO swimlanes (id, project_id, name, position, kind) VALUES
  ('s1', 'p1', 'Backlog', 0, 'backlog'),
  ('s2', 'p2', 'Backlog', 0, 'backlog');
INSERT INTO priority_options (id, project_id, label, color, position) VALUES
  ('prio-1', 'p1', 'Medium', '#888888', 0),
  ('prio-2', 'p2', 'Medium', '#888888', 0);
INSERT INTO type_options (id, project_id, label, color, position) VALUES
  ('type-1', 'p1', 'Bug', '#ff0000', 0),
  ('type-2', 'p2', 'Bug', '#ff0000', 0);
INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, created_at, key, number)
  VALUES ('t1', 'p1', 'c1', 's1', 'Existing', 'a0', '2026-01-01 10:00:00', 'EG-1', 1);
`);
  handler = createApiHandler(dbPath);
});

afterAll(() => {
  try { db.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

interface CallOptions {
  clientIp?: string;
  origin?: string;
  env?: RuntimeEnv;
  headers?: Record<string, string>;
}

function mcpRequest(key: string | null, body: unknown, options: CallOptions = {}): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...options.headers,
  };
  if (key) headers.authorization = `Bearer ${key}`;
  if (options.origin) headers.origin = options.origin;
  return new Request("https://lexa.test/mcp", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function boundaryDeps(key: string | null, options: CallOptions = {}): McpBoundaryDeps {
  const authHeader = key ? `Bearer ${key}` : "";
  return {
    env: options.env ?? TEST_ENV,
    clientIp: options.clientIp ?? "192.0.2.10",
    authenticate: async (header) => {
      const identity = resolveApiKeyIdentity(header, new Headers(), db, dbPath);
      if (!identity || identity.userId === null) return null;
      return { ...identity, userId: identity.userId };
    },
    dispatch: createRestDispatch(handler, { authHeader, baseUrl: "https://lexa.test" }),
  };
}

async function mcp(key: string | null, body: unknown, options: CallOptions = {}) {
  return handleMcpRequest(mcpRequest(key, body, options), boundaryDeps(key, options));
}

async function initialize(key: string, options: CallOptions = {}): Promise<RpcResponse> {
  const response = await mcp(key, INITIALIZE, options);
  expect(response.status).toBe(200);
  return (await response.json()) as RpcResponse;
}

async function callTool(
  key: string,
  name: string,
  args: Record<string, unknown>,
  options: CallOptions = {}
): Promise<ToolResult> {
  await initialize(key, options);
  const response = await mcp(
    key,
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } },
    options
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as RpcResponse;
  return body.result as ToolResult;
}

function isToolError(result: ToolResult): boolean {
  return result.isError === true;
}

describe("inbound MCP boundary", () => {
  it("initializes and exposes exactly the 22-tool catalog", async () => {
    const init = await initialize(ADMIN_KEY);
    expect(init.result).toMatchObject({ serverInfo: { name: "lexa" } });
    expect(typeof (init.result as { protocolVersion: string }).protocolVersion).toBe("string");

    const response = await mcp(ADMIN_KEY, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: { tools: Array<{ name: string }> } };
    expect(body.result.tools.map((tool) => tool.name).sort()).toEqual([...EXPECTED_TOOLS].sort());
  });

  it("rejects missing, unbound, and cookie-only credentials", async () => {
    const missing = await mcp(null, INITIALIZE);
    expect(missing.status).toBe(401);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe("UNAUTHORIZED");

    const unbound = await mcp(LEGACY_KEY, INITIALIZE);
    expect(unbound.status).toBe(401);

    const cookieOnly = await mcp(null, INITIALIZE, {
      headers: { cookie: "better-auth.session_token=forged" },
    });
    expect(cookieOnly.status).toBe(401);
  });

  it("re-checks the key on every request, so revocation beats an initialized connection", async () => {
    await initialize(REVOKE_KEY);
    db.prepare("DELETE FROM api_keys WHERE id = 'k-rev'").run();
    const after = await mcp(REVOKE_KEY, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(after.status).toBe(401);
  });

  it("rejects a disallowed Origin, accepts the configured one, and accepts an absent Origin", async () => {
    const denied = await mcp(ADMIN_KEY, INITIALIZE, { origin: "https://evil.example" });
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as RpcResponse).error?.message).toContain("Invalid Origin header");

    const absent = await mcp(ADMIN_KEY, INITIALIZE);
    expect(absent.status).toBe(200);

    const allowed = await mcp(ADMIN_KEY, INITIALIZE, { origin: "https://lexa.test" });
    expect(allowed.status).toBe(200);
  });

  it("rejects a body over the shared API cap", async () => {
    const padded = `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })}${" ".repeat(4096)}`;
    const response = await mcp(ADMIN_KEY, padded, { env: { LXK_MAX_BODY_MB: "0.001" } });
    expect(response.status).toBe(413);
  });
});

describe("inbound MCP tools", () => {
  it("persists through the REST operation and returns authoritative structured content", async () => {
    const created = await callTool(ADMIN_KEY, "lexa_create_task", {
      projectSlug: "p1",
      columnId: "c1",
      title: "From MCP",
      description: "**bold**",
    });
    expect(isToolError(created)).toBe(false);
    const data = created.structuredContent?.data as { id: string; key: string };
    expect(typeof data.key).toBe("string");
    expect(data.key.length).toBeGreaterThan(0);
    const activity = created.structuredContent?.activity as Array<{ type: string }>;
    expect(activity.map((row) => row.type)).toContain("created");
    expect(JSON.parse(created.content[0]!.text)).toEqual(created.structuredContent);

    // Read back through the key the server returned: same persisted object,
    // Markdown intact, and the immutable key resolves the same row.
    const fetched = await callTool(ADMIN_KEY, "lexa_get_task", { projectSlug: "p1", id: data.key });
    const task = fetched.structuredContent as { id: string; key: string; description: string; columnId: string };
    expect(task.id).toBe(data.id);
    expect(task.key).toBe(data.key);
    expect(task.description).toBe("**bold**");
    expect(task.columnId).toBe("c1");

    const readBackActivity = await callTool(ADMIN_KEY, "lexa_get_task_activity", {
      projectSlug: "p1",
      id: data.key,
    });
    const events = readBackActivity.structuredContent?.data as Array<{ kind: string; type?: string }>;
    expect(events.some((row) => row.kind === "event" && row.type === "created")).toBe(true);

    const row = db
      .prepare("SELECT COUNT(*) AS count FROM tasks WHERE project_id = 'p1' AND title = 'From MCP'")
      .get() as { count: number };
    expect(row.count).toBe(1);
  });

  it("maps a domain failure to a tool error with the existing code and no mutation", async () => {
    const moved = await callTool(ADMIN_KEY, "lexa_move_task", {
      projectSlug: "p1",
      id: "EG-1",
      columnId: "c2",
      swimlaneId: "s1",
    });
    expect(isToolError(moved)).toBe(true);
    expect(moved.structuredContent?.error).toMatchObject({ code: "WIP_LIMIT" });
    expect(moved.content[0]!.text.startsWith("WIP_LIMIT: ")).toBe(true);

    const unchanged = await callTool(ADMIN_KEY, "lexa_get_task", { projectSlug: "p1", id: "EG-1" });
    expect((unchanged.structuredContent as { columnId: string }).columnId).toBe("c1");
  });

  it("rejects dot-segment path arguments without mutating the target", async () => {
    const projectBefore = await callTool(ADMIN_KEY, "lexa_get_project", { projectSlug: "p1" });
    const before = projectBefore.structuredContent as { description: string; name: string };
    const taskBefore = await callTool(ADMIN_KEY, "lexa_get_task", { projectSlug: "p1", id: "EG-1" });
    const titleBefore = (taskBefore.structuredContent as { title: string }).title;

    // Literal and percent-encoded dot segments in every caller-controlled path
    // argument must be refused before a Request is built: `..` would otherwise
    // normalize a task/wiki route onto the project route and mutate it.
    const taskAttempts: Array<[string, Record<string, unknown>]> = [
      ["task id .", { projectSlug: "p1", id: ".", description: "traversal" }],
      ["task id ..", { projectSlug: "p1", id: "..", description: "traversal" }],
      ["task id %2e%2e", { projectSlug: "p1", id: "%2e%2e", description: "traversal" }],
      ["project slug ..", { projectSlug: "..", id: "EG-1", description: "traversal" }],
      ["project slug %2e.", { projectSlug: "%2e.", id: "EG-1", description: "traversal" }],
    ];
    for (const [label, args] of taskAttempts) {
      const result = await callTool(ADMIN_KEY, "lexa_update_task", args);
      expect(isToolError(result), label).toBe(true);
      expect(result.structuredContent?.error).toMatchObject({ code: "INVALID_ARGS" });
    }

    const wikiAttempts: Array<[string, Record<string, unknown>]> = [
      ["wiki page slug ..", { projectSlug: "p1", pageSlug: "..", content: "traversal" }],
      ["wiki page slug %2e%2e", { projectSlug: "p1", pageSlug: "%2e%2e", content: "traversal" }],
      ["wiki project slug ..", { projectSlug: "..", pageSlug: "smoke-page", content: "traversal" }],
    ];
    for (const [label, args] of wikiAttempts) {
      const result = await callTool(ADMIN_KEY, "lexa_update_wiki_page", args);
      expect(isToolError(result), label).toBe(true);
      expect(result.structuredContent?.error).toMatchObject({ code: "INVALID_ARGS" });
    }

    const projectAfter = await callTool(ADMIN_KEY, "lexa_get_project", { projectSlug: "p1" });
    const after = projectAfter.structuredContent as { description: string; name: string };
    expect(after.description).toBe(before.description);
    expect(after.name).toBe(before.name);
    const taskAfter = await callTool(ADMIN_KEY, "lexa_get_task", { projectSlug: "p1", id: "EG-1" });
    expect((taskAfter.structuredContent as { title: string }).title).toBe(titleBefore);
  });

  it("still serves ordinary task updates and reads", async () => {
    const updated = await callTool(ADMIN_KEY, "lexa_update_task", {
      projectSlug: "p1",
      id: "EG-1",
      title: "Renamed through MCP",
    });
    expect(isToolError(updated)).toBe(false);
    expect((updated.structuredContent?.data as { title: string }).title).toBe("Renamed through MCP");

    const fetched = await callTool(ADMIN_KEY, "lexa_get_task", { projectSlug: "p1", id: "EG-1" });
    expect((fetched.structuredContent as { title: string }).title).toBe("Renamed through MCP");
  });

  it("filters discovery and denies guessed projects for a member key", async () => {
    const list = await callTool(MEMBER1_KEY, "lexa_list_projects", {});
    expect((list.structuredContent as { data: Array<{ slug: string }> }).data.map((p) => p.slug)).toEqual(["p1"]);

    const denied = await callTool(MEMBER1_KEY, "lexa_get_project", { projectSlug: "p2" });
    expect(isToolError(denied)).toBe(true);
    expect(denied.structuredContent?.error).toMatchObject({ code: "FORBIDDEN" });
  });

  it("keeps concurrent users isolated", async () => {
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        callTool(index % 2 === 0 ? MEMBER1_KEY : MEMBER2_KEY, "lexa_list_projects", {})
      )
    );
    const slugs = results.map((result) =>
      (result.structuredContent as { data: Array<{ slug: string }> }).data.map((p) => p.slug).join(",")
    );
    expect(slugs).toEqual(["p1", "p2", "p1", "p2"]);
  });

  it("re-checks project access on requests after an already-initialized connection", async () => {
    await initialize(MEMBER1_KEY);
    // The grant is removed after the client initialized; the next request must
    // use the current permission state, not a session grant.
    db.prepare("DELETE FROM user_project_roles WHERE user_id = 'u1' AND project_id = 'p1'").run();

    const listResponse = await mcp(MEMBER1_KEY, {
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "lexa_list_projects", arguments: {} },
    });
    expect(listResponse.status).toBe(200);
    const listBody = (await listResponse.json()) as RpcResponse;
    const listed = listBody.result as ToolResult;
    const listedData = listed.structuredContent?.data;
    expect(Array.isArray(listedData) ? listedData.length : -1).toBe(0);

    const deniedResponse = await mcp(MEMBER1_KEY, {
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: { name: "lexa_get_project", arguments: { projectSlug: "p1" } },
    });
    expect(deniedResponse.status).toBe(200);
    const deniedBody = (await deniedResponse.json()) as RpcResponse;
    const denied = deniedBody.result as ToolResult;
    expect(denied.isError).toBe(true);
    const deniedError = denied.structuredContent?.error;
    expect(deniedError).toEqual(expect.objectContaining({ code: "FORBIDDEN" }));
  });

  // Last: it reconfigures the shared limiter singleton for this file.
  it("charges the shared bucket once per MCP request and never per inner dispatch", async () => {
    db.exec("DELETE FROM settings WHERE key IN ('rate_limit_max','rate_limit_window_ms')");
    db.exec("INSERT INTO settings (key, value) VALUES ('rate_limit_max','2'), ('rate_limit_window_ms','600000')");
    syncRateLimitFromDb(db);

    // Three tool calls from three client IPs. Each MCP request fits its own
    // 2-request bucket; if the in-process dispatch charged again they would all
    // share one inner bucket and the third would fail as RATE_LIMITED.
    const calls = await Promise.all(
      ["198.51.100.1", "198.51.100.2", "198.51.100.3"].map((clientIp) =>
        callTool(ADMIN_KEY, "lexa_list_projects", {}, { clientIp })
      )
    );
    for (const result of calls) {
      expect(result.isError === true).toBe(false);
      expect((result.structuredContent as { data: unknown[] }).data).toHaveLength(2);
    }

    // Same shared policy as /api: a third request in the window is refused.
    const clientIp = "203.0.113.9";
    const first = await mcp(ADMIN_KEY, INITIALIZE, { clientIp });
    expect(first.status).toBe(200);
    const second = await mcp(ADMIN_KEY, { jsonrpc: "2.0", id: 2, method: "ping" }, { clientIp });
    expect(second.status).toBe(200);
    const third = await mcp(ADMIN_KEY, { jsonrpc: "2.0", id: 3, method: "ping" }, { clientIp });
    expect(third.status).toBe(429);
    expect(((await third.json()) as { error: { code: string } }).error.code).toBe("RATE_LIMITED");
  });
});
