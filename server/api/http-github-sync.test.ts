import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync } from "node:crypto";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { createApiHandler } from "./http";
import { syncGitHubConfigFromDb } from "../github/client";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

const ADMIN_KEY = "lxk_" + "a".repeat(43);

async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Real RSA key so the app JWT signing succeeds — the fetch mock intercepts all
// GitHub API calls, so no real network traffic ever happens.
const { privateKey: testPrivateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const testPrivateKeyPem = testPrivateKey.export({ type: "pkcs8", format: "pem" }).toString();

let dir: string;
let handler: (req: Request) => Promise<Response>;
let db: Database;
let patchCalls: { url: string; body: unknown }[];
let failPatches: boolean;

const fetchMock = vi.fn();

beforeAll(async () => {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
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
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  dir = mkdtempSync(join(tmpdir(), "lexa-github-sync-"));
  const dbPath = join(dir, "test.db");
  runMigrations(dbPath, MIGRATIONS);
  const adminHash = await sha256(ADMIN_KEY);
  db = new Database(dbPath);
  db.exec(`
INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k1', 'test-admin', '${adminHash}', NULL);
INSERT INTO projects (id, name, slug, key, next_task_number) VALUES ('p1', 'P', 'p1', 'EG', 1);
INSERT INTO columns (id, project_id, name, position, github_state) VALUES ('c1', 'p1', 'Todo', 0, 'open'), ('c2', 'p1', 'Done', 1, 'closed');
INSERT INTO swimlanes (id, project_id, name, position, kind) VALUES ('s-backlog', 'p1', 'Backlog', 0, 'backlog');
INSERT INTO priority_options (id, project_id, label, color, position) VALUES ('prio-1', 'p1', 'Medium', '#888', 0);
INSERT INTO type_options (id, project_id, label, color, position) VALUES ('type-1', 'p1', 'Bug', '#f00', 0);
INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, description, priority, type, position, created_at, key, number) VALUES
  ('t1', 'p1', 'c1', 's-backlog', 'T1', '{"type":"doc","content":[]}', 'prio-1', 'type-1', 'a0', '2026-01-01 10:00:00', 'EG-1', 1);
INSERT INTO task_github_issues (task_id, issue_id, issue_number, repo, synced_state) VALUES ('t1', 'ghi1', 7, 'owner/repo', 'open');
INSERT INTO project_repos (id, project_id, repo, source_role, workspace_role) VALUES ('pr1', 'p1', 'owner/repo', 0, 1);
INSERT INTO settings (key, value) VALUES ('github_app_id', '12345');
`);
  db.prepare("INSERT INTO settings (key, value) VALUES ('github_private_key', ?)").run(testPrivateKeyPem);
  syncGitHubConfigFromDb(db);
  handler = createApiHandler(dbPath);
});

afterAll(() => {
  try { db.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  patchCalls = [];
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

describe("GitHub content push on task save", () => {
  it("pushes title+body on the first save after a link, then records the echo columns", async () => {
    const res = await api("PATCH", "/api/projects/p1/tasks/t1", { title: "T1 edited" });
    expect(res.status).toBe(200);
    expect(patchCalls).toHaveLength(1);
    expect(JSON.parse(String(patchCalls[0].body))).toMatchObject({ title: "T1 edited", body: "" });

    const row = db.prepare("SELECT pushed_title, pushed_body, push_failed FROM task_github_issues WHERE task_id = 't1'").get() as { pushed_title: string | null; pushed_body: string | null; push_failed: number };
    expect(row.pushed_title).toBe("T1 edited");
    expect(row.pushed_body).toBe("");
    expect(row.push_failed).toBe(0);
  });

  it("is a no-op when title and body match what we last pushed", async () => {
    await api("PATCH", "/api/projects/p1/tasks/t1", { title: "T1 edited" });
    expect(patchCalls).toHaveLength(1);

    // Same title again — diff against pushed_* says nothing to push.
    const res = await api("PATCH", "/api/projects/p1/tasks/t1", { title: "T1 edited" });
    expect(res.status).toBe(200);
    expect(patchCalls).toHaveLength(1);

    // Non-content field change — also no push.
    await api("PATCH", "/api/projects/p1/tasks/t1", { priority: "prio-1" });
    expect(patchCalls).toHaveLength(1);
  });

  it("retries on the next save after a failed push, flagging push_failed", async () => {
    failPatches = true;
    const res = await api("PATCH", "/api/projects/p1/tasks/t1", { title: "T1 edited" });
    expect(res.status).toBe(200);
    let row = db.prepare("SELECT pushed_title, push_failed FROM task_github_issues WHERE task_id = 't1'").get() as { pushed_title: string | null; push_failed: number };
    expect(row.pushed_title).toBeNull();
    expect(row.push_failed).toBe(1);

    // The mutation response carries the divergence flag for the UI badge.
    const body = await res.json();

    const row2 = db.prepare("SELECT pushed_title, push_failed FROM task_github_issues WHERE task_id = 't1'").get();
    console.log("ROW2:", JSON.stringify(row2));
    expect(body.data.githubs[0].pushFailed).toBe(true);

    // Next save retries (pushed_* still NULL → diff says changed).
    failPatches = false;
    const res2 = await api("PATCH", "/api/projects/p1/tasks/t1", { title: "T1 edited" });
    expect(res2.status).toBe(200);
    expect(patchCalls).toHaveLength(1);
    row = db.prepare("SELECT pushed_title, push_failed FROM task_github_issues WHERE task_id = 't1'").get() as { pushed_title: string | null; push_failed: number };
    expect(row.pushed_title).toBe("T1 edited");
    expect(row.push_failed).toBe(0);
  });
});
