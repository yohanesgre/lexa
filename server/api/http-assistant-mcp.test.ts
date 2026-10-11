import { describe, it, expect, afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { Effect, Layer, Context } from "effect";
import { runMigrations } from "../db/migrate";
import { Sqlite } from "../db/database";
import { DbBunLive } from "../db/db";
import { AssistantSettingsRepo } from "../repos/assistant-settings.repo";
import { createAssistantApiHandler } from "./assistant-api";
import { McpConnectFailed } from "./errors";
import type * as SsrfModule from "../assistant/ssrf";
import { McpConnector, PROCESS_FIELDS_REJECTED, SECRET_REQUIRES_MASTER_KEY } from "../services/assistant-mcp.service";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));
const ADMIN_KEY = "lxk_" + "j".repeat(43);
const MEMBER_KEY = "lxk_" + "k".repeat(43);
const NOGRANT_KEY = "lxk_" + "n".repeat(43);
const PADMIN_KEY = "lxk_" + "p".repeat(43);
const BARE_KEY = "lxk_" + "q".repeat(43);
const JEV_KEY = "jev-plaintext-4c8e1b-do-not-leak";

// The save-time SSRF guard resolves DNS and fails closed, so an unresolvable
// test host would 400 every remote registration. Stub the lookup only; the
// guard's own behaviour is covered in server/assistant/ssrf tests.
vi.mock("../assistant/ssrf", async (importOriginal) => {
  const actual = await importOriginal<typeof SsrfModule>();
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
    bare: await sha256(BARE_KEY),
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
      ('k5','padmin','${hashes.padmin}','u5'),
      ('k6','bare','${hashes.bare}',NULL);
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

// 0010 deleted the seeded `jev` registration, so every MCP row in these tests
// is one the test itself created through the API.
beforeEach(() => {
  db.exec("DELETE FROM assistant_mcp_project_servers");
  db.exec("DELETE FROM assistant_mcp_servers");
  db.exec("DELETE FROM assistant_mcp_secrets");
  db.exec("DELETE FROM assistant_jev_secrets");
  db.exec(`UPDATE assistant_jev_config SET base_url = 'https://api.typesafe.ai', model = 'jev-latest', enabled = 0 WHERE id = 'default'`);
  // This suite's default env has no master key (the capability must read
  // false). vitest.setup sets one globally so better-auth can sign sessions,
  // so clear it here; tests that need it set it explicitly.
  delete process.env.LXK_SECRETS_MASTER_KEY;
  delete process.env.LXK_SECRETS_MASTER_KEY_PREV;
});

afterEach(() => {
  vi.unstubAllGlobals();
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
  const body = await res.json() as { id: string };
  return body.id;
}

const refOf = (id: string) =>
  (db.prepare("SELECT secret_ref FROM assistant_mcp_servers WHERE id = ?").get(id) as
    | { secret_ref: string | null }
    | null)?.secret_ref ?? null;

type ErrorBody = { error: { code: string; message: string } };

describe("MCP client registry (superadmin)", () => {
  it("lists remote clients (no secret ref) with the managed-secrets capability and a grant-gated per-project view", async () => {
    const empty = await handler(authed("GET", "/api/assistant/mcp-servers"));
    expect(empty.status).toBe(200);
    const emptyBody = await empty.json() as { data: unknown[]; managedSecretsEnabled: unknown };
    expect(emptyBody.data).toEqual([]);
    // Additive sibling of `data`: the row shape is untouched. No master key in
    // this suite's default env, so the capability reads false.
    expect(emptyBody.managedSecretsEnabled).toBe(false);
    expect(JSON.stringify(emptyBody)).not.toContain("LXK_SECRETS_MASTER_KEY");

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

    // Per-project availability is grant-gated: a member reads, an ungranted
    // member is refused, and only a project admin may replace the set.
    const memberRead = await handler(authed("GET", "/api/projects/p1/assistant/mcp-servers", undefined, MEMBER_KEY));
    expect(memberRead.status).toBe(200);
    const memberReadBody = await memberRead.json() as { data: unknown[] };
    expect(memberReadBody.data).toEqual([]);

    const noGrant = await handler(authed("GET", "/api/projects/p1/assistant/mcp-servers", undefined, NOGRANT_KEY));
    expect(noGrant.status).toBe(403);

    const a = await createClient("Alpha Client");
    const b = await createClient("Beta Client", "sse");

    const memberWrite = await handler(authed("PUT", "/api/projects/p1/assistant/mcp-servers", {
      entries: [{ serverId: a, enabled: true }],
    }, MEMBER_KEY));
    expect(memberWrite.status).toBe(403);

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

    const unknown = await handler(authed("PUT", "/api/projects/p1/assistant/mcp-servers", {
      entries: [{ serverId: "ghost", enabled: true }],
    }, ADMIN_KEY));
    expect(unknown.status).toBe(404);
    const unknownBody = await unknown.json() as ErrorBody;
    expect(unknownBody.error.code).toBe("MCP_SERVER_NOT_FOUND");
  });

  it("create → 201, patch, delete → 204, unknown → 404; the legacy process fields and stdio payload are refused", async () => {
    const created = await handler(authed("POST", "/api/assistant/mcp-servers", {
      label: "Remote Client",
      transportType: "http",
      url: "https://mcp.test/mcp",
    }));
    expect(created.status).toBe(201);
    const row = await created.json() as Record<string, unknown>;
    expect(row).toMatchObject({ id: "remote-client", label: "Remote Client", transportType: "http", url: "https://mcp.test/mcp", command: null, args: [], hasSecret: false, secretSource: "none" });

    const patched = await handler(authed("PATCH", "/api/assistant/mcp-servers/remote-client", { label: "Remote 2" }));
    expect(patched.status).toBe(200);
    const patchedBody = await patched.json() as Record<string, unknown>;
    expect(patchedBody).toMatchObject({ label: "Remote 2", hasSecret: false, secretSource: "none" });

    const removed = await handler(authed("DELETE", "/api/assistant/mcp-servers/remote-client"));
    expect(removed.status).toBe(204);

    const missing = await handler(authed("PATCH", "/api/assistant/mcp-servers/remote-client", { label: "x" }));
    expect(missing.status).toBe(404);
    const missingBody = await missing.json() as ErrorBody;
    expect(missingBody.error.code).toBe("MCP_SERVER_NOT_FOUND");

    const withCommand = await handler(authed("POST", "/api/assistant/mcp-servers", {
      label: "Process",
      transportType: "http",
      url: "https://mcp.test/mcp",
      command: "npx",
    }));
    expect(withCommand.status).toBe(400);
    const withCommandBody = await withCommand.json() as ErrorBody;
    expect(withCommandBody.error).toMatchObject({ code: "MCP_INVALID_TRANSPORT_CONFIG", message: PROCESS_FIELDS_REJECTED });

    const stdio = await handler(authed("POST", "/api/assistant/mcp-servers", {
      label: "Local",
      transportType: "stdio",
      command: "local-mcp",
      args: ["--stdio"],
    }));
    expect(stdio.status).toBe(400);
    const stdioBody = await stdio.json() as ErrorBody;
    expect(stdioBody.error.code).toBe("MCP_INVALID_TRANSPORT_CONFIG");

    const invalid = await handler(authed("POST", "/api/assistant/mcp-servers", { label: "Remote", transportType: "http", url: null }));
    expect(invalid.status).toBe(400);
    const invalidBody = await invalid.json() as ErrorBody;
    expect(invalidBody.error.code).toBe("MCP_INVALID_TRANSPORT_CONFIG");

    const id = await createClient("Remote");
    const patchedArgs = await handler(authed("PATCH", `/api/assistant/mcp-servers/${id}`, { args: ["--verbose"] }));
    expect(patchedArgs.status).toBe(400);

    // Nothing was written by the refused calls.
    const list = await handler(authed("GET", "/api/assistant/mcp-servers"));
    const listBody = await list.json() as { data: Array<Record<string, unknown>> };
    expect(listBody.data).toMatchObject([{ id, command: null, args: [] }]);
  });

  it("a managed secret save is refused without the capability, is write-only with it, and clearSecret clears the row", async () => {
    const refused = await handler(authed("POST", "/api/assistant/mcp-servers", {
      label: "Unkeyed",
      transportType: "http",
      url: "https://mcp.test/mcp",
      secret: "bearer_token_with_no_key",
    }));
    expect(refused.status).toBe(400);
    const refusedBody = await refused.json() as ErrorBody;
    expect(refusedBody.error).toMatchObject({ code: "MCP_INVALID_TRANSPORT_CONFIG", message: SECRET_REQUIRES_MASTER_KEY });

    process.env.LXK_SECRETS_MASTER_KEY = Buffer.alloc(32, 9).toString("base64");
    const TOKEN = "planted-http-managed-token-4c8e1b-do-not-leak";
    const res = await handler(authed("POST", "/api/assistant/mcp-servers", {
      label: "Managed HTTP",
      transportType: "http",
      url: "https://mcp.test/managed",
      secret: TOKEN,
    }));
    expect(res.status).toBe(201);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toMatchObject({ id: "managed-http", hasSecret: true, secretSource: "managed" });
    expect(JSON.stringify(body)).not.toContain(TOKEN);
    expect(body).not.toHaveProperty("secret");
    expect(body).not.toHaveProperty("ciphertext");

    const stored = db.prepare("SELECT ciphertext, iv FROM assistant_mcp_secrets WHERE server_id = ?").get("managed-http") as
      | { ciphertext: string; iv: string }
      | null;
    expect(stored).not.toBeNull();
    expect(stored!.ciphertext).not.toContain(TOKEN);
    expect(stored!.iv).not.toContain(TOKEN);
    expect(refOf("managed-http")).toBeNull();

    // A clear is a pure row delete and must work without the master key.
    delete process.env.LXK_SECRETS_MASTER_KEY;
    const cleared = await handler(authed("PATCH", "/api/assistant/mcp-servers/managed-http", { clearSecret: true }));
    expect(cleared.status).toBe(200);
    const clearedBody = await cleared.json() as Record<string, unknown>;
    expect(clearedBody).toMatchObject({ id: "managed-http", hasSecret: false, secretSource: "none" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM assistant_mcp_secrets WHERE server_id = 'managed-http'").get()).toMatchObject({ n: 0 });
  });

  it("test endpoint reports a failed connect as ok:false and 404s an unknown row", async () => {
    const id = await createClient("Broken");
    const res = await failHandler(authed("POST", `/api/assistant/mcp-servers/${id}/test`));
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; toolCount: number; readOnlyToolCount: number; latencyMs: number; error: { code: string } | null };
    // A failed connect is an expected result, not a 5xx.
    expect(body.ok).toBe(false);
    expect(body.toolCount).toBe(0);
    expect(body.readOnlyToolCount).toBe(0);
    expect(typeof body.latencyMs).toBe("number");
    expect(body.error?.code).toBe("MCP_CONNECT_FAILED");

    const ok = await okHandler(authed("POST", `/api/assistant/mcp-servers/${id}/test`));
    const okBody = await ok.json() as { ok: boolean; toolCount: number; readOnlyToolCount: number; error: unknown };
    expect(okBody.ok).toBe(true);
    expect(okBody.toolCount).toBe(3);
    expect(okBody.readOnlyToolCount).toBe(2);
    expect(okBody.error).toBeNull();

    const unknown = await failHandler(authed("POST", "/api/assistant/mcp-servers/ghost/test"));
    expect(unknown.status).toBe(404);
    const unknownBody = await unknown.json() as ErrorBody;
    expect(unknownBody.error.code).toBe("MCP_SERVER_NOT_FOUND");
  });
});

// The Jev registry is the companion extension/secret admin surface: same
// superadmin gate, masked config, write-only secret, and probe mapping.
describe("Jev registry (superadmin)", () => {
  it("GET masks the config, PATCH stores the key write-only, and the probe maps upstream failures to 502", async () => {
    const res = await handler(authed("GET", "/api/assistant/jev"));
    expect(res.status).toBe(200);
    const body = await res.json() as { config: Record<string, unknown>; secretsEnabled: boolean };
    expect(body.secretsEnabled).toBe(false);
    expect(body.config).toMatchObject({ id: "default", baseUrl: "https://api.typesafe.ai", model: "jev-latest", enabled: false, hasKey: false, keyMask: null });
    expect(body.config).not.toHaveProperty("secret");
    expect(body.config).not.toHaveProperty("ciphertext");

    process.env.LXK_SECRETS_MASTER_KEY = Buffer.from("h".repeat(32)).toString("base64");
    const patched = await handler(authed("PATCH", "/api/assistant/jev", {
      baseUrl: "https://jev.internal",
      model: "jev-2026-09",
      enabled: true,
      secret: JEV_KEY,
    }));
    expect(patched.status).toBe(200);
    const patchedBody = await patched.json() as { config: Record<string, unknown>; secretsEnabled: boolean };
    expect(patchedBody.secretsEnabled).toBe(true);
    expect(patchedBody.config).toMatchObject({ baseUrl: "https://jev.internal", model: "jev-2026-09", enabled: true, hasKey: true, keyMask: "jev-…leak" });
    expect(JSON.stringify(patchedBody)).not.toContain(JEV_KEY);
    expect(patchedBody.config).not.toHaveProperty("secret");
    expect(patchedBody.config).not.toHaveProperty("ciphertext");

    const stored = db.prepare("SELECT ciphertext, iv, key_hint FROM assistant_jev_secrets WHERE config_id = 'default'").get() as
      | { ciphertext: string; iv: string; key_hint: string }
      | null;
    expect(stored).not.toBeNull();
    expect(stored!.ciphertext).not.toContain(JEV_KEY);
    expect(stored!.iv).not.toContain(JEV_KEY);
    expect(stored!.key_hint).toBe("leak");

    vi.stubGlobal("fetch", (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch);
    const auth = await handler(authed("POST", "/api/assistant/jev/test"));
    expect(auth.status).toBe(502);
    expect((await auth.json() as ErrorBody).error.code).toBe("JEV_AUTH_FAILED");

    vi.stubGlobal("fetch", (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch);
    const unreachable = await handler(authed("POST", "/api/assistant/jev/test"));
    expect(unreachable.status).toBe(502);
    expect((await unreachable.json() as ErrorBody).error.code).toBe("JEV_UNREACHABLE");
  });
});

// ---- folded from http-assistant-bindings.test.ts ----
// Own tmp DB + fixtures: the bindings overview row shape and the masked-view
// seam behind it (the repo is the only place a stored search key could leak).
let paDir: string;
let paDb: Database;
let paHandler: (req: Request) => Promise<Response>;

const PA_ADMIN_KEY = "lxk_" + "b".repeat(43);
const PA_MEMBER_KEY = "lxk_" + "c".repeat(43);

const paAuthed = (path: string, key = PA_ADMIN_KEY) =>
  new Request(`http://lexa.test${path}`, { headers: { authorization: `Bearer ${key}` } });

function paRepoFor(database: Database) {
  const layer = AssistantSettingsRepo.Default.pipe(
    Layer.provide(Layer.mergeAll(Layer.succeed(Sqlite, database), DbBunLive(database)))
  );
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  return Context.get(ctx, AssistantSettingsRepo);
}

describe("Assistant bindings + maskedView (folded)", () => {
  beforeAll(async () => {
    paDir = mkdtempSync(join(tmpdir(), "lexa-assistant-bindings-http-"));
    const dbPath = join(paDir, "test.db");
    runMigrations(dbPath, MIGRATIONS);
    const adminHash = await sha256(PA_ADMIN_KEY);
    const memberHash = await sha256(PA_MEMBER_KEY);
    paDb = new Database(dbPath);
    paDb.exec(`
      INSERT INTO users (id, email, name, role) VALUES ('u1','a@lexa.test','A','superadmin'), ('u2','m@lexa.test','M','member');
      INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k1','test','${adminHash}','u1'), ('k2','mem','${memberHash}','u2');
      INSERT INTO projects (id, name, slug) VALUES ('p1','Alpha','alpha'), ('p2','Beta','beta'), ('p3','Gamma','gamma');
      INSERT INTO assistant_providers (id, label, base_url, api_key) VALUES ('pr1','Opencode Go','https://x', '');
      INSERT INTO assistant_models (id, provider_id, model_id, kind, priority, enabled) VALUES ('mdl1','pr1','gpt-5.1','openai_compatible',0,1);
      INSERT INTO assistant_settings (project_id, provider_id, primary_model_id, fallback_model_ids, write_tools, search_api_key, reasoning_effort)
        VALUES ('p1','pr1','mdl1','["mdl2","mdl3"]','create_task,update_task','exa-key','high');
      INSERT INTO assistant_settings (project_id) VALUES ('p3');
      INSERT INTO project_memory (id, project_id, content, source) VALUES ('m1','p1','note one','assistant'), ('m2','p1','note two','assistant');
    `);
    paHandler = createAssistantApiHandler(dbPath);
  });

  afterAll(() => { try { paDb.close(); } catch {} rmSync(paDir, { recursive: true, force: true }); });

  it("bindings returns one row per project with labels and counts, including unconfigured", async () => {
    const res = await paHandler(paAuthed("/api/admin/assistant/bindings"));
    expect(res.status).toBe(200);
    const body = await res.json() as { data: Array<Record<string, unknown>> };
    expect(body.data.map((r) => r.projectId)).toEqual(["p1", "p2", "p3"]);

    const configured = body.data[0]!;
    expect(configured.projectName).toBe("Alpha");
    expect(configured.projectSlug).toBe("alpha");
    expect(configured.providerId).toBe("pr1");
    expect(configured.providerLabel).toBe("Opencode Go");
    expect(configured.modelId).toBe("mdl1");
    expect(configured.modelLabel).toBe("gpt-5.1");
    expect(configured.fallbackCount).toBe(2);
    expect(configured.writeToolsCount).toBe(2);
    expect(configured.memoryCount).toBe(2);
    expect(configured.hasSearchKey).toBe(true);
    expect(configured.reasoningEffort).toBe("high");
    expect(configured.updatedAt).not.toBeNull();

    const unconfigured = body.data[1]!;
    expect(unconfigured.providerId).toBeNull();
    expect(unconfigured.providerLabel).toBeNull();
    expect(unconfigured.modelId).toBeNull();
    expect(unconfigured.modelLabel).toBeNull();
    expect(unconfigured.fallbackCount).toBe(0);
    expect(unconfigured.writeToolsCount).toBe(0);
    expect(unconfigured.memoryCount).toBe(0);
    expect(unconfigured.hasSearchKey).toBe(false);
    expect(unconfigured.reasoningEffort).toBeNull();
    expect(unconfigured.updatedAt).toBeNull();

    const empty = body.data[2]!;
    expect(empty.projectId).toBe("p3");
    expect(empty.providerId).toBeNull();
    expect(empty.fallbackCount).toBe(0);
    expect(empty.writeToolsCount).toBe(0);
    expect(empty.hasSearchKey).toBe(false);
    expect(empty.updatedAt).not.toBeNull();
  });

  it("maskedView never exposes keys, reports hasSearchKey, and fails RowNotFound when absent", async () => {
    paDb.prepare("INSERT OR IGNORE INTO projects (id, name, slug) VALUES ('pm','Masked','masked'), ('pm2','NoKey','nokey')").run();
    const repo = paRepoFor(paDb);
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* repo.upsert("pm", { searchProvider: "exa", searchApiKey: "exa-key-9zzz", urlAllowlist: "docs.example.com" });
        const masked = yield* repo.maskedView("pm");
        expect(masked.hasSearchKey).toBe(true);
        expect(masked.searchProvider).toBe("exa");
        expect(JSON.stringify(masked)).not.toContain("exa-key-9zzz");

        yield* repo.upsert("pm2", {});
        const noKey = yield* repo.maskedView("pm2");
        expect(noKey.hasSearchKey).toBe(false);
        expect(noKey.searchProvider).toBeNull();

        const err = yield* repo.maskedView("ghost-project").pipe(Effect.flip);
        expect(err._tag).toBe("RowNotFound");
      })
    );
  });
});

// ADR-0005 D7: the Bun flavor mounts the assistant tier in-process. A bare
// admin key with no user binding must be refused by the handler's identity
// gate (400 NO_USER_CONTEXT, not the framework's 404), proving the group is
// mounted, and assistant responses carry the Workers-parity security headers.
describe("Bun flavor mounts the assistant surface", () => {
  it("a bare unbound key reaches the assistant handler (400 NO_USER_CONTEXT, not 404) and the response carries nosniff/no-store", async () => {
    const res = await handler(authed("GET", "/api/assistant/chat/does-not-exist", undefined, BARE_KEY));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("NO_USER_CONTEXT");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});
