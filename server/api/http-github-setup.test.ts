import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { Effect, ManagedRuntime } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { createApiHandler } from "./http";
import { GitHubConfig, GitHubConfigLive } from "../github/client";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

const ADMIN_KEY = "lxk_" + "a".repeat(43);
const MASTER_KEY = Buffer.from("m".repeat(32)).toString("base64");
const PUBLIC_URL = "https://lexa.example.com";

async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

let dir: string;
let db: Database;
let handler: (req: Request) => Promise<Response>;

async function liveConfig(): Promise<GitHubConfig["Type"]> {
  const runtime = ManagedRuntime.make(GitHubConfigLive);
  try {
    return await runtime.runPromise(Effect.gen(function* () {
      return yield* GitHubConfig;
    }));
  } finally {
    await runtime.dispose();
  }
}

const req = (method: string, path: string, body?: unknown) =>
  new Request(`http://lexa.test${path}`, {
    method,
    headers: {
      authorization: `Bearer ${ADMIN_KEY}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

const savedEnv: Record<string, string | undefined> = {};
for (const key of ["GITHUB_APP_ID", "GITHUB_PRIVATE_KEY", "GITHUB_PRIVATE_KEY_FILE", "GITHUB_WEBHOOK_SECRET", "LXK_SECRETS_MASTER_KEY", "LXK_PUBLIC_URL"]) {
  savedEnv[key] = process.env[key];
}

beforeAll(async () => {
  // The Bun handler resolves RuntimeEnv from process.env at request time, so the
  // test pins the env it needs (and clears the GITHUB_* bootstrap vars) rather
  // than passing a RuntimeEnv — which the Bun path uses for storage only.
  delete process.env.GITHUB_APP_ID;
  delete process.env.GITHUB_PRIVATE_KEY;
  delete process.env.GITHUB_PRIVATE_KEY_FILE;
  delete process.env.GITHUB_WEBHOOK_SECRET;
  process.env.LXK_SECRETS_MASTER_KEY = MASTER_KEY;
  process.env.LXK_PUBLIC_URL = PUBLIC_URL;

  dir = mkdtempSync(join(tmpdir(), "lexa-github-setup-api-"));
  const dbPath = join(dir, "test.db");
  runMigrations(dbPath, MIGRATIONS);
  const adminHash = await sha256(ADMIN_KEY);
  db = new Database(dbPath);
  db.exec(`INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k1', 'test-admin', '${adminHash}', NULL)`);
  handler = createApiHandler(dbPath);
});

afterAll(() => {
  db.exec("DELETE FROM github_app_secrets WHERE 1");
  db.exec("DELETE FROM settings WHERE key LIKE 'github_%'");
  db.close();
  rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value !== undefined) process.env[key] = value; else delete process.env[key];
  }
  vi.unstubAllGlobals();
});

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  db.exec("DELETE FROM github_app_secrets WHERE 1");
  db.exec("DELETE FROM settings WHERE key LIKE 'github_%'");
});

async function issueState(): Promise<string> {
  const res = await handler(req("POST", "/api/settings/github/manifest"));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { url: string; state: string; manifest: { default_permissions: Record<string, string> } };
  expect(body.url).toContain("https://github.com/settings/apps/new?state=");
  return body.state;
}

describe("github manifest connect endpoints", () => {
  it("POST /settings/github/manifest returns the GitHub form target, one-time state, and manifest", async () => {
    const res = await handler(req("POST", "/api/settings/github/manifest"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      url: string;
      state: string;
      manifest: { url: string; hook_attributes: { url: string }; redirect_url: string; default_permissions: Record<string, string>; default_events: string[] };
    };
    expect(body.state).toMatch(/^[0-9a-f]{64}$/);
    expect(body.url).toBe(`https://github.com/settings/apps/new?state=${body.state}`);
    expect(body.manifest).toMatchObject({
      url: PUBLIC_URL,
      hook_attributes: { url: `${PUBLIC_URL}/api/webhooks/github`, active: true },
      redirect_url: `${PUBLIC_URL}/settings/github/callback`,
      default_permissions: { issues: "write", metadata: "read", contents: "read" },
      default_events: ["issues"],
    });
  });

  it("state is single-use: a replayed setup → 400 GITHUB_MANIFEST_STATE_INVALID", async () => {
    const state = await issueState();
    const invalidRes = await handler(req("POST", "/api/settings/github/setup", { code: "c", state: "not-the-state" }));
    expect(invalidRes.status).toBe(400);
    expect((await invalidRes.json()).error.code).toBe("GITHUB_MANIFEST_STATE_INVALID");
    // the mismatch consumed the row
    const replay = await handler(req("POST", "/api/settings/github/setup", { code: "c", state }));
    expect(replay.status).toBe(400);
    expect((await replay.json()).error.code).toBe("GITHUB_MANIFEST_STATE_INVALID");
  });

  it("an expired state → 400 GITHUB_MANIFEST_STATE_INVALID", async () => {
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
      "github_manifest_state",
      JSON.stringify({ value: "old-state", expiresMs: Date.now() - 1_000 })
    );
    const res = await handler(req("POST", "/api/settings/github/setup", { code: "c", state: "old-state" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("GITHUB_MANIFEST_STATE_INVALID");
  });

  it("a successful exchange stores the credentials encrypted and applies them live", async () => {
    const state = await issueState();
    fetchMock.mockResolvedValue(
      json({
        id: 4242,
        slug: "lexa-test-app",
        pem: "-----BEGIN RSA PRIVATE KEY-----\nbody\n-----END RSA PRIVATE KEY-----",
        webhook_secret: "whsec-live",
        permissions: { issues: "write", metadata: "read", contents: "read" },
      })
    );
    const res = await handler(req("POST", "/api/settings/github/setup", { code: "the-code", state }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      appId: "4242",
      appSlug: "lexa-test-app",
      privateKeySet: true,
      webhookSecretSet: true,
      source: "settings",
    });

    // Encrypted rows written; no plaintext GitHub secrets anywhere.
    const secretNames = (db.prepare("SELECT name FROM github_app_secrets ORDER BY name").all() as { name: string }[]).map((r) => r.name);
    expect(secretNames).toEqual(["private_key", "webhook_secret"]);
    const plaintext = db.prepare("SELECT key FROM settings WHERE key IN ('github_private_key','github_webhook_secret')").all();
    expect(plaintext).toEqual([]);

    // Live holder apply — no runtime rebuild.
    const cfg = await liveConfig();
    expect(cfg).toMatchObject({ appId: "4242", webhookSecret: "whsec-live" });
    expect(cfg.privateKey).toContain("BEGIN RSA PRIVATE KEY");

    // GET reflects the slug for the Connect UI.
    const get = await handler(req("GET", "/api/settings/github"));
    expect(await get.json()).toMatchObject({ appId: "4242", appSlug: "lexa-test-app", source: "settings" });
  });

  it("a cancelled consent (no code) consumes the state and writes nothing", async () => {
    const state = await issueState();
    const res = await handler(req("POST", "/api/settings/github/setup", { state }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ appId: "", appSlug: "", privateKeySet: false, webhookSecretSet: false, source: "none" });
    expect(db.prepare("SELECT COUNT(*) c FROM github_app_secrets").get()).toEqual({ c: 0 });

    const replay = await handler(req("POST", "/api/settings/github/setup", { state }));
    expect(replay.status).toBe(400);
    expect((await replay.json()).error.code).toBe("GITHUB_MANIFEST_STATE_INVALID");
  });

  it("a GitHub exchange failure → 502 GITHUB_MANIFEST_EXCHANGE_FAILED", async () => {
    const state = await issueState();
    fetchMock.mockResolvedValue(json({ message: "bad" }, 500));
    const res = await handler(req("POST", "/api/settings/github/setup", { code: "c", state }));
    expect(res.status).toBe(502);
    expect((await res.json()).error.code).toBe("GITHUB_MANIFEST_EXCHANGE_FAILED");
  });

  it("a created App missing a required permission → 422 GITHUB_MANIFEST_PERMISSIONS_DENIED", async () => {
    const state = await issueState();
    fetchMock.mockResolvedValue(
      json({
        id: 1,
        slug: "lexa-test-app",
        pem: "-----BEGIN RSA PRIVATE KEY-----\nbody\n-----END RSA PRIVATE KEY-----",
        webhook_secret: "whsec",
        permissions: { issues: "read", metadata: "read", contents: "read" },
      })
    );
    const res = await handler(req("POST", "/api/settings/github/setup", { code: "c", state }));
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("GITHUB_MANIFEST_PERMISSIONS_DENIED");
    expect(db.prepare("SELECT COUNT(*) c FROM github_app_secrets").get()).toEqual({ c: 0 });
  });

  it("without a master key the setup → 500 GITHUB_SECRET_WRITE_FAILED", async () => {
    const saved = process.env.LXK_SECRETS_MASTER_KEY;
    delete process.env.LXK_SECRETS_MASTER_KEY;
    try {
      const state = await issueState();
      fetchMock.mockResolvedValue(
        json({
          id: 2,
          slug: "lexa-test-app",
          pem: "-----BEGIN RSA PRIVATE KEY-----\nbody\n-----END RSA PRIVATE KEY-----",
          webhook_secret: "whsec",
          permissions: { issues: "write", metadata: "read", contents: "read" },
        })
      );
      const res = await handler(req("POST", "/api/settings/github/setup", { code: "c", state }));
      expect(res.status).toBe(500);
      expect((await res.json()).error.code).toBe("GITHUB_SECRET_WRITE_FAILED");
    } finally {
      if (saved !== undefined) process.env.LXK_SECRETS_MASTER_KEY = saved;
    }
  });
});
