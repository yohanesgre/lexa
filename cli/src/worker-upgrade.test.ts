// cli/worker.ts — `lx worker upgrade` update execution (LX-37/38/39): dry-run
// plan, version refusal, backup/rollback, migration pre-flight, custody/binding
// preservation, plus dispatch + target resolution through the REAL entry point
// (folded in from cli/src/index.worker.test.ts at depth-2). Seams (fetch,
// wrangler, CF API, tar) are injected so these tests never touch the network or
// Cloudflare; a bun shim intercepts `bun x wrangler auth token`.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex, type ReleaseFetcher } from "./release";
import {
  backupPathFor,
  buildDoRemovalMigrations,
  buildUpgradeConfig,
  discoverWorkerDeploys,
  parseWorkerConfigText,
  parseWranglerTokenOutput,
  readDeployConfigFile,
  resolveCfCredentials,
  runUpgrade,
  selectWorkerDeploy,
  type CfJson,
  type UpgradeDeps,
  type UpgradeOptions,
  type WorkerConfigJson,
  type WorkerDeployConfig,
  type WranglerRunner,
  type WranglerTokenReader,
} from "./worker";
import {
  MCP_SECRET_REFS_MIGRATION,
  migrationOrderError,
  pendingMigrations,
} from "../../scripts/lib/cf-deploy";
import { cleanupIsolationDirs, freshLexaDir, runCli, type RunResult } from "./test-utils";

const roots: string[] = [];

// ADR-0006: every emitted deploy config carries the chat supervisor namespace.
const SUPERVISOR_DO = { bindings: [{ name: "CHAT_DO", class_name: "LexaChatSupervisor" }] };

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
  it("refuses the same version without --force and proceeds with --force", async () => {
    const root = makeRoot();
    const prior = priorConfig({ vars: { LXK_VERSION: "2.0.0" } });
    const { config } = makeDeploy(root, prior);
    const { deps } = buildDeps({});

    const refused = await runUpgrade(options(config, prior), deps);
    expect(refused.status).toBe("refused");
    expect(existsSync(backupPathFor(config.dir))).toBe(false);

    const forced = await runUpgrade(options(config, prior, { force: true, dryRun: true }), deps);
    expect(forced.status).toBe("dry-run");
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

describe("worker upgrade state preservation", () => {
  it("preserves prior vars/account/bindings/custody, stamps the version, and reads the real config afterwards", async () => {
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
    expect(rebuilt.vars?.CUSTOM_FLAG).toBe("keep-me");
    expect(rebuilt.vars?.LXK_VERSION).toBe("2.0.0");
    // ADR-0006: the assistant DO stays retired, and the supervisor namespace is
    // bound + its create tag emitted on every upgrade.
    expect(rebuilt.durable_objects).toEqual(SUPERVISOR_DO);
    expect(rebuilt.migrations).toEqual([{ tag: "v1", new_sqlite_classes: ["LexaChatSupervisor"] }]);
    // Custody untouched, prior bundle retained.
    expect(readFileSync(cfToken, "utf-8")).toBe("saved-token\n");
    expect(readFileSync(envFile, "utf-8")).toBe('LXK_SECRETS_MASTER_KEY = "abc"\n');
    expect(existsSync(backupPathFor(config.dir))).toBe(true);
    // The server manifest never lands as the bare `wrangler.json`; discovery
    // still resolves exactly one real deploy from the real config.
    expect(existsSync(join(config.dir, "wrangler.json"))).toBe(false);
    const configs = discoverWorkerDeploys(root);
    expect(configs.map((c) => c.flavor)).toEqual(["lexa"]);
    expect(configs[0]!.accountId).toBe("acct_123");
    const real = readDeployConfigFile(configs[0]!.configPath)!;
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

  it("prefers --cf-token, then env, then the dir/deploy .cf-token, then wrangler login, then none", () => {
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
    delete process.env.CLOUDFLARE_API_TOKEN;
    // The deployDir token is read only when the dir-level one is absent.
    rmSync(join(root, ".cf-token"));
    expect(resolveCfCredentials(undefined, root, deployDir, noWrangler)).toEqual({ token: "deploy-tok", source: ".cf-token" });
    writeFileSync(join(root, ".cf-token"), "dir-tok\n");
    expect(resolveCfCredentials(undefined, root, deployDir, noWrangler)).toEqual({ token: "dir-tok", source: ".cf-token" });
    // A stored wrangler login is the last resort before the error.
    rmSync(join(root, ".cf-token"));
    rmSync(join(deployDir, ".cf-token"));
    expect(resolveCfCredentials(undefined, root, deployDir, () => "wrangler-tok")).toEqual({
      token: "wrangler-tok",
      source: "wrangler-login",
    });
    expect(resolveCfCredentials(undefined, root, deployDir, noWrangler)).toEqual({ token: "", source: "none" });
  });
});

describe("wrangler token parse", () => {
  it("extracts only the token from banner/progress streams and yields undefined for junk", () => {
    // wrangler 4.147.0 prints this banner on STDOUT before the token.
    const banner = "⛅️ wrangler 4.147.0 (update available 4.149.0)\n───────────────────────────\ncfoat_AbC-123_xyz.token\n";
    expect(parseWranglerTokenOutput(banner)).toBe("cfoat_AbC-123_xyz.token");
    const plain = "⛅️ wrangler 4.147.0 (update available 4.149.0)\n───────────\nplain-oauth_token.v1\n";
    expect(parseWranglerTokenOutput(plain)).toBe("plain-oauth_token.v1");
    // A cold `bun x` prepends progress lines — fall back to the last bare token.
    expect(parseWranglerTokenOutput("Resolving dependencies\ndownloaded wrangler@4\nwrangler-tok\n")).toBe("wrangler-tok");
    expect(parseWranglerTokenOutput("wrangler-tok\n")).toBe("wrangler-tok");
    expect(parseWranglerTokenOutput(" \n\n")).toBeUndefined();
  });
});

describe("worker upgrade DO removal migration (ADR-0005)", () => {
  const DO_BINDING = {
    bindings: [{ name: "ASSISTANT_AGENT", class_name: "LexaAssistantAgent" }],
  };
  const BUNDLE = { main: "index.js", assets: { directory: "../client" } };

  it("appends ADR-0005's delete-class tag and ADR-0006's supervisor binding + create for a DO-era prior config", async () => {
    const root = makeRoot();
    const prior = priorConfig({
      durable_objects: DO_BINDING,
      migrations: [{ tag: "v1", new_sqlite_classes: ["LexaAssistantAgent"] }],
    });
    const { config } = makeDeploy(root, prior);
    const { deps } = buildDeps({ applied: [MCP_SECRET_REFS_MIGRATION, "0013_jev_registry.sql"] });

    const outcome = await runUpgrade(options(config, prior), deps);

    expect(outcome.status).toBe("ok");
    const rebuilt = readDeployConfigFile(config.configPath)!;
    // ADR-0005's delete-class tag, then ADR-0006's supervisor binding + create.
    expect(rebuilt.durable_objects).toEqual(SUPERVISOR_DO);
    expect(rebuilt.migrations).toEqual([
      { tag: "v1", new_sqlite_classes: ["LexaAssistantAgent"] },
      { tag: "v2", deleted_classes: ["LexaAssistantAgent"] },
      { tag: "v3", new_sqlite_classes: ["LexaChatSupervisor"] },
    ]);
  });

  it("keeps a repeat upgrade's history verbatim, appends the next tag when deeper, and emits the supervisor create for a never-DO config", () => {
    const repeat = priorConfig({
      migrations: [
        { tag: "v1", new_sqlite_classes: ["LexaAssistantAgent"] },
        { tag: "v2", deleted_classes: ["LexaAssistantAgent"] },
      ],
    });
    expect(buildDoRemovalMigrations(repeat)).toEqual([
      { tag: "v1", new_sqlite_classes: ["LexaAssistantAgent"] },
      { tag: "v2", deleted_classes: ["LexaAssistantAgent"] },
    ]);
    const rebuiltRepeat = buildUpgradeConfig(repeat, {
      version: "2.0.0",
      publicUrl: "https://lexa.example.workers.dev",
      bundle: BUNDLE,
    });
    expect(rebuiltRepeat.migrations).toEqual([
      { tag: "v1", new_sqlite_classes: ["LexaAssistantAgent"] },
      { tag: "v2", deleted_classes: ["LexaAssistantAgent"] },
      { tag: "v3", new_sqlite_classes: ["LexaChatSupervisor"] },
    ]);

    const deeper = priorConfig({
      durable_objects: DO_BINDING,
      migrations: [
        { tag: "v1", new_sqlite_classes: ["LexaAssistantAgent"] },
        { tag: "v2", deleted_classes: ["SomeOtherClass"] },
      ],
    });
    expect(
      buildUpgradeConfig(deeper, { version: "2.0.0", publicUrl: "https://lexa.example.workers.dev", bundle: BUNDLE }).migrations
    ).toEqual([
      { tag: "v1", new_sqlite_classes: ["LexaAssistantAgent"] },
      { tag: "v2", deleted_classes: ["SomeOtherClass"] },
      { tag: "v3", deleted_classes: ["LexaAssistantAgent"] },
      { tag: "v4", new_sqlite_classes: ["LexaChatSupervisor"] },
    ]);

    // Binding-only prior: the DO class is detected without a migrations history.
    const bindingOnly = priorConfig({ durable_objects: DO_BINDING });
    expect(
      buildUpgradeConfig(bindingOnly, { version: "2.0.0", publicUrl: "https://lexa.example.workers.dev", bundle: BUNDLE }).migrations
    ).toEqual([
      { tag: "v1", deleted_classes: ["LexaAssistantAgent"] },
      { tag: "v2", new_sqlite_classes: ["LexaChatSupervisor"] },
    ]);

    const never = priorConfig();
    expect(buildDoRemovalMigrations(never)).toBeUndefined();
    const rebuiltNever = buildUpgradeConfig(never, {
      version: "2.0.0",
      publicUrl: "https://lexa.example.workers.dev",
      bundle: BUNDLE,
    });
    expect(rebuiltNever.migrations).toEqual([{ tag: "v1", new_sqlite_classes: ["LexaChatSupervisor"] }]);
    expect(rebuiltNever.durable_objects).toEqual(SUPERVISOR_DO);
  });
});

describe("migration pre-flight ordering", () => {
  const files = [MCP_SECRET_REFS_MIGRATION, "0013_jev_registry.sql", "0014_provider_secrets.sql"];

  it("lists pending migrations in order and enforces the 0012 rule", () => {
    expect(pendingMigrations(files, new Set())).toEqual(files);
    expect(pendingMigrations(files, new Set([MCP_SECRET_REFS_MIGRATION]))).toEqual([
      "0013_jev_registry.sql",
      "0014_provider_secrets.sql",
    ]);
    const err = migrationOrderError(files, new Set(["0013_jev_registry.sql", "0014_provider_secrets.sql"]));
    expect(err).not.toBeNull();
    expect(err).toContain(MCP_SECRET_REFS_MIGRATION);
    // Applied 0012 (with or before later ones) is the legal order.
    expect(migrationOrderError(files, new Set(files))).toBeNull();
  });
});

// ── dispatch + target resolution (REAL entry point, folded from index.worker) ──

const tmpRoots: string[] = [];

// `runCli` spawns the real `bun`, and the resolved deploy dir makes the creds
// chain invoke `bun x wrangler auth token`. A delegating shim intercepts that
// exact argv (returning "not logged in") and execs the real bun for everything
// else — so no test ever runs a real `wrangler auth token`. When
// LXK_SHIM_MARKER is set the shim records the probe, letting a test prove the
// offline path never reaches it.
const shimDir = mkdtempSync(join(tmpdir(), "lexa-worker-shim-"));
const realBun = execFileSync("bash", ["-c", "command -v bun"], { encoding: "utf-8" }).trim();
writeFileSync(
  join(shimDir, "bun"),
  `#!/usr/bin/env bash
if [ "$1" = "x" ] && [ "$2" = "wrangler" ] && [ "$3" = "auth" ] && [ "$4" = "token" ]; then
  if [ -n "$LXK_SHIM_MARKER" ]; then echo "probe" >> "$LXK_SHIM_MARKER"; fi
  exit 1
fi
exec "${realBun}" "$@"
`,
  { mode: 0o755 },
);

function runWorkerCli(args: string[], env: Record<string, string> = {}): Promise<RunResult> {
  return runCli(args, { PATH: `${shimDir}:${process.env.PATH ?? ""}`, ...env });
}

afterAll(() => {
  cleanupIsolationDirs();
  rmSync(shimDir, { recursive: true, force: true });
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
  tmpRoots.length = 0;
});

function makeWorkerRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "lexa-worker-"));
  tmpRoots.push(d);
  return d;
}

function writeDeploy(
  root: string,
  flavor: string,
  cfg: { name: string; accountId?: string; publicUrl?: string; version?: string },
): void {
  const dir = join(root, `deploy-${flavor}`);
  mkdirSync(dir, { recursive: true });
  const config: Record<string, unknown> = {
    name: cfg.name,
    account_id: cfg.accountId ?? "acct_123",
    vars: {
      ...(cfg.publicUrl ? { LXK_PUBLIC_URL: cfg.publicUrl } : {}),
      ...(cfg.version ? { LXK_VERSION: cfg.version } : {}),
    },
  };
  writeFileSync(join(dir, `wrangler.${flavor}.json`), JSON.stringify(config, null, 2) + "\n");
}

// A saved login for `url`, landing in its normalized group dir.
function writeLogin(lexaDir: string, url: string): void {
  const host = new URL(url).hostname;
  mkdirSync(join(lexaDir, host), { recursive: true });
  writeFileSync(join(lexaDir, host, "config.json"), JSON.stringify({ url, apiKey: "lxk_test" }));
}

describe("worker upgrade target resolution", () => {
  it("refuses outside a cf-workers custody dir and rejects a bare --dir flag", async () => {
    const root = makeWorkerRoot();
    const r = await runWorkerCli(["worker", "upgrade", "--dir", root], { LEXA_URL: "", LEXA_API_KEY: "" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("No Cloudflare Workers deploy found");
    expect(r.stderr).toContain("cf-workers/");

    const bare = await runWorkerCli(["worker", "upgrade", "--dir"], { LEXA_URL: "", LEXA_API_KEY: "" });
    expect(bare.status).toBe(1);
    expect(bare.stderr).toContain("Usage: lx worker upgrade");
  });

  it("fails offline without credentials instead of stubbing the update, and never probes a stored wrangler login", async () => {
    const root = makeWorkerRoot();
    writeDeploy(root, "lexa", { name: "lexa" });
    const r = await runWorkerCli(["worker", "upgrade", "--dir", root], { LEXA_URL: "", LEXA_API_KEY: "", LXK_UPGRADE_OFFLINE: "1" });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("Worker:      lexa");
    expect(r.stderr).toContain("could not resolve the release");

    const marker = join(makeWorkerRoot(), "probe.log");
    const offlineOk = await runWorkerCli(["worker", "upgrade", "--dir", root, "--dry-run"], {
      LEXA_URL: "",
      LEXA_API_KEY: "",
      LXK_UPGRADE_OFFLINE: "1",
      LXK_SHIM_MARKER: marker,
      CF_API_TOKEN: "",
      CLOUDFLARE_API_TOKEN: "",
    });
    expect(offlineOk.status).toBe(0);
    expect(offlineOk.stdout).toContain("CF token:    none");
    expect(existsSync(marker)).toBe(false);
  });

  it("refuses several deploys without --worker and selects with --worker", async () => {
    const root = makeWorkerRoot();
    writeDeploy(root, "alpha", { name: "alpha" });
    writeDeploy(root, "beta", { name: "beta" });
    const several = await runWorkerCli(["worker", "upgrade", "--dir", root, "--dry-run"], { LEXA_URL: "", LEXA_API_KEY: "", LXK_UPGRADE_OFFLINE: "1" });
    expect(several.status).toBe(1);
    expect(several.stderr).toContain("Multiple deploys");
    expect(several.stderr).toContain("alpha");
    expect(several.stderr).toContain("beta");
    expect(several.stderr).toContain("--worker");

    const picked = await runWorkerCli(["worker", "upgrade", "--dir", root, "--worker", "beta", "--dry-run"], { LEXA_URL: "", LEXA_API_KEY: "", LXK_UPGRADE_OFFLINE: "1" });
    expect(picked.status).toBe(0);
    expect(picked.stdout).toContain("Worker:      beta");
  });

  it("rejects an unknown --worker, breaks a tie by saved login ↔ LXK_PUBLIC_URL, and refuses a login mismatch", async () => {
    const root = makeWorkerRoot();
    writeDeploy(root, "alpha", { name: "alpha" });
    writeDeploy(root, "beta", { name: "beta" });
    const unknown = await runWorkerCli(["worker", "upgrade", "--dir", root, "--worker", "nope", "--dry-run"], { LEXA_URL: "", LEXA_API_KEY: "", LXK_UPGRADE_OFFLINE: "1" });
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain("No deploy matches --worker 'nope'");
    expect(unknown.stderr).toContain("alpha, beta");

    const tie = makeWorkerRoot();
    writeDeploy(tie, "alpha", { name: "alpha-worker", publicUrl: "https://alpha.example.com" });
    writeDeploy(tie, "beta", { name: "beta-worker", publicUrl: "https://lexa.example.com" });
    const lexaDir = freshLexaDir();
    writeLogin(lexaDir, "https://lexa.example.com");
    const picked = await runWorkerCli(["worker", "upgrade", "--dir", tie, "--dry-run"], { LEXA_URL: "", LEXA_API_KEY: "", LEXA_DIR: lexaDir, LXK_UPGRADE_OFFLINE: "1" });
    expect(picked.status).toBe(0);
    expect(picked.stdout).toContain("Worker:      beta-worker");

    const mismatchRoot = makeWorkerRoot();
    writeDeploy(mismatchRoot, "lexa", { name: "lexa", publicUrl: "https://lexa.example.com" });
    const otherDir = freshLexaDir();
    writeLogin(otherDir, "https://other.example.com");
    const mismatch = await runWorkerCli(["worker", "upgrade", "--dir", mismatchRoot, "--dry-run"], { LEXA_URL: "", LEXA_API_KEY: "", LEXA_DIR: otherDir, LXK_UPGRADE_OFFLINE: "1" });
    expect(mismatch.status).toBe(1);
    expect(mismatch.stderr).toContain("you are logged in to");
    expect(mismatch.stderr).toContain("other.example.com");
  });
});

describe("worker config parsing + selection (pure)", () => {
  it("parses configs, discovers deploys (skipping non-configs) and never picks a .bak", () => {
    const parsed = parseWorkerConfigText(JSON.stringify({ name: "lexa", account_id: "a1", vars: { LXK_PUBLIC_URL: "https://x.test", LXK_VERSION: "1.2.3" } }));
    expect(parsed).toEqual({ name: "lexa", accountId: "a1", publicUrl: "https://x.test", version: "1.2.3" });
    expect(parseWorkerConfigText("not json")).toBeNull();
    expect(parseWorkerConfigText(JSON.stringify({ account_id: "a1" }))).toBeNull();

    const root = makeWorkerRoot();
    writeDeploy(root, "beta", { name: "beta" });
    writeDeploy(root, "alpha", { name: "alpha" });
    mkdirSync(join(root, "deploy-empty"), { recursive: true });
    const configs = discoverWorkerDeploys(root);
    expect(configs.map((c) => c.flavor)).toEqual(["alpha", "beta"]);
    expect(configs[0]!.workerName).toBe("alpha");

    // A backup sitting beside the live dir must never be discovered as a deploy.
    const live = makeWorkerRoot();
    writeDeploy(live, "lexa", { name: "lexa", accountId: "acct_live", version: "2.0.0" });
    const bak = join(live, "deploy-lexa.bak");
    mkdirSync(bak, { recursive: true });
    writeFileSync(
      join(bak, "wrangler.lexa.json"),
      JSON.stringify({ name: "lexa", account_id: "acct_stale", vars: { LXK_VERSION: "1.0.0" } }, null, 2) + "\n",
    );
    const liveConfigs = discoverWorkerDeploys(live);
    expect(liveConfigs.map((c) => c.flavor)).toEqual(["lexa"]);
    expect(liveConfigs[0]!.accountId).toBe("acct_live");
    const picked = selectWorkerDeploy(liveConfigs, { worker: "lexa" });
    expect(picked.kind).toBe("resolved");
    if (picked.kind === "resolved") {
      expect(picked.config.flavor).toBe("lexa");
      expect(picked.config.accountId).toBe("acct_live");
    }
  });

  it("selectWorkerDeploy drops .bak entries and reports ambiguous / worker-not-found / login-host tie-break", () => {
    const stale = { flavor: "lexa.bak", dir: "", configPath: "", workerName: "lexa", accountId: "acct_stale", publicUrl: "", version: "" };
    expect(selectWorkerDeploy([stale], {})).toEqual({ kind: "none" });
    const single = [{ flavor: "lexa", dir: "", configPath: "", workerName: "lexa", accountId: "acct_live", publicUrl: "", version: "" }];
    const kept = selectWorkerDeploy([...single, stale], {});
    expect(kept.kind).toBe("resolved");
    if (kept.kind === "resolved") expect(kept.config.accountId).toBe("acct_live");

    const many = [
      { flavor: "alpha", dir: "", configPath: "", workerName: "alpha", accountId: "", publicUrl: "https://alpha.test", version: "" },
      { flavor: "beta", dir: "", configPath: "", workerName: "beta", accountId: "", publicUrl: "https://beta.test", version: "" },
    ];
    expect(selectWorkerDeploy(many, {})).toEqual({ kind: "ambiguous", available: ["alpha", "beta"] });
    expect(selectWorkerDeploy(many, { worker: "nope" })).toEqual({ kind: "worker-not-found", worker: "nope", available: ["alpha", "beta"] });
    const picked = selectWorkerDeploy(many, { loginHost: "beta.test" });
    expect(picked.kind).toBe("resolved");
    if (picked.kind === "resolved") expect(picked.config.flavor).toBe("beta");
  });
});
