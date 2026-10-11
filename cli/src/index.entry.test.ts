// cli/index.ts — command dispatch + requireClient resolution, exercised
// through the REAL entry point as a bun subprocess (the module self-executes
// only under import.meta.main; in-worker it must be inert). A local http
// server stands in for the Lexa API for the env/saved-login fallback tests.
// Also covers `lx skill install` dispatch + file writes.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NotLoggedIn, devicePollDeadline } from "./index";
import { cleanupIsolationDirs, freshLexaDir, runCli } from "./test-utils";

const REPO_ROOT = join(import.meta.dirname ?? ".", "..", "..");
const dirs: string[] = [];

function freshDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runSkillCli(
  args: string[],
  opts: { cwd?: string; env?: Record<string, string>; stdin?: string } = {}
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", [join(REPO_ROOT, "cli/src/index.ts"), ...args], {
      cwd: opts.cwd ?? REPO_ROOT,
      env: { ...process.env, ...opts.env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    if (opts.stdin !== undefined) {
      child.stdin.write(opts.stdin);
      child.stdin.end();
    }
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

afterAll(cleanupIsolationDirs);

describe("requireClient resolution (env + saved-login fallbacks)", () => {
  let server: Server;
  let base = "";
  let seenUrls: string[] = [];
  let seenAuth: string[] = [];

  beforeAll(async () => {
    seenUrls = [];
    seenAuth = [];
    server = createServer((req, res) => {
      seenUrls.push(req.url ?? "");
      seenAuth.push(req.headers.authorization ?? "");
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

  function writeLogin(lexaDir: string, host: string, url: string, apiKey: string): void {
    // Saved logins live in the group of their server URL: 127.0.0.1:<port> →
    // <LEXA_DIR>/localhost:<port>/config.json.
    mkdirSync(join(lexaDir, host), { recursive: true });
    writeFileSync(join(lexaDir, host, "config.json"), JSON.stringify({ url, apiKey }));
  }

  it("uses a single saved login env-free; several without a marker error listing hosts", async () => {
    const lexaDir = freshLexaDir();
    writeLogin(lexaDir, `localhost:${new URL(base).port}`, base, "lxk_saved_key_1234567890123456789012345678901234567890");
    const ok = await runCli(["status"], { LEXA_URL: "", LEXA_API_KEY: "", LEXA_DIR: lexaDir });
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain("Server:   reachable (health ok)");

    const p = new URL(base).port;
    const two = freshLexaDir();
    writeLogin(two, `localhost:${p}`, base, "lxk_a_key_123456789012345678901234567890123456789012");
    writeLogin(two, "other.example.com", "http://other.example.com", "lxk_b_key_123456789012345678901234567890123456789012");
    const r = await runCli(["status"], { LEXA_URL: "", LEXA_API_KEY: "", LEXA_DIR: two });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Multiple saved logins");
    expect(r.stderr).toContain(`localhost:${p}`);
    expect(r.stderr).toContain("other.example.com");
    expect(r.stderr).toContain("--url");
  });

  it("active marker selects the host among several saved logins", async () => {
    const lexaDir = freshLexaDir();
    const p = new URL(base).port;
    const activeHost = `localhost:${p}`;
    const activeKey = "lxk_active_key_1234567890123456789012345678901234567890";
    writeLogin(lexaDir, activeHost, base, activeKey);
    writeLogin(lexaDir, "other.example.com", "http://other.example.com", "lxk_other_key_12345678901234567890123456789012345678901");
    writeFileSync(join(lexaDir, ".active"), `${activeHost}\n`);
    seenAuth = [];
    const r = await runCli(["status"], { LEXA_URL: "", LEXA_API_KEY: "", LEXA_DIR: lexaDir });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Host:");
    expect(r.stdout).toContain(base);
    expect(seenAuth).toContain(`Bearer ${activeKey}`);
  });

  it("--url X uses X's saved key, never another host's LEXA_API_KEY", async () => {
    const lexaDir = freshLexaDir();
    const p = new URL(base).port;
    const savedKey = "lxk_saved_key_1234567890123456789012345678901234567890";
    const envKey = "lxk_env_key_12345678901234567890123456789012345678901";
    writeLogin(lexaDir, `localhost:${p}`, base, savedKey);
    seenAuth = [];
    const r = await runCli(["status", "--url", base], { LEXA_URL: "http://other.example.com", LEXA_API_KEY: envKey, LEXA_DIR: lexaDir });
    expect(r.status).toBe(0);
    expect(seenAuth).toContain(`Bearer ${savedKey}`);
    expect(seenAuth).not.toContain(`Bearer ${envKey}`);
  });

  it("--url X without a matching saved login → NotLoggedIn and zero requests (no key leak)", async () => {
    const envKey = "lxk_env_key_12345678901234567890123456789012345678901";
    const withOther = freshLexaDir();
    writeLogin(withOther, "other.example.com", "http://other.example.com", "lxk_other_key_12345678901234567890123456789012345678901");
    seenAuth = [];
    const r1 = await runCli(["status", "--url", base], { LEXA_URL: "http://other.example.com", LEXA_API_KEY: envKey, LEXA_DIR: withOther });
    expect(r1.status).toBe(1);
    expect(r1.stderr).toContain("Not logged in");
    expect(seenAuth).not.toContain(`Bearer ${envKey}`);
    expect(seenAuth).toEqual([]);

    const none = freshLexaDir();
    const r2 = await runCli(["status", "--url", base], { LEXA_URL: "http://other.example.com", LEXA_API_KEY: envKey, LEXA_DIR: none });
    expect(r2.status).toBe(1);
    expect(r2.stderr).toContain("Not logged in");
    expect(seenAuth).toEqual([]);
  });

  it("LEXA_URL wins over the saved key and over the active marker", async () => {
    const lexaDir = freshLexaDir();
    const p = new URL(base).port;
    const savedKey = "lxk_saved_key_1234567890123456789012345678901234567890";
    const envKey = "lxk_env_key_12345678901234567890123456789012345678901";
    writeLogin(lexaDir, `localhost:${p}`, base, savedKey);
    seenAuth = [];
    const r1 = await runCli(["status"], { LEXA_URL: base, LEXA_API_KEY: envKey, LEXA_DIR: lexaDir });
    expect(r1.status).toBe(0);
    expect(seenAuth).toContain(`Bearer ${envKey}`);
    expect(seenAuth).not.toContain(`Bearer ${savedKey}`);

    const envHostKey = "lxk_envhost_key_1234567890123456789012345678901234567890";
    const activeKey = "lxk_active_key_12345678901234567890123456789012345678901";
    writeLogin(lexaDir, "active.example.com", "http://active.example.com", activeKey);
    writeFileSync(join(lexaDir, ".active"), "active.example.com\n");
    writeLogin(lexaDir, `localhost:${p}`, base, envHostKey);
    seenAuth = [];
    const r2 = await runCli(["status"], { LEXA_URL: base, LEXA_API_KEY: "", LEXA_DIR: lexaDir });
    expect(r2.status).toBe(0);
    expect(r2.stdout).toContain(`Host:     ${base}`);
    expect(seenAuth).toContain(`Bearer ${envHostKey}`);
    expect(seenAuth).not.toContain(`Bearer ${activeKey}`);
  });

  it("stale active marker falls back to the single saved login, else NotLoggedIn", async () => {
    const lexaDir = freshLexaDir();
    const p = new URL(base).port;
    writeLogin(lexaDir, `localhost:${p}`, base, "lxk_single_key_1234567890123456789012345678901234567890");
    writeFileSync(join(lexaDir, ".active"), "gone.example.com\n");
    const r = await runCli(["status"], { LEXA_URL: "", LEXA_API_KEY: "", LEXA_DIR: lexaDir });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Host:");
    expect(r.stdout).toContain(base);

    const none = freshLexaDir();
    writeFileSync(join(none, ".active"), "gone.example.com\n");
    const r2 = await runCli(["status"], { LEXA_URL: "", LEXA_API_KEY: "", LEXA_DIR: none });
    expect(r2.status).toBe(1);
    expect(r2.stderr).toContain("Not logged in");
  });

  it("logout targets the active host, leaves siblings, and errors listing hosts with no marker", async () => {
    const lexaDir = freshLexaDir();
    const p = new URL(base).port;
    const activeHost = `localhost:${p}`;
    writeLogin(lexaDir, activeHost, base, "lxk_a");
    writeLogin(lexaDir, "other.example.com", "http://other.example.com", "lxk_b");
    writeFileSync(join(lexaDir, ".active"), `${activeHost}\n`);
    const r = await runCli(["logout"], { LEXA_URL: "", LEXA_API_KEY: "", LEXA_DIR: lexaDir });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`Logged out ${activeHost}`);
    expect(existsSync(join(lexaDir, activeHost, "config.json"))).toBe(false);
    expect(existsSync(join(lexaDir, "other.example.com", "config.json"))).toBe(true);
    expect(existsSync(join(lexaDir, ".active"))).toBe(false);

    const two = freshLexaDir();
    writeLogin(two, "a.example.com", "http://a.example.com", "lxk_a");
    writeLogin(two, "b.example.com", "http://b.example.com", "lxk_b");
    const r2 = await runCli(["logout"], { LEXA_URL: "", LEXA_API_KEY: "", LEXA_DIR: two });
    expect(r2.status).toBe(1);
    expect(r2.stderr).toContain("Multiple saved logins");
    expect(r2.stderr).toContain("a.example.com");
    expect(r2.stderr).toContain("b.example.com");
  });

  it("logout --all clears every login plus the marker; logout clears a raw (unnormalized) group dir", async () => {
    const lexaDir = freshLexaDir();
    const p = new URL(base).port;
    const activeHost = `localhost:${p}`;
    writeLogin(lexaDir, activeHost, base, "lxk_a");
    writeLogin(lexaDir, "other.example.com", "http://other.example.com", "lxk_b");
    writeFileSync(join(lexaDir, ".active"), `${activeHost}\n`);
    const r = await runCli(["logout", "--all"], { LEXA_URL: "", LEXA_API_KEY: "", LEXA_DIR: lexaDir });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`Logged out ${activeHost}`);
    expect(r.stdout).toContain("Logged out other.example.com");
    expect(existsSync(join(lexaDir, activeHost, "config.json"))).toBe(false);
    expect(existsSync(join(lexaDir, "other.example.com", "config.json"))).toBe(false);
    expect(existsSync(join(lexaDir, ".active"))).toBe(false);

    const raw = freshLexaDir();
    mkdirSync(join(raw, "127.0.0.1"), { recursive: true });
    writeFileSync(join(raw, "127.0.0.1", "config.json"), JSON.stringify({ url: "http://127.0.0.1", apiKey: "lxk_a" }));
    const r2 = await runCli(["logout", "--url", "http://127.0.0.1"], { LEXA_URL: "", LEXA_API_KEY: "", LEXA_DIR: raw });
    expect(r2.status).toBe(0);
    expect(r2.stdout).toContain("Logged out 127.0.0.1");
    expect(existsSync(join(raw, "127.0.0.1", "config.json"))).toBe(false);
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

  it("legacy --url --key login: validates, saves config, records the active host", async () => {
    const lexaDir = freshLexaDir();
    const r = await runCli(["login", "--url", base, "--key", legacyKey], { LEXA_DIR: lexaDir });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`Logged in to ${base}`);
    expect(savedConfig(lexaDir)).toEqual({ url: base, apiKey: legacyKey });
    expect(readFileSync(join(lexaDir, ".active"), "utf-8").trim()).toBe(`localhost:${new URL(base).port}`);
  });

  it("device flow happy path: verify URL + backup code printed, pending → approved, config saved", async () => {
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
    expect(readFileSync(join(lexaDir, ".active"), "utf-8").trim()).toBe(`localhost:${new URL(base).port}`);
    // Poll deadline honors the server expiresMs plus a small grace.
    const now = 1_000_000;
    expect(devicePollDeadline(now + 10 * 60 * 1000, now)).toBe(now + 10 * 60 * 1000 + 10 * 1000);
  });

  it("device flow failures: denied, expired, and an old server → exit 1 with a clear message", async () => {
    pollQueue = [{ status: 403, body: { error: { code: "DEVICE_LOGIN_DENIED", message: "Login request denied" } } }];
    const denied = await runCli(["login", base], { LEXA_URL: "", LEXA_API_KEY: "" });
    expect(denied.status).toBe(1);
    expect(denied.stderr).toContain("denied");

    pollQueue = [{ status: 410, body: { error: { code: "DEVICE_LOGIN_EXPIRED", message: "Login request expired" } } }];
    const expired = await runCli(["login", base], { LEXA_URL: "", LEXA_API_KEY: "" });
    expect(expired.status).toBe(1);
    expect(expired.stderr).toContain("expired");

    pollQueue = [{ status: 404, body: { error: { code: "DEVICE_LOGIN_NOT_FOUND", message: "not found" } } }];
    const old = await runCli(["login", base], { LEXA_URL: "", LEXA_API_KEY: "" });
    expect(old.status).toBe(1);
    expect(old.stderr).toContain("does not support device login");
    expect(old.stderr).toContain("lx login --key <lxk_...>");
  });
});

describe("module import (in-worker)", () => {
  it("importing index.ts is inert — no exit, no help dump, exports available", () => {
    // If the import.meta.main guard were missing, this import would have
    // printed HELP and called process.exit(0).
    expect(typeof NotLoggedIn).toBe("function");
    const err = new NotLoggedIn();
    expect(err.message).toContain("Not logged in. Run: lx login");
  });
});

describe("skill install (bun subprocess)", () => {
  it("non-TTY without a target refuses; --global and --local write the embedded SKILL.md", async () => {
    const noTarget = await runSkillCli(["skill", "install"]);
    expect(noTarget.status).toBe(1);
    expect(noTarget.stderr).toContain("target is required");
    expect(noTarget.stderr).toContain("Usage: lx skill install [--global | --local] [--force]");

    const home = freshDir("lx-skill-home-");
    const glob = await runSkillCli(["skill", "install", "--global"], { env: { HOME: home } });
    expect(glob.status).toBe(0);
    const globalPath = join(home, ".agents/skills/lexa-cli/SKILL.md");
    expect(existsSync(globalPath)).toBe(true);
    expect(readFileSync(globalPath, "utf-8")).toContain("name: lexa-cli");
    expect(readFileSync(globalPath, "utf-8")).toContain("lx skill install");
    expect(glob.stdout).toContain(globalPath);

    const cwd = freshDir("lx-skill-cwd-");
    const loc = await runSkillCli(["skill", "install", "--local"], { cwd });
    expect(loc.status).toBe(0);
    const localPath = join(cwd, ".agents/skills/lexa-cli/SKILL.md");
    expect(existsSync(localPath)).toBe(true);
    expect(readFileSync(localPath, "utf-8")).toContain("name: lexa-cli");
    expect(loc.stdout).toContain(localPath);
  });

  it("refuses to clobber without --force, overwrites with --force, rejects --global+--local", async () => {
    const cwd = freshDir("lx-skill-cwd-");
    const path = join(cwd, ".agents/skills/lexa-cli/SKILL.md");
    mkdirSync(join(cwd, ".agents/skills/lexa-cli"), { recursive: true });
    writeFileSync(path, "pre-existing\n");
    const refused = await runSkillCli(["skill", "install", "--local"], { cwd });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("already exists");
    expect(refused.stderr).toContain("--force");
    expect(readFileSync(path, "utf-8")).toBe("pre-existing\n");

    const forced = await runSkillCli(["skill", "install", "--local", "--force"], { cwd });
    expect(forced.status).toBe(0);
    expect(readFileSync(path, "utf-8")).toContain("name: lexa-cli");

    const both = await runSkillCli(["skill", "install", "--global", "--local"]);
    expect(both.status).toBe(1);
    expect(both.stderr).toContain("Usage: lx skill install");
  });
});
