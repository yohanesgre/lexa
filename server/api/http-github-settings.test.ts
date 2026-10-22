import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { Effect } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync } from "node:crypto";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { createBunSqliteDriver } from "../db/drivers/bun-sqlite";
import { createApiHandler, createWebhookHandler } from "./http";
import { syncGitHubConfigFromDbAsync } from "../github/client";
import type * as GithubCrypto from "../github/crypto";

// The stored TEST_PEM is intentionally not a usable key; the probe/sync tests
// reach the stubbed fetch, so the app JWT signing is stubbed.
vi.mock("../github/crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof GithubCrypto>();
  return { ...actual, createAppJwt: vi.fn(async () => "fake-jwt") };
});

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

const ADMIN_KEY = "lxk_" + "a".repeat(43);
const MASTER_KEY = Buffer.from("m".repeat(32)).toString("base64");
const PUBLIC_URL = "https://lexa.example.com";

// Test-only PEM — a real PKCS#1 header + a fake body is enough to exercise
// storage/clearing; the GET response must never echo any of it.
const TEST_PEM = "-----BEGIN RSA PRIVATE KEY-----\nLXK-TEST-KEY-FRAGMENT-12345\n-----END RSA PRIVATE KEY-----";
const TEST_SECRET = "lxk-whsec-test-98765";

// Real RSA key so the app JWT signing path is exercised end-to-end; the fetch
// mock intercepts all GitHub API calls, so no real network traffic happens.
const { privateKey: testPrivateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const testPrivateKeyPem = testPrivateKey.export({ type: "pkcs8", format: "pem" }).toString();

async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

let dir: string;
let dbPath: string;
let db: Database;
let handler: (req: Request) => Promise<Response>;
let webhookHandler: (rawBody: ArrayBuffer, deliveryId: string, event: string) => Response;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "lexa-github-settings-api-"));
  dbPath = join(dir, "test.db");
  runMigrations(dbPath, MIGRATIONS);
  const adminHash = await sha256(ADMIN_KEY);
  db = new Database(dbPath);
  db.exec(`INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k1', 'test-admin', '${adminHash}', NULL)`);
  handler = createApiHandler(dbPath);
  webhookHandler = createWebhookHandler(dbPath);
});

afterAll(async () => {
  // Restore the shared config holder to its DB-derived state and drop the
  // global settings rows so this file's mutations don't leak anywhere.
  db.exec("DELETE FROM settings WHERE key LIKE 'github_%'");
  db.exec("DELETE FROM github_app_secrets");
  await Effect.runPromise(syncGitHubConfigFromDbAsync(createBunSqliteDriver(db)));
  db.close();
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

const json = (method: string, path: string, body?: unknown) =>
  new Request(`http://lexa.test${path}`, {
    method,
    headers: {
      authorization: `Bearer ${ADMIN_KEY}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

describe("settings github endpoints", () => {
  it("GET source 'none' when unconfigured; PUT valid saves/applies and GET reflects it without echoing secrets; empty strings clear", async () => {
    db.exec("DELETE FROM settings WHERE key LIKE 'github_%'");
    const none = await handler(json("GET", "/api/settings/github"));
    expect(none.status).toBe(200);
    expect(await none.json()).toEqual({
      appId: "",
      appSlug: "",
      privateKeySet: false,
      webhookSecretSet: false,
      source: "none",
    });

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
    const getText = get.clone();
    expect(await get.json()).toEqual({
      appId: "1234567",
      appSlug: "",
      privateKeySet: true,
      webhookSecretSet: true,
      source: "settings",
    });
    expect(db.prepare("SELECT value FROM settings WHERE key = 'github_app_id'").get()).toEqual({ value: "1234567" });
    expect(db.prepare("SELECT value FROM settings WHERE key = 'github_private_key'").get()).toEqual({ value: TEST_PEM });
    expect(db.prepare("SELECT value FROM settings WHERE key = 'github_webhook_secret'").get()).toEqual({ value: TEST_SECRET });

    // K3: the GET response never echoes the PEM or the webhook secret.
    const text = await getText.text();
    expect(text).not.toContain("BEGIN RSA PRIVATE KEY");
    expect(text).not.toContain("LXK-TEST-KEY-FRAGMENT-12345");
    expect(text).not.toContain(TEST_SECRET);

    // Empty strings clear the rows → source back to 'none'.
    const cleared = await handler(json("PUT", "/api/settings/github", { appId: "", privateKey: "", webhookSecret: "" }));
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({
      appId: "",
      appSlug: "",
      privateKeySet: false,
      webhookSecretSet: false,
      source: "none",
    });
    expect(db.prepare("SELECT COUNT(*) c FROM settings WHERE key LIKE 'github_%'").get()).toEqual({ c: 0 });
  });

  it("PUT with an invalid body → 422 INVALID_GITHUB_SETTINGS", async () => {
    const bodies = [
      { appId: "abc" },
      { appId: "12a34" },
      { appId: "123", privateKey: "not-a-pem" },
      { appId: "123", privateKey: "BEGIN RSA" },
      { webhookSecret: "x" },
      {},
    ];
    for (const body of bodies) {
      const res = await handler(json("PUT", "/api/settings/github", body));
      expect(res.status).toBe(422);
      expect((await res.json()).error.code).toBe("INVALID_GITHUB_SETTINGS");
    }
  });
});

describe("settings github installations probe", () => {
  const installationsResponse = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

  it("not_installed when unconfigured; installed with account logins; upstream failure → unknown (never a 5xx)", async () => {
    db.exec("DELETE FROM settings WHERE key LIKE 'github_%'");
    db.exec("DELETE FROM github_app_secrets");
    await Effect.runPromise(syncGitHubConfigFromDbAsync(createBunSqliteDriver(db)));
    const off = await handler(json("GET", "/api/settings/github/installations"));
    expect(off.status).toBe(200);
    expect(await off.json()).toEqual({ status: "not_installed", accounts: [] });

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
    const installed = await handler(json("GET", "/api/settings/github/installations"));
    expect(installed.status).toBe(200);
    expect(await installed.json()).toEqual({ status: "installed", accounts: ["acme", "beta"] });
    expect(fetchMock).toHaveBeenCalled();

    await handler(json("PUT", "/api/settings/github", {
      appId: "1234567",
      privateKey: TEST_PEM,
      webhookSecret: TEST_SECRET,
    }));
    const failingMock = vi.fn(() => Promise.reject(new Error("network down")));
    vi.stubGlobal("fetch", failingMock);
    const unknown = await handler(json("GET", "/api/settings/github/installations"));
    expect(unknown.status).toBe(200);
    expect(await unknown.json()).toEqual({ status: "unknown", accounts: [] });
    // Pin the failure path: the probe must have reached the stubbed fetch.
    expect(failingMock).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe("github manifest connect endpoints", () => {
  const fetchMock = vi.fn();
  const jsonBody = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

  const savedEnv: Record<string, string | undefined> = {};
  for (const key of ["LXK_SECRETS_MASTER_KEY", "LXK_PUBLIC_URL"]) savedEnv[key] = process.env[key];

  beforeAll(() => {
    // The Bun handler resolves RuntimeEnv from process.env at request time.
    process.env.LXK_SECRETS_MASTER_KEY = MASTER_KEY;
    process.env.LXK_PUBLIC_URL = PUBLIC_URL;
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value !== undefined) process.env[key] = value; else delete process.env[key];
    }
  });

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    db.exec("DELETE FROM github_app_secrets WHERE 1");
    db.exec("DELETE FROM settings WHERE key LIKE 'github_%'");
  });

  async function issueState(): Promise<string> {
    const res = await handler(json("POST", "/api/settings/github/manifest"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.url).toContain("https://github.com/settings/apps/new?state=");
    return body.state;
  }

  it("state is single-use (replay → 400); a created App missing a permission → 422 and no secrets stored", async () => {
    const state = await issueState();
    const invalidRes = await handler(json("POST", "/api/settings/github/setup", { code: "c", state: "not-the-state" }));
    expect(invalidRes.status).toBe(400);
    expect((await invalidRes.json()).error.code).toBe("GITHUB_MANIFEST_STATE_INVALID");
    // the mismatch consumed the row
    const replay = await handler(json("POST", "/api/settings/github/setup", { code: "c", state }));
    expect(replay.status).toBe(400);
    expect((await replay.json()).error.code).toBe("GITHUB_MANIFEST_STATE_INVALID");

    const state2 = await issueState();
    fetchMock.mockResolvedValue(
      jsonBody({
        id: 1,
        slug: "lexa-test-app",
        pem: "-----BEGIN RSA PRIVATE KEY-----\nbody\n-----END RSA PRIVATE KEY-----",
        webhook_secret: "whsec",
        permissions: { issues: "read", metadata: "read", contents: "read" },
      })
    );
    const denied = await handler(json("POST", "/api/settings/github/setup", { code: "c", state: state2 }));
    expect(denied.status).toBe(422);
    expect((await denied.json()).error.code).toBe("GITHUB_MANIFEST_PERMISSIONS_DENIED");
    expect(db.prepare("SELECT COUNT(*) c FROM github_app_secrets").get()).toEqual({ c: 0 });
  });
});

describe("GitHub content push on task save", () => {
  const patchCalls: { url: string; body: unknown }[] = [];
  let failPatches = false;
  const pushFetch = vi.fn();

  beforeAll(async () => {
    pushFetch.mockImplementation((url: string, init?: RequestInit) => {
      const key = `${init?.method ?? "GET"} ${url}`;
      if (key === "PATCH https://api.github.com/repos/owner/repo/issues/7") {
        if (failPatches) {
          return Promise.resolve(new Response(JSON.stringify({ message: "boom" }), { status: 500 }));
        }
        patchCalls.push({ url, body: init?.body });
        return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } }));
      }
      if (key === "GET https://api.github.com/repos/owner/repo/installation") {
        return Promise.resolve(new Response(JSON.stringify({ id: 1 }), { status: 200, headers: { "Content-Type": "application/json" } }));
      }
      if (key === "POST https://api.github.com/app/installations/1/access_tokens") {
        return Promise.resolve(new Response(JSON.stringify({ token: "inst-token", expires_at: new Date(Date.now() + 3_600_000).toISOString() }), { status: 200, headers: { "Content-Type": "application/json" } }));
      }
      if (key === "GET https://api.github.com/repos/owner/repo/issues/7") {
        return Promise.resolve(new Response(JSON.stringify({ node_id: "ghi1", number: 7, state: "open", title: "T1", body: "" }), { status: 200, headers: { "Content-Type": "application/json" } }));
      }
      return Promise.reject(new Error(`unmocked: ${key}`));
    });
    globalThis.fetch = pushFetch as unknown as typeof fetch;

    db.exec(`
INSERT INTO projects (id, name, slug, key, next_task_number) VALUES ('p1', 'P', 'p1', 'EG', 1);
INSERT INTO columns (id, project_id, name, position, github_state) VALUES ('c1', 'p1', 'Todo', 0, 'open'), ('c2', 'p1', 'Done', 1, 'closed');
INSERT INTO swimlanes (id, project_id, name, position, kind) VALUES ('s-backlog', 'p1', 'Backlog', 0, 'backlog');
INSERT INTO priority_options (id, project_id, label, color, position) VALUES ('prio-1', 'p1', 'Medium', '#888', 0);
INSERT INTO type_options (id, project_id, label, color, position) VALUES ('type-1', 'p1', 'Bug', '#f00', 0);
INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, description, priority, type, position, created_at, key, number) VALUES
  ('t1', 'p1', 'c1', 's-backlog', 'T1', '', 'prio-1', 'type-1', 'a0', '2026-01-01 10:00:00', 'EG-1', 1);
INSERT INTO task_github_issues (task_id, issue_id, issue_number, repo, synced_state) VALUES ('t1', 'ghi1', 7, 'owner/repo', 'open');
INSERT INTO project_repos (id, project_id, repo, source_role, workspace_role) VALUES ('pr1', 'p1', 'owner/repo', 0, 1);
INSERT INTO settings (key, value) VALUES ('github_app_id', '12345') ON CONFLICT(key) DO UPDATE SET value = excluded.value;
`);
    db.prepare("INSERT INTO settings (key, value) VALUES ('github_private_key', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(testPrivateKeyPem);
    await Effect.runPromise(syncGitHubConfigFromDbAsync(createBunSqliteDriver(db)));
  });

  beforeEach(() => {
    patchCalls.length = 0;
    failPatches = false;
    db.prepare("UPDATE task_github_issues SET pushed_title = NULL, pushed_body = NULL, push_failed = 0 WHERE task_id = 't1'").run();
  });

  function api(method: string, path: string, body?: unknown) {
    return handler(
      new Request(`http://lexa.test${path}`, {
        method,
        headers: {
          authorization: `Bearer ${ADMIN_KEY}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      })
    );
  }

  it("first save pushes and records echo columns, matching re-save is suppressed, failed push flags push_failed and retries, webhook refresh updates the title", async () => {
    const res = await api("PATCH", "/api/projects/p1/tasks/t1", { title: "T1 edited" });
    expect(res.status).toBe(200);
    expect(patchCalls).toHaveLength(1);
    expect(JSON.parse(String(patchCalls[0]!.body))).toMatchObject({ title: "T1 edited", body: "" });

    const row = db.prepare("SELECT pushed_title, pushed_body, push_failed, issue_title FROM task_github_issues WHERE task_id = 't1'").get() as { pushed_title: string | null; pushed_body: string | null; push_failed: number; issue_title: string | null };
    expect(row.pushed_title).toBe("T1 edited");
    expect(row.pushed_body).toBe("");
    expect(row.push_failed).toBe(0);
    expect(row.issue_title).toBe("T1 edited");

    // Same title again — diff against pushed_* says nothing to push.
    const again = await api("PATCH", "/api/projects/p1/tasks/t1", { title: "T1 edited" });
    expect(again.status).toBe(200);
    expect(patchCalls).toHaveLength(1);

    // Non-content field change — also no push.
    await api("PATCH", "/api/projects/p1/tasks/t1", { priority: "prio-1" });
    expect(patchCalls).toHaveLength(1);

    // Failed push flags push_failed in the mutation response and keeps pushed_title stale.
    failPatches = true;
    const failed = await api("PATCH", "/api/projects/p1/tasks/t1", { title: "T1 again" });
    expect(failed.status).toBe(200);
    let failRow = db.prepare("SELECT pushed_title, push_failed FROM task_github_issues WHERE task_id = 't1'").get() as { pushed_title: string | null; push_failed: number };
    expect(failRow.push_failed).toBe(1);
    expect((await failed.json()).data.githubs[0]!.pushFailed).toBe(true);

    // Next save retries (pushed_* still stale → diff says changed) and clears the flag.
    failPatches = false;
    const retried = await api("PATCH", "/api/projects/p1/tasks/t1", { title: "T1 again" });
    expect(retried.status).toBe(200);
    expect(patchCalls).toHaveLength(2);
    failRow = db.prepare("SELECT pushed_title, push_failed FROM task_github_issues WHERE task_id = 't1'").get() as { pushed_title: string | null; push_failed: number };
    expect(failRow.pushed_title).toBe("T1 again");
    expect(failRow.push_failed).toBe(0);

    // Webhook refreshes the stored issue title when the upstream issue is edited.
    db.prepare("UPDATE task_github_issues SET issue_title = 'Old title' WHERE task_id = 't1'").run();
    const raw = new TextEncoder().encode(JSON.stringify({ action: "edited", issue: { node_id: "ghi1", title: "T1" } })).buffer;
    const hookRes = webhookHandler(raw, `delivery-title-${Date.now()}`, "issues");
    expect(hookRes.status).toBe(200);
    await vi.waitFor(() => {
      const r = db.prepare("SELECT issue_title FROM task_github_issues WHERE task_id = 't1'").get() as { issue_title: string | null };
      expect(r.issue_title).toBe("T1");
    });
  });
});
