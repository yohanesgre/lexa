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

// CF request recorder + app-policy list override (the cmdDeploy policy
// branch tests assert the PUT target and body).
const cfMocks = vi.hoisted(() => ({
  requests: [] as Array<{ url: string; method: string; body: string }>,
  policyList: [] as Array<{ id: string; precedence?: number; app_count?: number; reusable?: boolean; name?: string }>,
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
  cfMocks.policyList = [];
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
    if (path.includes("/access/apps/") && path.includes("/policies")) result = method === "GET" ? cfMocks.policyList : {};
    // Account-level policies endpoint — reusable policy updates land here.
    else if (path.includes("/access/policies/")) result = {};
    else if (path.includes("/access/apps")) result = method === "GET" ? [] : { id: "app1" };
    else if (path.includes("/access/identity_providers")) result = method === "GET" ? [] : { id: "idp1" };
    else if (path.includes("/cfd_tunnel") && path.includes("/token")) result = { token: "tok1" };
    else if (path.includes("/cfd_tunnel") && path.includes("/configurations")) result = {};
    else if (path.includes("/cfd_tunnel")) result = method === "GET" ? [] : { id: "tun1" };
    else if (path.includes("/dns_records")) result = method === "GET" ? [] : {};
    else if (path.includes("/zones")) result = [{ id: "zone1" }];
    else if (path.includes("/accounts")) result = [{ id: "acc1" }];
    return Promise.resolve(cfResponse(result));
  });
}

const DEPLOY_FLAGS = {
  "deploy-dir": "", // filled per test
  "cf-token": "cf-tok",
  "google-client-id": "g-id",
  "google-client-secret": "g-sec",
  "team-domain": "lexa.cloudflareaccess.com",
  "email-domain": "example.com",
  "admin-email": "admin@example.com",
  "api-key": "lxk_test_key_1234567890123456789012345678901234567890",
};

describe("materializeCompose", () => {
  it("writes only the flavor's compose files (gunzipped) to --deploy-dir", async () => {
    const mod = await import("./deploy");
    const deployDir = mkdtempSync(join(tmpdir(), "lexa-deploy-dir-"));
    const out = mod.materializeCompose("prod", { "deploy-dir": deployDir });
    expect(out).toBe(deployDir);
    const files = readdirSync(deployDir).sort();
    expect(files).toEqual(["docker-compose.yml", "docker-compose.prod.yml"].sort());
    expect(existsSync(join(deployDir, "docker-compose.staging.yml"))).toBe(false);
    const base = readFileSync(join(deployDir, "docker-compose.yml"), "utf-8");
    expect(base.length).toBeGreaterThan(100);
    expect(base).toMatch(/services:/);
    rmSync(deployDir, { recursive: true, force: true });
  });

  it("defaults to the flavor deploy dir under LEXA_DIR", async () => {
    const mod = await import("./deploy");
    const out = mod.materializeCompose("prod", {});
    expect(out).toBe(join(lexaDir, "deploy"));
    expect(existsSync(join(out, "docker-compose.yml"))).toBe(true);
  });

  it("falls back to the repo cwd when no compose files are embedded", async () => {
    composeMocks.empty = true;
    vi.resetModules();
    const mod = await import("./deploy");
    const repo = mkdtempSync(join(tmpdir(), "lexa-deploy-repo-"));
    writeFileSync(join(repo, "docker-compose.yml"), "services: {}\n");
    process.chdir(repo);
    expect(mod.materializeCompose("prod", {})).toBe(repo);
    process.chdir(cwd);
    rmSync(repo, { recursive: true, force: true });
  });

  it("throws when neither embedded files nor a repo checkout exist", async () => {
    composeMocks.empty = true;
    vi.resetModules();
    const mod = await import("./deploy");
    const empty = mkdtempSync(join(tmpdir(), "lexa-deploy-empty-"));
    process.chdir(empty);
    expect(() => mod.materializeCompose("prod", {})).toThrow(/no embedded compose files/);
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
    // Deploy creds persisted via CliConfigService.
    const saved = JSON.parse(readFileSync(join(lexaDir, "config.json"), "utf-8")) as { deploy?: unknown };
    expect(saved.deploy).toEqual({ cfToken: "cf-tok", googleClientId: "g-id", googleClientSecret: "g-sec", cfTeamDomain: "lexa.cloudflareaccess.com", emailDomain: "example.com" });
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

  it("updates a reusable policy via the account-level endpoint without precedence", async () => {
    cfMocks.policyList = [{ id: "pol-reusable", app_count: 1, reusable: true, name: "Allow @gmail.com" }];
    const { log } = await runDeploy();
    const put = cfMocks.requests.find((r) => r.method === "PUT" && r.url.includes("/access/policies/pol-reusable"));
    expect(put).toBeDefined();
    expect(put?.url).toContain("/accounts/acc1/access/policies/pol-reusable");
    const body = JSON.parse(put?.body ?? "{}") as Record<string, unknown>;
    expect(body).toEqual({
      name: "Allow @example.com",
      decision: "allow",
      include: [{ email_domain: { domain: "example.com" } }],
    });
    expect(body).not.toHaveProperty("precedence");
    // No app-scoped PUT for the same row.
    expect(cfMocks.requests.some((r) => r.method === "PUT" && r.url.includes("/access/apps/app1/policies/pol-reusable"))).toBe(false);
    expect(log).toContain("Updating existing reusable policy: pol-reusable");
    expect(log).toContain("Policy: allow @example.com");
  });

  it("treats a row with app_count but no reusable flag as reusable", async () => {
    cfMocks.policyList = [{ id: "pol-multi", app_count: 3 }];
    await runDeploy();
    expect(cfMocks.requests.some((r) => r.method === "PUT" && r.url.includes("/access/policies/pol-multi"))).toBe(true);
    expect(cfMocks.requests.some((r) => r.method === "PUT" && r.url.includes("/access/apps/app1/policies/pol-multi"))).toBe(false);
  });

  it("updates an app-scoped policy via the app endpoint with precedence in the body", async () => {
    cfMocks.policyList = [{ id: "pol-app", precedence: 1 }];
    const { log } = await runDeploy();
    const put = cfMocks.requests.find((r) => r.method === "PUT" && r.url.includes("/access/apps/app1/policies/pol-app"));
    expect(put).toBeDefined();
    const body = JSON.parse(put?.body ?? "{}") as Record<string, unknown>;
    expect(body.precedence).toBe(1);
    expect(body.name).toBe("Allow @example.com");
    expect((body.include as Array<Record<string, unknown>>)[0]).toEqual({ email_domain: { domain: "example.com" } });
    // No account-level PUT for an app-scoped row.
    expect(cfMocks.requests.some((r) => r.method === "PUT" && r.url.includes("/access/policies/pol-app"))).toBe(false);
    expect(log).toContain("Updating existing policy: pol-app");
  });
});
