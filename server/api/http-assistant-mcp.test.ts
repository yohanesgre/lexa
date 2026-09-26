import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { Effect, Layer } from "effect";
import { runMigrations } from "../db/migrate";
import { createApiHandler } from "./http";
import { McpConnectFailed } from "./errors";
import { McpConnector } from "../services/assistant-mcp.service";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));
const ADMIN_KEY = "lxk_" + "j".repeat(43);
const MEMBER_KEY = "lxk_" + "k".repeat(43);
const NOGRANT_KEY = "lxk_" + "n".repeat(43);
const PADMIN_KEY = "lxk_" + "p".repeat(43);

async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

let dir: string;
let handler: (req: Request) => Promise<Response>;
let okHandler: (req: Request) => Promise<Response>;
let failHandler: (req: Request) => Promise<Response>;
let db: Database;

// Injected connectors keep the HTTP shapes deterministic: the live default
// would spawn/hit whatever server the row points at.
const okConnector = Layer.succeed(McpConnector, {
  connect: () => Effect.succeed({ toolCount: 3, readOnlyToolCount: 2 }),
});

const failConnector = Layer.succeed(McpConnector, {
  connect: () => Effect.fail(new McpConnectFailed({ message: "no route to host" })),
});

const authed = (method: string, path: string, body?: unknown, key = ADMIN_KEY) =>
  new Request(`http://lexa.test${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "lexa-assistant-mcp-http-"));
  const dbPath = join(dir, "test.db");
  runMigrations(dbPath, MIGRATIONS);
  const hashes = {
    admin: await sha256(ADMIN_KEY),
    member: await sha256(MEMBER_KEY),
    nogrant: await sha256(NOGRANT_KEY),
    padmin: await sha256(PADMIN_KEY),
  };
  db = new Database(dbPath);
  db.exec(`
    INSERT INTO users (id, email, name, role) VALUES
      ('u1','a@lexa.test','A','superadmin'),
      ('u3','m@lexa.test','M','member'),
      ('u4','n@lexa.test','N','member'),
      ('u5','pa@lexa.test','PA','member');
    INSERT INTO api_keys (id, name, key_hash, user_id) VALUES
      ('k1','test','${hashes.admin}','u1'),
      ('k3','mem','${hashes.member}','u3'),
      ('k4','nogrant','${hashes.nogrant}','u4'),
      ('k5','padmin','${hashes.padmin}','u5');
    INSERT INTO projects (id, name, slug) VALUES ('p1','Alpha','alpha');
    INSERT INTO user_project_roles (user_id, role, project_id) VALUES
      ('u3','member','p1'),
      ('u5','admin','p1');
  `);
  handler = createApiHandler(dbPath);
  okHandler = createApiHandler(dbPath, undefined, { mcpConnector: okConnector });
  failHandler = createApiHandler(dbPath, undefined, { mcpConnector: failConnector });
});

afterAll(() => { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });

beforeEach(() => {
  db.exec("DELETE FROM assistant_mcp_project_servers");
  db.exec("DELETE FROM assistant_mcp_servers WHERE id != 'jev'");
});

describe("MCP server registry (superadmin)", () => {
  it("lists the seeded jev row disabled with no secret", async () => {
    const res = await handler(authed("GET", "/api/assistant/mcp-servers"));
    expect(res.status).toBe(200);
    const body = await res.json() as { data: Array<Record<string, unknown>> };
    expect(body.data).toHaveLength(1);
    const jev = body.data[0]!;
    expect(jev).toMatchObject({
      id: "jev",
      label: "Jev",
      transportType: "stdio",
      url: null,
      command: "jev-mcp",
      args: [],
      hasSecret: false,
      enabled: false,
    });
    expect(JSON.stringify(body)).not.toContain("secret_ref");
  });

  it("member key → 403", async () => {
    const res = await handler(authed("GET", "/api/assistant/mcp-servers", undefined, MEMBER_KEY));
    expect(res.status).toBe(403);
  });

  it("create → 201, then patch, delete → 204", async () => {
    const created = await handler(authed("POST", "/api/assistant/mcp-servers", {
      label: "Local Server",
      transportType: "stdio",
      command: "local-mcp",
      args: ["--x"],
    }));
    expect(created.status).toBe(201);
    const row = await created.json() as Record<string, unknown>;
    expect(row).toMatchObject({ id: "local-server", label: "Local Server", transportType: "stdio", hasSecret: false, enabled: false });

    const patched = await handler(authed("PATCH", "/api/assistant/mcp-servers/local-server", { label: "Local 2", secretRef: "env:LOCAL_TOKEN" }));
    expect(patched.status).toBe(200);
    const patchedBody = await patched.json() as Record<string, unknown>;
    expect(patchedBody.label).toBe("Local 2");
    expect(patchedBody.hasSecret).toBe(true);
    expect(JSON.stringify(patchedBody)).not.toContain("LOCAL_TOKEN");

    const removed = await handler(authed("DELETE", "/api/assistant/mcp-servers/local-server"));
    expect(removed.status).toBe(204);

    const missing = await handler(authed("PATCH", "/api/assistant/mcp-servers/local-server", { label: "x" }));
    expect(missing.status).toBe(404);
    expect((await missing.json() as { error: { code: string } }).error.code).toBe("MCP_SERVER_NOT_FOUND");
  });

  it("create rejects an invalid transport shape with MCP_INVALID_TRANSPORT_CONFIG", async () => {
    const res = await handler(authed("POST", "/api/assistant/mcp-servers", {
      label: "Remote",
      transportType: "http",
      url: null,
    }));
    expect(res.status).toBe(400);
    expect((await res.json() as { error: { code: string } }).error.code).toBe("MCP_INVALID_TRANSPORT_CONFIG");

    const reserved = await handler(authed("POST", "/api/assistant/mcp-servers", {
      label: "Jev",
      transportType: "stdio",
      command: "jev-mcp",
    }));
    expect(reserved.status).toBe(400);
    expect((await reserved.json() as { error: { code: string } }).error.code).toBe("MCP_INVALID_TRANSPORT_CONFIG");
  });

  it("delete of the reserved jev row → 400; unknown id → 404", async () => {
    const jev = await handler(authed("DELETE", "/api/assistant/mcp-servers/jev"));
    expect(jev.status).toBe(400);
    expect((await jev.json() as { error: { code: string } }).error.code).toBe("MCP_INVALID_TRANSPORT_CONFIG");

    const unknown = await handler(authed("DELETE", "/api/assistant/mcp-servers/ghost"));
    expect(unknown.status).toBe(404);
    expect((await unknown.json() as { error: { code: string } }).error.code).toBe("MCP_SERVER_NOT_FOUND");
  });

  it("test endpoint returns 200 with a failed-connect result for an existing row; 404 for unknown", async () => {
    const res = await failHandler(authed("POST", "/api/assistant/mcp-servers/jev/test"));
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; toolCount: number; readOnlyToolCount: number; latencyMs: number; error: { code: string; message: string } | null };
    // A failed connect is an expected result, not a 5xx.
    expect(body.ok).toBe(false);
    expect(body.toolCount).toBe(0);
    expect(body.readOnlyToolCount).toBe(0);
    expect(typeof body.latencyMs).toBe("number");
    expect(body.error?.code).toBe("MCP_CONNECT_FAILED");

    const unknown = await failHandler(authed("POST", "/api/assistant/mcp-servers/ghost/test"));
    expect(unknown.status).toBe(404);
    expect((await unknown.json() as { error: { code: string } }).error.code).toBe("MCP_SERVER_NOT_FOUND");
  });

  it("test endpoint returns the ok shape with the fake connector", async () => {
    const res = await okHandler(authed("POST", "/api/assistant/mcp-servers/jev/test"));
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; toolCount: number; readOnlyToolCount: number; latencyMs: number; error: unknown };
    expect(body.ok).toBe(true);
    expect(body.toolCount).toBe(3);
    expect(body.readOnlyToolCount).toBe(2);
    expect(typeof body.latencyMs).toBe("number");
    expect(body.error).toBeNull();
  });
});

describe("Per-project MCP availability", () => {
  it("member GET with a grant → 200; without a grant → 403; PUT is admin-gated", async () => {
    const memberRead = await handler(authed("GET", "/api/projects/p1/assistant/mcp-servers", undefined, MEMBER_KEY));
    expect(memberRead.status).toBe(200);
    expect((await memberRead.json() as { data: unknown[] }).data).toEqual([]);

    const noGrant = await handler(authed("GET", "/api/projects/p1/assistant/mcp-servers", undefined, NOGRANT_KEY));
    expect(noGrant.status).toBe(403);

    const memberWrite = await handler(authed("PUT", "/api/projects/p1/assistant/mcp-servers", {
      entries: [{ serverId: "jev", enabled: true }],
    }, MEMBER_KEY));
    expect(memberWrite.status).toBe(403);
  });

  it("project admin PUTs a replace-set reflected by the GET", async () => {
    const put = await handler(authed("PUT", "/api/projects/p1/assistant/mcp-servers", {
      entries: [{ serverId: "jev", enabled: true }],
    }, PADMIN_KEY));
    expect(put.status).toBe(200);
    const putBody = await put.json() as { data: Array<Record<string, unknown>> };
    expect(putBody.data).toMatchObject([{ projectId: "p1", serverId: "jev", enabled: true }]);

    const get = await handler(authed("GET", "/api/projects/p1/assistant/mcp-servers", undefined, MEMBER_KEY));
    const getBody = await get.json() as { data: Array<Record<string, unknown>> };
    expect(getBody.data).toMatchObject([{ projectId: "p1", serverId: "jev", enabled: true }]);

    // Replace-set: the second PUT drops jev.
    const cleared = await handler(authed("PUT", "/api/projects/p1/assistant/mcp-servers", { entries: [] }, ADMIN_KEY));
    expect(cleared.status).toBe(200);
    expect((await cleared.json() as { data: unknown[] }).data).toEqual([]);
  });

  it("PUT with an unknown serverId → 404 MCP_SERVER_NOT_FOUND", async () => {
    const res = await handler(authed("PUT", "/api/projects/p1/assistant/mcp-servers", {
      entries: [{ serverId: "ghost", enabled: true }],
    }, ADMIN_KEY));
    expect(res.status).toBe(404);
    expect((await res.json() as { error: { code: string } }).error.code).toBe("MCP_SERVER_NOT_FOUND");
  });
});
