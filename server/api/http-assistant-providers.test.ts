import { describe, it, expect, afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { createAssistantApiHandler } from "./assistant-api";
import { PROVIDER_CLEAR_KEY_CONFLICT_REJECTED, PROVIDER_KEY_UNDECRYPTABLE, PROVIDER_SECRET_REQUIRES_MASTER_KEY } from "../services/assistant-providers.service";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));
const ADMIN_KEY = "lxk_" + "p".repeat(43);
const MEMBER_KEY = "lxk_" + "m".repeat(43);
const MASTER_KEY = Buffer.from("v".repeat(32)).toString("base64");
const PLAINTEXT_KEY = "sk-provider-4c8e1b-do-not-leak";

async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

let dir: string;
let handler: (req: Request) => Promise<Response>;
let db: Database;

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
  dir = mkdtempSync(join(tmpdir(), "lexa-assistant-providers-http-"));
  const dbPath = join(dir, "test.db");
  runMigrations(dbPath, MIGRATIONS);
  const hashes = { admin: await sha256(ADMIN_KEY), member: await sha256(MEMBER_KEY) };
  db = new Database(dbPath);
  db.exec(`
    INSERT INTO users (id, email, name, role) VALUES
      ('u1','a@lexa.test','A','superadmin'),
      ('u2','m@lexa.test','M','member');
    INSERT INTO api_keys (id, name, key_hash, user_id) VALUES
      ('k1','test','${hashes.admin}','u1'),
      ('k2','mem','${hashes.member}','u2');
  `);
  handler = createAssistantApiHandler(dbPath);
});

afterAll(() => { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.LXK_SECRETS_MASTER_KEY;
  delete process.env.LXK_SECRETS_MASTER_KEY_PREV;
  db.exec("DELETE FROM assistant_provider_health");
  db.exec("DELETE FROM assistant_provider_secrets");
  db.exec("DELETE FROM assistant_models");
  db.exec("DELETE FROM assistant_model_prices");
  db.exec("DELETE FROM assistant_providers");
});

const secretRow = (id: string) =>
  db.prepare("SELECT ciphertext, iv, key_id, key_hint FROM assistant_provider_secrets WHERE provider_id = ?").get(id) as
    | { ciphertext: string; iv: string; key_id: string; key_hint: string }
    | null;

async function createProvider(apiKey = "", label = "P"): Promise<{ id: string; body: Record<string, unknown> }> {
  const res = await handler(authed("POST", "/api/admin/assistant/providers", { label, baseUrl: "https://api.test", apiKey }));
  expect(res.status).toBe(200);
  const body = await res.json() as Record<string, unknown>;
  return { id: body.id as string, body };
}

const jsonBody = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const urlOf = (input: string | URL | Request): string =>
  typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

type ErrorBody = { error: { code: string; message: string } };

describe("providers API", () => {
  it("GET masks stored keys and reports the capability, a keyed save without the master key is refused, and PATCH clearKey/conflict + DELETE remove the secret", async () => {
    // No master key: the capability reads false and a keyed save is refused.
    delete process.env.LXK_SECRETS_MASTER_KEY;
    delete process.env.LXK_SECRETS_MASTER_KEY_PREV;
    await createProvider("", "Uncap");
    const uncap = await handler(authed("GET", "/api/admin/assistant/providers"));
    const uncapBody = await uncap.json() as { secretsEnabled: boolean };
    expect(uncapBody.secretsEnabled).toBe(false);

    const keyed = await handler(authed("POST", "/api/admin/assistant/providers", { label: "Keyed", baseUrl: "https://x", apiKey: PLAINTEXT_KEY }));
    expect(keyed.status).toBe(400);
    const keyedBody = await keyed.json() as ErrorBody;
    expect(keyedBody.error).toMatchObject({ code: "SECRET_KEY_UNAVAILABLE", message: PROVIDER_SECRET_REQUIRES_MASTER_KEY });

    process.env.LXK_SECRETS_MASTER_KEY = MASTER_KEY;
    db.exec("DELETE FROM assistant_providers");
    const { id } = await createProvider(PLAINTEXT_KEY, "Masked");
    const res = await handler(authed("GET", "/api/admin/assistant/providers"));
    expect(res.status).toBe(200);
    const body = await res.json() as { data: Array<Record<string, unknown>>; secretsEnabled: boolean };
    expect(body.secretsEnabled).toBe(true);
    expect(body.data[0]).toMatchObject({ hasKey: true, keyMask: "sk-…leak" });
    expect(JSON.stringify(body)).not.toContain(PLAINTEXT_KEY);
    expect(body.data[0]).not.toHaveProperty("api_key");
    expect(body.data[0]).not.toHaveProperty("ciphertext");

    // A clear is a pure row delete and must work without the master key.
    expect(secretRow(id)).not.toBeNull();
    delete process.env.LXK_SECRETS_MASTER_KEY;
    const cleared = await handler(authed("PATCH", `/api/admin/assistant/providers/${id}`, { clearKey: true }));
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toMatchObject({ hasKey: false, keyMask: null });
    expect(secretRow(id)).toBeNull();

    process.env.LXK_SECRETS_MASTER_KEY = MASTER_KEY;
    const { id: conflictId } = await createProvider("", "Conflict");
    const conflict = await handler(authed("PATCH", `/api/admin/assistant/providers/${conflictId}`, { clearKey: true, apiKey: "nope" }));
    expect(conflict.status).toBe(422);
    const conflictBody = await conflict.json() as ErrorBody;
    expect(conflictBody.error).toMatchObject({ code: "INVALID_ARGS", message: PROVIDER_CLEAR_KEY_CONFLICT_REJECTED });
    expect(secretRow(conflictId)).toBeNull();

    const { id: deleteId } = await createProvider(PLAINTEXT_KEY, "Deletable");
    const removed = await handler(authed("DELETE", `/api/admin/assistant/providers/${deleteId}`));
    expect(removed.status).toBe(204);
    expect(db.prepare("SELECT COUNT(*) AS n FROM assistant_providers WHERE id = ?").get(deleteId)).toEqual({ n: 0 });
    expect(secretRow(deleteId)).toBeNull();
  });
});

const catalog = (ids: string[]) =>
  vi.fn(async () => new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));

describe("provider model sync", () => {
  it("syncs kind-correct in one atomic batch, persists CF per-M prices, preserves workers_ai, and skips Google-wire ids", async () => {
    process.env.LXK_SECRETS_MASTER_KEY = MASTER_KEY;
    const { id } = await createProvider(PLAINTEXT_KEY, "Sync");
    vi.stubGlobal("fetch", catalog(["gpt-4o", "plain-model"]));
    const res = await handler(authed("POST", `/api/admin/assistant/providers/${id}/models`));
    expect(res.status).toBe(200);
    const rows = db.prepare("SELECT model_id, kind, priority, enabled FROM assistant_models WHERE provider_id = ? ORDER BY priority").all(id) as Array<{ model_id: string; kind: string; priority: number; enabled: number }>;
    expect(rows.map((r) => r.model_id)).toEqual(["gpt-4o", "plain-model"]);
    expect(rows.map((r) => r.kind)).toEqual(["openai_responses", "openai_compatible"]);
    expect(rows.every((r) => r.enabled === 0)).toBe(true);

    db.prepare("UPDATE assistant_models SET kind = 'openai_responses' WHERE provider_id = ? AND model_id = 'plain-model'").run(id);
    vi.stubGlobal("fetch", catalog(["gpt-4o", "plain-model"]));
    const again = await handler(authed("POST", `/api/admin/assistant/providers/${id}/models`));
    expect(again.status).toBe(200);
    expect(db.prepare("SELECT COUNT(*) AS n FROM assistant_models WHERE provider_id = ?").get(id)).toEqual({ n: 2 });
    expect(db.prepare("SELECT kind FROM assistant_models WHERE provider_id = ? AND model_id = 'plain-model'").get(id)).toEqual({ kind: "openai_compatible" });

    // A forced failure in the update-or-create batch rolls every write back.
    const before = db.prepare("SELECT COUNT(*) AS n FROM assistant_models WHERE provider_id = ?").get(id) as { n: number };
    db.exec("CREATE TRIGGER fail_model BEFORE INSERT ON assistant_models WHEN NEW.model_id = 'second-model' BEGIN SELECT RAISE(ABORT, 'forced model failure'); END");
    vi.stubGlobal("fetch", catalog(["first-model", "second-model"]));
    try {
      const failed = await handler(authed("POST", `/api/admin/assistant/providers/${id}/models`));
      expect(failed.status).not.toBe(200);
      const after = db.prepare("SELECT COUNT(*) AS n FROM assistant_models WHERE provider_id = ?").get(id) as { n: number };
      expect(after.n).toBe(before.n);
    } finally {
      db.exec("DROP TRIGGER fail_model");
    }

    // CF per-M prices land in assistant_model_prices.
    const create = await handler(authed("POST", "/api/admin/assistant/providers", {
      label: "CF",
      baseUrl: "https://api.cloudflare.com/client/v4/accounts/acc123/ai/v1",
      apiKey: PLAINTEXT_KEY,
    }));
    expect(create.status).toBe(200);
    const createBody = await create.json() as { id: string };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            result: [
              {
                name: "@cf/meta/llama-3.2-1b-instruct",
                properties: [
                  {
                    property_id: "price",
                    value: [
                      { unit: "per M input tokens", price: 0.027, currency: "USD" },
                      { unit: "per M output tokens", price: 0.201, currency: "USD" },
                    ],
                  },
                ],
              },
            ],
            result_info: { per_page: 50, total_count: 1 },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
    );
    const cfSync = await handler(authed("POST", `/api/admin/assistant/providers/${createBody.id}/models`));
    expect(cfSync.status).toBe(200);
    expect(
      db
        .prepare("SELECT prompt_price, completion_price, cached_read_price, cached_write_price FROM assistant_model_prices WHERE model = ?")
        .get("@cf/meta/llama-3.2-1b-instruct")
    ).toEqual({ prompt_price: 0.027, completion_price: 0.201, cached_read_price: 0, cached_write_price: 0 });

    // A manual workers_ai row is preserved (inferModelKind("gpt-4o") is
    // openai_responses, so a workers_ai row must not flip); Google-wire gemini
    // ids are skipped on an OpenCode Zen base.
    const { id: manualId } = await createProvider(PLAINTEXT_KEY, "Manual");
    db.prepare(
      "INSERT INTO assistant_models (id, provider_id, model_id, kind, priority, enabled) VALUES ('wm1', ?, 'gpt-4o', 'workers_ai', 0, 1)"
    ).run(manualId);
    vi.stubGlobal("fetch", catalog(["gpt-4o"]));
    const preserved = await handler(authed("POST", `/api/admin/assistant/providers/${manualId}/models`));
    expect(preserved.status).toBe(200);
    expect(db.prepare("SELECT model_id, kind FROM assistant_models WHERE provider_id = ?").all(manualId)).toEqual([{ model_id: "gpt-4o", kind: "workers_ai" }]);

    const zen = await handler(authed("POST", "/api/admin/assistant/providers", { label: "Zen", baseUrl: "https://opencode.ai/zen/v1", apiKey: PLAINTEXT_KEY }));
    expect(zen.status).toBe(200);
    const zenBody = await zen.json() as { id: string };
    vi.stubGlobal("fetch", catalog(["claude-sonnet-4", "gpt-5", "qwen3.7-max", "gemini-2.5-pro"]));
    const skipped = await handler(authed("POST", `/api/admin/assistant/providers/${zenBody.id}/models`));
    expect(skipped.status).toBe(200);
    const skippedBody = await skipped.json() as { data: Array<{ modelId: string; kind: string }>; skipped: Array<{ id: string; reason: string }> };
    expect(skippedBody.data.map((r) => r.modelId)).toEqual(["claude-sonnet-4", "gpt-5", "qwen3.7-max"]);
    expect(skippedBody.skipped).toEqual([{ id: "gemini-2.5-pro", reason: "google wire" }]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM assistant_models WHERE provider_id = ? AND model_id = 'gemini-2.5-pro'").get(zenBody.id)).toEqual({ n: 0 });
  });
});

describe("provider test fallback when the listing route is absent", () => {
  it("maps a 405 listing to a chat ping, an undecryptable key to PROVIDER_AUTH_FAILED, and upstream failures to PROVIDER_UNREACHABLE", async () => {
    const { id } = await createProvider("", "Ping");
    const calls: Array<{ url: string; method?: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = urlOf(input);
      calls.push({ url, ...(init?.method !== undefined ? { method: init.method } : {}) });
      if (init?.method === "POST" && url.endsWith("/chat/completions")) return jsonBody(200, { choices: [] });
      return jsonBody(405, { code: 7001, message: "GET not supported for requested URI." });
    }));
    const ok = await handler(authed("POST", `/api/admin/assistant/providers/${id}/test`));
    expect(ok.status).toBe(200);
    const okBody = await ok.json() as { ok: boolean; latencyMs: number };
    expect(okBody.ok).toBe(true);
    expect(typeof okBody.latencyMs).toBe("number");
    expect(calls.find((c) => c.method === "POST")?.url).toContain("/chat/completions");

    // 500 / network failure / anthropic-wire 404 → PROVIDER_UNREACHABLE with no chat ping.
    const calls2: Array<{ url: string; method?: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls2.push({ url: urlOf(input), ...(init?.method !== undefined ? { method: init.method } : {}) });
      return jsonBody(500, {});
    }));
    const res = await handler(authed("POST", `/api/admin/assistant/providers/${id}/test`));
    expect(res.status).toBe(502);
    expect((await res.json() as ErrorBody).error.code).toBe("PROVIDER_UNREACHABLE");
    expect(calls2.some((c) => c.method === "POST")).toBe(false);

    const netCalls: Array<{ url: string; method?: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      netCalls.push({ url: urlOf(input), ...(init?.method !== undefined ? { method: init.method } : {}) });
      throw new Error("fetch failed");
    }));
    const net = await handler(authed("POST", `/api/admin/assistant/providers/${id}/test`));
    expect(net.status).toBe(502);
    expect((await net.json() as ErrorBody).error.code).toBe("PROVIDER_UNREACHABLE");
    expect(netCalls.some((c) => c.method === "POST")).toBe(false);

    db.prepare("INSERT INTO assistant_models (id, provider_id, model_id, kind, priority, enabled) VALUES (?,?,?,?,?,?)").run("am-anthropic", id, "claude-x", "anthropic_compatible", 0, 1);
    const anthropicCalls: Array<{ url: string; method?: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      anthropicCalls.push({ url: urlOf(input), ...(init?.method !== undefined ? { method: init.method } : {}) });
      return jsonBody(404, {});
    }));
    const anthropic = await handler(authed("POST", `/api/admin/assistant/providers/${id}/test`));
    expect(anthropic.status).toBe(502);
    expect((await anthropic.json() as ErrorBody).error.code).toBe("PROVIDER_UNREACHABLE");
    expect(anthropicCalls.some((c) => c.method === "POST")).toBe(false);
    expect(anthropicCalls[0]?.url).toBe("https://api.test/v1/models");

    // An undecryptable stored key → PROVIDER_AUTH_FAILED and never the plaintext.
    process.env.LXK_SECRETS_MASTER_KEY = MASTER_KEY;
    const { id: rotatedId } = await createProvider(PLAINTEXT_KEY, "Rotated");
    // Rotate to a key that cannot open the stored ciphertext.
    process.env.LXK_SECRETS_MASTER_KEY = Buffer.from("w".repeat(32)).toString("base64");
    const undecryptable = await handler(authed("POST", `/api/admin/assistant/providers/${rotatedId}/test`));
    expect(undecryptable.status).toBe(502);
    const undecryptableBody = await undecryptable.json() as ErrorBody;
    expect(undecryptableBody.error).toMatchObject({ code: "PROVIDER_AUTH_FAILED", message: PROVIDER_KEY_UNDECRYPTABLE });
    expect(JSON.stringify(undecryptableBody)).not.toContain(PLAINTEXT_KEY);
  });
});

describe("provider health and probe", () => {
  it("health reports closed then open with a retry countdown, a probe closes the breaker, and price sync reports its count", async () => {
    const { id } = await createProvider("", "Health");
    const closed = await handler(authed("GET", `/api/admin/assistant/providers/${id}/health`));
    expect(closed.status).toBe(200);
    const body = await closed.json() as {
      providerId: string; circuitState: string; failureCount: number; consecutiveFailures: number;
      openedAt: string | null; latencyMs: number | null; retryAfterSeconds: number | null;
      lastFailureCode: string | null; lastCheckedAt: string | null;
    };
    expect(body.providerId).toBe(id);
    expect(body.circuitState).toBe("closed");
    expect(body.failureCount).toBe(0);
    expect(body.consecutiveFailures).toBe(0);
    expect(body.openedAt).toBeNull();
    expect(body.latencyMs).toBeNull();
    expect(body.retryAfterSeconds).toBeNull();
    expect(body.lastFailureCode).toBeNull();
    expect(body.lastCheckedAt).toBeNull();

    db.prepare("INSERT INTO assistant_provider_health (provider_id, failure_count, circuit_state, opened_at, consecutive_failures) VALUES (?,3,'open',?,3)").run(id, new Date().toISOString());
    const open = await handler(authed("GET", `/api/admin/assistant/providers/${id}/health`));
    const openBody = await open.json() as { circuitState: string; failureCount: number; retryAfterSeconds: number };
    expect(openBody.circuitState).toBe("open");
    expect(openBody.failureCount).toBe(3);
    expect(openBody.retryAfterSeconds).toBeGreaterThan(0);
    expect(openBody.retryAfterSeconds).toBeLessThanOrEqual(300);

    // A probe success closes the breaker; unreachable/auth record a failure;
    // an open breaker stays open with bumped counts.
    const okModels = { status: 200, ok: true, json: async () => ({ data: [{ id: "m1" }] }) };
    db.prepare("DELETE FROM assistant_provider_health WHERE provider_id = ?").run(id);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okModels));
    const ok = await handler(authed("POST", `/api/admin/assistant/providers/${id}/probe`));
    expect(ok.status).toBe(200);
    const okBody = await ok.json() as { providerId: string; circuitState: string; failureCount: number };
    expect(okBody.providerId).toBe(id);
    expect(okBody.circuitState).toBe("closed");
    expect(okBody.failureCount).toBe(0);

    db.prepare("DELETE FROM assistant_provider_health WHERE provider_id = ?").run(id);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    const unreachable = await handler(authed("POST", `/api/admin/assistant/providers/${id}/probe`));
    const unreachableBody = await unreachable.json() as { circuitState: string; failureCount: number; consecutiveFailures: number };
    expect(unreachableBody.circuitState).toBe("closed");
    expect(unreachableBody.failureCount).toBe(1);
    expect(unreachableBody.consecutiveFailures).toBe(1);

    db.prepare("DELETE FROM assistant_provider_health WHERE provider_id = ?").run(id);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 401, ok: false, json: async () => ({}) }));
    const auth = await handler(authed("POST", `/api/admin/assistant/providers/${id}/probe`));
    const authBody = await auth.json() as { failureCount: number };
    expect(authBody.failureCount).toBe(1);

    db.prepare("UPDATE assistant_provider_health SET failure_count = 3, circuit_state = 'open', opened_at = ?, consecutive_failures = 3 WHERE provider_id = ?").run(new Date().toISOString(), id);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    const stillOpen = await handler(authed("POST", `/api/admin/assistant/providers/${id}/probe`));
    const stillOpenBody = await stillOpen.json() as { circuitState: string; failureCount: number };
    expect(stillOpenBody.circuitState).toBe("open");
    expect(stillOpenBody.failureCount).toBe(4);

    const unknown = await handler(authed("POST", "/api/admin/assistant/providers/nope/probe"));
    expect(unknown.status).toBe(404);

    // Price sync returns the synced count plus rows, and 0 with no rows when upstream fails.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: "anthropic/claude-sonnet-4", pricing: { prompt: "0.000003", completion: "0.000015" } }] }),
    }));
    const synced = await handler(authed("POST", "/api/admin/assistant/prices/sync"));
    expect(synced.status).toBe(200);
    const syncedBody = await synced.json() as { synced: number; data: Array<Record<string, unknown>> };
    expect(syncedBody.synced).toBe(1);
    expect(syncedBody.data[0]).toMatchObject({ model: "anthropic/claude-sonnet-4", prompt_price: 3, completion_price: 15 });

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    db.prepare("DELETE FROM assistant_model_prices").run();
    const failed = await handler(authed("POST", "/api/admin/assistant/prices/sync"));
    expect(failed.status).toBe(200);
    const failedBody = await failed.json() as { synced: number; data: unknown[] };
    expect(failedBody.synced).toBe(0);
    expect(failedBody.data).toEqual([]);
  });
});

// ---- folded from http-assistant-runs.test.ts ----
// Own tmp DB + fixtures; the admin runs/usage and project schedules surfaces.
let rDir: string;
let rDb: Database;
let rHandler: (req: Request) => Promise<Response>;

const R_ADMIN_KEY = "lxk_" + "r".repeat(43);
const R_MEMBER_KEY = "lxk_" + "s".repeat(43);

const rAuthed = (path: string, key = R_ADMIN_KEY) =>
  new Request(`http://lexa.test${path}`, { headers: { authorization: `Bearer ${key}` } });

const rPost = (path: string, key = R_ADMIN_KEY) =>
  new Request(`http://lexa.test${path}`, { method: "POST", headers: { authorization: `Bearer ${key}` } });

const rJson = (path: string, method: string, body: unknown, key = R_ADMIN_KEY) =>
  new Request(`http://lexa.test${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

function rInsertTask(id: string, status: string, projectId: string, createdAt: string) {
  rDb.prepare(
    "INSERT INTO assistant_tasks (id, project_id, document_type, document_id, agent_id, skill_id, status, error, created_at) VALUES (?, ?, 'task', 't1', 'a1', 'sk1', ?, ?, ?)"
  ).run(id, projectId, status, status === "failed" ? "boom" : null, createdAt);
}

function rInsertRun(id: string, kind: string, status: string, projectId: string, createdAt: string, threadKey = "chat:c1") {
  rDb.prepare(
    "INSERT INTO assistant_runs (id, project_id, thread_key, kind, status, goal, created_at) VALUES (?, ?, ?, ?, ?, 'g', ?)"
  ).run(id, projectId, threadKey, kind, status, createdAt);
}

describe("assistant runs (folded)", () => {
  beforeAll(async () => {
    rDir = mkdtempSync(join(tmpdir(), "lexa-assistant-runs-http-"));
    const dbPath = join(rDir, "test.db");
    runMigrations(dbPath, MIGRATIONS);
    const adminHash = await sha256(R_ADMIN_KEY);
    const memberHash = await sha256(R_MEMBER_KEY);
    rDb = new Database(dbPath);
    rDb.exec(`
      INSERT INTO users (id, email, name, role) VALUES ('u1','a@lexa.test','A','superadmin'), ('u2','m@lexa.test','M','member');
      INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k1','test','${adminHash}','u1'), ('k2','mem','${memberHash}','u2');
      INSERT INTO projects (id, name, slug) VALUES ('p1','Alpha','alpha'), ('p2','Beta','beta');
      INSERT INTO user_project_roles (user_id, role, project_id) VALUES ('u2','member','p1');
      INSERT INTO lexa_agents (id, name, description, instructions, is_builtin) VALUES ('a1','A','','',0);
      INSERT INTO lexa_skills (id, name, description, instructions, is_builtin) VALUES ('sk1','S','','',0);
    `);
    rHandler = createAssistantApiHandler(dbPath);
  });

  afterAll(() => { try { rDb.close(); } catch {} rmSync(rDir, { recursive: true, force: true }); });

  beforeEach(() => {
    rDb.prepare("DELETE FROM assistant_tasks").run();
    rDb.prepare("DELETE FROM assistant_runs").run();
    rDb.prepare("DELETE FROM assistant_schedules").run();
    rDb.prepare("DELETE FROM assistant_call_logs").run();
  });

  it("unions document and registry runs, counts both, leaks no result/extraPrompt/selection, and caps + paginates with a keyset cursor", async () => {
    rInsertTask("r1", "completed", "p1", "2026-01-01 10:00:00");
    rInsertTask("r2", "failed", "p1", "2026-01-02 10:00:00");
    rDb.prepare(
      "INSERT INTO assistant_tasks (id, project_id, document_type, document_id, agent_id, skill_id, status, created_at) VALUES ('auto1', 'p1', 'task', 't1', 'a1', NULL, 'queued', '2026-01-01 09:00:00')"
    ).run();
    rInsertRun("c1", "chat_run", "running", "p1", "2026-01-03 10:00:00", "chat:c9");
    rInsertRun("s1", "schedule", "queued", "p1", "2026-01-04 10:00:00");

    const res = await rHandler(rAuthed("/api/admin/assistant/runs"));
    expect(res.status).toBe(200);
    const body = await res.json() as { data: Array<Record<string, unknown>>; nextCursor: string | null; counts: Record<string, number> };
    expect(body.nextCursor).toBeNull();
    // counts span both tables (union GROUP BY).
    expect(body.counts).toEqual({ queued: 2, running: 1, completed: 1, failed: 1, cancelled: 0 });

    const document = body.data.find((r) => r.id === "r2")!;
    expect(document.error).toBe("boom");
    expect(document.kind).toBe("document");
    expect(document.threadKey).toBe("task:t1");
    expect("result" in document).toBe(false);
    expect("extraPrompt" in document).toBe(false);
    expect("selection" in document).toBe(false);

    const auto = body.data.find((r) => r.id === "auto1")!;
    expect(auto.skillId).toBeNull();
    expect(auto.agentId).toBe("a1");

    const chatRun = body.data.find((r) => r.id === "c1")!;
    expect(chatRun.kind).toBe("chat_run");
    expect(chatRun.documentType).toBeNull();
    expect(chatRun.documentId).toBe("");
    expect(chatRun.threadKey).toBe("chat:c9");
    expect(chatRun.key).toBe("c1");

    const schedule = body.data.find((r) => r.id === "s1")!;
    expect(schedule.kind).toBe("schedule");

    // limit caps at 200 with a keyset cursor.
    rDb.prepare("DELETE FROM assistant_tasks").run();
    rDb.prepare("DELETE FROM assistant_runs").run();
    const stmt = rDb.prepare(
      "INSERT INTO assistant_tasks (id, project_id, document_type, document_id, agent_id, skill_id, status, created_at) VALUES (?, 'p1', 'task', 't1', 'a1', 'sk1', 'queued', ?)"
    );
    for (let i = 0; i < 205; i++) {
      const mm = String(Math.floor(i / 60)).padStart(2, "0");
      const ss = String(i % 60).padStart(2, "0");
      stmt.run(`c${String(i).padStart(3, "0")}`, `2026-01-01 00:${mm}:${ss}`);
    }
    const capped = await rHandler(rAuthed("/api/admin/assistant/runs?limit=999"));
    const cappedBody = await capped.json() as { data: unknown[]; nextCursor: string | null };
    expect(cappedBody.data.length).toBe(200);
    expect(cappedBody.nextCursor).not.toBeNull();
    rDb.prepare("DELETE FROM assistant_tasks").run();

    rInsertTask("r1", "queued", "p1", "2026-01-01 10:00:00");
    rInsertTask("r2", "queued", "p1", "2026-01-02 10:00:00");
    rInsertTask("r3", "queued", "p1", "2026-01-03 10:00:00");
    const first = await rHandler(rAuthed("/api/admin/assistant/runs?limit=2"));
    const firstBody = await first.json() as { data: Array<{ id: string }>; nextCursor: string | null };
    expect(firstBody.data.map((r) => r.id)).toEqual(["r3", "r2"]);
    expect(firstBody.nextCursor).not.toBeNull();
    const second = await rHandler(rAuthed(`/api/admin/assistant/runs?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor!)}`));
    const secondBody = await second.json() as { data: Array<{ id: string }>; nextCursor: string | null };
    expect(secondBody.data.map((r) => r.id)).toEqual(["r1"]);
    expect(secondBody.nextCursor).toBeNull();
  });

  it("filters by status, kind, and project, and rejects unknown values", async () => {
    rInsertTask("r1", "completed", "p1", "2026-01-01 10:00:00");
    rInsertTask("r2", "failed", "p1", "2026-01-02 10:00:00");
    rInsertTask("r3", "failed", "p2", "2026-01-03 10:00:00");
    rInsertRun("c1", "chat_run", "completed", "p1", "2026-01-04 10:00:00");
    rInsertRun("s1", "schedule", "completed", "p1", "2026-01-05 10:00:00");

    const byStatus = await rHandler(rAuthed("/api/admin/assistant/runs?status=failed"));
    expect((await byStatus.json() as { data: Array<{ id: string }> }).data.map((r) => r.id)).toEqual(["r3", "r2"]);

    const byKind = await rHandler(rAuthed("/api/admin/assistant/runs?kind=schedule"));
    expect((await byKind.json() as { data: Array<{ id: string }> }).data.map((r) => r.id)).toEqual(["s1"]);

    const byProject = await rHandler(rAuthed("/api/admin/assistant/runs?projectId=p2"));
    expect((await byProject.json() as { data: Array<{ id: string }> }).data.map((r) => r.id)).toEqual(["r3"]);

    expect((await rHandler(rAuthed("/api/admin/assistant/runs?status=bogus"))).status).toBe(422);
    expect((await rHandler(rAuthed("/api/admin/assistant/runs?kind=bogus"))).status).toBe(422);
  });

  it("serves the persisted run columns with 404 for foreign/unknown, and aborts ack/no-op/404", async () => {
    rInsertRun("r1", "chat_run", "running", "p1", "2026-01-02 10:00:00", "chat:c9");
    const res = await rHandler(rAuthed("/api/assistant/runs/r1"));
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      id: "r1",
      projectId: "p1",
      threadKey: "chat:c9",
      parentRunId: null,
      kind: "chat_run",
      status: "running",
      goal: "g",
      stepsUsed: 0,
      startedAt: null,
      finishedAt: null,
    });
    // The live event log is session-memory only — never part of the REST row.
    expect("events" in body).toBe(false);

    const member = await rHandler(rAuthed("/api/assistant/runs/r1", R_MEMBER_KEY));
    expect(member.status).toBe(200);

    rInsertRun("r2", "chat_run", "running", "p2", "2026-01-02 10:00:00");
    const foreign = await rHandler(rAuthed("/api/assistant/runs/r2", R_MEMBER_KEY));
    expect(foreign.status).toBe(404);
    expect((await foreign.json()).error.code).toBe("ASSISTANT_RUN_NOT_FOUND");

    const missing = await rHandler(rAuthed("/api/assistant/runs/nope"));
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe("ASSISTANT_RUN_NOT_FOUND");

    // Abort acks on the no-DO flavor, is a no-op on terminal, and 404s foreign/unknown.
    const ack = await rHandler(rPost("/api/assistant/runs/r1/abort"));
    expect(ack.status).toBe(200);
    expect(await ack.json()).toEqual({ ok: true });
    expect(rDb.prepare("SELECT status FROM assistant_runs WHERE id = 'r1'").get()).toMatchObject({ status: "running" });

    const memberAbort = await rHandler(rPost("/api/assistant/runs/r1/abort", R_MEMBER_KEY));
    expect(memberAbort.status).toBe(200);
    expect(await memberAbort.json()).toEqual({ ok: true });

    rInsertRun("r3", "chat_run", "completed", "p1", "2026-01-02 10:00:00");
    const terminal = await rHandler(rPost("/api/assistant/runs/r3/abort"));
    expect(terminal.status).toBe(200);
    expect(await terminal.json()).toEqual({ ok: true });
    expect(rDb.prepare("SELECT status FROM assistant_runs WHERE id = 'r3'").get()).toMatchObject({ status: "completed" });

    const foreignAbort = await rHandler(rPost("/api/assistant/runs/r2/abort", R_MEMBER_KEY));
    expect(foreignAbort.status).toBe(404);
    expect((await foreignAbort.json()).error.code).toBe("ASSISTANT_RUN_NOT_FOUND");

    const missingAbort = await rHandler(rPost("/api/assistant/runs/nope/abort"));
    expect(missingAbort.status).toBe(404);
    expect((await missingAbort.json()).error.code).toBe("ASSISTANT_RUN_NOT_FOUND");
  });

  it("schedules CRUD with admin gate/422/404, and usage p50/p95 with an inclusive from/to", async () => {
    const created = await rHandler(rJson("/api/assistant/schedules/p1", "POST", { title: "Nightly", prompt: "summarize", cron: "0 9 * * *" }));
    expect(created.status).toBe(201);
    const row = await created.json() as Record<string, unknown>;
    expect(row).toMatchObject({
      projectId: "p1",
      title: "Nightly",
      prompt: "summarize",
      cron: "0 9 * * *",
      intervalSeconds: null,
      threadKey: null,
      createdBy: "u1",
      enabled: true,
      lastRunAt: null,
      lastRunId: null,
    });
    expect(typeof row.id).toBe("string");
    expect(typeof row.nextRunAt).toBe("string");

    const list = await rHandler(rAuthed("/api/assistant/schedules/p1"));
    expect(list.status).toBe(200);
    expect((await list.json() as { data: Array<{ id: string }> }).data.map((r) => r.id)).toEqual([row.id]);

    const get = await rHandler(rAuthed(`/api/assistant/schedules/p1/${row.id as string}`));
    expect(get.status).toBe(200);
    expect((await get.json() as { id: string }).id).toBe(row.id);

    const patched = await rHandler(rJson(`/api/assistant/schedules/p1/${row.id as string}`, "PATCH", { title: "Renamed", enabled: false }));
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({ title: "Renamed", enabled: false });

    const del = await rHandler(new Request(`http://lexa.test/api/assistant/schedules/p1/${row.id as string}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${R_ADMIN_KEY}` },
    }));
    expect(del.status).toBe(204);
    expect((await rHandler(rAuthed(`/api/assistant/schedules/p1/${row.id as string}`))).status).toBe(404);

    // Admin gate + 422 (no timing) + 404 (unknown/cross-project).
    const memberWrite = await rHandler(rJson("/api/assistant/schedules/p1", "POST", { title: "x", prompt: "y", intervalSeconds: 60 }, R_MEMBER_KEY));
    expect(memberWrite.status).toBe(403);
    expect(rDb.prepare("SELECT COUNT(*) AS n FROM assistant_schedules").get()).toMatchObject({ n: 0 });

    const noTiming = await rHandler(rJson("/api/assistant/schedules/p1", "POST", { title: "x", prompt: "y" }));
    expect(noTiming.status).toBe(422);

    const created2 = await rHandler(rJson("/api/assistant/schedules/p1", "POST", { title: "x", prompt: "y", intervalSeconds: 60 }));
    expect(created2.status).toBe(201);
    const created2Body = await created2.json() as { id: string };
    const cleared = await rHandler(rJson(`/api/assistant/schedules/p1/${created2Body.id}`, "PATCH", { cron: null, intervalSeconds: null }));
    expect(cleared.status).toBe(422);

    expect((await rHandler(rAuthed("/api/assistant/schedules/p1/nope"))).status).toBe(404);
    const crossProject = await rHandler(rAuthed(`/api/assistant/schedules/p2/${created2Body.id}`));
    expect(crossProject.status).toBe(404);

    // Usage: nearest-rank p50/p95 over non-null latencies, inclusive from/to.
    rDb.exec(`
      INSERT INTO assistant_call_logs (id, project_id, provider_id, model, kind, status, usage_in, usage_out, cached_in, latency_ms, cost_cents, created_at)
      VALUES
        ('l1','p1',NULL,'anthropic/claude-sonnet-4','openai_compatible','done',100,50,0,1200,100,'2026-08-01 10:00:00'),
        ('l2','p1',NULL,'anthropic/claude-sonnet-4','openai_compatible','done',200,100,0,800,200,'2026-08-02 10:00:00'),
        ('l3','p2',NULL,'openai/gpt-5-mini','openai_compatible','error',10,5,0,500,10,'2026-08-02 11:00:00'),
        ('l4','p1',NULL,'openai/gpt-5-mini','openai_compatible','done',50,25,0,1000,50,'2026-08-03 10:00:00');
    `);
    const usage = await rHandler(rAuthed("/api/admin/assistant/usage"));
    expect(usage.status).toBe(200);
    const usageBody = await usage.json() as {
      summary: { totalCalls: number; totalCostCents: number; errorRate: number; p50LatencyMs: number | null; p95LatencyMs: number | null };
      byDay: Array<{ day: string }>;
    };
    expect(usageBody.summary.totalCalls).toBe(4);
    expect(usageBody.summary.totalCostCents).toBe(360);
    expect(usageBody.summary.errorRate).toBeCloseTo(0.25);
    // Nearest-rank over [500,800,1000,1200]: p50 → rank 2 (800), p95 → rank 4 (1200).
    expect(usageBody.summary.p50LatencyMs).toBe(800);
    expect(usageBody.summary.p95LatencyMs).toBe(1200);
    expect(usageBody.byDay.map((d) => d.day)).toEqual(["2026-08-01", "2026-08-02", "2026-08-03"]);

    const ranged = await rHandler(rAuthed("/api/admin/assistant/usage?from=2026-08-02&to=2026-08-02"));
    expect(ranged.status).toBe(200);
    const rangedBody = await ranged.json() as { summary: { totalCalls: number }; byDay: Array<{ day: string }> };
    expect(rangedBody.summary.totalCalls).toBe(2);
    expect(rangedBody.byDay.map((d) => d.day)).toEqual(["2026-08-02"]);
  });
});
