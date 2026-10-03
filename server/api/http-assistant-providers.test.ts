import { describe, it, expect, afterAll, afterEach, beforeAll, vi } from "vitest";
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
  delete process.env.LXK_SECRETS_MASTER_KEY;
  delete process.env.LXK_SECRETS_MASTER_KEY_PREV;
  db.exec("DELETE FROM assistant_provider_secrets");
  db.exec("DELETE FROM assistant_models");
  db.exec("DELETE FROM assistant_providers");
});

const secretRow = (id: string) =>
  db.prepare("SELECT ciphertext, iv, key_id, key_hint FROM assistant_provider_secrets WHERE provider_id = ?").get(id) as
    | { ciphertext: string; iv: string; key_id: string; key_hint: string }
    | null;

async function createProvider(apiKey = ""): Promise<{ id: string; body: Record<string, unknown> }> {
  const res = await handler(authed("POST", "/api/admin/assistant/providers", { label: "P", baseUrl: "https://api.test", apiKey }));
  expect(res.status).toBe(200);
  const body = await res.json() as Record<string, unknown>;
  return { id: body.id as string, body };
}

describe("providers API", () => {
  it("GET reports secretsEnabled and the masked rows carry no key material", async () => {
    process.env.LXK_SECRETS_MASTER_KEY = MASTER_KEY;
    await createProvider(PLAINTEXT_KEY);
    const res = await handler(authed("GET", "/api/admin/assistant/providers"));
    expect(res.status).toBe(200);
    const body = await res.json() as { data: Array<Record<string, unknown>>; secretsEnabled: boolean };
    expect(body.secretsEnabled).toBe(true);
    expect(body.data[0]).toMatchObject({ hasKey: true, keyMask: "sk-…leak" });
    expect(JSON.stringify(body)).not.toContain(PLAINTEXT_KEY);
    expect(body.data[0]).not.toHaveProperty("api_key");
    expect(body.data[0]).not.toHaveProperty("ciphertext");
  });

  it("GET without a master key reports secretsEnabled false", async () => {
    await createProvider("");
    const res = await handler(authed("GET", "/api/admin/assistant/providers"));
    const body = await res.json() as { secretsEnabled: boolean };
    expect(body.secretsEnabled).toBe(false);
  });

  it("PATCH clearKey clears the stored key keylessly", async () => {
    process.env.LXK_SECRETS_MASTER_KEY = MASTER_KEY;
    const { id } = await createProvider(PLAINTEXT_KEY);
    expect(secretRow(id)).not.toBeNull();

    delete process.env.LXK_SECRETS_MASTER_KEY;
    const res = await handler(authed("PATCH", `/api/admin/assistant/providers/${id}`, { clearKey: true }));
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toMatchObject({ hasKey: false, keyMask: null });
    expect(secretRow(id)).toBeNull();
  });

  it("PATCH clearKey + apiKey conflicts with 422 INVALID_ARGS", async () => {
    process.env.LXK_SECRETS_MASTER_KEY = MASTER_KEY;
    const { id } = await createProvider("");
    const res = await handler(authed("PATCH", `/api/admin/assistant/providers/${id}`, { clearKey: true, apiKey: "nope" }));
    expect(res.status).toBe(422);
    const body = await res.json() as { error: { code: string; message: string } };
    expect(body.error).toMatchObject({ code: "INVALID_ARGS", message: PROVIDER_CLEAR_KEY_CONFLICT_REJECTED });
    expect(secretRow(id)).toBeNull();
  });

  it("a key with no master key → 400 SECRET_KEY_UNAVAILABLE naming the variable", async () => {
    const res = await handler(authed("POST", "/api/admin/assistant/providers", { label: "P", baseUrl: "https://x", apiKey: PLAINTEXT_KEY }));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string; message: string } };
    expect(body.error).toMatchObject({ code: "SECRET_KEY_UNAVAILABLE", message: PROVIDER_SECRET_REQUIRES_MASTER_KEY });
    expect(db.prepare("SELECT COUNT(*) AS n FROM assistant_providers").get()).toEqual({ n: 0 });
  });

  it("DELETE removes the provider and its secret child", async () => {
    process.env.LXK_SECRETS_MASTER_KEY = MASTER_KEY;
    const { id } = await createProvider(PLAINTEXT_KEY);
    const res = await handler(authed("DELETE", `/api/admin/assistant/providers/${id}`));
    expect(res.status).toBe(204);
    expect(db.prepare("SELECT COUNT(*) AS n FROM assistant_providers WHERE id = ?").get(id)).toEqual({ n: 0 });
    expect(secretRow(id)).toBeNull();
  });

  it("an undecryptable stored key → 502 PROVIDER_AUTH_FAILED with the fixed message", async () => {
    process.env.LXK_SECRETS_MASTER_KEY = MASTER_KEY;
    const { id } = await createProvider(PLAINTEXT_KEY);
    // Rotate to a key that cannot open the stored ciphertext.
    process.env.LXK_SECRETS_MASTER_KEY = Buffer.from("w".repeat(32)).toString("base64");
    const res = await handler(authed("POST", `/api/admin/assistant/providers/${id}/test`));
    expect(res.status).toBe(502);
    const body = await res.json() as { error: { code: string; message: string } };
    expect(body.error).toMatchObject({ code: "PROVIDER_AUTH_FAILED", message: PROVIDER_KEY_UNDECRYPTABLE });
    expect(JSON.stringify(body)).not.toContain(PLAINTEXT_KEY);
  });

  it("member key → 403", async () => {
    const res = await handler(authed("GET", "/api/admin/assistant/providers", undefined, MEMBER_KEY));
    expect(res.status).toBe(403);
  });
});

describe("provider model sync", () => {
  const catalog = (ids: string[]) =>
    vi.fn(async () => new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

  it("creates the catalog in one batch and kind-corrects existing rows on the next sync", async () => {
    process.env.LXK_SECRETS_MASTER_KEY = MASTER_KEY;
    const { id } = await createProvider(PLAINTEXT_KEY);
    vi.stubGlobal("fetch", catalog(["gpt-4o", "plain-model"]));
    try {
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
      const after = db.prepare("SELECT COUNT(*) AS n FROM assistant_models WHERE provider_id = ?").get(id) as { n: number };
      expect(after.n).toBe(2);
      const corrected = db.prepare("SELECT kind FROM assistant_models WHERE provider_id = ? AND model_id = 'plain-model'").get(id) as { kind: string };
      expect(corrected.kind).toBe("openai_compatible");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a forced failure in the update-or-create batch rolls every write back", async () => {
    process.env.LXK_SECRETS_MASTER_KEY = MASTER_KEY;
    const { id } = await createProvider(PLAINTEXT_KEY);
    db.exec("CREATE TRIGGER fail_model BEFORE INSERT ON assistant_models WHEN NEW.model_id = 'second-model' BEGIN SELECT RAISE(ABORT, 'forced model failure'); END");
    vi.stubGlobal("fetch", catalog(["first-model", "second-model"]));
    try {
      const res = await handler(authed("POST", `/api/admin/assistant/providers/${id}/models`));
      expect(res.status).not.toBe(200);
      const n = (db.prepare("SELECT COUNT(*) AS n FROM assistant_models WHERE provider_id = ?").get(id) as { n: number }).n;
      expect(n).toBe(0);
    } finally {
      vi.unstubAllGlobals();
      db.exec("DROP TRIGGER fail_model");
    }
  });
  it("preserves a manually registered workers_ai row through a catalog sync", async () => {
    process.env.LXK_SECRETS_MASTER_KEY = MASTER_KEY;
    const { id } = await createProvider(PLAINTEXT_KEY);
    // inferModelKind("gpt-4o") is openai_responses — the pre-fix sync would
    // flip this workers_ai row. The catalog carries the same id.
    db.prepare(
      "INSERT INTO assistant_models (id, provider_id, model_id, kind, priority, enabled) VALUES ('wm1', ?, 'gpt-4o', 'workers_ai', 0, 1)"
    ).run(id);
    vi.stubGlobal("fetch", catalog(["gpt-4o"]));
    try {
      const res = await handler(authed("POST", `/api/admin/assistant/providers/${id}/models`));
      expect(res.status).toBe(200);
      const rows = db.prepare("SELECT model_id, kind FROM assistant_models WHERE provider_id = ?").all(id) as Array<{ model_id: string; kind: string }>;
      expect(rows).toEqual([{ model_id: "gpt-4o", kind: "workers_ai" }]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

const jsonBody = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const urlOf = (input: string | URL | Request): string =>
  typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

describe("provider test fallback when the listing route is absent", () => {
  it("GET /models 405 then chat ping 200 → { ok: true }", async () => {
    const { id } = await createProvider();
    const calls: Array<{ url: string; method?: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = urlOf(input);
      calls.push({ url, ...(init?.method !== undefined ? { method: init.method } : {}) });
      if (init?.method === "POST" && url.endsWith("/chat/completions")) return jsonBody(200, { choices: [] });
      return jsonBody(405, { code: 7001, message: "GET not supported for requested URI." });
    }));
    try {
      const res = await handler(authed("POST", `/api/admin/assistant/providers/${id}/test`));
      expect(res.status).toBe(200);
      const body = await res.json() as { ok: boolean; latencyMs: number };
      expect(body.ok).toBe(true);
      expect(typeof body.latencyMs).toBe("number");
      const ping = calls.find((c) => c.method === "POST");
      expect(ping?.url).toContain("/chat/completions");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("GET /models 404 then chat ping 401 → 502 PROVIDER_AUTH_FAILED", async () => {
    const { id } = await createProvider();
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = urlOf(input);
      if (init?.method === "POST" && url.endsWith("/chat/completions")) return jsonBody(401, {});
      return jsonBody(404, {});
    }));
    try {
      const res = await handler(authed("POST", `/api/admin/assistant/providers/${id}/test`));
      expect(res.status).toBe(502);
      const body = await res.json() as { error: { code: string } };
      expect(body.error.code).toBe("PROVIDER_AUTH_FAILED");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("unsaved models: GET /models 405 then chat ping 200 → { models: [] }", async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = urlOf(input);
      calls.push({ url, ...(init?.method !== undefined ? { method: init.method } : {}) });
      if (init?.method === "POST" && url.endsWith("/chat/completions")) return jsonBody(200, { choices: [] });
      return jsonBody(405, { code: 7001, message: "GET not supported for requested URI." });
    }));
    try {
      const res = await handler(authed("POST", "/api/assistant/settings/p1/models", { kind: "openai_compatible", baseUrl: "https://api.test", model: "m1" }));
      expect(res.status).toBe(200);
      const body = await res.json() as { models: Array<{ id: string }> };
      expect(body.models).toEqual([]);
      expect(calls.some((c) => c.method === "POST")).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("unsaved models: GET /models 405 then chat ping 403 → 502 PROVIDER_AUTH_FAILED", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = urlOf(input);
      if (init?.method === "POST" && url.endsWith("/chat/completions")) return jsonBody(403, {});
      return jsonBody(405, {});
    }));
    try {
      const res = await handler(authed("POST", "/api/assistant/settings/p1/models", { kind: "openai_compatible", baseUrl: "https://api.test", model: "m1" }));
      expect(res.status).toBe(502);
      const body = await res.json() as { error: { code: string } };
      expect(body.error.code).toBe("PROVIDER_AUTH_FAILED");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
