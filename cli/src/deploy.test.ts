// cli/deploy.ts process-bound surfaces: materializeCompose (embedded compose
// files → deploy dir), runCompose (docker compose invocation), and the full
// cmdDeploy flow with the process/network boundary mocked (spawnSync + fetch
// stubs, tmp HOME/LEXA_DIR, stdin-driven --clean confirmation).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Effect, Layer, Context } from "effect";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

const childMocks = vi.hoisted(() => ({
  spawnSyncCalls: [] as Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }>,
  spawnSyncStatus: 0,
}));

// packed-compose is real by default; the fallback tests flip `empty` so
// materializeCompose exercises its repo-cwd path.
const composeMocks = vi.hoisted(() => ({ empty: false }));

// CF request recorder (the cmdUndeploy tests seed existing resources so the
// DELETE paths run).
const cfMocks = vi.hoisted(() => ({
  requests: [] as Array<{ url: string; method: string; body: string }>,
  dnsList: [] as Array<{ id: string }>,
  tunnelList: [] as Array<{ id: string }>,
}));

vi.mock("./packed-compose", async () => {
  const real = await vi.importActual<typeof import("./packed-compose")>("./packed-compose");
  // Getter reads the flag at access time — the factory result is cached per
  // module id, so a static object would freeze the first test's choice.
  return { get COMPOSE_FILES(): Record<string, string> { return composeMocks.empty ? {} : real.COMPOSE_FILES; } };
});

vi.mock("node:child_process", () => ({
  spawnSync: (cmd: string, args: string[], opts: Record<string, unknown>) => {
    childMocks.spawnSyncCalls.push({ cmd, args, opts });
    return { status: childMocks.spawnSyncStatus, stdout: "", stderr: "", signal: null, pid: 1 };
  },
}));

let homeDir = "";
let lexaDir = "";
let cwd = "";

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), "lexa-deploy-home-"));
  lexaDir = mkdtempSync(join(tmpdir(), "lexa-deploy-lexa-"));
  process.env.HOME = homeDir;
  process.env.LEXA_DIR = lexaDir;
  cwd = process.cwd();
  childMocks.spawnSyncCalls.length = 0;
  childMocks.spawnSyncStatus = 0;
  cfMocks.requests.length = 0;
  cfMocks.dnsList = [];
  cfMocks.tunnelList = [];
  vi.resetModules();
});

afterEach(() => {
  process.chdir(cwd);
  delete process.env.HOME;
  delete process.env.LEXA_DIR;
  composeMocks.empty = false;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (homeDir) rmSync(homeDir, { recursive: true, force: true });
  if (lexaDir) rmSync(lexaDir, { recursive: true, force: true });
});

function cfResponse(result: unknown): Response {
  return new Response(JSON.stringify({ success: true, result }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function stubCfApi(): void {
  vi.stubGlobal("fetch", (url: string | URL, init?: RequestInit) => {
    const full = String(url);
    const path = new URL(url).pathname + new URL(url).search;
    const method = init?.method ?? "GET";
    cfMocks.requests.push({ url: full, method, body: typeof init?.body === "string" ? init.body : "" });
    let result: unknown = {};
    if (path.includes("/cfd_tunnel") && path.includes("/token")) result = { token: "tok1" };
    else if (path.includes("/cfd_tunnel") && path.includes("/configurations")) result = {};
    else if (path.includes("/cfd_tunnel")) result = method === "GET" ? cfMocks.tunnelList : { id: "tun1" };
    else if (path.includes("/dns_records")) result = method === "GET" ? cfMocks.dnsList : {};
    else if (path.includes("/zones")) result = [{ id: "zone1" }];
    else if (path.includes("/accounts")) result = [{ id: "acc1" }];
    return Promise.resolve(cfResponse(result));
  });
}

const DEPLOY_FLAGS = {
  "deploy-dir": "", // filled per test
  "cf-token": "cf-tok",
  "admin-email": "admin@example.com",
  "api-key": "lxk_test_key_1234567890123456789012345678901234567890",
};

describe("materializeCompose", () => {
  it("writes only the flavor's compose files (gunzipped) to --deploy-dir", async () => {
    const mod = await import("./deploy");
    const deployDir = mkdtempSync(join(tmpdir(), "lexa-deploy-dir-"));
    const out = mod.materializeCompose("prod", { "deploy-dir": deployDir }, "example.com");
    expect(out).toBe(deployDir);
    const files = readdirSync(deployDir).sort();
    expect(files).toEqual(["docker-compose.yml", "docker-compose.prod.yml"].sort());
    expect(existsSync(join(deployDir, "docker-compose.staging.yml"))).toBe(false);
    const base = readFileSync(join(deployDir, "docker-compose.yml"), "utf-8");
    expect(base.length).toBeGreaterThan(100);
    expect(base).toMatch(/services:/);
    rmSync(deployDir, { recursive: true, force: true });
  });

  it("defaults to the domain group deploy dir under LEXA_DIR", async () => {
    const mod = await import("./deploy");
    const out = mod.materializeCompose("prod", {}, "example.com");
    expect(out).toBe(join(lexaDir, "example.com", "deploy"));
    expect(existsSync(join(out, "docker-compose.yml"))).toBe(true);
  });

  it("falls back to the repo cwd when no compose files are embedded", async () => {
    composeMocks.empty = true;
    vi.resetModules();
    const mod = await import("./deploy");
    const repo = mkdtempSync(join(tmpdir(), "lexa-deploy-repo-"));
    writeFileSync(join(repo, "docker-compose.yml"), "services: {}\n");
    process.chdir(repo);
    expect(mod.materializeCompose("prod", {}, "example.com")).toBe(repo);
    process.chdir(cwd);
    rmSync(repo, { recursive: true, force: true });
  });

  it("throws when neither embedded files nor a repo checkout exist", async () => {
    composeMocks.empty = true;
    vi.resetModules();
    const mod = await import("./deploy");
    const empty = mkdtempSync(join(tmpdir(), "lexa-deploy-empty-"));
    process.chdir(empty);
    expect(() => mod.materializeCompose("prod", {}, "example.com")).toThrow(/no embedded compose files/);
    process.chdir(cwd);
    rmSync(empty, { recursive: true, force: true });
  });
});

describe("runCompose", () => {
  it("fails with the repo-root error when docker-compose.yml is missing", async () => {
    const mod = await import("./deploy");
    const empty = mkdtempSync(join(tmpdir(), "lexa-deploy-nocompose-"));
    process.chdir(empty);
    const err = (await Effect.runPromise(mod.runCompose(mod.FLAVORS.prod)).catch((e) => e)) as Error;
    expect(err.message).toBe("  ERROR: run from the repo root (docker-compose.yml not found)");
    process.chdir(cwd);
    rmSync(empty, { recursive: true, force: true });
  });

  it("assembles the up invocation with project name and image tag env", async () => {
    const mod = await import("./deploy");
    const repo = mkdtempSync(join(tmpdir(), "lexa-deploy-run-"));
    writeFileSync(join(repo, "docker-compose.yml"), "services: {}\n");
    process.chdir(repo);
    await Effect.runPromise(mod.runCompose(mod.FLAVORS.prod, { imageTag: "v1.2.3" }));
    const up = childMocks.spawnSyncCalls.find((c) => c.args.includes("up"));
    expect(up?.cmd).toBe("docker");
    expect(up?.args).toEqual(["compose", "-f", "docker-compose.yml", "-f", "docker-compose.prod.yml", "--env-file", ".env.prod", "up", "-d", "--pull", "always", "--wait"]);
    const env = up?.opts.env as Record<string, string>;
    expect(env.COMPOSE_PROJECT_NAME).toBe("lexa-prod");
    expect(env.LXK_IMAGE_TAG).toBe("v1.2.3");
    process.chdir(cwd);
    rmSync(repo, { recursive: true, force: true });
  });

  it("staging flavor uses the staging compose files and project name", async () => {
    const mod = await import("./deploy");
    const repo = mkdtempSync(join(tmpdir(), "lexa-deploy-run-"));
    writeFileSync(join(repo, "docker-compose.yml"), "services: {}\n");
    process.chdir(repo);
    await Effect.runPromise(mod.runCompose(mod.FLAVORS.staging));
    const up = childMocks.spawnSyncCalls.find((c) => c.args.includes("up"));
    expect(up?.args).toContain("docker-compose.staging.yml");
    expect((up?.opts.env as Record<string, string>).COMPOSE_PROJECT_NAME).toBe("lexa-staging");
    expect((up?.opts.env as Record<string, string>).LXK_IMAGE_TAG).toBeUndefined();
    process.chdir(cwd);
    rmSync(repo, { recursive: true, force: true });
  });

  it("--clean runs down -v before up", async () => {
    const mod = await import("./deploy");
    const repo = mkdtempSync(join(tmpdir(), "lexa-deploy-run-"));
    writeFileSync(join(repo, "docker-compose.yml"), "services: {}\n");
    process.chdir(repo);
    await Effect.runPromise(mod.runCompose(mod.FLAVORS.prod, { clean: true }));
    const cmds = childMocks.spawnSyncCalls.map((c) => c.args.join(" "));
    const downIdx = cmds.findIndex((a) => a.includes("down -v"));
    const upIdx = cmds.findIndex((a) => a.includes("up -d"));
    expect(downIdx).toBeGreaterThanOrEqual(0);
    expect(upIdx).toBeGreaterThan(downIdx);
    process.chdir(cwd);
    rmSync(repo, { recursive: true, force: true });
  });

  it("propagates a non-zero docker exit as DeployError", async () => {
    childMocks.spawnSyncStatus = 7;
    const mod = await import("./deploy");
    const repo = mkdtempSync(join(tmpdir(), "lexa-deploy-run-"));
    writeFileSync(join(repo, "docker-compose.yml"), "services: {}\n");
    process.chdir(repo);
    const err = (await Effect.runPromise(mod.runCompose(mod.FLAVORS.prod)).catch((e) => e)) as Error;
    expect(err.message).toBe("  ERROR: docker compose failed (status 7)");
    process.chdir(cwd);
    rmSync(repo, { recursive: true, force: true });
  });
});

describe("cmdDeploy end-to-end", () => {
  async function runDeploy(extra: Record<string, string | boolean> = {}): Promise<{ deployDir: string; log: string }> {
    stubCfApi();
    const deployDir = mkdtempSync(join(tmpdir(), "lexa-deploy-e2e-"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const mod = await import("./deploy");
    const cfg = (await import("./config")).CliConfigService;
    const svc = Effect.runSync(Effect.scoped(Layer.build(cfg.Default)));
    await Effect.runPromise(
      mod.cmdDeploy({ ...DEPLOY_FLAGS, "deploy-dir": deployDir, ...extra }, ["example.com", "prod"]).pipe(
        Effect.provideService(cfg, Context.get(svc, cfg)),
      ),
    );
    const captured = log.mock.calls.map((c) => String(c[0])).join("\n");
    log.mockRestore();
    return { deployDir, log: captured };
  }

  it("runs the full non-TTY flow: prereqs, CF provisioning, env file, creds, compose up", async () => {
    const { deployDir, log } = await runDeploy({ image: "v1.2.3" });
    // Env file written into the deploy dir (cwd after chdir).
    const env = readFileSync(join(deployDir, ".env.prod"), "utf-8");
    expect(env).toContain("LXK_API_KEY=lxk_test_key_1234567890123456789012345678901234567890");
    expect(env).toContain("LXK_ADMIN_EMAILS=admin@example.com");
    expect(env).toContain("LXK_ENV=prod");
    expect(env).toContain("CF_TUNNEL_TOKEN=tok1");
    expect(env).toContain("LXK_PUBLIC_URL=https://lexa.example.com");
    // Deploy creds persisted via CliConfigService in the DOMAIN group dir.
    const saved = JSON.parse(readFileSync(join(lexaDir, "example.com", "config.json"), "utf-8")) as { deploy?: unknown };
    expect(saved.deploy).toEqual({ cfToken: "cf-tok" });
    // Compose invoked with the pinned image tag.
    const up = childMocks.spawnSyncCalls.find((c) => c.args.includes("up"));
    expect(up?.args).toContain("--env-file");
    expect(up?.args).toContain(".env.prod");
    expect((up?.opts.env as Record<string, string>).LXK_IMAGE_TAG).toBe("v1.2.3");
    // Banner shows the pinned image.
    expect(log).toContain("Image: ghcr.io/yohanesgre/lexa:v1.2.3");
    expect(log).toContain("https://lexa.example.com");
    rmSync(deployDir, { recursive: true, force: true });
  });

  it("--clean on a non-TTY skips the confirmation prompt and downs the volume", async () => {
    const { deployDir } = await runDeploy({ clean: true });
    const cmds = childMocks.spawnSyncCalls.map((c) => c.args.join(" "));
    expect(cmds.some((a) => a.includes("down -v"))).toBe(true);
    rmSync(deployDir, { recursive: true, force: true });
  });

  it("--clean on a TTY aborts with exit 1 when the confirmation does not match", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => { throw new Error(`exit(${code})`); }) as never);
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    process.stdin.push("nope\n");
    const deployDir = mkdtempSync(join(tmpdir(), "lexa-deploy-e2e-"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    stubCfApi();
    const mod = await import("./deploy");
    const cfg = (await import("./config")).CliConfigService;
    const svc = Effect.runSync(Effect.scoped(Layer.build(cfg.Default)));
    await expect(
      Effect.runPromise(mod.cmdDeploy({ ...DEPLOY_FLAGS, "deploy-dir": deployDir, clean: true }, ["example.com", "prod"]).pipe(
        Effect.provideService(cfg, Context.get(svc, cfg)),
      )),
    ).rejects.toThrow(/exit\(1\)/);
    expect(log.mock.calls.map((c) => String(c[0])).join("\n")).toContain("Aborted (confirmation did not match).");
    // No compose up after an aborted clean.
    expect(childMocks.spawnSyncCalls.some((c) => c.args.includes("up"))).toBe(false);
    exitSpy.mockRestore();
    log.mockRestore();
    rmSync(deployDir, { recursive: true, force: true });
  });

  it("--clean on a TTY proceeds when the confirmation matches", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    process.stdin.push("clean\n");
    const { deployDir } = await runDeploy({ clean: true });
    const cmds = childMocks.spawnSyncCalls.map((c) => c.args.join(" "));
    expect(cmds.some((a) => a.includes("down -v"))).toBe(true);
    expect(cmds.some((a) => a.includes("up -d"))).toBe(true);
    rmSync(deployDir, { recursive: true, force: true });
  });
});

describe("cmdUndeploy", () => {
  // isTTY is forced per test — earlier cmdDeploy TTY tests leave it true,
  // which would route non-TTY tests into the stdin prompt and hang.
  async function invokeUndeploy(deployDir: string, flags: Record<string, string | boolean>, positionals: string[], opts: { tty?: boolean; input?: string } = {}): Promise<string> {
    stubCfApi();
    Object.defineProperty(process.stdin, "isTTY", { value: opts.tty === true, configurable: true });
    if (opts.input) process.stdin.push(opts.input);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mod = await import("./deploy");
    const cfg = (await import("./config")).CliConfigService;
    const svc = Effect.runSync(Effect.scoped(Layer.build(cfg.Default)));
    let captured = "";
    try {
      await Effect.runPromise(
        mod.cmdUndeploy({ ...flags, "deploy-dir": deployDir }, positionals).pipe(
          Effect.provideService(cfg, Context.get(svc, cfg)),
        ),
      );
    } finally {
      captured = [...log.mock.calls, ...warn.mock.calls].map((c) => String(c[0])).join("\n");
      log.mockRestore();
      warn.mockRestore();
    }
    return captured;
  }

  it("full non-TTY flow with --yes: compose down, CF deletions in order, local state removed", async () => {
    const deployDir = mkdtempSync(join(tmpdir(), "lexa-undeploy-e2e-"));
    // A deployed flavor has its env file in the deploy dir (deploy writes it).
    writeFileSync(join(deployDir, ".env.prod"), "LXK_ENV=prod\n");
    // Saved login + deploy creds in the DOMAIN group — teardown must keep the
    // login, drop deploy.
    mkdirSync(join(lexaDir, "example.com"), { recursive: true });
    writeFileSync(join(lexaDir, "example.com", "config.json"), JSON.stringify({ url: "http://example.com", apiKey: "k", deploy: { cfToken: "cf-tok" } }));
    cfMocks.dnsList = [{ id: "dns1" }];
    cfMocks.tunnelList = [{ id: "tun1" }];

    const log = await invokeUndeploy(deployDir, { ...DEPLOY_FLAGS, yes: true }, ["example.com", "prod"]);

    // Compose down with the flavor project name + env file.
    const down = childMocks.spawnSyncCalls.find((c) => c.args.includes("down"));
    expect(down?.cmd).toBe("docker");
    expect(down?.args).toEqual(["compose", "-f", "docker-compose.yml", "-f", "docker-compose.prod.yml", "--env-file", ".env.prod", "down", "-v"]);
    expect((down?.opts.env as Record<string, string>).COMPOSE_PROJECT_NAME).toBe("lexa-prod");

    // CF deletions in order: DNS → tunnel.
    const deletes = cfMocks.requests.filter((r) => r.method === "DELETE");
    const dnsIdx = deletes.findIndex((r) => r.url.includes("/dns_records/dns1"));
    const tunIdx = deletes.findIndex((r) => r.url.includes("/cfd_tunnel/tun1"));
    expect(dnsIdx).toBeGreaterThanOrEqual(0);
    expect(tunIdx).toBeGreaterThan(dnsIdx);
    // No Access/IdP resources exist anymore.
    expect(deletes.some((r) => r.url.includes("/access"))).toBe(false);

    // Local state: deploy dir gone, login kept, deploy key dropped.
    expect(existsSync(deployDir)).toBe(false);
    const saved = JSON.parse(readFileSync(join(lexaDir, "example.com", "config.json"), "utf-8")) as Record<string, unknown>;
    expect(saved).toEqual({ url: "http://example.com", apiKey: "k" });
    expect(log).toContain("Undeployed prod (lexa.example.com) — containers, volume, CF resources, and local state removed.");
  });

  it("non-TTY without --yes fails before any side effects", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    const mod = await import("./deploy");
    const cfg = (await import("./config")).CliConfigService;
    const svc = Effect.runSync(Effect.scoped(Layer.build(cfg.Default)));
    const err = (await Effect.runPromise(
      mod.cmdUndeploy({ ...DEPLOY_FLAGS }, ["example.com", "prod"]).pipe(
        Effect.provideService(cfg, Context.get(svc, cfg)),
      ),
    ).catch((e) => e)) as Error;
    expect(err.message).toMatch(/--yes/);
    expect(childMocks.spawnSyncCalls.length).toBe(0);
    expect(cfMocks.requests.length).toBe(0);
  });

  it("missing CF token: compose down + local state still happen, CF skipped, warning printed", async () => {
    const deployDir = mkdtempSync(join(tmpdir(), "lexa-undeploy-e2e-"));
    writeFileSync(join(deployDir, ".env.prod"), "LXK_ENV=prod\n");
    const { "cf-token": _cfToken, ...noToken } = DEPLOY_FLAGS;
    const log = await invokeUndeploy(deployDir, { ...noToken, yes: true }, ["example.com", "prod"]);

    expect(childMocks.spawnSyncCalls.some((c) => c.args.includes("down"))).toBe(true);
    expect(cfMocks.requests.length).toBe(0);
    expect(log).toContain("No Cloudflare API token");
    expect(existsSync(deployDir)).toBe(false);
    expect(existsSync(join(lexaDir, "example.com", "config.json"))).toBe(false);
  });

  it("TTY confirmation mismatch aborts with exit 1 before any side effects", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => { throw new Error(`exit(${code})`); }) as never);
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    process.stdin.push("nope\n");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const mod = await import("./deploy");
    const cfg = (await import("./config")).CliConfigService;
    const svc = Effect.runSync(Effect.scoped(Layer.build(cfg.Default)));
    await expect(
      Effect.runPromise(mod.cmdUndeploy({ ...DEPLOY_FLAGS }, ["example.com", "prod"]).pipe(
        Effect.provideService(cfg, Context.get(svc, cfg)),
      )),
    ).rejects.toThrow(/exit\(1\)/);
    expect(log.mock.calls.map((c) => String(c[0])).join("\n")).toContain("Aborted (confirmation did not match).");
    expect(childMocks.spawnSyncCalls.length).toBe(0);
    expect(cfMocks.requests.length).toBe(0);
    exitSpy.mockRestore();
    log.mockRestore();
  });
});
