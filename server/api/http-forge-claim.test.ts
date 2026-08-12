import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { createApiHandler } from "./http";
import { syncGitHubConfigFromDb } from "../github/client";

// The claim handler's GitHubClient signs an app JWT before any fetch — stub
// it so the fixture PEM never touches real crypto.
vi.mock("../github/crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../github/crypto")>();
  return { ...actual, createAppJwt: vi.fn(async () => "fake-jwt") };
});

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

const ADMIN_KEY = "lxk_" + "a".repeat(43);

async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ── GitHub fetch mock (installation lookup + token mint + repo/tree/contents) ──
const fetchMock = vi.fn();
const routes = new Map<string, unknown>();

function mockFetch() {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url}`;
    const hit = routes.get(key) ?? routes.get(`GET ${url}`);
    if (hit === undefined) return Promise.reject(new Error(`unmocked: ${key}`));
    return Promise.resolve(new Response(JSON.stringify(hit), { status: 200, headers: { "Content-Type": "application/json" } }));
  });
}

function setupGithubRoutes(repo = "owner/repo") {
  const b64 = (s: string) => Buffer.from(s).toString("base64");
  routes.set(`GET https://api.github.com/repos/${repo}/installation`, { id: 1 });
  routes.set(`POST https://api.github.com/app/installations/1/access_tokens`, {
    token: "inst-token",
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  });
  routes.set(`GET https://api.github.com/repos/${repo}`, { default_branch: "main" });
  routes.set(`GET https://api.github.com/repos/${repo}/git/trees/main?recursive=1`, {
    truncated: false,
    tree: [
      { path: "src", type: "tree" },
      { path: "src/index.ts", type: "blob", size: 40 },
      { path: "node_modules/pkg/index.js", type: "blob", size: 5 },
      { path: "README.md", type: "blob", size: 10 },
    ],
  });
  routes.set(`GET https://api.github.com/repos/${repo}/contents/src/index.ts`, { content: b64("export const answer = 42;") });
  routes.set(`GET https://api.github.com/repos/${repo}/contents/README.md`, { content: b64("# Widget\n") });
}

let dir: string;
let db: Database;
let handler: (req: Request) => Promise<Response>;

const claim = (runtimeId: string) =>
  new Request("http://lexa.test/api/forge/daemon/claim", {
    method: "POST",
    headers: { authorization: `Bearer ${ADMIN_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ runtimeId }),
  });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "lexa-forge-claim-"));
  const dbPath = join(dir, "test.db");
  runMigrations(dbPath, MIGRATIONS);
  const adminHash = await sha256(ADMIN_KEY);
  db = new Database(dbPath);
  db.exec(`
INSERT INTO api_keys (id, name, key_hash) VALUES ('k1', 'test-admin', '${adminHash}');
INSERT INTO runtimes (id, name, provider, model, status, agent, print_logs, log_level) VALUES
  ('r1', 'dev', 'opencode', 'claude', 'online', 'lexa', 0, 'INFO');
INSERT INTO projects (id, name, slug) VALUES ('p1', 'P', 'p1');
INSERT INTO columns (id, project_id, name, position) VALUES ('c1', 'p1', 'Todo', 0);
INSERT INTO swimlanes (id, project_id, name, position, kind) VALUES ('s1', 'p1', 'Main', 0, 'backlog');
INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, description, priority, type, position, created_at) VALUES
  ('t1', 'p1', 'c1', 's1', 'Linked Task', '{"type":"doc","content":[]}', 'pr-1', 'tp-1', 'a0', '2026-01-01 10:00:00'),
  ('t2', 'p1', 'c1', 's1', 'Plain Task', '{"type":"doc","content":[]}', 'pr-1', 'tp-1', 'a1', '2026-01-01 10:00:00');
INSERT INTO task_github_issues (task_id, issue_id, issue_number, repo, synced_state) VALUES
  ('t1', 'ghi1', 7, 'owner/repo', 'open');
INSERT INTO project_repos (id, project_id, repo, source_role, workspace_role) VALUES
  ('pr1', 'p1', 'owner/repo', 1, 1);
INSERT INTO settings (key, value) VALUES
  ('github_app_id', '12345'),
  ('github_private_key', '-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----'),
  ('github_webhook_secret', 'whsec');
INSERT INTO forge_agents (id, name, description, instructions, is_builtin) VALUES
  ('a1', 'Test Agent', '', 'Agent instructions', 0);
INSERT INTO forge_skills (id, name, description, instructions, is_builtin) VALUES
  ('sk1', 'Test Skill', '', 'Skill instructions', 0);
-- p2 has no source repos — tasks there get no repoContent.
INSERT INTO projects (id, name, slug) VALUES ('p2', 'P2', 'p2');
INSERT INTO columns (id, project_id, name, position) VALUES ('c2', 'p2', 'Todo', 0);
INSERT INTO swimlanes (id, project_id, name, position, kind) VALUES ('s2', 'p2', 'Main', 0, 'backlog');
INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, description, priority, type, position, created_at) VALUES
  ('t3', 'p2', 'c2', 's2', 'NoRepo Task', '{"type":"doc","content":[]}', 'pr-1', 'tp-1', 'a0', '2026-01-01 10:00:00');
INSERT INTO forge_tasks (id, project_id, document_type, document_id, agent_id, skill_id, selection, doc_context, status, created_at) VALUES
  ('ft1', 'p1', 'task', 't1', 'a1', 'sk1', '', 'Task: Linked Task', 'queued', '2026-01-01 10:00:00'),
  ('ft2', 'p1', 'task', 't1', 'a1', 'sk1', '', 'Task: Linked Task', 'queued', '2026-01-01 10:00:01'),
  ('ft3', 'p2', 'task', 't3', 'a1', 'sk1', '', 'Task: NoRepo Task', 'queued', '2026-01-01 10:00:02'),
  ('ft4', 'p1', 'task', 't1', 'a1', 'sk1', '', 'Task: Linked Task', 'queued', '2026-01-01 10:00:03');
`);
  handler = createApiHandler(dbPath);
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  routes.clear();
  mockFetch();
  // Configure the shared GitHub config holder (settings > env).
  syncGitHubConfigFromDb(db);
});

describe("forge claim repoContent", () => {
  it("returns linked-repo content + a prompt pointing at repo-content/", async () => {
    setupGithubRoutes();
    const res = await handler(claim("r1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.task.id).toBe("ft1");
    expect(body.repoContent).toEqual([
      { owner: "owner", repo: "owner/repo", path: "src/index.ts", content: "export const answer = 42;" },
      { owner: "owner", repo: "owner/repo", path: "README.md", content: "# Widget\n" },
    ]);
    expect(body.prompt).toContain("repo-content/");
    expect(body.prompt).toContain("Linked GitHub repo content is in the repo-content/ directory");
  });

  it("claim succeeds without repoContent when GitHub calls fail", async () => {
    // No routes for the GitHub API → every fetch rejects (network failure).
    const res = await handler(claim("r1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.task.id).toBe("ft2");
    expect(body.repoContent).toEqual([]);
    expect(body.prompt).not.toContain("repo-content/");
  });

  it("task without linked repos → no repoContent", async () => {
    setupGithubRoutes();
    const res = await handler(claim("r1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.task.id).toBe("ft3");
    expect(body.repoContent).toEqual([]);
    expect(body.prompt).not.toContain("repo-content/");
  });

  it("claim succeeds without repoContent when GitHub is unconfigured", async () => {
    db.exec("DELETE FROM settings WHERE key LIKE 'github_%'");
    syncGitHubConfigFromDb(db); // holder back to env (empty in test env)
    setupGithubRoutes(); // would succeed if reached — must not be reached
    const res = await handler(claim("r1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.task.id).toBe("ft4");
    expect(body.repoContent).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled(); // requireConfig throws before any fetch
  });
});
