// cli/index.ts — command dispatch + requireClient resolution, exercised
// through the REAL entry point as a bun subprocess (the module self-executes
// only under import.meta.main; in-worker it must be inert). A local http
// server stands in for the Lexa API for the env/saved-login fallback tests.
// NOTE: the subprocess is spawned ASYNC — spawnSync would block this worker's
// event loop and the in-process fake server could never accept connections.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    expect(r.stdout).toContain("Usage: lexa-cli <command> [options]");
  });

  it("prints the CLI version", async () => {
    const r = await runCli(["--version"]);
    expect(r.status).toBe(0);
    const pkg = await import("../package.json");
    expect(r.stdout.trim()).toBe(`lexa-cli ${pkg.version}`);
  });

  it("rejects an unknown command with usage + exit 1", async () => {
    const r = await runCli(["bogus"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Unknown command: bogus");
    expect(r.stdout).toContain("Usage: lexa-cli <command> [options]");
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
    expect(r.stderr).toContain("Not logged in. Run: lexa-cli login");
  });

  it("machine install --no-systemd prints the supervisor instructions", async () => {
    const r = await runCli(["machine", "install", "--no-systemd"], {
      LEXA_URL: "http://127.0.0.1:1",
      LEXA_API_KEY: "lxk_key_1234567890123456789012345678901234567890",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Start the machine listener under your supervisor:");
  });

  it("github status validates an env file without needing login", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lexa-index-"));
    const pem = join(dir, "app-key.pem");
    writeFileSync(pem, "-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n", { mode: 0o600 });
    writeFileSync(join(dir, ".env"), `GITHUB_APP_ID=123\nGITHUB_PRIVATE_KEY_FILE=${pem}\nGITHUB_WEBHOOK_SECRET=0123456789abcdef\n`);
    const r = await runCli(["github", "status", "--env-file", join(dir, ".env")]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Config looks complete");
    rmSync(dir, { recursive: true, force: true });
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

  it("saved login (config.json) is used when env vars are absent", async () => {
    const lexaDir = freshLexaDir();
    writeFileSync(join(lexaDir, "config.json"), JSON.stringify({ url: base, apiKey: "lxk_saved_key_1234567890123456789012345678901234567890" }));
    const r = await runCli(["status"], { LEXA_URL: "", LEXA_API_KEY: "", LEXA_DIR: lexaDir });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Server:   reachable (health ok)");
  });

  it("flags override the saved login", async () => {
    const lexaDir = freshLexaDir();
    writeFileSync(join(lexaDir, "config.json"), JSON.stringify({ url: "http://127.0.0.1:1", apiKey: "lxk_wrong_key_1234567890123456789012345678901234567890" }));
    const r = await runCli(["status", "--url", base, "--key", "lxk_flag_key_1234567890123456789012345678901234567890"], { LEXA_DIR: lexaDir });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Server:   reachable (health ok)");
  });
});

describe("module import (in-worker)", () => {
  it("importing index.ts is inert — no exit, no help dump, exports available", async () => {
    // If the import.meta.main guard were missing, this import would have
    // printed HELP and called process.exit(0).
    expect(typeof NotLoggedIn).toBe("function");
    const err = new NotLoggedIn();
    expect(err.message).toContain("Not logged in. Run: lexa-cli login");
  });
});
