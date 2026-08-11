import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { createApiHandler } from "./http";
import { syncGitHubConfigFromDb } from "../github/client";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

const ADMIN_KEY = "lxk_" + "a".repeat(43);
const MEMBER_KEY = "lxk_" + "m".repeat(43);

// Test-only PEM — a real PKCS#1 header + a fake body is enough to exercise
// storage/clearing; the GET response must never echo any of it.
const TEST_PEM = "-----BEGIN RSA PRIVATE KEY-----\nLXK-TEST-KEY-FRAGMENT-12345\n-----END RSA PRIVATE KEY-----";
const TEST_SECRET = "lxk-whsec-test-98765";

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

const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  // The endpoints report DB-only state — pin the env to empty so the
  // assertions hold regardless of the machine's shell environment.
  for (const key of ["GITHUB_APP_ID", "GITHUB_PRIVATE_KEY", "GITHUB_PRIVATE_KEY_FILE", "GITHUB_WEBHOOK_SECRET"]) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }

  dir = mkdtempSync(join(tmpdir(), "lexa-github-settings-api-"));
  const dbPath = join(dir, "test.db");
  runMigrations(dbPath, MIGRATIONS);
  const adminHash = await sha256(ADMIN_KEY);
  const memberHash = await sha256(MEMBER_KEY);
  db = new Database(dbPath);
  db.exec(`
INSERT INTO users (id, email, name, role) VALUES ('u1', 'maria@lexa.test', 'Maria', 'member');
INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k1', 'test-admin', '${adminHash}', NULL);
INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k2', 'test-member', '${memberHash}', 'u1');
`);
  handler = createApiHandler(dbPath);
});

afterAll(() => {
  // Restore the shared config holder to its DB-derived state and drop the
  // global settings rows so this file's mutations don't leak anywhere.
  db.exec("DELETE FROM settings WHERE key LIKE 'github_%'");
  for (const key of ["GITHUB_APP_ID", "GITHUB_PRIVATE_KEY", "GITHUB_PRIVATE_KEY_FILE", "GITHUB_WEBHOOK_SECRET"]) {
    if (savedEnv[key] !== undefined) process.env[key] = savedEnv[key]!; else delete process.env[key];
  }
  syncGitHubConfigFromDb(db);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const json = (method: string, path: string, body?: unknown, key: string = ADMIN_KEY) =>
  new Request(`http://lexa.test${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

describe("settings github endpoints", () => {
  it("GET returns source 'none' when nothing is configured", async () => {
    db.exec("DELETE FROM settings WHERE key LIKE 'github_%'");
    const res = await handler(json("GET", "/api/settings/github"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      appId: "",
      privateKeySet: false,
      webhookSecretSet: false,
      source: "none",
    });
  });

  it("GET ignores env vars at runtime (DB is the single source of truth, no 'env' state)", async () => {
    const keys = ["GITHUB_APP_ID", "GITHUB_PRIVATE_KEY", "GITHUB_PRIVATE_KEY_FILE", "GITHUB_WEBHOOK_SECRET"];
    const saved: Record<string, string | undefined> = {};
    for (const key of keys) saved[key] = process.env[key];
    process.env.GITHUB_APP_ID = "999";
    process.env.GITHUB_PRIVATE_KEY = "env-pem";
    process.env.GITHUB_PRIVATE_KEY_FILE = "/x.pem";
    process.env.GITHUB_WEBHOOK_SECRET = "env-secret";
    try {
      db.exec("DELETE FROM settings WHERE key LIKE 'github_%'");
      const res = await handler(json("GET", "/api/settings/github"));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        appId: "",
        privateKeySet: false,
        webhookSecretSet: false,
        source: "none",
      });
    } finally {
      for (const key of keys) {
        if (saved[key] !== undefined) process.env[key] = saved[key]!; else delete process.env[key];
      }
    }
  });

  it("PUT with valid values saves, applies, and GET reflects them (source 'settings')", async () => {
    const res = await handler(json("PUT", "/api/settings/github", {
      appId: "1234567",
      privateKey: TEST_PEM,
      webhookSecret: TEST_SECRET,
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      appId: "1234567",
      privateKeySet: true,
      webhookSecretSet: true,
      source: "settings",
    });
    const get = await handler(json("GET", "/api/settings/github"));
    expect(get.status).toBe(200);
    expect(await get.json()).toEqual({
      appId: "1234567",
      privateKeySet: true,
      webhookSecretSet: true,
      source: "settings",
    });
    // Persisted to the settings KV table.
    expect(db.prepare("SELECT value FROM settings WHERE key = 'github_app_id'").get()).toEqual({ value: "1234567" });
    expect(db.prepare("SELECT value FROM settings WHERE key = 'github_private_key'").get()).toEqual({ value: TEST_PEM });
    expect(db.prepare("SELECT value FROM settings WHERE key = 'github_webhook_secret'").get()).toEqual({ value: TEST_SECRET });
  });

  it("GET never returns the PEM or webhook secret", async () => {
    const get = await handler(json("GET", "/api/settings/github"));
    expect(get.status).toBe(200);
    const text = await get.text();
    expect(text).not.toContain("BEGIN RSA PRIVATE KEY");
    expect(text).not.toContain("LXK-TEST-KEY-FRAGMENT-12345");
    expect(text).not.toContain(TEST_SECRET);
  });

  it("PUT with empty strings clears the rows → source back to 'none'", async () => {
    const res = await handler(json("PUT", "/api/settings/github", { appId: "", privateKey: "", webhookSecret: "" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      appId: "",
      privateKeySet: false,
      webhookSecretSet: false,
      source: "none",
    });
    expect(db.prepare("SELECT COUNT(*) c FROM settings WHERE key LIKE 'github_%'").get()).toEqual({ c: 0 });
  });

  it("PUT with a partial body replaces only the present fields", async () => {
    await handler(json("PUT", "/api/settings/github", { appId: "555", privateKey: TEST_PEM, webhookSecret: "old-secret" }));
    const res = await handler(json("PUT", "/api/settings/github", { appId: "555", webhookSecret: "new-secret" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ appId: "555", privateKeySet: true, webhookSecretSet: true, source: "settings" });
    // privateKey row untouched, webhookSecret replaced.
    expect(db.prepare("SELECT value FROM settings WHERE key = 'github_private_key'").get()).toEqual({ value: TEST_PEM });
    expect(db.prepare("SELECT value FROM settings WHERE key = 'github_webhook_secret'").get()).toEqual({ value: "new-secret" });
  });

  it.each([
    { appId: "abc" },
    { appId: "12a34" },
    { appId: "123", privateKey: "not-a-pem" },
    { appId: "123", privateKey: "BEGIN RSA" },
    { webhookSecret: "x" }, // missing appId
    {},
  ])("PUT with invalid body %o → 422 INVALID_GITHUB_SETTINGS", async (body) => {
    const res = await handler(json("PUT", "/api/settings/github", body));
    expect(res.status).toBe(422);
    const parsed = await res.json();
    expect(parsed.error.code).toBe("INVALID_GITHUB_SETTINGS");
  });

  it("member-bound key → 403 FORBIDDEN on both endpoints", async () => {
    const get = await handler(json("GET", "/api/settings/github", undefined, MEMBER_KEY));
    expect(get.status).toBe(403);
    expect((await get.json()).error.code).toBe("FORBIDDEN");
    const put = await handler(json("PUT", "/api/settings/github", { appId: "1" }, MEMBER_KEY));
    expect(put.status).toBe(403);
    expect((await put.json()).error.code).toBe("FORBIDDEN");
  });

  it("rejects without a key → 401", async () => {
    const res = await handler(new Request("http://lexa.test/api/settings/github"));
    expect(res.status).toBe(401);
  });
});
