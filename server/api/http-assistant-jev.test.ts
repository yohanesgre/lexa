import { describe, it, expect, afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { createAssistantApiHandler } from "./assistant-api";
import { JEV_CLEAR_SECRET_CONFLICT_REJECTED, JEV_SECRET_REQUIRES_MASTER_KEY } from "../services/assistant-jev.service";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));
const ADMIN_KEY = "lxk_" + "j".repeat(43);
const MEMBER_KEY = "lxk_" + "k".repeat(43);
const NOGRANT_KEY = "lxk_" + "n".repeat(43);
const PADMIN_KEY = "lxk_" + "p".repeat(43);
const MASTER_KEY = Buffer.from("h".repeat(32)).toString("base64");
const PLAINTEXT_KEY = "jev-plaintext-4c8e1b-do-not-leak";

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
  dir = mkdtempSync(join(tmpdir(), "lexa-assistant-jev-http-"));
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
});

afterAll(() => { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });

beforeEach(() => {
  db.exec("DELETE FROM assistant_jev_secrets");
  db.exec("DELETE FROM assistant_jev_projects");
  db.exec(`UPDATE assistant_jev_config SET base_url = 'https://api.typesafe.ai', model = 'jev-latest', enabled = 0, updated_at = datetime('now') WHERE id = 'default'`);
});

afterEach(() => {
  delete process.env.LXK_SECRETS_MASTER_KEY;
  delete process.env.LXK_SECRETS_MASTER_KEY_PREV;
  vi.unstubAllGlobals();
});

const secretRow = () =>
  db.prepare("SELECT ciphertext, iv, key_id, key_hint FROM assistant_jev_secrets WHERE config_id = 'default'").get() as
    | { ciphertext: string; iv: string; key_id: string; key_hint: string }
    | null;

describe("Jev registry (superadmin)", () => {
  it("member key → 403 on every admin route", async () => {
    for (const [method, path, body] of [
      ["GET", "/api/assistant/jev", undefined],
      ["PATCH", "/api/assistant/jev", { enabled: true }],
      ["POST", "/api/assistant/jev/test", undefined],
    ] as const) {
      const res = await handler(authed(method, path, body, MEMBER_KEY));
      expect(res.status, `${method} ${path}`).toBe(403);
    }
  });

  it("GET returns the seeded masked config and never key material", async () => {
    const res = await handler(authed("GET", "/api/assistant/jev"));
    expect(res.status).toBe(200);
    const body = await res.json() as { config: Record<string, unknown>; secretsEnabled: boolean };
    expect(body.secretsEnabled).toBe(false);
    expect(body.config).toMatchObject({
      id: "default",
      baseUrl: "https://api.typesafe.ai",
      model: "jev-latest",
      enabled: false,
      hasKey: false,
      keyMask: null,
    });
    expect(body.config).not.toHaveProperty("secret");
    expect(body.config).not.toHaveProperty("ciphertext");
  });

  it("PATCH writes config and stores a key write-only, with a server-provided mask", async () => {
    process.env.LXK_SECRETS_MASTER_KEY = MASTER_KEY;
    const res = await handler(authed("PATCH", "/api/assistant/jev", {
      baseUrl: "https://jev.internal",
      model: "jev-2026-09",
      enabled: true,
      secret: PLAINTEXT_KEY,
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as { config: Record<string, unknown>; secretsEnabled: boolean };
    expect(body.secretsEnabled).toBe(true);
    expect(body.config).toMatchObject({
      baseUrl: "https://jev.internal",
      model: "jev-2026-09",
      enabled: true,
      hasKey: true,
      keyMask: "jev-…leak",
    });
    expect(JSON.stringify(body)).not.toContain(PLAINTEXT_KEY);
    expect(body.config).not.toHaveProperty("secret");
    expect(body.config).not.toHaveProperty("ciphertext");

    const stored = secretRow();
    expect(stored).not.toBeNull();
    expect(stored!.ciphertext).not.toContain(PLAINTEXT_KEY);
    expect(stored!.iv).not.toContain(PLAINTEXT_KEY);
    expect(stored!.key_hint).toBe("leak");
  });

  it("PATCH clearSecret clears keylessly and the row is gone", async () => {
    process.env.LXK_SECRETS_MASTER_KEY = MASTER_KEY;
    await handler(authed("PATCH", "/api/assistant/jev", { secret: PLAINTEXT_KEY }));
    expect(secretRow()).not.toBeNull();

    // No master key: a clear is a pure row delete and must still work.
    delete process.env.LXK_SECRETS_MASTER_KEY;
    const cleared = await handler(authed("PATCH", "/api/assistant/jev", { clearSecret: true }));
    expect(cleared.status).toBe(200);
    const body = await cleared.json() as { config: Record<string, unknown> };
    expect(body.config).toMatchObject({ hasKey: false, keyMask: null });
    expect(secretRow()).toBeNull();
  });

  it("refuses clearSecret + secret with JEV_INVALID_CONFIG, and an invalid baseUrl / model", async () => {
    process.env.LXK_SECRETS_MASTER_KEY = MASTER_KEY;
    const conflict = await handler(authed("PATCH", "/api/assistant/jev", { clearSecret: true, secret: "nope" }));
    expect(conflict.status).toBe(400);
    expect((await conflict.json() as { error: { code: string; message: string } }).error).toMatchObject({
      code: "JEV_INVALID_CONFIG",
      message: JEV_CLEAR_SECRET_CONFLICT_REJECTED,
    });

    const badUrl = await handler(authed("PATCH", "/api/assistant/jev", { baseUrl: "ftp://jev.internal" }));
    expect(badUrl.status).toBe(400);
    expect((await badUrl.json() as { error: { code: string } }).error.code).toBe("JEV_INVALID_CONFIG");

    const longModel = await handler(authed("PATCH", "/api/assistant/jev", { model: "x".repeat(121) }));
    expect(longModel.status).toBe(400);
    expect((await longModel.json() as { error: { code: string } }).error.code).toBe("JEV_INVALID_CONFIG");

    // Nothing was written by the refused calls.
    expect(secretRow()).toBeNull();
    const get = await handler(authed("GET", "/api/assistant/jev"));
    expect((await get.json() as { config: { model: string } }).config.model).toBe("jev-latest");
  });

  it("a secret with no master key → 400 SECRET_KEY_UNAVAILABLE naming the variable", async () => {
    const res = await handler(authed("PATCH", "/api/assistant/jev", { secret: PLAINTEXT_KEY }));
    expect(res.status).toBe(400);
    expect((await res.json() as { error: { code: string; message: string } }).error).toMatchObject({
      code: "SECRET_KEY_UNAVAILABLE",
      message: JEV_SECRET_REQUIRES_MASTER_KEY,
    });
    expect(secretRow()).toBeNull();
  });

  it("an oversize secret is refused at decode (400)", async () => {
    process.env.LXK_SECRETS_MASTER_KEY = MASTER_KEY;
    const res = await handler(authed("PATCH", "/api/assistant/jev", { secret: "x".repeat(4097) }));
    expect(res.status).toBe(400);
    expect(secretRow()).toBeNull();
  });
});

describe("Per-project Jev opt-in", () => {
  it("member GET with a grant → 200 disabled default; without a grant → 403; unknown project → 404", async () => {
    const granted = await handler(authed("GET", "/api/projects/p1/assistant/jev", undefined, MEMBER_KEY));
    expect(granted.status).toBe(200);
    expect(await granted.json()).toEqual({ projectId: "p1", enabled: false, available: false, createdAt: null, updatedAt: null });

    const noGrant = await handler(authed("GET", "/api/projects/p1/assistant/jev", undefined, NOGRANT_KEY));
    expect(noGrant.status).toBe(403);

    const unknown = await handler(authed("GET", "/api/projects/ghost/assistant/jev", undefined, ADMIN_KEY));
    expect(unknown.status).toBe(404);
    expect((await unknown.json() as { error: { code: string } }).error.code).toBe("PROJECT_NOT_FOUND");
  });

  it("available reflects global usability for a member with no superadmin read access", async () => {
    const off = await handler(authed("GET", "/api/projects/p1/assistant/jev", undefined, MEMBER_KEY));
    expect((await off.json() as { available: boolean }).available).toBe(false);

    process.env.LXK_SECRETS_MASTER_KEY = MASTER_KEY;
    const stored = await handler(authed("PATCH", "/api/assistant/jev", { enabled: true, secret: PLAINTEXT_KEY }));
    expect(stored.status).toBe(200);

    const on = await handler(authed("GET", "/api/projects/p1/assistant/jev", undefined, MEMBER_KEY));
    const body = await on.json() as { available: boolean; enabled: boolean };
    expect(body.available).toBe(true);
    // Availability ignores this project's own row: still opted out.
    expect(body.enabled).toBe(false);
  });

  it("PUT is project-admin gated; the write is reflected by the member GET", async () => {
    const memberWrite = await handler(authed("PUT", "/api/projects/p1/assistant/jev", { enabled: true }, MEMBER_KEY));
    expect(memberWrite.status).toBe(403);

    const put = await handler(authed("PUT", "/api/projects/p1/assistant/jev", { enabled: true }, PADMIN_KEY));
    expect(put.status).toBe(200);
    const putBody = await put.json() as Record<string, unknown>;
    expect(putBody).toMatchObject({ projectId: "p1", enabled: true });
    expect(typeof putBody.createdAt).toBe("string");
    expect(typeof putBody.updatedAt).toBe("string");

    const get = await handler(authed("GET", "/api/projects/p1/assistant/jev", undefined, MEMBER_KEY));
    expect((await get.json() as { enabled: boolean }).enabled).toBe(true);

    const off = await handler(authed("PUT", "/api/projects/p1/assistant/jev", { enabled: false }, ADMIN_KEY));
    expect((await off.json() as { enabled: boolean }).enabled).toBe(false);
  });
});

describe("Jev probe over HTTP", () => {
  const storeKey = async () => {
    process.env.LXK_SECRETS_MASTER_KEY = MASTER_KEY;
    const res = await handler(authed("PATCH", "/api/assistant/jev", { baseUrl: "https://jev.internal", secret: PLAINTEXT_KEY }));
    expect(res.status).toBe(200);
  };

  it("no stored key → 400 JEV_INVALID_CONFIG without touching the network", async () => {
    vi.stubGlobal("fetch", (async () => {
      throw new Error("probe must not reach the network without a key");
    }) as unknown as typeof fetch);
    const res = await handler(authed("POST", "/api/assistant/jev/test"));
    expect(res.status).toBe(400);
    expect((await res.json() as { error: { code: string } }).error.code).toBe("JEV_INVALID_CONFIG");
  });

  it("success → 200 { ok, latencyMs, models }", async () => {
    await storeKey();
    vi.stubGlobal("fetch", (async () =>
      new Response(JSON.stringify({ models: [{ name: "jev-latest", description: "d", release_date: "2026-01-01" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch);
    const res = await handler(authed("POST", "/api/assistant/jev/test"));
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; latencyMs: number; models: string[] };
    expect(body.ok).toBe(true);
    expect(body.models).toEqual(["jev-latest"]);
    expect(typeof body.latencyMs).toBe("number");
  });

  it("401 → 502 JEV_AUTH_FAILED; 500 → 502 JEV_UNREACHABLE", async () => {
    await storeKey();
    vi.stubGlobal("fetch", (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch);
    const auth = await handler(authed("POST", "/api/assistant/jev/test"));
    expect(auth.status).toBe(502);
    expect((await auth.json() as { error: { code: string } }).error.code).toBe("JEV_AUTH_FAILED");

    vi.stubGlobal("fetch", (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch);
    const unreachable = await handler(authed("POST", "/api/assistant/jev/test"));
    expect(unreachable.status).toBe(502);
    expect((await unreachable.json() as { error: { code: string } }).error.code).toBe("JEV_UNREACHABLE");
  });
});
