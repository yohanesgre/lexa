import { describe, it, expect, afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { Effect, Layer } from "effect";
import { runMigrations } from "../db/migrate";
import { createAssistantApiHandler } from "./assistant-api";
import { McpConnectFailed } from "./errors";
import { McpConnector, PROCESS_FIELDS_REJECTED, SECRET_CLEAR_CONFLICT_REJECTED, SECRET_REQUIRES_MASTER_KEY } from "../services/assistant-mcp.service";

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
  handler = createAssistantApiHandler(dbPath);
  okHandler = createAssistantApiHandler(dbPath, undefined, { mcpConnector: okConnector });
  failHandler = createAssistantApiHandler(dbPath, undefined, { mcpConnector: failConnector });
});

afterAll(() => { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });

// 0010 deleted the seeded `jev` registration, so every row in these tests is one
// the test itself created through the API.
beforeEach(() => {
  db.exec("DELETE FROM assistant_mcp_project_servers");
  db.exec("DELETE FROM assistant_mcp_servers");
  // This suite's default env has no master key (the capability must read
  // false). vitest.setup sets one globally so better-auth can sign sessions,
  // so clear it here; tests that need it set it explicitly.
  delete process.env.LXK_SECRETS_MASTER_KEY;
  delete process.env.LXK_SECRETS_MASTER_KEY_PREV;
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

const refOf = (id: string) =>
  (db.prepare("SELECT secret_ref FROM assistant_mcp_servers WHERE id = ?").get(id) as
    | { secret_ref: string | null }
    | null)?.secret_ref ?? null;

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

  it("carries managedSecretsEnabled alongside data, and never a key value", async () => {
    const res = await handler(authed("GET", "/api/assistant/mcp-servers"));
    expect(res.status).toBe(200);
    const body = await res.json() as { data: unknown[]; managedSecretsEnabled: unknown };
    // Additive sibling of `data`: the row shape is untouched. No key is set in
    // this suite's default env, so the capability reads false.
    expect(body.managedSecretsEnabled).toBe(false);
    expect(body).toHaveProperty("data");
    expect(JSON.stringify(body)).not.toContain("LXK_SECRETS_MASTER_KEY");
  });

  it("managedSecretsEnabled is true when the server env configures a master key, and a managed save then succeeds", async () => {
    // Same env snapshot the save path reads, so the rendered capability and the
    // enforced one cannot disagree: true here, and the very next call proves
    // the feature really works.
    process.env.LXK_SECRETS_MASTER_KEY = Buffer.alloc(32, 9).toString("base64");
    try {
      const res = await handler(authed("GET", "/api/assistant/mcp-servers"));
      expect(res.status).toBe(200);
      const body = await res.json() as { managedSecretsEnabled: unknown };
      expect(body.managedSecretsEnabled).toBe(true);

      const created = await handler(authed("POST", "/api/assistant/mcp-servers", {
        label: "Keyed",
        transportType: "http",
        url: "https://mcp.test/mcp",
        secret: "bearer_token_for_the_keyed_server",
      }));
      expect(created.status).toBe(201);
      const createdBody = await created.json() as Record<string, unknown>;
      expect(createdBody).toMatchObject({ hasSecret: true, secretSource: "managed" });
      expect(JSON.stringify(createdBody)).not.toContain("bearer_token_for_the_keyed_server");
    } finally {
      delete process.env.LXK_SECRETS_MASTER_KEY;
    }
  });

  it("a managed save is refused with the frozen code when the capability is false", async () => {
    const res = await handler(authed("POST", "/api/assistant/mcp-servers", {
      label: "Unkeyed",
      transportType: "http",
      url: "https://mcp.test/mcp",
      secret: "bearer_token_with_no_key",
    }));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("MCP_INVALID_TRANSPORT_CONFIG");
    expect(body.error.message).toBe(SECRET_REQUIRES_MASTER_KEY);
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

    const patched = await handler(authed("PATCH", "/api/assistant/mcp-servers/remote-client", { label: "Remote 2" }));
    expect(patched.status).toBe(200);
    const patchedBody = await patched.json() as Record<string, unknown>;
    expect(patchedBody).toMatchObject({ label: "Remote 2", hasSecret: false, secretSource: "none" });

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

  // Managed-only (2026-09-28): `secretRef` stays on the payloads for typed-client
  // compatibility, is accepted-and-ignored, and logs one structured WARN. It is
  // never stored, never echoed, and never reported as a credential source.
  it("a secretRef on create/patch is accepted-and-ignored with one WARN and never echoed", async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      logged.push(String(chunk));
      return true;
    });
    let created: Record<string, unknown>;
    let patched: Record<string, unknown>;
    try {
      const createdRes = await handler(authed("POST", "/api/assistant/mcp-servers", {
        label: "Ignored",
        transportType: "http",
        url: "https://mcp.test/mcp",
        secretRef: "env:GITHUB_WEBHOOK_SECRET",
      }));
      expect(createdRes.status).toBe(201);
      created = await createdRes.json() as Record<string, unknown>;

      const patchedRes = await handler(authed("PATCH", "/api/assistant/mcp-servers/ignored", {
        label: "Ignored 2",
        secretRef: "env:GITHUB_WEBHOOK_SECRET",
      }));
      expect(patchedRes.status).toBe(200);
      patched = await patchedRes.json() as Record<string, unknown>;
    } finally {
      spy.mockRestore();
    }

    for (const body of [created, patched]) {
      expect(body).toMatchObject({ hasSecret: false, secretSource: "none" });
      expect(body).not.toHaveProperty("secretRef");
      expect(JSON.stringify(body)).not.toContain("GITHUB_WEBHOOK_SECRET");
    }
    expect(patched).toMatchObject({ label: "Ignored 2" });
    expect(refOf("ignored")).toBeNull();

    // One WARN per request, naming the operation, never the ref.
    const warns = logged
      .map((line) => JSON.parse(line) as { level?: string; message?: string })
      .filter((entry) => entry.level === "WARN");
    expect(warns).toHaveLength(2);
    for (const warn of warns) expect(warn.message).toContain("secretRef ignored");
    expect(logged.join("\n")).not.toContain("GITHUB_WEBHOOK_SECRET");
  });

  it("an oversize secretRef is refused at decode (400), like an oversize managed secret", async () => {
    const res = await handler(authed("POST", "/api/assistant/mcp-servers", {
      label: "Too Long",
      transportType: "http",
      url: "https://mcp.test/mcp",
      secretRef: "env:" + "x".repeat(4096),
    }));
    expect(res.status).toBe(400);
    // A decode refusal never reaches the handler, so nothing is written.
    const still = await handler(authed("GET", "/api/assistant/mcp-servers"));
    expect((await still.json() as { data: unknown[] }).data).toEqual([]);
  });

  // A row stored before references were removed: `secret_ref` is legacy and is
  // never a credential. GET hides it; PATCH clears it on write.
  it("legacy stored secret_ref is hidden by GET and cleared by PATCH", async () => {
    db.exec(
      `INSERT INTO assistant_mcp_servers (id, label, transport_type, url, command, args, secret_ref, enabled)
       VALUES ('legacy-ref', 'Legacy Ref', 'http', 'https://mcp.test/mcp', NULL, '[]', 'env:LINEAR_TOKEN', 0)`
    );

    const list = await handler(authed("GET", "/api/assistant/mcp-servers"));
    expect(list.status).toBe(200);
    const listBody = await list.json() as { data: Array<Record<string, unknown>> };
    expect(listBody.data).toMatchObject([{ id: "legacy-ref", hasSecret: false, secretSource: "none" }]);
    expect(JSON.stringify(listBody)).not.toContain("LINEAR_TOKEN");
    expect(JSON.stringify(listBody)).not.toContain("secret_ref");

    const renamed = await handler(authed("PATCH", "/api/assistant/mcp-servers/legacy-ref", { label: "Legacy Renamed", enabled: true }));
    expect(renamed.status).toBe(200);
    const body = await renamed.json() as Record<string, unknown>;
    expect(body).toMatchObject({ id: "legacy-ref", label: "Legacy Renamed", enabled: true, hasSecret: false, secretSource: "none" });
    expect(JSON.stringify(body)).not.toContain("LINEAR_TOKEN");
    expect(refOf("legacy-ref")).toBeNull();
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

// The managed-secret wire contract over HTTP. The master key reaches the service
// through RuntimeEnv, and the Bun handler resolves the fallback snapshot with
// getEnv() PER REQUEST, so setting process.env around a case is what the
// production single-key deployment does at boot.
describe("managed MCP client secrets over HTTP", () => {
  const MASTER_KEY = Buffer.from("h".repeat(32)).toString("base64");
  const TOKEN = "planted-http-managed-token-4c8e1b-do-not-leak";

  const secretRow = (id: string) =>
    db.prepare("SELECT server_id, ciphertext, iv, key_id FROM assistant_mcp_secrets WHERE server_id = ?").get(id) as
      | { server_id: string; ciphertext: string; iv: string; key_id: string }
      | null;

  // `secret` is write-only by construction, so the response body is the only
  // place a leaked value could surface, and the raw row is the only place the
  // stored ciphertext can be checked for a plaintext leak.
  afterEach(() => {
    delete process.env.LXK_SECRETS_MASTER_KEY;
    delete process.env.LXK_SECRETS_MASTER_KEY_PREV;
  });

  it("POST with a managed secret → 201, hasSecret + secretSource managed, and no value anywhere in the response", async () => {
    process.env.LXK_SECRETS_MASTER_KEY = MASTER_KEY;

    const res = await handler(authed("POST", "/api/assistant/mcp-servers", {
      label: "Managed HTTP",
      transportType: "http",
      url: "https://mcp.test/managed",
      secret: TOKEN,
    }));
    expect(res.status).toBe(201);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toMatchObject({ id: "managed-http", hasSecret: true, secretSource: "managed" });
    // Write-only: neither the token nor a secret/ciphertext field is echoed.
    expect(JSON.stringify(body)).not.toContain(TOKEN);
    expect(body).not.toHaveProperty("secret");
    expect(body).not.toHaveProperty("secretRef");
    expect(body).not.toHaveProperty("ciphertext");

    // The stored blob is ciphertext, and the registry ref stays null: the
    // credential lives in the secret table only.
    const stored = secretRow("managed-http");
    expect(stored).toBeDefined();
    expect(stored!.ciphertext).not.toContain(TOKEN);
    expect(stored!.iv).not.toContain(TOKEN);
    expect(refOf("managed-http")).toBeNull();
  });

  it("PATCH clearSecret → 200 with hasSecret false and secretSource none, and the ciphertext row is gone", async () => {
    process.env.LXK_SECRETS_MASTER_KEY = MASTER_KEY;

    const created = await handler(authed("POST", "/api/assistant/mcp-servers", {
      label: "Clearable",
      transportType: "http",
      url: "https://mcp.test/clearable",
      secret: TOKEN,
    }));
    expect(created.status).toBe(201);
    expect(secretRow("clearable")).toBeDefined();

    const cleared = await handler(authed("PATCH", "/api/assistant/mcp-servers/clearable", { clearSecret: true }));
    expect(cleared.status).toBe(200);
    const body = await cleared.json() as Record<string, unknown>;
    expect(body).toMatchObject({ id: "clearable", hasSecret: false, secretSource: "none" });
    expect(JSON.stringify(body)).not.toContain(TOKEN);
    expect(secretRow("clearable")).toBeNull();
    expect(refOf("clearable")).toBeNull();
  });

  it("PATCH secret + secretRef stores the managed token, ignores the ref, and logs one WARN", async () => {
    process.env.LXK_SECRETS_MASTER_KEY = MASTER_KEY;

    const created = await handler(authed("POST", "/api/assistant/mcp-servers", {
      label: "Ignored Ref",
      transportType: "http",
      url: "https://mcp.test/ignored-ref",
    }));
    expect(created.status).toBe(201);
    expect(secretRow("ignored-ref")).toBeNull();

    const logged: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      logged.push(String(chunk));
      return true;
    });
    let res: Response;
    try {
      res = await handler(authed("PATCH", "/api/assistant/mcp-servers/ignored-ref", {
        secret: TOKEN,
        secretRef: "env:CRON_SECRET",
      }));
    } finally {
      spy.mockRestore();
    }
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toMatchObject({ id: "ignored-ref", hasSecret: true, secretSource: "managed" });
    expect(JSON.stringify(body)).not.toContain(TOKEN);
    expect(JSON.stringify(body)).not.toContain("CRON_SECRET");
    expect(secretRow("ignored-ref")).toBeDefined();
    expect(refOf("ignored-ref")).toBeNull();

    const warns = logged
      .map((line) => JSON.parse(line) as { level?: string; message?: string })
      .filter((entry) => entry.level === "WARN");
    expect(warns).toHaveLength(1);
    expect(warns[0]!.message).toContain("secretRef ignored");
    expect(logged.join("\n")).not.toContain("CRON_SECRET");
  });

  it("PATCH secretRef alone on a managed row is ignored: 200, source managed, ciphertext untouched, stored ref null, one WARN", async () => {
    process.env.LXK_SECRETS_MASTER_KEY = MASTER_KEY;

    const created = await handler(authed("POST", "/api/assistant/mcp-servers", {
      label: "Managed Ref",
      transportType: "http",
      url: "https://mcp.test/managed-ref",
      secret: TOKEN,
    }));
    expect(created.status).toBe(201);
    const before = secretRow("managed-ref");
    expect(before).toBeDefined();

    const logged: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      logged.push(String(chunk));
      return true;
    });
    let res: Response;
    try {
      res = await handler(authed("PATCH", "/api/assistant/mcp-servers/managed-ref", { secretRef: "env:CRON_SECRET" }));
    } finally {
      spy.mockRestore();
    }
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toMatchObject({ id: "managed-ref", hasSecret: true, secretSource: "managed" });
    expect(JSON.stringify(body)).not.toContain(TOKEN);
    expect(JSON.stringify(body)).not.toContain("CRON_SECRET");

    // The ignored ref neither rewrites the ref column nor touches the blob: the
    // managed ciphertext is authoritative and byte-identical after the write.
    expect(refOf("managed-ref")).toBeNull();
    expect(secretRow("managed-ref")).toEqual(before);

    const warns = logged
      .map((line) => JSON.parse(line) as { level?: string; message?: string })
      .filter((entry) => entry.level === "WARN");
    expect(warns).toHaveLength(1);
    expect(warns[0]!.message).toContain("secretRef ignored");
    expect(logged.join("\n")).not.toContain("CRON_SECRET");
  });

  it("PATCH clearSecret + secretRef succeeds; clearSecret + secret is still refused", async () => {
    process.env.LXK_SECRETS_MASTER_KEY = MASTER_KEY;

    const created = await handler(authed("POST", "/api/assistant/mcp-servers", {
      label: "Clearable",
      transportType: "http",
      url: "https://mcp.test/clearable-2",
      secret: TOKEN,
    }));
    expect(created.status).toBe(201);
    expect(secretRow("clearable")).toBeDefined();

    // An ignored ref does not conflict with a clear.
    const cleared = await handler(authed("PATCH", "/api/assistant/mcp-servers/clearable", {
      clearSecret: true,
      secretRef: "env:CRON_SECRET",
    }));
    expect(cleared.status).toBe(200);
    expect(await cleared.json() as Record<string, unknown>).toMatchObject({ hasSecret: false, secretSource: "none" });
    expect(secretRow("clearable")).toBeNull();

    // A real token does: the conflict is unchanged.
    const conflict = await handler(authed("PATCH", "/api/assistant/mcp-servers/clearable", {
      clearSecret: true,
      secret: TOKEN,
    }));
    expect(conflict.status).toBe(400);
    expect((await conflict.json() as { error: { code: string; message: string } }).error).toMatchObject({
      code: "MCP_INVALID_TRANSPORT_CONFIG",
      message: SECRET_CLEAR_CONFLICT_REJECTED,
    });
  });

  // The response literal is `managed | none` — a `reference` value must never
  // come back from any route.
  it("never reports secretSource reference", async () => {
    process.env.LXK_SECRETS_MASTER_KEY = MASTER_KEY;
    await handler(authed("POST", "/api/assistant/mcp-servers", {
      label: "Source Check",
      transportType: "http",
      url: "https://mcp.test/source",
      secret: TOKEN,
      secretRef: "env:CRON_SECRET",
    }));
    const list = await handler(authed("GET", "/api/assistant/mcp-servers"));
    const body = await list.text();
    expect(body).toContain('"secretSource":"managed"');
    expect(body).not.toContain('"reference"');
  });
});
