// cli/index.ts — command dispatch + requireClient resolution, exercised
// through the REAL entry point as a bun subprocess (the module self-executes
// only under import.meta.main; in-worker it must be inert). A local http
// server stands in for the Lexa API for the env/saved-login fallback tests.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NotLoggedIn, devicePollDeadline, nextDevicePollDelayMs } from "./index";
import { cleanupIsolationDirs, freshLexaDir, runCli } from "./test-utils";

afterAll(cleanupIsolationDirs);

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

  it("two saved logins with no active marker → error listing hosts, no alphabetical pick", async () => {
    const lexaDir = freshLexaDir();
    const p = new URL(base).port;
    mkdirSync(join(lexaDir, `localhost:${p}`), { recursive: true });
    writeFileSync(join(lexaDir, `localhost:${p}`, "config.json"), JSON.stringify({ url: base, apiKey: "lxk_a_key_123456789012345678901234567890123456789012" }));
    mkdirSync(join(lexaDir, "other.example.com"), { recursive: true });
    writeFileSync(join(lexaDir, "other.example.com", "config.json"), JSON.stringify({ url: "http://other.example.com", apiKey: "lxk_b_key_123456789012345678901234567890123456789012" }));
    const r = await runCli(["status"], { LEXA_URL: "", LEXA_API_KEY: "", LEXA_DIR: lexaDir });
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
    mkdirSync(join(lexaDir, activeHost), { recursive: true });
    writeFileSync(join(lexaDir, activeHost, "config.json"), JSON.stringify({ url: base, apiKey: activeKey }));
    mkdirSync(join(lexaDir, "other.example.com"), { recursive: true });
    writeFileSync(join(lexaDir, "other.example.com", "config.json"), JSON.stringify({ url: "http://other.example.com", apiKey: "lxk_other_key_12345678901234567890123456789012345678901" }));
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
    mkdirSync(join(lexaDir, `localhost:${p}`), { recursive: true });
    writeFileSync(join(lexaDir, `localhost:${p}`, "config.json"), JSON.stringify({ url: base, apiKey: savedKey }));
    seenAuth = [];
    const r = await runCli(["status", "--url", base], { LEXA_URL: "http://other.example.com", LEXA_API_KEY: envKey, LEXA_DIR: lexaDir });
    expect(r.status).toBe(0);
    expect(seenAuth).toContain(`Bearer ${savedKey}`);
    expect(seenAuth).not.toContain(`Bearer ${envKey}`);
  });

  it("matching LEXA_URL + saved login: the env key wins over the saved key", async () => {
    const lexaDir = freshLexaDir();
    const p = new URL(base).port;
    const savedKey = "lxk_saved_key_1234567890123456789012345678901234567890";
    const envKey = "lxk_env_key_12345678901234567890123456789012345678901";
    mkdirSync(join(lexaDir, `localhost:${p}`), { recursive: true });
    writeFileSync(join(lexaDir, `localhost:${p}`, "config.json"), JSON.stringify({ url: base, apiKey: savedKey }));
    seenAuth = [];
    const r = await runCli(["status"], { LEXA_URL: base, LEXA_API_KEY: envKey, LEXA_DIR: lexaDir });
    expect(r.status).toBe(0);
    expect(seenAuth).toContain(`Bearer ${envKey}`);
    expect(seenAuth).not.toContain(`Bearer ${savedKey}`);
  });

  it("--url X with no saved login and a non-matching LEXA_URL does not borrow LEXA_API_KEY", async () => {
    const lexaDir = freshLexaDir();
    mkdirSync(join(lexaDir, "other.example.com"), { recursive: true });
    writeFileSync(join(lexaDir, "other.example.com", "config.json"), JSON.stringify({ url: "http://other.example.com", apiKey: "lxk_other_key_12345678901234567890123456789012345678901" }));
    const r = await runCli(["status", "--url", base], { LEXA_URL: "http://other.example.com", LEXA_API_KEY: "lxk_env_key_12345678901234567890123456789012345678901", LEXA_DIR: lexaDir });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Not logged in");
  });

  it("zero saved logins + LEXA_URL on another host + --url <base> does not leak LEXA_API_KEY", async () => {
    const lexaDir = freshLexaDir();
    const envKey = "lxk_env_key_12345678901234567890123456789012345678901";
    seenAuth = [];
    const r = await runCli(["status", "--url", base], { LEXA_URL: "http://other.example.com", LEXA_API_KEY: envKey, LEXA_DIR: lexaDir });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Not logged in");
    expect(seenAuth).not.toContain(`Bearer ${envKey}`);
    expect(seenAuth).toEqual([]);
  });

  it("LEXA_URL beats the active marker when choosing the host", async () => {
    const lexaDir = freshLexaDir();
    const p = new URL(base).port;
    const envHost = `localhost:${p}`;
    const envHostKey = "lxk_envhost_key_1234567890123456789012345678901234567890";
    mkdirSync(join(lexaDir, envHost), { recursive: true });
    writeFileSync(join(lexaDir, envHost, "config.json"), JSON.stringify({ url: base, apiKey: envHostKey }));
    mkdirSync(join(lexaDir, "active.example.com"), { recursive: true });
    writeFileSync(join(lexaDir, "active.example.com", "config.json"), JSON.stringify({ url: "http://active.example.com", apiKey: "lxk_active_key_12345678901234567890123456789012345678901" }));
    writeFileSync(join(lexaDir, ".active"), "active.example.com\n");
    seenAuth = [];
    const r = await runCli(["status"], { LEXA_URL: base, LEXA_API_KEY: "", LEXA_DIR: lexaDir });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`Host:     ${base}`);
    expect(seenAuth).toContain(`Bearer ${envHostKey}`);
    expect(seenAuth).not.toContain("Bearer lxk_active_key_12345678901234567890123456789012345678901");
  });

  it("stale active marker (config gone) falls back to the single saved login", async () => {
    const lexaDir = freshLexaDir();
    const p = new URL(base).port;
    mkdirSync(join(lexaDir, `localhost:${p}`), { recursive: true });
    writeFileSync(join(lexaDir, `localhost:${p}`, "config.json"), JSON.stringify({ url: base, apiKey: "lxk_single_key_1234567890123456789012345678901234567890" }));
    writeFileSync(join(lexaDir, ".active"), "gone.example.com\n");
    const r = await runCli(["status"], { LEXA_URL: "", LEXA_API_KEY: "", LEXA_DIR: lexaDir });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Host:");
    expect(r.stdout).toContain(base);
  });

  it("stale active marker with no saved logins and no env → NotLoggedIn", async () => {
    const lexaDir = freshLexaDir();
    writeFileSync(join(lexaDir, ".active"), "gone.example.com\n");
    const r = await runCli(["status"], { LEXA_URL: "", LEXA_API_KEY: "", LEXA_DIR: lexaDir });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Not logged in");
  });

  it("logout targets the active host and prints it; siblings survive", async () => {
    const lexaDir = freshLexaDir();
    const p = new URL(base).port;
    const activeHost = `localhost:${p}`;
    mkdirSync(join(lexaDir, activeHost), { recursive: true });
    writeFileSync(join(lexaDir, activeHost, "config.json"), JSON.stringify({ url: base, apiKey: "lxk_a" }));
    mkdirSync(join(lexaDir, "other.example.com"), { recursive: true });
    writeFileSync(join(lexaDir, "other.example.com", "config.json"), JSON.stringify({ url: "http://other.example.com", apiKey: "lxk_b" }));
    writeFileSync(join(lexaDir, ".active"), `${activeHost}\n`);
    const r = await runCli(["logout"], { LEXA_URL: "", LEXA_API_KEY: "", LEXA_DIR: lexaDir });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`Logged out ${activeHost}`);
    expect(existsSync(join(lexaDir, activeHost, "config.json"))).toBe(false);
    expect(existsSync(join(lexaDir, "other.example.com", "config.json"))).toBe(true);
    expect(existsSync(join(lexaDir, ".active"))).toBe(false);
  });

  it("logout --all clears every saved login and the active marker", async () => {
    const lexaDir = freshLexaDir();
    const p = new URL(base).port;
    const activeHost = `localhost:${p}`;
    mkdirSync(join(lexaDir, activeHost), { recursive: true });
    writeFileSync(join(lexaDir, activeHost, "config.json"), JSON.stringify({ url: base, apiKey: "lxk_a" }));
    mkdirSync(join(lexaDir, "other.example.com"), { recursive: true });
    writeFileSync(join(lexaDir, "other.example.com", "config.json"), JSON.stringify({ url: "http://other.example.com", apiKey: "lxk_b" }));
    writeFileSync(join(lexaDir, ".active"), `${activeHost}\n`);
    const r = await runCli(["logout", "--all"], { LEXA_URL: "", LEXA_API_KEY: "", LEXA_DIR: lexaDir });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`Logged out ${activeHost}`);
    expect(r.stdout).toContain("Logged out other.example.com");
    expect(existsSync(join(lexaDir, activeHost, "config.json"))).toBe(false);
    expect(existsSync(join(lexaDir, "other.example.com", "config.json"))).toBe(false);
    expect(existsSync(join(lexaDir, ".active"))).toBe(false);
  });

  it("logout with several logins and no active marker errors listing hosts", async () => {
    const lexaDir = freshLexaDir();
    mkdirSync(join(lexaDir, "a.example.com"), { recursive: true });
    writeFileSync(join(lexaDir, "a.example.com", "config.json"), JSON.stringify({ url: "http://a.example.com", apiKey: "lxk_a" }));
    mkdirSync(join(lexaDir, "b.example.com"), { recursive: true });
    writeFileSync(join(lexaDir, "b.example.com", "config.json"), JSON.stringify({ url: "http://b.example.com", apiKey: "lxk_b" }));
    const r = await runCli(["logout"], { LEXA_URL: "", LEXA_API_KEY: "", LEXA_DIR: lexaDir });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Multiple saved logins");
    expect(r.stderr).toContain("a.example.com");
    expect(r.stderr).toContain("b.example.com");
  });

  it("logout --url <host> removes that host's login even when it is not active", async () => {
    const lexaDir = freshLexaDir();
    const p = new URL(base).port;
    const target = `localhost:${p}`;
    mkdirSync(join(lexaDir, target), { recursive: true });
    writeFileSync(join(lexaDir, target, "config.json"), JSON.stringify({ url: base, apiKey: "lxk_a" }));
    mkdirSync(join(lexaDir, "other.example.com"), { recursive: true });
    writeFileSync(join(lexaDir, "other.example.com", "config.json"), JSON.stringify({ url: "http://other.example.com", apiKey: "lxk_b" }));
    const r = await runCli(["logout", "--url", base], { LEXA_URL: "", LEXA_API_KEY: "", LEXA_DIR: lexaDir });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(target);
    expect(existsSync(join(lexaDir, target, "config.json"))).toBe(false);
    expect(existsSync(join(lexaDir, "other.example.com", "config.json"))).toBe(true);
  });

  it("logout without --url but with LEXA_URL targets that host among several logins", async () => {
    const lexaDir = freshLexaDir();
    const p = new URL(base).port;
    const target = `localhost:${p}`;
    mkdirSync(join(lexaDir, target), { recursive: true });
    writeFileSync(join(lexaDir, target, "config.json"), JSON.stringify({ url: base, apiKey: "lxk_a" }));
    mkdirSync(join(lexaDir, "other.example.com"), { recursive: true });
    writeFileSync(join(lexaDir, "other.example.com", "config.json"), JSON.stringify({ url: "http://other.example.com", apiKey: "lxk_b" }));
    const r = await runCli(["logout"], { LEXA_URL: base, LEXA_API_KEY: "", LEXA_DIR: lexaDir });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`Logged out ${target}`);
    expect(existsSync(join(lexaDir, target, "config.json"))).toBe(false);
    expect(existsSync(join(lexaDir, "other.example.com", "config.json"))).toBe(true);
  });

  it("logout clears a login stored under a raw (unnormalized) group dir", async () => {
    const lexaDir = freshLexaDir();
    const raw = join(lexaDir, "127.0.0.1");
    mkdirSync(raw, { recursive: true });
    writeFileSync(join(raw, "config.json"), JSON.stringify({ url: "http://127.0.0.1", apiKey: "lxk_a" }));
    const r = await runCli(["logout", "--url", "http://127.0.0.1"], { LEXA_URL: "", LEXA_API_KEY: "", LEXA_DIR: lexaDir });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Logged out 127.0.0.1");
    expect(existsSync(join(raw, "config.json"))).toBe(false);
  });

  it("logout --url <host> with no saved login reports nothing to remove and leaves the marker", async () => {
    const lexaDir = freshLexaDir();
    writeFileSync(join(lexaDir, ".active"), "keep.example.com\n");
    const r = await runCli(["logout", "--url", "http://nobody.example.com"], { LEXA_URL: "", LEXA_API_KEY: "", LEXA_DIR: lexaDir });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Not logged in for nobody.example.com");
    expect(existsSync(join(lexaDir, ".active"))).toBe(true);
  });

  it("logout --all with zero logins reports nothing to remove", async () => {
    const lexaDir = freshLexaDir();
    const r = await runCli(["logout", "--all"], { LEXA_URL: "", LEXA_API_KEY: "", LEXA_DIR: lexaDir });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("nothing to remove");
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
    expect(readFileSync(join(lexaDir, ".active"), "utf-8").trim()).toBe(`localhost:${new URL(base).port}`);
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

describe("device poll deadline", () => {
  const now = 1_000_000;
  const MIN = 60 * 1000;

  it("honors the server expiresMs plus a small grace", () => {
    expect(devicePollDeadline(now + 10 * MIN, now)).toBe(now + 10 * MIN + 10 * 1000);
  });

  it("clamps an absurd far-future expiresMs to the max window", () => {
    expect(devicePollDeadline(now + 24 * 60 * MIN, now)).toBe(now + 30 * MIN);
  });

  it("falls back to the 5-minute constant when expiresMs is absent or nonsensical", () => {
    expect(devicePollDeadline(undefined, now)).toBe(now + 5 * MIN);
    expect(devicePollDeadline(Number.NaN, now)).toBe(now + 5 * MIN);
    expect(devicePollDeadline(now - 1000, now)).toBe(now + 5 * MIN);
  });
});

describe("device poll backoff", () => {
  // rand() === 0.5 yields the exact base delay (no jitter).
  const mid = () => 0.5;

  it("grows 2s -> 5s -> 10s and stays capped at 10s", () => {
    expect(nextDevicePollDelayMs(0, mid)).toBe(2000);
    expect(nextDevicePollDelayMs(1, mid)).toBe(5000);
    expect(nextDevicePollDelayMs(2, mid)).toBe(10_000);
    expect(nextDevicePollDelayMs(3, mid)).toBe(10_000);
    expect(nextDevicePollDelayMs(50, mid)).toBe(10_000);
  });

  it("keeps jitter within ±20% of the base delay", () => {
    const bases = [2000, 5000, 10_000, 10_000, 10_000];
    for (let attempt = 0; attempt < bases.length; attempt++) {
      const base = bases[attempt]!;
      expect(nextDevicePollDelayMs(attempt, () => 0)).toBe(Math.round(base * 0.8));
      expect(nextDevicePollDelayMs(attempt, () => 1)).toBe(Math.round(base * 1.2));
      for (const r of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
        const d = nextDevicePollDelayMs(attempt, () => r);
        expect(d).toBeGreaterThanOrEqual(Math.round(base * 0.8));
        expect(d).toBeLessThanOrEqual(Math.round(base * 1.2));
      }
    }
  });

  it("clamps negative and fractional attempts to the first delay", () => {
    expect(nextDevicePollDelayMs(-1, mid)).toBe(2000);
    expect(nextDevicePollDelayMs(0.9, mid)).toBe(2000);
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
