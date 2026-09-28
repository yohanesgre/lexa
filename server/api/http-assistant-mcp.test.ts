import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { Effect, Layer } from "effect";
import { runMigrations } from "../db/migrate";
import { createApiHandler } from "./http";
import { McpConnectFailed } from "./errors";
import { McpConnector, envSecretRefReason, PROCESS_FIELDS_REJECTED } from "../services/assistant-mcp.service";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));
const ADMIN_KEY = "lxk_" + "j".repeat(43);
const MEMBER_KEY = "lxk_" + "k".repeat(43);
const NOGRANT_KEY = "lxk_" + "n".repeat(43);
const PADMIN_KEY = "lxk_" + "p".repeat(43);
const STDIO_REASON = "transportType 'stdio' is not supported — MCP clients connect to remote http/sse servers";

// The save-time SSRF guard resolves DNS and fails closed, so an unresolvable
// test host would 400 every remote registration. Stub the lookup only; the
// guard's own behaviour is covered in server/assistant/ssrf tests.
vi.mock("../assistant/ssrf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../assistant/ssrf")>();
  return { ...actual, validateUrl: async (raw: string) => new URL(raw) };
});

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
// would hit whatever remote server the row points at.
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

// 0010 deleted the seeded `jev` registration, so every row in these tests is one
// the test itself created through the API.
beforeEach(() => {
  db.exec("DELETE FROM assistant_mcp_project_servers");
  db.exec("DELETE FROM assistant_mcp_servers");
});

async function createClient(label: string, transportType: "http" | "sse" = "http", extra: Record<string, unknown> = {}) {
  const res = await handler(authed("POST", "/api/assistant/mcp-servers", {
    label,
    transportType,
    url: transportType === "sse" ? "https://mcp.test/sse" : "https://mcp.test/mcp",
    ...extra,
  }));
  expect(res.status).toBe(201);
  return (await res.json() as { id: string }).id;
}

describe("MCP client registry (superadmin)", () => {
  it("lists registered remote clients, with no seeded row and no secret ref", async () => {
    const empty = await handler(authed("GET", "/api/assistant/mcp-servers"));
    expect(empty.status).toBe(200);
    expect((await empty.json() as { data: unknown[] }).data).toEqual([]);

    await createClient("Web");
    await createClient("Stream", "sse");

    const res = await handler(authed("GET", "/api/assistant/mcp-servers"));
    expect(res.status).toBe(200);
    const body = await res.json() as { data: Array<Record<string, unknown>> };
    expect(body.data).toEqual([
      expect.objectContaining({ id: "stream", label: "Stream", transportType: "sse", url: "https://mcp.test/sse", command: null, hasSecret: false, enabled: false }),
      expect.objectContaining({ id: "web", label: "Web", transportType: "http", url: "https://mcp.test/mcp", command: null, hasSecret: false, enabled: false }),
    ]);
    expect(JSON.stringify(body)).not.toContain("secret_ref");
  });

  it("member key → 403", async () => {
    const res = await handler(authed("GET", "/api/assistant/mcp-servers", undefined, MEMBER_KEY));
    expect(res.status).toBe(403);
  });

  it("create → 201, then patch, delete → 204", async () => {
    const created = await handler(authed("POST", "/api/assistant/mcp-servers", {
      label: "Remote Client",
      transportType: "http",
      url: "https://mcp.test/mcp",
    }));
    expect(created.status).toBe(201);
    const row = await created.json() as Record<string, unknown>;
    expect(row).toMatchObject({ id: "remote-client", label: "Remote Client", transportType: "http", url: "https://mcp.test/mcp", command: null, args: [], hasSecret: false, enabled: false });

    const patched = await handler(authed("PATCH", "/api/assistant/mcp-servers/remote-client", { label: "Remote 2", secretRef: "env:GITHUB_WEBHOOK_SECRET" }));
    expect(patched.status).toBe(200);
    const patchedBody = await patched.json() as Record<string, unknown>;
    expect(patchedBody.label).toBe("Remote 2");
    expect(patchedBody.hasSecret).toBe(true);
    expect(JSON.stringify(patchedBody)).not.toContain("GITHUB_WEBHOOK_SECRET");

    const removed = await handler(authed("DELETE", "/api/assistant/mcp-servers/remote-client"));
    expect(removed.status).toBe(204);

    const missing = await handler(authed("PATCH", "/api/assistant/mcp-servers/remote-client", { label: "x" }));
    expect(missing.status).toBe(404);
    expect((await missing.json() as { error: { code: string } }).error.code).toBe("MCP_SERVER_NOT_FOUND");
  });

  it("create/patch refuse the legacy process fields with MCP_INVALID_TRANSPORT_CONFIG", async () => {
    const withCommand = await handler(authed("POST", "/api/assistant/mcp-servers", {
      label: "Process",
      transportType: "http",
      url: "https://mcp.test/mcp",
      command: "npx",
    }));
    expect(withCommand.status).toBe(400);
    expect((await withCommand.json() as { error: { code: string; message: string } }).error).toMatchObject({
      code: "MCP_INVALID_TRANSPORT_CONFIG",
      message: PROCESS_FIELDS_REJECTED,
    });

    const withArgs = await handler(authed("POST", "/api/assistant/mcp-servers", {
      label: "Process",
      transportType: "sse",
      url: "https://mcp.test/sse",
      args: ["--x"],
    }));
    expect(withArgs.status).toBe(400);
    expect((await withArgs.json() as { error: { code: string } }).error.code).toBe("MCP_INVALID_TRANSPORT_CONFIG");

    const id = await createClient("Remote");
    const patched = await handler(authed("PATCH", `/api/assistant/mcp-servers/${id}`, { args: ["--verbose"] }));
    expect(patched.status).toBe(400);
    expect((await patched.json() as { error: { code: string } }).error.code).toBe("MCP_INVALID_TRANSPORT_CONFIG");

    // Nothing was written by the refused calls.
    const list = await handler(authed("GET", "/api/assistant/mcp-servers"));
    expect((await list.json() as { data: Array<Record<string, unknown>> }).data).toMatchObject([{ id, command: null, args: [] }]);
  });

  it("create rejects an invalid transport shape with MCP_INVALID_TRANSPORT_CONFIG", async () => {
    const res = await handler(authed("POST", "/api/assistant/mcp-servers", {
      label: "Remote",
      transportType: "http",
      url: null,
    }));
    expect(res.status).toBe(400);
    expect((await res.json() as { error: { code: string } }).error.code).toBe("MCP_INVALID_TRANSPORT_CONFIG");
  });

  // `env:NAME` resolves only a fixed RuntimeEnv key; an unknown name is refused
  // at save time (400) instead of being stored and failing at connect.
  it("create/patch refuse an env: secret name outside the RuntimeEnv snapshot", async () => {
    const created = await handler(authed("POST", "/api/assistant/mcp-servers", {
      label: "Linear",
      transportType: "http",
      url: "https://mcp.test/mcp",
      secretRef: "env:LINEAR_TOKEN",
    }));
    expect(created.status).toBe(400);
    expect((await created.json() as { error: { code: string; message: string } }).error).toMatchObject({
      code: "MCP_INVALID_TRANSPORT_CONFIG",
      message: envSecretRefReason("LINEAR_TOKEN"),
    });

    const id = await createClient("Remote");
    const patched = await handler(authed("PATCH", `/api/assistant/mcp-servers/${id}`, { secretRef: "env:LINEAR_TOKEN" }));
    expect(patched.status).toBe(400);
    expect((await patched.json() as { error: { code: string; message: string } }).error).toMatchObject({
      code: "MCP_INVALID_TRANSPORT_CONFIG",
      message: envSecretRefReason("LINEAR_TOKEN"),
    });

    const still = await handler(authed("GET", "/api/assistant/mcp-servers"));
    expect((await still.json() as { data: Array<Record<string, unknown>> }).data).toMatchObject([
      { id, hasSecret: false },
    ]);
  });

  // A row stored before the `env:NAME` allowlist existed: PATCH must still edit
  // it, and only a supplied `secretRef` is allowlist-validated.
  it("patch does not freeze a row on a pre-existing non-allowlisted secret ref", async () => {
    db.exec(
      `INSERT INTO assistant_mcp_servers (id, label, transport_type, url, command, args, secret_ref, enabled)
       VALUES ('legacy-ref', 'Legacy Ref', 'http', 'https://mcp.test/mcp', NULL, '[]', 'env:LINEAR_TOKEN', 0)`
    );

    const renamed = await handler(authed("PATCH", "/api/assistant/mcp-servers/legacy-ref", { label: "Legacy Renamed", enabled: true }));
    expect(renamed.status).toBe(200);
    const body = await renamed.json() as Record<string, unknown>;
    expect(body).toMatchObject({ id: "legacy-ref", label: "Legacy Renamed", enabled: true, hasSecret: true });
    expect(JSON.stringify(body)).not.toContain("LINEAR_TOKEN");

    const supplied = await handler(authed("PATCH", "/api/assistant/mcp-servers/legacy-ref", { secretRef: "env:LINEAR_TOKEN" }));
    expect(supplied.status).toBe(400);
    expect((await supplied.json() as { error: { code: string; message: string } }).error).toMatchObject({
      code: "MCP_INVALID_TRANSPORT_CONFIG",
      message: envSecretRefReason("LINEAR_TOKEN"),
    });
  });

  it("create rejects the legacy stdio payload with MCP_INVALID_TRANSPORT_CONFIG, not a decode 400", async () => {
    const res = await handler(authed("POST", "/api/assistant/mcp-servers", {
      label: "Local",
      transportType: "stdio",
      command: "local-mcp",
      args: ["--stdio"],
    }));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("MCP_INVALID_TRANSPORT_CONFIG");
    expect(body.error.message).toBe(STDIO_REASON);
    const still = await handler(authed("GET", "/api/assistant/mcp-servers"));
    expect((await still.json() as { data: unknown[] }).data).toEqual([]);
  });

  it("slug `jev` is an ordinary user-owned client", async () => {
    const id = await createClient("Jev");
    expect(id).toBe("jev");
    const removed = await handler(authed("DELETE", "/api/assistant/mcp-servers/jev"));
    expect(removed.status).toBe(204);
  });

  it("delete of an unknown id → 404 MCP_SERVER_NOT_FOUND", async () => {
    const unknown = await handler(authed("DELETE", "/api/assistant/mcp-servers/ghost"));
    expect(unknown.status).toBe(404);
    expect((await unknown.json() as { error: { code: string } }).error.code).toBe("MCP_SERVER_NOT_FOUND");
  });

  it("test endpoint returns 200 with a failed-connect result for an existing row; 404 for unknown", async () => {
    const id = await createClient("Broken");
    const res = await failHandler(authed("POST", `/api/assistant/mcp-servers/${id}/test`));
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
    const id = await createClient("Reachable");
    const res = await okHandler(authed("POST", `/api/assistant/mcp-servers/${id}/test`));
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

    const id = await createClient("Shared");
    const memberWrite = await handler(authed("PUT", "/api/projects/p1/assistant/mcp-servers", {
      entries: [{ serverId: id, enabled: true }],
    }, MEMBER_KEY));
    expect(memberWrite.status).toBe(403);
  });

  it("project admin PUTs a replace-set reflected by the GET", async () => {
    const a = await createClient("Alpha Client");
    const b = await createClient("Beta Client", "sse");

    const put = await handler(authed("PUT", "/api/projects/p1/assistant/mcp-servers", {
      entries: [{ serverId: a, enabled: true }],
    }, PADMIN_KEY));
    expect(put.status).toBe(200);
    const putBody = await put.json() as { data: Array<Record<string, unknown>> };
    expect(putBody.data).toMatchObject([{ projectId: "p1", serverId: a, enabled: true }]);

    const replace = await handler(authed("PUT", "/api/projects/p1/assistant/mcp-servers", {
      entries: [{ serverId: b, enabled: false }],
    }, PADMIN_KEY));
    expect(replace.status).toBe(200);

    const get = await handler(authed("GET", "/api/projects/p1/assistant/mcp-servers", undefined, MEMBER_KEY));
    const getBody = await get.json() as { data: Array<Record<string, unknown>> };
    expect(getBody.data).toMatchObject([{ projectId: "p1", serverId: b, enabled: false }]);

    // Replace-set: an empty PUT drops every binding.
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
