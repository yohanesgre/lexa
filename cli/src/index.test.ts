// cli/index.ts — command dispatch + requireClient resolution, exercised
// through the REAL entry point as a bun subprocess (the module self-executes
// only under import.meta.main; in-worker it must be inert). A local http
// server stands in for the Lexa API for the env/saved-login fallback tests.
// NOTE: the subprocess is spawned ASYNC — spawnSync would block this worker's
// event loop and the in-process fake server could never accept connections.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NotLoggedIn } from "./index";

const REPO_ROOT = join(import.meta.dirname ?? ".", "..", "..");
// Fresh per-run LEXA_DIR so subprocesses never see the real saved login.
const isolationDirs: string[] = [];

function freshLexaDir(): string {
  const d = mkdtempSync(join(tmpdir(), "lexa-index-lexa-"));
  isolationDirs.push(d);
  return d;
}

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], env: Record<string, string> = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", ["cli/src/index.ts", ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env, LEXA_DIR: env.LEXA_DIR ?? freshLexaDir() },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`cli subprocess timed out: ${args.join(" ")}`));
    }, 20_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ status: code ?? -1, stdout, stderr });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

afterAll(() => {
  for (const d of isolationDirs) rmSync(d, { recursive: true, force: true });
  isolationDirs.length = 0;
});

describe("entry point (bun subprocess)", () => {
  it("prints help with no args and exits 0", async () => {
    const r = await runCli([]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Usage: lx <command> [options]");
  });

  it("prints the CLI version", async () => {
    const r = await runCli(["--version"]);
    expect(r.status).toBe(0);
    const pkg = await import("../package.json");
    expect(r.stdout.trim()).toBe(`lx ${pkg.version}`);
  });

  it("rejects an unknown command with usage + exit 1", async () => {
    const r = await runCli(["bogus"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Unknown command: bogus");
    expect(r.stdout).toContain("Usage: lx <command> [options]");
  });

  it("routes to group help for a known group with an unknown subcommand", async () => {
    const r = await runCli(["task", "bogus"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Unknown: task bogus");
    expect(r.stdout).toContain("task list");
  });

  it("task list without credentials fails with NotLoggedIn + exit 1", async () => {
    const r = await runCli(["task", "list"], { LEXA_URL: "", LEXA_API_KEY: "" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Not logged in. Run: lx login");
  });

  it("github status --local without login is now gated (NotLoggedIn + exit 1)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lexa-index-"));
    const pem = join(dir, "app-key.pem");
    writeFileSync(pem, "-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n", { mode: 0o600 });
    writeFileSync(join(dir, ".env"), `GITHUB_APP_ID=123\nGITHUB_PRIVATE_KEY_FILE=${pem}\nGITHUB_WEBHOOK_SECRET=0123456789abcdef\n`);
    const r = await runCli(["github", "status", "--local", "--env-file", join(dir, ".env")], { LEXA_URL: "", LEXA_API_KEY: "" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Not logged in. Run: lx login");
    rmSync(dir, { recursive: true, force: true });
  });

  it("github status --local validates an env file with credentials present", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lexa-index-"));
    const pem = join(dir, "app-key.pem");
    writeFileSync(pem, "-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n", { mode: 0o600 });
    writeFileSync(join(dir, ".env"), `GITHUB_APP_ID=123\nGITHUB_PRIVATE_KEY_FILE=${pem}\nGITHUB_WEBHOOK_SECRET=0123456789abcdef\n`);
    const r = await runCli(["github", "status", "--local", "--env-file", join(dir, ".env")], {
      LEXA_URL: "http://127.0.0.1:1",
      LEXA_API_KEY: "lxk_key_1234567890123456789012345678901234567890",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Config looks complete");
    rmSync(dir, { recursive: true, force: true });
  });

  it("github status without login fails pointing at login", async () => {
    const r = await runCli(["github", "status"], { LEXA_URL: "", LEXA_API_KEY: "" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Not logged in. Run: lx login [--url <base>] [--key <lxk_...>]");
  });

  it("removed machine/runtime commands are unknown", async () => {
    for (const args of [["machine", "list"], ["machine", "install"], ["runtime", "list"], ["runtime", "delete", "x"]]) {
      const r = await runCli(args, { LEXA_URL: "", LEXA_API_KEY: "" });
      expect(r.status, args.join(" ")).toBe(1);
      expect(r.stderr, args.join(" ")).toContain(`Unknown command: ${args[0]}`);
    }
  });
});

describe("requireClient resolution (env + saved-login fallbacks)", () => {
  let server: Server;
  let base = "";
  let seenUrls: string[] = [];

  beforeAll(async () => {
    seenUrls = [];
    server = createServer((req, res) => {
      seenUrls.push(req.url ?? "");
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.url === "/api/health") res.end(JSON.stringify({ ok: true }));
      else if (req.url === "/api/projects") res.end(JSON.stringify({ data: [] }));
      else res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("env fallbacks (LEXA_URL/LEXA_API_KEY) authenticate against the server", async () => {
    const r = await runCli(["status"], { LEXA_URL: base, LEXA_API_KEY: "lxk_env_key_1234567890123456789012345678901234567890" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Server:   reachable (health ok)");
    expect(r.stdout).toContain("Projects: 0");
    expect(seenUrls).toContain("/api/health");
    expect(seenUrls).toContain("/api/projects");
  });

  it("saved login (group config.json) is used when env vars are absent", async () => {
    const lexaDir = freshLexaDir();
    // Saved logins live in the group of their server URL: 127.0.0.1:<port> →
    // <LEXA_DIR>/localhost:<port>/config.json.
    const group = join(lexaDir, `localhost:${new URL(base).port}`);
    mkdirSync(group, { recursive: true });
    writeFileSync(join(group, "config.json"), JSON.stringify({ url: base, apiKey: "lxk_saved_key_1234567890123456789012345678901234567890" }));
    const r = await runCli(["status"], { LEXA_URL: "", LEXA_API_KEY: "", LEXA_DIR: lexaDir });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Server:   reachable (health ok)");
  });

  it("flags override the saved login", async () => {
    const lexaDir = freshLexaDir();
    const group = join(lexaDir, "localhost:1");
    mkdirSync(group, { recursive: true });
    writeFileSync(join(group, "config.json"), JSON.stringify({ url: "http://127.0.0.1:1", apiKey: "lxk_wrong_key_1234567890123456789012345678901234567890" }));
    const r = await runCli(["status", "--url", base, "--key", "lxk_flag_key_1234567890123456789012345678901234567890"], { LEXA_DIR: lexaDir });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Server:   reachable (health ok)");
  });
});

describe("login (legacy key + device flow)", () => {
  let server: Server;
  let base = "";
  let pollQueue: Array<{ status: number; body: unknown }> = [];
  const DEVICE_TOKEN = "ab".repeat(32);
  const pendingBody = { status: "pending", clientName: "cli-testhost", code: "ABCDEFGH", expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString() };
  const approvedKey = "lxk_" + "d".repeat(43);
  const legacyKey = "lxk_" + "l".repeat(43);

  beforeAll(async () => {
    server = createServer((req, res) => {
      res.setHeader("Content-Type", "application/json");
      const url = new URL(req.url ?? "", base);
      if (req.method === "POST" && url.pathname === "/api/device-login/requests") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          const clientName = (JSON.parse(body) as { clientName?: string }).clientName ?? "";
          res.writeHead(201);
          res.end(JSON.stringify({
            id: "dl_req_1",
            code: "ABCDEFGH",
            clientName,
            status: "pending",
            expiresMs: Date.now() + 10 * 60 * 1000,
            verifyUrl: `${base}/device-login?token=${DEVICE_TOKEN}`,
          }));
        });
        return;
      }
      if (req.method === "GET" && /^\/api\/device-login\/requests\/[^/]+$/.test(url.pathname)) {
        const next = pollQueue.shift() ?? { status: 200, body: pendingBody };
        res.writeHead(next.status);
        res.end(JSON.stringify(next.body));
        return;
      }
      if (url.pathname === "/api/health") { res.writeHead(200); res.end(JSON.stringify({ ok: true })); return; }
      if (url.pathname === "/api/projects") { res.writeHead(200); res.end(JSON.stringify({ data: [] })); return; }
      res.writeHead(404);
      res.end(JSON.stringify({ error: { code: "NOT_FOUND", message: "not found" } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function savedConfig(lexaDir: string): { url: string; apiKey: string } {
    const group = join(lexaDir, `localhost:${new URL(base).port}`);
    return JSON.parse(readFileSync(join(group, "config.json"), "utf-8")) as { url: string; apiKey: string };
  }

  it("legacy --url --key login: validates, saves config", async () => {
    const lexaDir = freshLexaDir();
    const r = await runCli(["login", "--url", base, "--key", legacyKey], { LEXA_DIR: lexaDir });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`Logged in to ${base}`);
    expect(savedConfig(lexaDir)).toEqual({ url: base, apiKey: legacyKey });
  });

  it("legacy env login (LEXA_URL/LEXA_API_KEY) still works", async () => {
    const lexaDir = freshLexaDir();
    const r = await runCli(["login"], { LEXA_URL: base, LEXA_API_KEY: legacyKey, LEXA_DIR: lexaDir });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`Logged in to ${base}`);
    expect(savedConfig(lexaDir)).toEqual({ url: base, apiKey: legacyKey });
  });

  it("device flow happy path: verify URL printed, pending → approved, config saved", async () => {
    const lexaDir = freshLexaDir();
    pollQueue = [{ status: 200, body: pendingBody }, { status: 200, body: { status: "approved", rawKey: approvedKey, keyName: "cli-testhost", approverName: "Maria" } }];
    const r = await runCli(["login", base], { LEXA_URL: "", LEXA_API_KEY: "", LEXA_DIR: lexaDir });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`${base}/device-login?token=${DEVICE_TOKEN}`);
    expect(r.stdout).toContain("Backup code (shown on the approve page): ABCDEFGH");
    expect(r.stdout).toContain("Waiting for approval");
    expect(r.stdout).toContain(`New API key: cli-testhost`);
    expect(r.stdout).toContain("Logged in as Maria");
    expect(r.stdout).toContain(`Logged in to ${base}`);
    expect(savedConfig(lexaDir)).toEqual({ url: base, apiKey: approvedKey });
  });

  it("device flow denied → exit 1 with a clear message", async () => {
    pollQueue = [{ status: 403, body: { error: { code: "DEVICE_LOGIN_DENIED", message: "Login request denied" } } }];
    const r = await runCli(["login", base], { LEXA_URL: "", LEXA_API_KEY: "" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("denied");
  });

  it("device flow expired → exit 1 with a clear message", async () => {
    pollQueue = [{ status: 410, body: { error: { code: "DEVICE_LOGIN_EXPIRED", message: "Login request expired" } } }];
    const r = await runCli(["login", base], { LEXA_URL: "", LEXA_API_KEY: "" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("expired");
  });

  it("device flow on an old server (404 DEVICE_LOGIN_NOT_FOUND) points at --key login", async () => {
    pollQueue = [{ status: 404, body: { error: { code: "DEVICE_LOGIN_NOT_FOUND", message: "not found" } } }];
    const r = await runCli(["login", base], { LEXA_URL: "", LEXA_API_KEY: "" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("does not support device login");
    expect(r.stderr).toContain("lx login --key <lxk_...>");
  });

  it("non-TTY login with no URL and no key fails with usage", async () => {
    const r = await runCli(["login"], { LEXA_URL: "", LEXA_API_KEY: "" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Server URL is required");
  });
});

describe("task id resolution + move (server-delegating)", () => {
  let server: Server;
  let base = "";
  let requests: Array<{ method: string; url: string; body: string }> = [];
  const API_KEY = "lxk_move_key_1234567890123456789012345678901234567890";
  const UUID = "11111111-2222-3333-4444-555555555555";
  const task = {
    id: UUID,
    key: "NIM-12",
    title: "Fix the thing",
    priority: null,
    type: null,
    columnId: "col-1",
    swimlaneId: "lane-1",
    assignees: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const url = new URL(req.url ?? "", base);
        requests.push({ method: req.method ?? "GET", url: url.pathname + url.search, body });
        res.setHeader("Content-Type", "application/json");
        if (url.pathname === "/api/projects/demo/columns") {
          res.end(JSON.stringify({ data: [{ id: "col-1", name: "In Progress", wipLimit: null, requiredFields: null, color: null, position: 0, githubState: null }] }));
          return;
        }
        if (url.pathname === "/api/projects/demo/swimlanes") {
          res.end(JSON.stringify({ data: [{ id: "lane-2", name: "Lane Two", position: 1 }] }));
          return;
        }
        const move = url.pathname.match(/^\/api\/projects\/demo\/tasks\/(.+)\/move$/);
        if (req.method === "POST" && move) {
          const payload = JSON.parse(body) as { columnId: string; swimlaneId: string };
          res.end(JSON.stringify({ data: { ...task, columnId: payload.columnId, swimlaneId: payload.swimlaneId } }));
          return;
        }
        if (req.method === "GET" && url.pathname === "/api/projects/demo/tasks") {
          res.end(JSON.stringify({ data: [task] }));
          return;
        }
        const get = url.pathname.match(/^\/api\/projects\/demo\/tasks\/(.+)$/);
        if (req.method === "GET" && get) {
          res.end(JSON.stringify(task));
          return;
        }
        res.writeHead(404);
        res.end(JSON.stringify({ error: { code: "NOT_FOUND", message: "not found" } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    requests = [];
  });

  function moveRequest(): { columnId: string; swimlaneId: string } | undefined {
    const req = requests.find((q) => q.method === "POST" && q.url.endsWith("/move"));
    return req ? (JSON.parse(req.body) as { columnId: string; swimlaneId: string }) : undefined;
  }

  it("task move without --swimlane sends the task's current non-empty swimlaneId", async () => {
    const r = await runCli(["task", "move", UUID, "--project", "demo", "--column", "In Progress"], { LEXA_URL: base, LEXA_API_KEY: API_KEY });
    expect(r.status).toBe(0);
    const payload = moveRequest();
    expect(payload).toBeDefined();
    expect(payload!.columnId).toBe("col-1");
    expect(payload!.swimlaneId).toBe("lane-1");
    expect(payload!.swimlaneId).not.toBe("");
  });

  it("task move with --swimlane sends the resolved named swimlane id", async () => {
    const r = await runCli(["task", "move", UUID, "--project", "demo", "--column", "In Progress", "--swimlane", "Lane Two"], { LEXA_URL: base, LEXA_API_KEY: API_KEY });
    expect(r.status).toBe(0);
    expect(moveRequest()!.swimlaneId).toBe("lane-2");
  });

  it("task list non-JSON output shows the full UUID", async () => {
    const r = await runCli(["task", "list", "--project", "demo"], { LEXA_URL: base, LEXA_API_KEY: API_KEY });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(UUID);
  });

  it("PREFIX-N task id passes through to the server verbatim (no client-side list scan)", async () => {
    const r = await runCli(["task", "move", "NIM-12", "--project", "demo", "--column", "In Progress"], { LEXA_URL: base, LEXA_API_KEY: API_KEY });
    expect(r.status).toBe(0);
    expect(requests.some((q) => q.url === "/api/projects/demo/tasks/NIM-12")).toBe(true);
    expect(requests.some((q) => q.url.includes("?limit="))).toBe(false);
    expect(moveRequest()!.swimlaneId).toBe("lane-1");
  });

  it("full UUID task id passes through unchanged", async () => {
    const r = await runCli(["task", "get", UUID, "--project", "demo", "--json"], { LEXA_URL: base, LEXA_API_KEY: API_KEY });
    expect(r.status).toBe(0);
    expect(requests.some((q) => q.url === `/api/projects/demo/tasks/${UUID}`)).toBe(true);
    expect(requests.some((q) => q.url.includes("?limit="))).toBe(false);
  });

  it("PREFIX-N task id passes through for task get too", async () => {
    const r = await runCli(["task", "get", "NIM-12", "--project", "demo", "--json"], { LEXA_URL: base, LEXA_API_KEY: API_KEY });
    expect(r.status).toBe(0);
    expect(requests.some((q) => q.url === "/api/projects/demo/tasks/NIM-12")).toBe(true);
    expect(requests.some((q) => q.url.includes("?limit="))).toBe(false);
  });
});

describe("lifecycle writes (task delete/update, wiki, github links)", () => {
  let server: Server;
  let base = "";
  let requests: Array<{ method: string; url: string; body: string }> = [];
  const API_KEY = "lxk_lifecycle_key_12345678901234567890123456789012345678";
  const UUID = "11111111-2222-3333-4444-555555555555";
  const task = {
    id: UUID,
    key: "NIM-12",
    title: "Fix the thing",
    priority: null,
    type: null,
    columnId: "col-1",
    swimlaneId: "lane-1",
    assignees: null,
    githubs: [{ issueId: "i1", issueNumber: 5, repo: "owner/repo", syncedState: "open", url: "https://github.com/owner/repo/issues/5", outOfSync: false }],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const page = {
    id: "w-page",
    projectId: "p1",
    title: "Old Title",
    slug: "old-slug",
    content: { type: "doc", content: [] },
    parentId: null,
    position: 0,
    updatedBy: null,
    updatedByName: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const url = new URL(req.url ?? "", base);
        const method = req.method ?? "GET";
        requests.push({ method, url: url.pathname + url.search, body });
        res.setHeader("Content-Type", "application/json");
        const wikiPage = url.pathname.match(/^\/api\/projects\/demo\/wiki\/([^/]+)$/);
        if (method === "GET" && wikiPage?.[1] !== undefined) {
          res.end(JSON.stringify({ ...page, slug: wikiPage[1] }));
          return;
        }
        if (method === "POST" && url.pathname === "/api/projects/demo/wiki") {
          const payload = JSON.parse(body || "{}") as { title?: string; slug?: string; parentId?: string };
          res.writeHead(201);
          res.end(JSON.stringify({ ...page, title: payload.title ?? "", slug: payload.slug ?? "new-page", parentId: payload.parentId ?? null }));
          return;
        }
        if (method === "PATCH" && wikiPage?.[1] !== undefined) {
          const payload = JSON.parse(body || "{}") as { slug?: string; title?: string; parentId?: string | null };
          res.end(JSON.stringify({ ...page, slug: payload.slug ?? wikiPage[1], title: payload.title ?? page.title, parentId: payload.parentId !== undefined ? payload.parentId : page.parentId }));
          return;
        }
        if (method === "DELETE" && wikiPage?.[1] !== undefined) {
          if (wikiPage[1] === "parent-page") {
            res.writeHead(409);
            res.end(JSON.stringify({ error: { code: "HAS_CHILDREN", message: "page has children", details: { count: 1 } } }));
            return;
          }
          res.writeHead(204);
          res.end();
          return;
        }
        const linkExisting = url.pathname.match(/^\/api\/projects\/demo\/tasks\/([^/]+)\/github-link-existing$/);
        if (method === "POST" && linkExisting) {
          res.end(JSON.stringify({ data: task, activity: [] }));
          return;
        }
        const unlink = url.pathname.match(/^\/api\/projects\/demo\/tasks\/([^/]+)\/github-link\/([^/]+)$/);
        if (method === "DELETE" && unlink) {
          res.end(JSON.stringify({ data: task, activity: [] }));
          return;
        }
        const link = url.pathname.match(/^\/api\/projects\/demo\/tasks\/([^/]+)\/github-link$/);
        if (method === "POST" && link) {
          res.end(JSON.stringify({ data: task, activity: [] }));
          return;
        }
        const taskMatch = url.pathname.match(/^\/api\/projects\/demo\/tasks\/([^/]+)$/);
        if (method === "PATCH" && taskMatch) {
          const payload = JSON.parse(body || "{}") as { title?: string };
          res.end(JSON.stringify({ data: { ...task, title: payload.title ?? task.title }, activity: [] }));
          return;
        }
        if (method === "DELETE" && taskMatch) {
          if (taskMatch[1] === "has-children") {
            res.writeHead(409);
            res.end(JSON.stringify({ error: { code: "TASK_HAS_CHILDREN", message: "task has children" } }));
            return;
          }
          res.writeHead(204);
          res.end();
          return;
        }
        if (method === "GET" && taskMatch) {
          res.end(JSON.stringify(task));
          return;
        }
        res.writeHead(404);
        res.end(JSON.stringify({ error: { code: "NOT_FOUND", message: "not found" } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    requests = [];
  });

  function env(): Record<string, string> {
    return { LEXA_URL: base, LEXA_API_KEY: API_KEY };
  }
  function lastReq(method: string, path: string): { method: string; url: string; body: string } | undefined {
    return requests.filter((r) => r.method === method && r.url === path).pop();
  }

  it("task delete → 204, exit 0, prints Deleted", async () => {
    const r = await runCli(["task", "delete", UUID, "--project", "demo"], env());
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("  Deleted ");
    expect(lastReq("DELETE", `/api/projects/demo/tasks/${UUID}`)).toBeDefined();
  });

  it("task delete 409 TASK_HAS_CHILDREN → exit 1 with the [CODE] suffix", async () => {
    const r = await runCli(["task", "delete", "has-children", "--project", "demo"], env());
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("TASK_HAS_CHILDREN");
    expect(r.stderr).toContain("[TASK_HAS_CHILDREN]");
  });

  it("task update --description sends a TipTap doc", async () => {
    const r = await runCli(["task", "update", UUID, "--project", "demo", "--description", "hello"], env());
    expect(r.status).toBe(0);
    const body = JSON.parse(lastReq("PATCH", `/api/projects/demo/tasks/${UUID}`)!.body) as { description?: { type?: string } };
    expect(body.description?.type).toBe("doc");
  });

  it("task update --assignees a,b → array; --assignees= → empty array", async () => {
    await runCli(["task", "update", UUID, "--project", "demo", "--assignees", "a,b"], env());
    expect((JSON.parse(lastReq("PATCH", `/api/projects/demo/tasks/${UUID}`)!.body) as { assignees?: string[] }).assignees).toEqual(["a", "b"]);
    await runCli(["task", "update", UUID, "--project", "demo", "--assignees="], env());
    expect((JSON.parse(lastReq("PATCH", `/api/projects/demo/tasks/${UUID}`)!.body) as { assignees?: string[] }).assignees).toEqual([]);
  });

  it("task update bare --assignees (no value) → usage, exit 1", async () => {
    const r = await runCli(["task", "update", UUID, "--project", "demo", "--assignees"], env());
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Usage: lx task update");
  });

  it("task update --due sets dueAt; --clear-due sends dueAt: null", async () => {
    await runCli(["task", "update", UUID, "--project", "demo", "--due", "2026-10-01"], env());
    expect((JSON.parse(lastReq("PATCH", `/api/projects/demo/tasks/${UUID}`)!.body) as { dueAt?: string | null }).dueAt).toBe("2026-10-01");
    await runCli(["task", "update", UUID, "--project", "demo", "--clear-due"], env());
    expect((JSON.parse(lastReq("PATCH", `/api/projects/demo/tasks/${UUID}`)!.body) as { dueAt?: string | null }).dueAt).toBeNull();
  });

  it("task update with no field flags → usage, exit 1", async () => {
    const r = await runCli(["task", "update", UUID, "--project", "demo"], env());
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Usage: lx task update");
  });

  it("wiki create prints the created slug", async () => {
    const r = await runCli(["wiki", "create", "--project", "demo", "--title", "New Page"], env());
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("new-page");
    const body = JSON.parse(lastReq("POST", "/api/projects/demo/wiki")!.body) as { title?: string };
    expect(body.title).toBe("New Page");
  });

  it("wiki update --slug prints the rename arrow", async () => {
    const r = await runCli(["wiki", "update", "old-slug", "--project", "demo", "--slug", "new-slug"], env());
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("→ new-slug");
  });

  it("wiki update --parent-root sends parentId: null", async () => {
    const r = await runCli(["wiki", "update", "old-slug", "--project", "demo", "--parent-root"], env());
    expect(r.status).toBe(0);
    expect((JSON.parse(lastReq("PATCH", "/api/projects/demo/wiki/old-slug")!.body) as { parentId?: string | null }).parentId).toBeNull();
  });

  it("wiki update --parent resolves the parent slug to its page id", async () => {
    const r = await runCli(["wiki", "update", "old-slug", "--project", "demo", "--parent", "root-page"], env());
    expect(r.status).toBe(0);
    expect(lastReq("GET", "/api/projects/demo/wiki/root-page")).toBeDefined();
    expect((JSON.parse(lastReq("PATCH", "/api/projects/demo/wiki/old-slug")!.body) as { parentId?: string | null }).parentId).toBe("w-page");
  });

  it("wiki create --content sends a TipTap doc", async () => {
    const r = await runCli(["wiki", "create", "--project", "demo", "--title", "New Page", "--content", "hello"], env());
    expect(r.status).toBe(0);
    expect((JSON.parse(lastReq("POST", "/api/projects/demo/wiki")!.body) as { content?: { type?: string } }).content?.type).toBe("doc");
  });

  it("wiki update --content sends a TipTap doc", async () => {
    const r = await runCli(["wiki", "update", "old-slug", "--project", "demo", "--content", "hello"], env());
    expect(r.status).toBe(0);
    expect((JSON.parse(lastReq("PATCH", "/api/projects/demo/wiki/old-slug")!.body) as { content?: { type?: string } }).content?.type).toBe("doc");
  });

  it("wiki update --parent= (empty) → usage, exit 1", async () => {
    const r = await runCli(["wiki", "update", "old-slug", "--project", "demo", "--parent="], env());
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Usage: lx wiki update");
  });

  it("wiki create --content= (empty) → usage, exit 1", async () => {
    const r = await runCli(["wiki", "create", "--project", "demo", "--title", "New Page", "--content="], env());
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Usage: lx wiki create");
  });

  it("wiki delete 409 HAS_CHILDREN → exit 1 with the [CODE] suffix", async () => {
    const r = await runCli(["wiki", "delete", "parent-page", "--project", "demo"], env());
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("HAS_CHILDREN");
    expect(r.stderr).toContain("[HAS_CHILDREN]");
  });

  it("github link POSTs repo and prints Linked", async () => {
    const r = await runCli(["github", "link", UUID, "--project", "demo", "--repo", "owner/repo"], env());
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`  Linked ${UUID} → owner/repo`);
    const body = JSON.parse(lastReq("POST", `/api/projects/demo/tasks/${UUID}/github-link`)!.body) as { repo?: string };
    expect(body).toEqual({ repo: "owner/repo" });
  });

  it("github link-existing POSTs repo + issueNumber", async () => {
    const r = await runCli(["github", "link-existing", UUID, "--project", "demo", "--repo", "owner/repo", "--issue", "7"], env());
    expect(r.status).toBe(0);
    const body = JSON.parse(lastReq("POST", `/api/projects/demo/tasks/${UUID}/github-link-existing`)!.body) as { repo?: string; issueNumber?: number };
    expect(body).toEqual({ repo: "owner/repo", issueNumber: 7 });
  });

  it("github unlink --issue-id unlinks by node id", async () => {
    const r = await runCli(["github", "unlink", UUID, "--project", "demo", "--issue-id", "i9"], env());
    expect(r.status).toBe(0);
    expect(lastReq("DELETE", `/api/projects/demo/tasks/${UUID}/github-link/i9`)).toBeDefined();
  });

  it("github unlink --repo + --issue resolves the node id via task get", async () => {
    const r = await runCli(["github", "unlink", UUID, "--project", "demo", "--repo", "owner/repo", "--issue", "5"], env());
    expect(r.status).toBe(0);
    expect(lastReq("GET", `/api/projects/demo/tasks/${UUID}`)).toBeDefined();
    expect(lastReq("DELETE", `/api/projects/demo/tasks/${UUID}/github-link/i1`)).toBeDefined();
  });

  it("github unlink with an unmatched repo+issue → exit 1", async () => {
    const r = await runCli(["github", "unlink", UUID, "--project", "demo", "--repo", "owner/repo", "--issue", "99"], env());
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("No linked issue");
  });

  it("group help lists the new subcommands", async () => {
    const taskHelp = await runCli(["task", "bogus"], { LEXA_URL: "", LEXA_API_KEY: "" });
    expect(taskHelp.status).toBe(1);
    expect(taskHelp.stdout).toContain("task delete");
    const wikiHelp = await runCli(["wiki", "bogus"], { LEXA_URL: "", LEXA_API_KEY: "" });
    expect(wikiHelp.status).toBe(1);
    expect(wikiHelp.stdout).toContain("wiki create");
    const githubHelp = await runCli(["github", "bogus"], { LEXA_URL: "", LEXA_API_KEY: "" });
    expect(githubHelp.status).toBe(1);
    expect(githubHelp.stdout).toContain("github link <id> --project <slug> --repo <owner/name>");
  });
});

describe("planning surface (column/swimlane/milestone + task move edges)", () => {
  let server: Server;
  let base = "";
  let requests: Array<{ method: string; url: string; body: string }> = [];
  const API_KEY = "lxk_planning_key_123456789012345678901234567890123";
  const UUID = "11111111-2222-3333-4444-555555555555";
  const task = {
    id: UUID,
    key: "NIM-12",
    title: "Fix the thing",
    priority: null,
    type: null,
    columnId: "col-1",
    swimlaneId: "lane-1",
    assignees: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const columns = [
    { id: "col-1", projectId: "p1", name: "In Progress", wipLimit: 3, requiredFields: null, color: null, position: 0, githubState: null, isDone: false },
    { id: "col-2", projectId: "p1", name: "Done", wipLimit: null, requiredFields: null, color: null, position: 1, githubState: "closed", isDone: true },
    { id: "col-wip", projectId: "p1", name: "Full", wipLimit: 1, requiredFields: null, color: null, position: 2, githubState: null, isDone: false },
  ];
  const swimlanes = [
    { id: "lane-1", projectId: "p1", name: "Sprint A", description: "", position: 0, dueAt: "2026-06-01", archivedAt: null, startAt: "2026-05-01", kind: "sprint", milestoneId: "ms-1" },
  ];
  const milestones = [
    { id: "ms-1", projectId: "p1", name: "v1", description: "", position: 0, dueAt: "2026-09-30", archivedAt: null, sprintCount: 2, archivedSprintCount: 0 },
  ];

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const url = new URL(req.url ?? "", base);
        const method = req.method ?? "GET";
        requests.push({ method, url: url.pathname + url.search, body });
        res.setHeader("Content-Type", "application/json");
        if (url.pathname === "/api/projects/demo/columns" && method === "GET") { res.end(JSON.stringify({ data: columns })); return; }
        if (url.pathname === "/api/projects/demo/swimlanes" && method === "GET") { res.end(JSON.stringify({ data: swimlanes })); return; }
        if (url.pathname === "/api/projects/demo/milestones" && method === "GET") { res.end(JSON.stringify({ data: milestones })); return; }
        if (url.pathname === "/api/projects/demo/milestones" && method === "POST") {
          const p = JSON.parse(body || "{}") as { name?: string; description?: string; dueAt?: string | null };
          res.writeHead(201);
          res.end(JSON.stringify({ ...milestones[0], name: p.name ?? milestones[0]!.name, description: p.description ?? "", dueAt: p.dueAt ?? null }));
          return;
        }
        const ms = url.pathname.match(/^\/api\/projects\/demo\/milestones\/([^/]+)$/);
        if (ms && method === "PATCH") {
          const p = JSON.parse(body || "{}") as { name?: string; dueAt?: string | null };
          res.end(JSON.stringify({ ...milestones[0], name: p.name ?? milestones[0]!.name, dueAt: p.dueAt !== undefined ? p.dueAt : milestones[0]!.dueAt }));
          return;
        }
        const getTask = url.pathname.match(/^\/api\/projects\/demo\/tasks\/([^/]+)$/);
        if (getTask && method === "GET") { res.end(JSON.stringify(task)); return; }
        const move = url.pathname.match(/^\/api\/projects\/demo\/tasks\/([^/]+)\/move$/);
        if (move && method === "POST") {
          const p = JSON.parse(body || "{}") as { columnId: string; swimlaneId: string };
          if (p.columnId === "col-wip") {
            res.writeHead(409);
            res.end(JSON.stringify({ error: { code: "WIP_LIMIT", message: "WIP limit reached", details: { limit: 1 } } }));
            return;
          }
          res.end(JSON.stringify({ data: { ...task, columnId: p.columnId, swimlaneId: p.swimlaneId }, activity: [] }));
          return;
        }
        res.writeHead(404);
        res.end(JSON.stringify({ error: { code: "NOT_FOUND", message: "not found" } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    requests = [];
  });

  function env(): Record<string, string> {
    return { LEXA_URL: base, LEXA_API_KEY: API_KEY };
  }
  function lastReq(method: string, path: string): { method: string; url: string; body: string } | undefined {
    return requests.filter((r) => r.method === method && r.url === path).pop();
  }
  function lastMove(): { columnId: string; swimlaneId: string; beforeTaskId?: string; afterTaskId?: string; clearDueAt?: boolean } | undefined {
    const req = requests.filter((r) => r.method === "POST" && r.url.endsWith("/move")).pop();
    return req ? (JSON.parse(req.body) as { columnId: string; swimlaneId: string }) : undefined;
  }

  it("column list shows WIP/DONE/GITHUB with — for a missing WIP limit", async () => {
    const r = await runCli(["column", "list", "--project", "demo"], env());
    expect(r.status).toBe(0);
    const lines = r.stdout.split("\n");
    expect(lines[0]).toContain("ID");
    expect(lines[0]).toContain("WIP");
    expect(lines[0]).toContain("DONE");
    expect(lines[0]).toContain("GITHUB");
    const progress = lines.find((l) => l.startsWith("col-1"))!;
    expect(progress).toContain("3");
    const done = lines.find((l) => l.startsWith("col-2"))!;
    expect(done).toContain("—");
    expect(done).toContain("yes");
    expect(done).toContain("closed");
  });

  it("column list --json emits the raw payload", async () => {
    const r = await runCli(["column", "list", "--project", "demo", "--json"], env());
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout) as Array<{ id: string }>;
    expect(parsed.map((c) => c.id)).toEqual(["col-1", "col-2", "col-wip"]);
  });

  it("swimlane list --json emits the raw payload", async () => {
    const r = await runCli(["swimlane", "list", "--project", "demo", "--json"], env());
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout) as Array<{ id: string }>;
    expect(parsed.map((l) => l.id)).toEqual(["lane-1"]);
  });

  it("milestone list --json emits the raw payload", async () => {
    const r = await runCli(["milestone", "list", "--project", "demo", "--json"], env());
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout) as Array<{ id: string }>;
    expect(parsed.map((m) => m.id)).toEqual(["ms-1"]);
  });

  it("swimlane list includes KIND/DUE columns", async () => {
    const r = await runCli(["swimlane", "list", "--project", "demo"], env());
    expect(r.status).toBe(0);
    const header = r.stdout.split("\n")[0]!;
    expect(header).toContain("KIND");
    expect(header).toContain("DUE");
    expect(r.stdout).toContain("sprint");
    expect(r.stdout).toContain("2026-06-01");
  });

  it("milestone list includes DUE and the sprint count when the payload carries it", async () => {
    const r = await runCli(["milestone", "list", "--project", "demo"], env());
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("2026-09-30");
    expect(r.stdout).toContain("SPRINTS");
    expect(r.stdout).toContain("2");
  });

  it("milestone create posts { name, dueAt } and prints the created milestone", async () => {
    const r = await runCli(["milestone", "create", "--project", "demo", "--name", "v2", "--due", "2027-01-31"], env());
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("  Created milestone ms-1 — v2");
    const body = JSON.parse(lastReq("POST", "/api/projects/demo/milestones")!.body) as Record<string, unknown>;
    expect(body).toEqual({ name: "v2", dueAt: "2027-01-31" });
  });

  it("milestone create without --name → usage, exit 1", async () => {
    const r = await runCli(["milestone", "create", "--project", "demo"], env());
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Usage: lx milestone create");
  });

  it("milestone update resolves by exact name, posts the new name, prints the result", async () => {
    const r = await runCli(["milestone", "update", "v1", "--project", "demo", "--name", "v1.1"], env());
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("  Updated milestone ms-1 — v1.1");
    const body = JSON.parse(lastReq("PATCH", "/api/projects/demo/milestones/ms-1")!.body) as Record<string, unknown>;
    expect(body).toEqual({ name: "v1.1" });
  });

  it("milestone update --clear-due sends dueAt: null", async () => {
    const r = await runCli(["milestone", "update", "ms-1", "--project", "demo", "--clear-due"], env());
    expect(r.status).toBe(0);
    const body = JSON.parse(lastReq("PATCH", "/api/projects/demo/milestones/ms-1")!.body) as { dueAt?: string | null };
    expect(body.dueAt).toBeNull();
  });

  it("milestone update with no mutation flag → usage, exit 1", async () => {
    const r = await runCli(["milestone", "update", "ms-1", "--project", "demo"], env());
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Usage: lx milestone update");
  });

  it("milestone update resolves a mixed-case ref case-insensitively", async () => {
    const r = await runCli(["milestone", "update", "V1", "--project", "demo", "--name", "v1.2"], env());
    expect(r.status).toBe(0);
    expect(lastReq("PATCH", "/api/projects/demo/milestones/ms-1")).toBeDefined();
  });

  it("milestone update --position <n> sends position in the body", async () => {
    const r = await runCli(["milestone", "update", "ms-1", "--project", "demo", "--position", "2"], env());
    expect(r.status).toBe(0);
    const body = JSON.parse(lastReq("PATCH", "/api/projects/demo/milestones/ms-1")!.body) as { position?: number };
    expect(body).toEqual({ position: 2 });
  });

  it("milestone update --name= (empty) → usage, exit 1", async () => {
    const r = await runCli(["milestone", "update", "ms-1", "--project", "demo", "--name="], env());
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Usage: lx milestone update");
  });

  it("unknown milestone ref → exit 1 listing the available names", async () => {
    const r = await runCli(["milestone", "update", "Nope", "--project", "demo", "--name", "x"], env());
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Milestone "Nope" not found. Available: v1');
  });

  it("unknown column ref → exit 1 listing the available names", async () => {
    const r = await runCli(["task", "move", UUID, "--project", "demo", "--column", "Nope"], env());
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Column "Nope" not found. Available: In Progress, Done, Full');
  });

  it("unknown swimlane ref → exit 1 listing the available names", async () => {
    const r = await runCli(["task", "move", UUID, "--project", "demo", "--column", "In Progress", "--swimlane", "Nope"], env());
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Swimlane "Nope" not found. Available: Sprint A');
  });

  it("task move --before passes beforeTaskId verbatim (PREFIX-N)", async () => {
    const r = await runCli(["task", "move", UUID, "--project", "demo", "--column", "In Progress", "--before", "NIM-3"], env());
    expect(r.status).toBe(0);
    expect(lastMove()!.columnId).toBe("col-1");
    expect(lastMove()!.beforeTaskId).toBe("NIM-3");
  });

  it("task move --after passes afterTaskId verbatim", async () => {
    const r = await runCli(["task", "move", UUID, "--project", "demo", "--column", "In Progress", "--after", "NIM-4"], env());
    expect(r.status).toBe(0);
    expect(lastMove()!.afterTaskId).toBe("NIM-4");
  });

  it("task move --clear-due sends clearDueAt: true", async () => {
    const r = await runCli(["task", "move", UUID, "--project", "demo", "--column", "In Progress", "--clear-due"], env());
    expect(r.status).toBe(0);
    expect(lastMove()!.clearDueAt).toBe(true);
  });

  it("task move --before + --after → usage, exit 1, no request sent", async () => {
    const r = await runCli(["task", "move", UUID, "--project", "demo", "--column", "In Progress", "--before", "NIM-3", "--after", "NIM-4"], env());
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Usage: lx task move");
    expect(requests.filter((q) => q.url.endsWith("/move")).length).toBe(0);
  });

  it("task move WIP 409 → stderr carries the [WIP_LIMIT] suffix", async () => {
    const r = await runCli(["task", "move", UUID, "--project", "demo", "--column", "Full"], env());
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("WIP_LIMIT");
    expect(r.stderr).toContain("[WIP_LIMIT]");
  });

  it("task move resolves a column by exact id first", async () => {
    const r = await runCli(["task", "move", UUID, "--project", "demo", "--column", "col-1"], env());
    expect(r.status).toBe(0);
    expect(lastMove()!.columnId).toBe("col-1");
  });

  it("task move --swimlane resolves by id before name", async () => {
    const r = await runCli(["task", "move", UUID, "--project", "demo", "--column", "In Progress", "--swimlane", "lane-1"], env());
    expect(r.status).toBe(0);
    expect(requests.some((q) => q.url === "/api/projects/demo/swimlanes")).toBe(true);
    expect(lastMove()!.swimlaneId).toBe("lane-1");
  });

  it("task move bare --before (no value) → usage, exit 1, no request sent", async () => {
    const r = await runCli(["task", "move", UUID, "--project", "demo", "--column", "In Progress", "--before"], env());
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Usage: lx task move");
    expect(requests.filter((q) => q.url.endsWith("/move")).length).toBe(0);
  });

  it("task move --after= (empty) → usage, exit 1, no request sent", async () => {
    const r = await runCli(["task", "move", UUID, "--project", "demo", "--column", "In Progress", "--after="], env());
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Usage: lx task move");
    expect(requests.filter((q) => q.url.endsWith("/move")).length).toBe(0);
  });

  it("group help lists the planning subcommands", async () => {
    const col = await runCli(["column", "bogus"], { LEXA_URL: "", LEXA_API_KEY: "" });
    expect(col.status).toBe(1);
    expect(col.stdout).toContain("column list");
    const lane = await runCli(["swimlane", "bogus"], { LEXA_URL: "", LEXA_API_KEY: "" });
    expect(lane.status).toBe(1);
    expect(lane.stdout).toContain("swimlane list");
    const ms = await runCli(["milestone", "bogus"], { LEXA_URL: "", LEXA_API_KEY: "" });
    expect(ms.status).toBe(1);
    expect(ms.stdout).toContain("milestone create");
  });
});

describe("module import (in-worker)", () => {
  it("importing index.ts is inert — no exit, no help dump, exports available", async () => {
    // If the import.meta.main guard were missing, this import would have
    // printed HELP and called process.exit(0).
    expect(typeof NotLoggedIn).toBe("function");
    const err = new NotLoggedIn();
    expect(err.message).toContain("Not logged in. Run: lx login");
  });
});
