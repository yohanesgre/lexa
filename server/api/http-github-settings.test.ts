import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Effect } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { createBunSqliteDriver } from "../db/drivers/bun-sqlite";
import { createApiHandler } from "./http";
import { syncGitHubConfigFromDbAsync } from "../github/client";
import { resolveGithubAppSecrets } from "../github/config-store";

// The stored TEST_PEM is intentionally not a usable key; the probe test needs
// to reach the stubbed fetch, so the app JWT signing is stubbed.
vi.mock("../github/crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../github/crypto")>();
  return { ...actual, createAppJwt: vi.fn(async () => "fake-jwt") };
});

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

beforeAll(async () => {
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

afterAll(async () => {
  // Restore the shared config holder to its DB-derived state and drop the
  // global settings rows so this file's mutations don't leak anywhere.
  db.exec("DELETE FROM settings WHERE key LIKE 'github_%'");
  db.exec("DELETE FROM github_app_secrets");
  await Effect.runPromise(syncGitHubConfigFromDbAsync(createBunSqliteDriver(db)));
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
      appSlug: "",
      privateKeySet: false,
      webhookSecretSet: false,
      source: "none",
    });
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
      appSlug: "",
      privateKeySet: true,
      webhookSecretSet: true,
      source: "settings",
    });
    const get = await handler(json("GET", "/api/settings/github"));
    expect(get.status).toBe(200);
    expect(await get.json()).toEqual({
      appId: "1234567",
      appSlug: "",
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
      appSlug: "",
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
    expect(body).toEqual({ appId: "555", appSlug: "", privateKeySet: true, webhookSecretSet: true, source: "settings" });
    // privateKey row untouched, webhookSecret replaced.
    expect(db.prepare("SELECT value FROM settings WHERE key = 'github_private_key'").get()).toEqual({ value: TEST_PEM });
    expect(db.prepare("SELECT value FROM settings WHERE key = 'github_webhook_secret'").get()).toEqual({ value: "new-secret" });
  });

  it("PUT clears the matching encrypted row and the plaintext write wins (last explicit write)", async () => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('github_app_id', '1234567') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
    db.prepare("INSERT INTO settings (key, value) VALUES ('github_private_key', 'legacy-pem') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
    db.prepare(
      "INSERT INTO github_app_secrets (name, ciphertext, iv, key_id) VALUES ('private_key', 'ct', 'iv', 'k1') ON CONFLICT(name) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv, key_id = excluded.key_id"
    ).run();

    const res = await handler(json("PUT", "/api/settings/github", { appId: "1234567", privateKey: TEST_PEM }));
    expect(res.status).toBe(200);

    // The encrypted row is gone; the new value lives in the plaintext row.
    expect(db.prepare("SELECT COUNT(*) c FROM github_app_secrets WHERE name = 'private_key'").get()).toEqual({ c: 0 });
    expect(db.prepare("SELECT value FROM settings WHERE key = 'github_private_key'").get()).toEqual({ value: TEST_PEM });

    // Runtime resolution reads the plaintext write.
    const resolved = await Effect.runPromise(resolveGithubAppSecrets(createBunSqliteDriver(db)));
    expect(resolved.privateKey).toBe(TEST_PEM);

    db.exec("DELETE FROM github_app_secrets");
    db.exec("DELETE FROM settings WHERE key LIKE 'github_%'");
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

describe("settings github installations probe", () => {
  it("member-bound key → 403 FORBIDDEN", async () => {
    const res = await handler(json("GET", "/api/settings/github/installations", undefined, MEMBER_KEY));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("FORBIDDEN");
  });

  it("no App configured → not_installed", async () => {
    db.exec("DELETE FROM settings WHERE key LIKE 'github_%'");
    db.exec("DELETE FROM github_app_secrets");
    await Effect.runPromise(syncGitHubConfigFromDbAsync(createBunSqliteDriver(db)));
    const res = await handler(json("GET", "/api/settings/github/installations"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "not_installed", accounts: [] });
  });

  it("upstream failure → unknown (never a 5xx)", async () => {
    await handler(json("PUT", "/api/settings/github", {
      appId: "1234567",
      privateKey: TEST_PEM,
      webhookSecret: TEST_SECRET,
    }));
    const fetchMock = vi.fn(() => Promise.reject(new Error("network down")));
    vi.stubGlobal("fetch", fetchMock);
    const res = await handler(json("GET", "/api/settings/github/installations"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "unknown", accounts: [] });
    // Pin the failure path: the probe must have reached the stubbed fetch, not
    // short-circuited on an (unmocked) JWT failure.
    expect(fetchMock).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  const installationsResponse = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

  it("installed App → installed with account logins", async () => {
    await handler(json("PUT", "/api/settings/github", {
      appId: "1234567",
      privateKey: TEST_PEM,
      webhookSecret: TEST_SECRET,
    }));
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        installationsResponse([
          { id: 1, account: { login: "acme" } },
          { id: 2, account: { login: "beta" } },
        ])
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    const res = await handler(json("GET", "/api/settings/github/installations"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "installed", accounts: ["acme", "beta"] });
    expect(fetchMock).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("missing account login is filtered from the probe", async () => {
    await handler(json("PUT", "/api/settings/github", {
      appId: "1234567",
      privateKey: TEST_PEM,
      webhookSecret: TEST_SECRET,
    }));
    vi.stubGlobal("fetch", vi.fn(() =>
      Promise.resolve(
        installationsResponse([
          { id: 1, account: { login: "acme" } },
          { id: 2 },
        ])
      )
    ));
    const res = await handler(json("GET", "/api/settings/github/installations"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "installed", accounts: ["acme"] });
    vi.unstubAllGlobals();
  });
});
