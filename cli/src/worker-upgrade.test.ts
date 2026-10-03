// cli/worker.ts update execution (LX-37/38/39): dry-run plan, version
// refusal, backup/rollback, migration pre-flight, and custody/binding
// preservation. Seams (fetch, wrangler, CF API, tar) are injected so these
// tests never touch the network or Cloudflare.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex, type ReleaseFetcher } from "./release";
import {
  backupPathFor,
  discoverWorkerDeploys,
  parseWranglerTokenOutput,
  readDeployConfigFile,
  resolveCfCredentials,
  runUpgrade,
  type CfJson,
  type UpgradeDeps,
  type UpgradeOptions,
  type WranglerRunner,
  type WranglerTokenReader,
  type WorkerConfigJson,
  type WorkerDeployConfig,
} from "./worker";
import {
  MCP_SECRET_REFS_MIGRATION,
  migrationOrderError,
  pendingMigrations,
} from "../../scripts/lib/cf-deploy";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots.length = 0;
});

function makeRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "lx-worker-upgrade-"));
  roots.push(d);
  return d;
}

const TARBALL_BYTES = new TextEncoder().encode("lexa-workers tarball fixture\n");
const TARBALL_NAME = "lexa-workers-v2.0.0.tar.gz";

function priorConfig(overrides: Partial<WorkerConfigJson> = {}): WorkerConfigJson {
  return {
    name: "lexa",
    account_id: "acct_123",
    main: "./index.js",
    compatibility_date: "2026-08-01",
    vars: {
      LXK_ENV: "production",
      LXK_PUBLIC_URL: "https://lexa.example.workers.dev",
      LXK_VERSION: "1.0.0",
    },
    d1_databases: [{ binding: "DB", database_name: "lexa", database_id: "d1-abc" }],
    r2_buckets: [{ binding: "BLOB", bucket_name: "lexa-blobs" }],
    kv_namespaces: [{ binding: "KV", id: "kv-abc" }],
    durable_objects: { bindings: [{ name: "ASSISTANT_AGENT", class_name: "LexaAssistantAgent" }] },
    migrations: [{ new_sqlite_classes: ["LexaAssistantAgent"] }],
    observability: { enabled: true },
    ...overrides,
  };
}

function makeDeploy(root: string, prior: WorkerConfigJson): { config: WorkerDeployConfig; prior: WorkerConfigJson } {
  const dir = join(root, "deploy-lexa");
  mkdirSync(dir, { recursive: true });
  const configPath = join(dir, "wrangler.lexa.json");
  writeFileSync(configPath, JSON.stringify(prior, null, 2) + "\n");
  const config: WorkerDeployConfig = {
    flavor: "lexa",
    dir,
    configPath,
    workerName: "lexa",
    accountId: prior.account_id,
    publicUrl: "https://lexa.example.workers.dev",
    version: String((prior.vars?.LXK_VERSION as string | undefined) ?? ""),
  };
  return { config, prior };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function releaseFetcher(): ReleaseFetcher {
  return async (url: string) => {
    if (url.includes("/releases?")) return jsonResponse([{ tag_name: "v2.0.0" }, { tag_name: "v1.0.0" }]);
    if (url.endsWith("checksums.txt")) {
      return new Response(`${sha256Hex(TARBALL_BYTES)}  ${TARBALL_NAME}\n`, { status: 200 });
    }
    if (url.endsWith(".tar.gz")) return new Response(TARBALL_BYTES, { status: 200 });
    return new Response("not found", { status: 404 });
  };
}

// The injected extractor stands in for `tar -xzf`: it writes the layout a real
// workers tarball has (dist/server manifest + bundle, dist/client, migrations,
// root wrangler.jsonc).
function stageFixture(dest: string): void {
  mkdirSync(join(dest, "dist", "server"), { recursive: true });
  writeFileSync(
    join(dest, "dist", "server", "wrangler.json"),
    JSON.stringify({ main: "index.js", assets: { directory: "../client" } }),
  );
  writeFileSync(join(dest, "dist", "server", "index.js"), "new-bundle\n");
  mkdirSync(join(dest, "dist", "client"), { recursive: true });
  writeFileSync(join(dest, "dist", "client", "app.js"), "client\n");
  mkdirSync(join(dest, "migrations"), { recursive: true });
  writeFileSync(join(dest, "migrations", MCP_SECRET_REFS_MIGRATION), "UPDATE mcp_clients SET secret_ref = NULL;\n");
  writeFileSync(join(dest, "migrations", "0013_jev_registry.sql"), "SELECT 1;\n");
  writeFileSync(
    join(dest, "wrangler.jsonc"),
    JSON.stringify({
      compatibility_date: "2026-08-01",
      observability: { enabled: true },
      durable_objects: { bindings: [{ name: "ASSISTANT_AGENT", class_name: "LexaAssistantAgent" }] },
      migrations: [{ new_sqlite_classes: ["LexaAssistantAgent"] }],
    }),
  );
}

function journalCfJson(applied: string[], calls: string[] = []): CfJson {
  return async <T>(label: string): Promise<T> => {
    calls.push(label);
    if (label === "D1 journal read") {
      return [{ results: applied.map((name) => ({ name })) }] as unknown as T;
    }
    return undefined as T;
  };
}

interface BuiltDeps {
  deps: UpgradeDeps;
  logs: string[];
  errors: string[];
  cfCalls: string[];
}

function buildDeps(opts: {
  applied?: string[];
  wrangler?: WranglerRunner;
  fetchFn?: ReleaseFetcher;
}): BuiltDeps {
  const logs: string[] = [];
  const errors: string[] = [];
  const cfCalls: string[] = [];
  const deps: UpgradeDeps = {
    fetchFn: opts.fetchFn ?? releaseFetcher(),
    wrangler: opts.wrangler ?? (() => ({ status: 0, stdout: "", stderr: "" })),
    cfJson: journalCfJson(opts.applied ?? [], cfCalls),
    extract: (_tarballPath, dest) => stageFixture(dest),
    prompt: async () => true,
    log: (m) => logs.push(m),
    error: (m) => errors.push(m),
  };
  return { deps, logs, errors, cfCalls };
}

function options(config: WorkerDeployConfig, prior: WorkerConfigJson, over: Partial<UpgradeOptions> = {}): UpgradeOptions {
  return {
    dir: config.dir,
    config,
    prior,
    token: "fixture-token",
    dryRun: false,
    yes: true,
    force: false,
    ...over,
  };
}

describe("worker upgrade dry-run", () => {
  it("prints the full plan (tag, sha256, pending migrations) and mutates nothing", async () => {
    const root = makeRoot();
    const prior = priorConfig();
    const { config } = makeDeploy(root, prior);
    const before = readFileSync(config.configPath, "utf-8");
    const { deps, logs } = buildDeps({ applied: [] });

    const outcome = await runUpgrade(options(config, prior, { dryRun: true }), deps);

    expect(outcome.status).toBe("dry-run");
    if (outcome.status !== "dry-run") throw new Error("expected dry-run");
    expect(outcome.tag).toBe("v2.0.0");
    expect(outcome.checksum).toBe("verified");
    expect(outcome.pending).toEqual([MCP_SECRET_REFS_MIGRATION, "0013_jev_registry.sql"]);
    expect(logs.join("\n")).toContain("sha256 verified");
    expect(logs.join("\n")).toContain("Dry run — no changes made.");
    // No deploy-dir mutation, no backup.
    expect(readFileSync(config.configPath, "utf-8")).toBe(before);
    expect(existsSync(backupPathFor(config.dir))).toBe(false);
  });
});

describe("worker upgrade version gate", () => {
  it("refuses the same version without --force", async () => {
    const root = makeRoot();
    const prior = priorConfig({ vars: { LXK_VERSION: "2.0.0" } });
    const { config } = makeDeploy(root, prior);
    const { deps } = buildDeps({});

    const outcome = await runUpgrade(options(config, prior), deps);

    expect(outcome.status).toBe("refused");
    expect(existsSync(backupPathFor(config.dir))).toBe(false);
  });

  it("proceeds with --force on the same version", async () => {
    const root = makeRoot();
    const prior = priorConfig({ vars: { LXK_VERSION: "2.0.0" } });
    const { config } = makeDeploy(root, prior);
    const { deps } = buildDeps({ applied: [] });

    const outcome = await runUpgrade(options(config, prior, { force: true, dryRun: true }), deps);

    expect(outcome.status).toBe("dry-run");
  });
});

describe("worker upgrade backup/rollback", () => {
  it("backs up before staging and restores the prior deploy dir when the deploy fails", async () => {
    const root = makeRoot();
    const prior = priorConfig();
    const { config } = makeDeploy(root, prior);
    const marker = join(config.dir, "PRIOR-MARKER.txt");
    writeFileSync(marker, "prior bundle\n");
    const before = readFileSync(config.configPath, "utf-8");
    const failing: WranglerRunner = () => ({ status: 1, stdout: "", stderr: "boom: deploy rejected" });
    const { deps, errors } = buildDeps({ applied: [MCP_SECRET_REFS_MIGRATION], wrangler: failing });

    const outcome = await runUpgrade(options(config, prior), deps);

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("expected failed");
    expect(outcome.rolledBack).toBe(true);
    // Prior deploy dir restored verbatim, backup retained.
    expect(readFileSync(config.configPath, "utf-8")).toBe(before);
    expect(existsSync(marker)).toBe(true);
    expect(existsSync(backupPathFor(config.dir))).toBe(true);
    expect(errors.join("\n")).toContain("Rolled back");
    // Dir-only rollback: applied migrations are reported, never reverted.
    expect(errors.join("\n")).toContain("migrations applied: 1 — not reverted");
  });
});

describe("worker upgrade var preservation", () => {
  it("keeps prior vars beyond the resolved LXK_* keys", async () => {
    const root = makeRoot();
    const prior = priorConfig({
      vars: {
        LXK_ENV: "production",
        LXK_PUBLIC_URL: "https://lexa.example.workers.dev",
        LXK_VERSION: "1.0.0",
        CUSTOM_FLAG: "keep-me",
      },
    });
    const { config } = makeDeploy(root, prior);
    const { deps } = buildDeps({ applied: [MCP_SECRET_REFS_MIGRATION, "0013_jev_registry.sql"] });

    const outcome = await runUpgrade(options(config, prior), deps);

    expect(outcome.status).toBe("ok");
    const rebuilt = readDeployConfigFile(config.configPath)!;
    expect(rebuilt.vars?.CUSTOM_FLAG).toBe("keep-me");
    expect(rebuilt.vars?.LXK_VERSION).toBe("2.0.0");
  });
});

describe("worker upgrade post-upgrade discovery", () => {
  it("reads the real config, not the staged bundle manifest, on a subsequent run", async () => {
    const root = makeRoot();
    const prior = priorConfig();
    const { config } = makeDeploy(root, prior);
    const { deps } = buildDeps({ applied: [MCP_SECRET_REFS_MIGRATION, "0013_jev_registry.sql"] });

    const outcome = await runUpgrade(options(config, prior), deps);
    expect(outcome.status).toBe("ok");
    // The server manifest never lands as the bare `wrangler.json`.
    expect(existsSync(join(config.dir, "wrangler.json"))).toBe(false);

    // The backup is present; discovery still resolves exactly one real deploy.
    expect(existsSync(backupPathFor(config.dir))).toBe(true);
    const configs = discoverWorkerDeploys(root);
    expect(configs.map((c) => c.flavor)).toEqual(["lexa"]);
    const found = configs[0]!;
    expect(found.accountId).toBe("acct_123");
    const real = readDeployConfigFile(found.configPath)!;
    expect(real.account_id).toBe("acct_123");
    expect(real.d1_databases).toEqual(prior.d1_databases);
    expect(real.kv_namespaces).toEqual(prior.kv_namespaces);
  });
});

describe("resolveCfCredentials precedence", () => {
  const envKeys = ["CF_API_TOKEN", "CLOUDFLARE_API_TOKEN"] as const;
  const saved: Record<string, string | undefined> = {};
  // Never shell out to a real wrangler in unit tests.
  const noWrangler: WranglerTokenReader = () => undefined;

  beforeEach(() => {
    for (const key of envKeys) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key]!;
    }
  });

  it("prefers --cf-token, then CF_API_TOKEN, then CLOUDFLARE_API_TOKEN", () => {
    const root = makeRoot();
    const deployDir = join(root, "deploy-lexa");
    mkdirSync(deployDir, { recursive: true });
    writeFileSync(join(root, ".cf-token"), "dir-tok\n");
    writeFileSync(join(deployDir, ".cf-token"), "deploy-tok\n");

    expect(resolveCfCredentials("flag-tok", root, deployDir, noWrangler)).toEqual({ token: "flag-tok", source: "--cf-token" });
    process.env.CF_API_TOKEN = "cf-env";
    expect(resolveCfCredentials(undefined, root, deployDir, noWrangler)).toEqual({ token: "cf-env", source: "environment" });
    delete process.env.CF_API_TOKEN;
    process.env.CLOUDFLARE_API_TOKEN = "cf-global";
    expect(resolveCfCredentials(undefined, root, deployDir, noWrangler)).toEqual({ token: "cf-global", source: "environment" });
  });

  it("falls back to the dir .cf-token, then the deployDir one, then wrangler login, then none", () => {
    const root = makeRoot();
    const deployDir = join(root, "deploy-lexa");
    mkdirSync(deployDir, { recursive: true });
    writeFileSync(join(deployDir, ".cf-token"), "deploy-tok\n");
    expect(resolveCfCredentials(undefined, root, deployDir, noWrangler)).toEqual({ token: "deploy-tok", source: ".cf-token" });

    writeFileSync(join(root, ".cf-token"), "dir-tok\n");
    expect(resolveCfCredentials(undefined, root, deployDir, noWrangler)).toEqual({ token: "dir-tok", source: ".cf-token" });

    rmSync(join(root, ".cf-token"));
    rmSync(join(deployDir, ".cf-token"));
    // A stored wrangler login is the last resort before the error. The reader
    // stands in for `bun x wrangler auth token` so no real token is fetched.
    expect(resolveCfCredentials(undefined, root, deployDir, () => "wrangler-tok")).toEqual({
      token: "wrangler-tok",
      source: "wrangler-login",
    });
    expect(resolveCfCredentials(undefined, root, deployDir, noWrangler)).toEqual({ token: "", source: "none" });
  });
});

describe("wrangler token parse + probe seam", () => {
  const envKeys = ["CF_API_TOKEN", "CLOUDFLARE_API_TOKEN"] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of envKeys) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key]!;
    }
  });

  it("takes the last non-empty stdout line when a cold `bun x` prepends progress", () => {
    expect(parseWranglerTokenOutput("Resolving dependencies\ndownloaded wrangler@4\nwrangler-tok\n")).toBe("wrangler-tok");
    expect(parseWranglerTokenOutput("wrangler-tok\n")).toBe("wrangler-tok");
    expect(parseWranglerTokenOutput(" \n\n")).toBeUndefined();
  });

  it("consults the injected reader only when no earlier source wins", () => {
    const root = makeRoot();
    const deployDir = join(root, "deploy-lexa");
    mkdirSync(deployDir, { recursive: true });
    const reader = vi.fn(() => "wrangler-tok");

    const creds = resolveCfCredentials(undefined, root, deployDir, reader);

    expect(creds).toEqual({ token: "wrangler-tok", source: "wrangler-login" });
    expect(reader).toHaveBeenCalledTimes(1);
    expect(reader).toHaveBeenCalledWith(deployDir);
  });
});

describe("worker upgrade state preservation", () => {
  it("preserves custody files, account, and prior bindings; stamps the new version", async () => {
    const root = makeRoot();
    const prior = priorConfig();
    const { config } = makeDeploy(root, prior);
    const cfToken = join(root, ".cf-token");
    const envFile = join(root, ".env.toml");
    writeFileSync(cfToken, "saved-token\n", { mode: 0o600 });
    writeFileSync(envFile, 'LXK_SECRETS_MASTER_KEY = "abc"\n', { mode: 0o600 });
    const { deps } = buildDeps({ applied: [MCP_SECRET_REFS_MIGRATION, "0013_jev_registry.sql"] });

    const outcome = await runUpgrade(options(config, prior), deps);

    expect(outcome.status).toBe("ok");
    const rebuilt = readDeployConfigFile(config.configPath)!;
    expect(rebuilt.name).toBe("lexa");
    expect(rebuilt.account_id).toBe("acct_123");
    expect(rebuilt.d1_databases).toEqual(prior.d1_databases);
    expect(rebuilt.r2_buckets).toEqual(prior.r2_buckets);
    expect(rebuilt.kv_namespaces).toEqual(prior.kv_namespaces);
    expect(rebuilt.durable_objects).toEqual(prior.durable_objects);
    expect(rebuilt.vars?.LXK_VERSION).toBe("2.0.0");
    // Custody untouched.
    expect(readFileSync(cfToken, "utf-8")).toBe("saved-token\n");
    expect(readFileSync(envFile, "utf-8")).toBe('LXK_SECRETS_MASTER_KEY = "abc"\n');
    // Prior bundle retained.
    expect(existsSync(backupPathFor(config.dir))).toBe(true);
  });
});

describe("migration pre-flight ordering", () => {
  const files = [MCP_SECRET_REFS_MIGRATION, "0013_jev_registry.sql", "0014_provider_secrets.sql"];

  it("lists pending migrations in order", () => {
    expect(pendingMigrations(files, new Set())).toEqual(files);
    expect(pendingMigrations(files, new Set([MCP_SECRET_REFS_MIGRATION]))).toEqual([
      "0013_jev_registry.sql",
      "0014_provider_secrets.sql",
    ]);
  });

  it("enforces the 0012 rule: no gap where a later migration is applied first", () => {
    const applied = new Set(["0013_jev_registry.sql", "0014_provider_secrets.sql"]);
    const err = migrationOrderError(files, applied);
    expect(err).not.toBeNull();
    expect(err).toContain(MCP_SECRET_REFS_MIGRATION);
    // Applied 0012 (with or before later ones) is the legal order.
    expect(migrationOrderError(files, new Set(files))).toBeNull();
  });
});
