// cli/deploy-workers.ts: D1 → R2 → KV → migrate → deploy → route → secrets
// orchestration with the process/network boundary mocked (spawnSync +
// fetch stubs, tmp HOME/LEXA_DIR, tmp repo checkout for the entry +
// migrations).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliConfigService } from "./config";

const childMocks = vi.hoisted(() => ({
  calls: [] as Array<{ cmd: string; args: string[]; input?: unknown; opts?: unknown }>,
  stdoutQueue: [] as string[],
  status: 0,
  failBuild: false,
}));

const cfMocks = vi.hoisted(() => ({
  requests: [] as Array<{ url: string; method: string; body: string }>,
  d1List: [] as Array<{ uuid: string }>,
  r2List: [] as Array<{ name: string }>,
  kvList: [] as Array<{ id: string; title: string }>,
  routes: [] as Array<{ id: string; pattern: string }>,
}));

vi.mock("node:child_process", () => ({
  spawnSync: (cmd: string, args: string[], opts: Record<string, unknown>) => {
    childMocks.calls.push({ cmd, args, input: (opts as { input?: unknown }).input, opts });
    if (cmd === "bun" && childMocks.failBuild) {
      return { status: 1, stdout: "", stderr: "", signal: null, pid: 1 };
    }
    // Only piped STDOUT yields output (like the real spawnSync): the
    // --version probe, streaming calls, and stdin-piped secret puts
    // consume nothing from the queue.
    const stdio = (opts as { stdio?: unknown }).stdio;
    const pipedOut = Array.isArray(stdio) ? stdio[1] === "pipe" : false;
    const stdout = pipedOut && childMocks.stdoutQueue.length > 0 ? childMocks.stdoutQueue.shift()! : "";
    return { status: childMocks.status, stdout, stderr: "", signal: null, pid: 1 };
  },
}));

let homeDir = "";
let lexaDir = "";
let repoDir = "";
let cwd = "";

function cfResponse(result: unknown): Response {
  return new Response(JSON.stringify({ success: true, result }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function stubCfApi(): void {
  vi.stubGlobal("fetch", (url: string | URL, init?: RequestInit) => {
    const full = String(url);
    const u = new URL(full);
    const path = u.pathname + u.search;
    const method = init?.method ?? "GET";
    cfMocks.requests.push({ url: full, method, body: typeof init?.body === "string" ? init.body : "" });
    let result: unknown = {};
    if (path.includes("/d1/database") && method === "GET") result = cfMocks.d1List;
    else if (path.includes("/d1/database") && method === "POST") result = { uuid: "d1-new" };
    else if (path.includes("/r2/buckets") && method === "GET") result = { buckets: cfMocks.r2List };
    else if (path.includes("/r2/buckets") && method === "POST") result = { name: "created" };
    else if (path.includes("/kv/namespaces") && method === "GET") result = cfMocks.kvList;
    else if (path.includes("/kv/namespaces") && method === "POST") result = { id: "kv-new" };
    else if (path.includes("/workers/routes") && method === "GET") result = cfMocks.routes;
    else if (path.includes("/workers/routes") && method === "POST") result = {};
    else if (path.includes("/workers/routes/") && method === "DELETE") result = {};
    else if (path.includes("/d1/database/") && method === "DELETE") result = {};
    else if (path.includes("/r2/buckets/") && method === "DELETE") result = {};
    else if (path.includes("/kv/namespaces/") && method === "DELETE") result = {};
    else if (path.includes("/zones")) result = [{ id: "zone1" }];
    else if (path.includes("/accounts")) result = [{ id: "acc1" }];
    return Promise.resolve(cfResponse(result));
  });
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "lexa-wrepo-"));
  mkdirSync(join(dir, "server"), { recursive: true });
  writeFileSync(join(dir, "server", "workers-entry.ts"), "export default {};\n");
  mkdirSync(join(dir, "migrations"), { recursive: true });
  writeFileSync(join(dir, "migrations", "0001_init.sql"), "CREATE TABLE IF NOT EXISTS t (a TEXT);\n");
  writeFileSync(join(dir, "wrangler.jsonc"), '{ "compatibility_date": "2026-08-01" }\n');
  // Prebuilt vite workers bundle (what `LEXA_FLAVOR=workers bun run build`
  // emits): the deploy points its generated config at this dist output.
  mkdirSync(join(dir, "dist", "server"), { recursive: true });
  mkdirSync(join(dir, "dist", "client"), { recursive: true });
  writeFileSync(join(dir, "dist", "server", "index.js"), "export default {};\n");
  mkdirSync(join(dir, "dist", "server", "assets"), { recursive: true });
  writeFileSync(join(dir, "dist", "server", "assets", "chunk.js"), "export const x = 1;\n");
  writeFileSync(
    join(dir, "dist", "server", "wrangler.json"),
    JSON.stringify({
      main: "index.js",
      assets: { directory: "../client" },
      no_bundle: true,
      rules: [{ type: "ESModule", globs: ["**/*.js", "**/*.mjs"] }],
    }) + "\n"
  );
  return dir;
}

const FLAGS = {
  "cf-token": "cf-tok",
  "admin-email": "admin@example.com",
  "api-key": "lxk_testkey",
};

function runDeploy(flags: Record<string, string | boolean>, positionals: string[]) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const mod = yield* Effect.promise(() => import("./deploy-workers"));
      yield* mod.cmdDeployWorkers(flags, positionals);
    }).pipe(Effect.provide(CliConfigService.Default))
  );
}

function runUndeploy(flags: Record<string, string | boolean>, positionals: string[]) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const mod = yield* Effect.promise(() => import("./deploy-workers"));
      yield* mod.cmdUndeployWorkers(flags, positionals);
    }).pipe(Effect.provide(CliConfigService.Default))
  );
}

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), "lexa-whome-"));
  lexaDir = mkdtempSync(join(tmpdir(), "lexa-wlexa-"));
  process.env.HOME = homeDir;
  process.env.LEXA_DIR = lexaDir;
  repoDir = makeRepo();
  cwd = process.cwd();
  process.chdir(repoDir);
  childMocks.calls.length = 0;
  childMocks.stdoutQueue.length = 0;
  childMocks.status = 0;
  childMocks.failBuild = false;
  cfMocks.requests.length = 0;
  cfMocks.d1List = [];
  cfMocks.r2List = [];
  cfMocks.kvList = [];
  cfMocks.routes = [];
  vi.resetModules();
  stubCfApi();
});

afterEach(() => {
  process.chdir(cwd);
  delete process.env.HOME;
  delete process.env.LEXA_DIR;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(lexaDir, { recursive: true, force: true });
  rmSync(repoDir, { recursive: true, force: true });
});

describe("cmdDeployWorkers", () => {
  it("provisions D1 → R2 → KV → migrate → deploy → route → secrets in order", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      // D1 journal: nothing applied yet (init read + journal read).
      childMocks.stdoutQueue.push("[]", "[]");
      await runDeploy(FLAGS, ["example.com", "staging"]);

      const cfPaths = cfMocks.requests.map((r) => `${r.method} ${new URL(r.url).pathname}`);
      const order = ["POST /client/v4/accounts/acc1/d1/database",
        "POST /client/v4/accounts/acc1/r2/buckets",
        "POST /client/v4/accounts/acc1/storage/kv/namespaces"];
      let last = -1;
      for (const step of order) {
        const idx = cfPaths.findIndex((p) => p === step);
        expect(idx).toBeGreaterThan(last);
        last = idx;
      }
      const routePost = cfMocks.requests.find((r) => r.method === "POST" && r.url.includes("/workers/routes"));
      expect(routePost).toBeDefined();
      expect(JSON.parse(routePost!.body)).toMatchObject({ pattern: "lexa-preview.example.com/*", script: "lexa-staging" });

      const spawns = childMocks.calls.filter((c) => c.cmd === "wrangler").map((c) => c.args);
      const deployIdx = spawns.findIndex((a) => a[0] === "deploy");
      expect(deployIdx).toBeGreaterThan(-1);
      // The vite workers bundle builds from the checkout before deploy.
      const build = childMocks.calls.find((c) => c.cmd === "bun");
      expect(build?.args).toEqual(["run", "build"]);
      expect((build?.opts as { cwd?: string } | undefined)?.cwd).toBe(repoDir);
      expect((build?.opts as { env?: Record<string, string> } | undefined)?.env?.LEXA_FLAVOR).toBe("workers");
      expect(childMocks.calls.indexOf(build!)).toBeLessThan(
        childMocks.calls.findIndex((c) => c.cmd === "wrangler" && c.args[0] === "deploy")
      );
      const secretCalls = spawns.filter((a) => a[0] === "secret");
      const secretIdx = spawns.findIndex((a) => a[0] === "secret");
      expect(secretIdx).toBeGreaterThan(deployIdx);
      expect(secretCalls[0]![1]).toBe("put");
      expect(secretCalls[0]![2]).toBe("LXK_API_KEY");
      // Secrets arrive via piped stdin, never argv.
      const apiKeyCall = childMocks.calls.find((c) => c.cmd === "wrangler" && c.args[2] === "LXK_API_KEY");
      expect(String(apiKeyCall?.input)).toContain("lxk_testkey");

      const cfgPath = join(lexaDir, "example.com", "deploy-workers", "staging", "wrangler.staging.jsonc");
      expect(existsSync(cfgPath)).toBe(true);
      const cfg = JSON.parse(readFileSync(cfgPath, "utf-8")) as {
        name: string; main: string; no_bundle: boolean; rules: unknown; assets: { directory: string };
        d1_databases: Array<{ database_id: string }>; kv_namespaces: Array<{ id: string }>;
        vars: { LXK_PUBLIC_URL: string };
      };
      expect(cfg.name).toBe("lexa-staging");
      // Dist-based deploy: the bundle is staged flat next to the generated
      // config (chunk imports resolve relative to the config dir), upload
      // instructions pass through from the build manifest, and the
      // source-dev alias shims are gone.
      expect(cfg.main).toBe("index.js");
      expect(cfg.assets.directory).toBe("client");
      expect(cfg.no_bundle).toBe(true);
      expect(cfg.rules).toEqual([{ type: "ESModule", globs: ["**/*.js", "**/*.mjs"] }]);
      expect(cfg).not.toHaveProperty("alias");
      const flavorDir = join(lexaDir, "example.com", "deploy-workers", "staging");
      expect(readFileSync(join(flavorDir, "index.js"), "utf-8")).toBe("export default {};\n");
      expect(readFileSync(join(flavorDir, "assets", "chunk.js"), "utf-8")).toBe("export const x = 1;\n");
      expect(existsSync(join(flavorDir, "client"))).toBe(true);
      // The plugin manifest is not staged — the generated config replaces it.
      expect(existsSync(join(flavorDir, "wrangler.json"))).toBe(false);
      expect(cfg.d1_databases[0]!.database_id).toBe("d1-new");
      expect(cfg.kv_namespaces[0]!.id).toBe("kv-new");
      expect(cfg.vars.LXK_PUBLIC_URL).toBe("https://lexa-preview.example.com");

      const out = log.mock.calls.map((c) => String(c[0]!)).join("\n");
      expect(out).toMatch(/Applied migration: 0001_init\.sql/);
    } finally {
      log.mockRestore();
    }
  });

  it("reuses existing D1/R2/KV instead of creating them", async () => {
    cfMocks.d1List = [{ uuid: "d1-old" }];
    cfMocks.r2List = [{ name: "lexa-blobs-prod" }];
    cfMocks.kvList = [{ id: "kv-old", title: "lexa-prod" }];
    childMocks.stdoutQueue.push("[]");
    await runDeploy(FLAGS, ["example.com", "prod"]);
    const posts = cfMocks.requests.filter((r) =>
      r.method === "POST" && (r.url.includes("/d1/database") || r.url.includes("/r2/buckets") || r.url.includes("/kv/namespaces"))
    );
    expect(posts).toEqual([]);
    const cfg = JSON.parse(
      readFileSync(join(lexaDir, "example.com", "deploy-workers", "prod", "wrangler.prod.jsonc"), "utf-8")
    ) as { d1_databases: Array<{ database_id: string }>; kv_namespaces: Array<{ id: string }> };
    expect(cfg.d1_databases[0]!.database_id).toBe("d1-old");
    expect(cfg.kv_namespaces[0]!.id).toBe("kv-old");
  });

  it("skips applied migrations via the D1 journal", async () => {
    // Two capturing reads: journal init, then the journal SELECT.
    childMocks.stdoutQueue.push("[]", JSON.stringify([{ results: [{ name: "0001_init.sql" }] }]));
    await runDeploy(FLAGS, ["example.com", "staging"]);
    const fileCalls = childMocks.calls.filter((c) => c.args.includes("--file"));
    expect(fileCalls).toEqual([]);
  });

  it("usage strings name --runtime workers (flag, not positional)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    try {
      await expect(runDeploy({}, [])).rejects.toThrow(/exit:1/);
      const out = err.mock.calls.map((c) => String(c[0]!)).join("\n");
      expect(out).toMatch(/deploy <domain> \[staging\|prod\] --runtime workers/);
      expect(out).not.toMatch(/deploy <domain> workers/);
    } finally {
      err.mockRestore();
      exit.mockRestore();
    }
  });

  it("prunes stale staged bundles from previous deploys", async () => {
    const flavorDir = join(lexaDir, "example.com", "deploy-workers", "staging");
    mkdirSync(flavorDir, { recursive: true });
    writeFileSync(join(flavorDir, "stale-chunk.js"), "stale\n");
    childMocks.stdoutQueue.push("[]", "[]");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await runDeploy(FLAGS, ["example.com", "staging"]);
      expect(existsSync(join(flavorDir, "stale-chunk.js"))).toBe(false);
      expect(existsSync(join(flavorDir, "index.js"))).toBe(true);
    } finally {
      log.mockRestore();
    }
  });

  it("fails loudly when the workers build fails (no deploy attempted)", async () => {
    childMocks.failBuild = true;
    await expect(runDeploy(FLAGS, ["example.com", "staging"])).rejects.toThrow(/vite build failed/);
    const deploy = childMocks.calls.find((c) => c.cmd === "wrangler" && c.args[0] === "deploy");
    expect(deploy).toBeUndefined();
  });

  it("fails loudly when the build emits no bundle manifest", async () => {
    rmSync(join(repoDir, "dist"), { recursive: true, force: true });
    await expect(runDeploy(FLAGS, ["example.com", "staging"])).rejects.toThrow(/dist\/server\/wrangler\.json/);
    const deploy = childMocks.calls.find((c) => c.cmd === "wrangler" && c.args[0] === "deploy");
    expect(deploy).toBeUndefined();
  });

  it("fails loudly outside a repo checkout", async () => {
    const empty = mkdtempSync(join(tmpdir(), "lexa-wempty-"));
    process.chdir(empty);
    try {
      await expect(runDeploy(FLAGS, ["example.com", "staging"])).rejects.toThrow(/repo checkout|repo root/);
    } finally {
      process.chdir(repoDir);
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("cmdUndeployWorkers", () => {
  it("deletes the route + worker and preserves data by default", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      cfMocks.routes = [{ id: "r1", pattern: "lexa.example.com/*" }];
      const deployDir = join(lexaDir, "example.com", "deploy-workers", "prod");
      mkdirSync(deployDir, { recursive: true });
      writeFileSync(join(deployDir, "wrangler.prod.jsonc"), "{}\n");
      await runUndeploy({ "cf-token": "cf-tok", yes: true }, ["example.com", "prod"]);
      const routeDel = cfMocks.requests.find((r) => r.method === "DELETE" && r.url.includes("/workers/routes/r1"));
      expect(routeDel).toBeDefined();
      const wranglerDel = childMocks.calls.find((c) => c.cmd === "wrangler" && c.args[0] === "delete");
      expect(wranglerDel).toBeDefined();
      const dataDels = cfMocks.requests.filter((r) => r.method === "DELETE" && !r.url.includes("/workers/routes/"));
      expect(dataDels).toEqual([]);
      const out = log.mock.calls.map((c) => String(c[0]!)).join("\n");
      expect(out).toMatch(/pass --purge-data/);
    } finally {
      log.mockRestore();
    }
  });

  it("--purge-data deletes D1, R2, and KV", async () => {
    cfMocks.d1List = [{ uuid: "d1-old" }];
    cfMocks.kvList = [{ id: "kv-old", title: "lexa-prod" }];
    await runUndeploy({ "cf-token": "cf-tok", yes: true, "purge-data": true }, ["example.com", "prod"]);
    const dels = cfMocks.requests.filter((r) => r.method === "DELETE").map((r) => new URL(r.url).pathname);
    expect(dels).toContain("/client/v4/accounts/acc1/d1/database/d1-old");
    expect(dels).toContain("/client/v4/accounts/acc1/r2/buckets/lexa-blobs-prod");
    expect(dels).toContain("/client/v4/accounts/acc1/storage/kv/namespaces/kv-old");
  });
});
