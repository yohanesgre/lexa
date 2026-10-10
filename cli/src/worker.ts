// lx worker upgrade — update a self-hosted Lexa web app on Cloudflare
// Workers. Custody layout (written by scripts/install.sh, WORK_DIR default
// `cf-workers/`):
//   cf-workers/deploy-<flavor>/wrangler.<flavor>.json   per-deploy config
//   cf-workers/deploy-<flavor>.bak                      prior bundle backup
//   cf-workers/.cf-token                                saved CF token (0600)
//   cf-workers/.env.toml                                master-key custody (0600)
// The deploy dir is required: cwd by default, `--dir` to point elsewhere —
// the same `flag("dir") || process.cwd()` pattern as
// scripts/lib/cf-deploy.ts.
//
// The update execution (LX-37 state preservation, LX-38 migrations, LX-39
// backup/rollback) is a pure-ish core (`runUpgrade`) with injected seams so
// tests never touch the network or Cloudflare. The command wires the default
// seams (fetch, bunx wrangler, CF API, tar) and maps the outcome to an exit.
import { Effect } from "effect";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { CliConfigService, normalizeHost } from "./config";
import {
  releaseForTag,
  resolveWorkersRelease,
  verifyTarballChecksum,
  type ReleaseFetcher,
  type ReleaseInfo,
} from "./release";
import { readDeployedVersion, sameVersion, webTagToVersion } from "./version";
import {
  MCP_SECRET_REFS_MIGRATION,
  buildDoRemovalMigrations,
  cfFetch,
  migrationOrderError,
  pendingMigrations,
  readRootWranglerConfig,
  resolveDeployVars,
  resolveObservability,
  setCfToken,
  wrangler as cfWrangler,
  type RootWorkerConfig,
} from "../../scripts/lib/cf-deploy";

// Re-export the migration rule so `lx worker upgrade` tests and callers have a
// single migration-order surface.
export { MCP_SECRET_REFS_MIGRATION, migrationOrderError, pendingMigrations };

// Re-export the shared DO-removal migration builder (defined in cf-deploy so the
// installer and the CLI share one tag/scan implementation).
export { buildDoRemovalMigrations };

// The custody layout carries no version marker before LX-36 — read it when
// present, otherwise the plan prints "unknown".
export interface WorkerDeployConfig {
  flavor: string;
  dir: string;
  configPath: string;
  workerName: string;
  accountId: string;
  publicUrl: string;
  version: string;
}

export type WorkerSelection =
  | { kind: "resolved"; config: WorkerDeployConfig }
  | { kind: "none" }
  | { kind: "worker-not-found"; worker: string; available: string[] }
  | { kind: "ambiguous"; available: string[] };

// A per-deploy wrangler config (parsed JSON). The installer emits strict JSON
// via JSON.stringify, so a plain JSON.parse suffices.
export interface WorkerConfigJson {
  name: string;
  account_id: string;
  main?: string;
  compatibility_date?: string;
  compatibility_flags?: string[];
  no_bundle?: boolean;
  rules?: unknown[];
  assets?: Record<string, unknown>;
  vars?: Record<string, unknown>;
  d1_databases?: Array<Record<string, unknown>>;
  r2_buckets?: Array<Record<string, unknown>>;
  kv_namespaces?: Array<Record<string, unknown>>;
  durable_objects?: Record<string, unknown>;
  migrations?: Array<Record<string, unknown>>;
  services?: Array<Record<string, unknown>>;
  ai?: Record<string, unknown>;
  triggers?: Record<string, unknown>;
  observability?: Record<string, unknown>;
}

interface BundleManifest {
  main?: string;
  assets?: { directory?: string };
  rules?: unknown[];
  no_bundle?: boolean;
}

// Parse a per-deploy wrangler config. The installer emits strict JSON via
// JSON.stringify, so a plain JSON.parse suffices. A config without a top-level
// `name` is not a deploy config — the caller skips it.
export function parseWorkerConfigText(
  text: string,
): { name: string; accountId: string; publicUrl: string; version: string } | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const cfg = raw as { name?: unknown; account_id?: unknown; vars?: unknown };
  const name = typeof cfg.name === "string" ? cfg.name : "";
  if (!name) return null;
  const accountId = typeof cfg.account_id === "string" ? cfg.account_id : "";
  const vars = (typeof cfg.vars === "object" && cfg.vars !== null ? cfg.vars : {}) as Record<string, unknown>;
  return {
    name,
    accountId,
    publicUrl: typeof vars.LXK_PUBLIC_URL === "string" ? vars.LXK_PUBLIC_URL : "",
    version: typeof vars.LXK_VERSION === "string" ? vars.LXK_VERSION : "",
  };
}

// The full prior config — state preservation (bindings, account, ids) reads
// this before the deploy dir is rebuilt.
export function readDeployConfigFile(configPath: string): WorkerConfigJson | null {
  let text: string;
  try {
    text = readFileSync(configPath, "utf-8");
  } catch {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const cfg = raw as WorkerConfigJson;
  return typeof cfg.name === "string" && cfg.name.length > 0 ? cfg : null;
}

// `deploy-<flavor>/wrangler.<flavor>.json`, but tolerate a bare
// `wrangler.json`. A flavor-specific config wins over the bare name — a staged
// bundle manifest is also called `wrangler.json`, so preferring the deploy
// config keeps discovery reading the real one. Sorted for deterministic output.
function findWranglerConfig(deployDir: string): string | null {
  let entries: string[];
  try {
    entries = readdirSync(deployDir);
  } catch {
    return null;
  }
  const matches = entries.filter((f) => /^wrangler(\..+)?\.json$/.test(f)).sort((a, b) => {
    const aBare = a === "wrangler.json";
    const bBare = b === "wrangler.json";
    if (aBare !== bBare) return aBare ? 1 : -1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return matches.length > 0 ? join(deployDir, matches[0]!) : null;
}

// Every deploy config under the custody dir, sorted by flavor for stable
// output. A dir without a readable config is skipped (not a deploy). The
// `deploy-<flavor>.bak` backup sits beside the live dir and must never be
// discovered as a deploy.
export function discoverWorkerDeploys(dir: string): WorkerDeployConfig[] {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: WorkerDeployConfig[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("deploy-") || entry.name.endsWith(".bak")) continue;
    const deployDir = join(dir, entry.name);
    const configPath = findWranglerConfig(deployDir);
    if (!configPath) continue;
    let parsed: ReturnType<typeof parseWorkerConfigText> = null;
    try {
      parsed = parseWorkerConfigText(readFileSync(configPath, "utf-8"));
    } catch {
      parsed = null;
    }
    if (!parsed) continue;
    out.push({
      flavor: entry.name.slice("deploy-".length),
      dir: deployDir,
      configPath,
      workerName: parsed.name,
      accountId: parsed.accountId,
      publicUrl: parsed.publicUrl,
      version: parsed.version,
    });
  }
  out.sort((a, b) => (a.flavor < b.flavor ? -1 : a.flavor > b.flavor ? 1 : 0));
  return out;
}

// The frozen target-resolution contract:
//   --worker <name>       matches the deploy flavor or the worker name
//   exactly one deploy    use it
//   several deploys       a saved login host matching vars.LXK_PUBLIC_URL
//   otherwise             ambiguous — the caller lists and refuses
// Never guesses alphabetically.
export function selectWorkerDeploy(
  configs: WorkerDeployConfig[],
  opts: { worker?: string | undefined; loginHost?: string | undefined },
): WorkerSelection {
  // Defensive: a `deploy-<flavor>.bak` backup must never be selected even if a
  // caller bypasses discovery's own filter.
  const deploys = configs.filter((c) => !c.flavor.endsWith(".bak"));
  const available = deploys.map((c) => c.flavor);
  if (deploys.length === 0) return { kind: "none" };
  if (opts.worker) {
    const matches = deploys.filter((c) => c.flavor === opts.worker || c.workerName === opts.worker);
    if (matches.length === 0) return { kind: "worker-not-found", worker: opts.worker, available };
    if (matches.length > 1) return { kind: "ambiguous", available };
    return { kind: "resolved", config: matches[0]! };
  }
  if (deploys.length === 1) return { kind: "resolved", config: deploys[0]! };
  if (opts.loginHost) {
    const matches = deploys.filter((c) => c.publicUrl !== "" && normalizeHost(c.publicUrl) === opts.loginHost);
    if (matches.length === 1) return { kind: "resolved", config: matches[0]! };
  }
  return { kind: "ambiguous", available };
}

// The server the operator is logged in to (active marker first, else a lone
// saved login). Several saved logins without an active marker yield null —
// the login-host tie-break is then unavailable.
function resolveLoginHost(): Effect.Effect<{ host: string; url: string } | null, never, CliConfigService> {
  return Effect.gen(function* () {
    const svc = yield* CliConfigService;
    const logins = yield* svc.listSavedLogins();
    if (logins.length === 0) return null;
    const active = yield* svc.activeHost();
    if (active) {
      const match = logins.find((l) => l.host === active);
      if (match) return { host: match.host, url: match.url };
    }
    if (logins.length === 1) return { host: logins[0]!.host, url: logins[0]!.url };
    return null;
  });
}

// ── credentials + custody (LX-37) ──

// The creds chain: --cf-token > CF_API_TOKEN/CLOUDFLARE_API_TOKEN > the custody
// `.cf-token` > a stored `wrangler login`. Never prints the token itself.
export interface CfCredentials {
  token: string;
  source: "--cf-token" | "environment" | ".cf-token" | "wrangler-login" | "none";
}

// Reads the OAuth token `wrangler login` stored, or undefined when not logged
// in. Injectable so tests never shell out to a real wrangler (which would print
// the operator's token).
export type WranglerTokenReader = (cwd: string) => string | undefined;

// wrangler 4.x prints an update banner on STDOUT, so the token is NOT simply
// the last non-empty line (a cold `bun x` may also prepend install progress).
// Prefer a `cfoat_`-prefixed match; else the LAST line that is a bare token
// charset (alnum + `_`/`.`/`-`, no spaces/emoji). Returns undefined when neither
// hits — the caller then falls through to the stored-config fallback.
const CFOAT_TOKEN_RE = /cfoat_[A-Za-z0-9_.-]+/;
const BARE_TOKEN_LINE_RE = /^[A-Za-z0-9_.-]+$/;

export function parseWranglerTokenOutput(stdout: string): string | undefined {
  const cfoat = stdout.match(CFOAT_TOKEN_RE);
  if (cfoat) return cfoat[0];
  const lines = stdout.split(/\r?\n/).map((line) => line.trim());
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (BARE_TOKEN_LINE_RE.test(lines[i]!)) return lines[i];
  }
  return undefined;
}

function defaultWranglerTokenReader(cwd: string): string | undefined {
  // `bun x wrangler`, not `bunx` — same runtime the deploy core uses. A cold
  // `bun x` may install wrangler, hence the generous timeout. Non-zero exit
  // (not logged in) or empty stdout falls through.
  const res = spawnSync("bun", ["x", "wrangler", "auth", "token"], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
    timeout: 30_000,
  });
  if (res.status !== 0) return undefined;
  return parseWranglerTokenOutput(typeof res.stdout === "string" ? res.stdout : "");
}

export function resolveCfCredentials(
  flagValue: string | boolean | undefined,
  dir: string,
  deployDir: string,
  readWranglerToken: WranglerTokenReader = defaultWranglerTokenReader,
): CfCredentials {
  if (typeof flagValue === "string" && flagValue) return { token: flagValue, source: "--cf-token" };
  const env = process.env.CF_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN || "";
  if (env) return { token: env, source: "environment" };
  for (const candidate of [join(dir, ".cf-token"), join(deployDir, ".cf-token")]) {
    if (!existsSync(candidate)) continue;
    try {
      const token = readFileSync(candidate, "utf-8").trim();
      if (token) return { token, source: ".cf-token" };
    } catch {
      /* unreadable custody token — fall through */
    }
  }
  const wranglerToken = readWranglerToken(deployDir);
  if (wranglerToken) return { token: wranglerToken, source: "wrangler-login" };
  return { token: "", source: "none" };
}

export interface CustodyState {
  cfTokenPath: string | null;
  envFilePath: string | null;
  hasMasterKey: boolean;
}

function hasEnvKey(text: string, key: string): boolean {
  return new RegExp(`(^|\\n)\\s*${key}\\s*=`).test(text);
}

// Read (never write) the custody files. `.env.toml`/`.env` carries the secrets
// master key; a missing key is a warning, not a hard refusal — the secret may
// live only on the Worker, but losing the custody copy would strand rotation.
export function readCustody(dir: string): CustodyState {
  const cfTokenPath = join(dir, ".cf-token");
  const envToml = join(dir, ".env.toml");
  const envFlat = join(dir, ".env");
  const envPath = existsSync(envToml) ? envToml : existsSync(envFlat) ? envFlat : null;
  let text = "";
  if (envPath) {
    try {
      text = readFileSync(envPath, "utf-8");
    } catch {
      text = "";
    }
  }
  return {
    cfTokenPath: existsSync(cfTokenPath) ? cfTokenPath : null,
    envFilePath: envPath,
    hasMasterKey: hasEnvKey(text, "LXK_SECRETS_MASTER_KEY"),
  };
}

// ── backup / rollback (LX-39) ──

export function backupPathFor(deployDir: string): string {
  return `${deployDir}.bak`;
}

// Copy `deploy-<flavor>/` → `deploy-<flavor>.bak` before any staging mutation.
// The previous bundle is retained on success and is the rollback source.
export function backupDeployDir(deployDir: string): string {
  const bak = backupPathFor(deployDir);
  rmSync(bak, { recursive: true, force: true });
  cpSync(deployDir, bak, { recursive: true });
  return bak;
}

// Restore the deploy dir from the backup. Returns false when no backup exists
// (nothing to roll back to). Restores via a temp sibling + rename so a crash
// mid-copy never leaves the deploy dir missing. The `.bak` is retained.
export function restoreDeployDir(deployDir: string): boolean {
  const bak = backupPathFor(deployDir);
  if (!existsSync(bak)) return false;
  const tmp = join(dirname(deployDir), `.${basename(deployDir)}.restore-tmp`);
  rmSync(tmp, { recursive: true, force: true });
  cpSync(bak, tmp, { recursive: true });
  rmSync(deployDir, { recursive: true, force: true });
  renameSync(tmp, deployDir);
  return true;
}

// ── deploy-config rebuild (LX-37) ──

function copyDirContents(from: string, to: string, exclude?: (name: string) => boolean): void {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from)) {
    if (exclude?.(entry)) continue;
    const src = join(from, entry);
    const dst = join(to, entry);
    if (statSync(src).isDirectory()) copyDirContents(src, dst, exclude);
    else writeFileSync(dst, readFileSync(src));
  }
}

export function readBundleManifest(stageDir: string): BundleManifest {
  const path = join(stageDir, "dist", "server", "wrangler.json");
  if (!existsSync(path)) {
    throw new Error(`workers tarball emitted no dist/server/wrangler.json`);
  }
  const raw = JSON.parse(readFileSync(path, "utf-8")) as BundleManifest;
  return raw;
}

// Stage the new bundle into the existing deploy dir (flat layout: server
// chunk contents at the deploy root, browser assets at ./assets). The server
// manifest `wrangler.json` is excluded — copied into the deploy dir it would
// masquerade as (and shadow) the per-deploy `wrangler.<flavor>.json`.
export function stageBundle(stageDir: string, deployDir: string, manifest: BundleManifest): void {
  const serverDir = join(stageDir, "dist", "server");
  const assetsDir = join(stageDir, "dist", "server", manifest.assets?.directory ?? "../client");
  if (!existsSync(serverDir)) throw new Error(`workers bundle entry missing: ${serverDir}`);
  copyDirContents(serverDir, deployDir, (name) => name === "wrangler.json");
  if (existsSync(assetsDir)) copyDirContents(assetsDir, join(deployDir, "assets"));
}

// Rebuild the per-deploy config from the PRIOR bindings (live D1/R2/KV ids and
// account) plus the new bundle + resolved vars. Bindings are preserved
// verbatim — the ids identify live resources and must never be recreated.
export function buildUpgradeConfig(
  prior: WorkerConfigJson,
  opts: {
    version: string | null;
    publicUrl: string;
    bundle: BundleManifest;
    root?: RootWorkerConfig | undefined;
  },
): WorkerConfigJson {
  const root = opts.root;
  let observability = prior.observability;
  if (root && !observability) observability = resolveObservability(root);
  // Preserve the scheduled tick (prune + R2 backup retention); derive it from
  // root when a prior config lacks it (older installs).
  const triggers = prior.triggers ?? root?.triggers;
  const main = opts.bundle.main ?? prior.main ?? "index.js";
  const config: WorkerConfigJson = {
    name: prior.name,
    account_id: prior.account_id,
    main: `./${basename(main)}`,
    compatibility_date: root?.compatibility_date ?? prior.compatibility_date ?? "2026-08-01",
    compatibility_flags: prior.compatibility_flags ?? ["nodejs_compat"],
    assets: prior.assets ?? { directory: "./assets", binding: "ASSETS" },
    vars: { ...(prior.vars ?? {}), ...resolveDeployVars({ version: opts.version, publicUrl: opts.publicUrl }) },
    observability: observability ?? { enabled: true },
  };
  const noBundle = opts.bundle.no_bundle ?? prior.no_bundle;
  if (noBundle !== undefined) config.no_bundle = noBundle;
  const rules = opts.bundle.rules ?? prior.rules;
  if (rules !== undefined) config.rules = rules;
  if (prior.d1_databases !== undefined) config.d1_databases = prior.d1_databases;
  if (prior.r2_buckets !== undefined) config.r2_buckets = prior.r2_buckets;
  if (prior.kv_namespaces !== undefined) config.kv_namespaces = prior.kv_namespaces;
  // ADR-0005: drop the DO binding and append the delete-class migration for a
  // DO-era deployment; a never-DO config carries no migrations at all.
  const migrations = buildDoRemovalMigrations(prior);
  if (migrations !== undefined) config.migrations = migrations;
  if (triggers !== undefined) config.triggers = triggers;
  return config;
}

// ── migration pre-flight (LX-38) ──

function readMigrationFiles(stageDir: string): string[] {
  const dir = join(stageDir, "migrations");
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  } catch {
    return [];
  }
}

function priorD1Id(prior: WorkerConfigJson): string {
  const list = prior.d1_databases;
  if (!Array.isArray(list) || list.length === 0) return "";
  const first = list[0];
  if (typeof first !== "object" || first === null) return "";
  const id = (first as { database_id?: unknown }).database_id;
  return typeof id === "string" ? id : "";
}

function priorPublicUrl(prior: WorkerConfigJson, config: WorkerDeployConfig): string {
  const vars = prior.vars;
  const url = vars && typeof vars.LXK_PUBLIC_URL === "string" ? vars.LXK_PUBLIC_URL : "";
  return url || config.publicUrl;
}

function isCustomDomain(publicUrl: string): boolean {
  if (!publicUrl) return false;
  try {
    return !new URL(publicUrl).hostname.endsWith(".workers.dev");
  } catch {
    return false;
  }
}

// ── injected seams ──

export interface WranglerRun {
  status: number;
  stdout: string;
  stderr: string;
}
export type WranglerRunner = (
  args: string[],
  opts?: { input?: string; capture?: boolean },
) => WranglerRun;
export type CfJson = <T>(label: string, path: string, init?: RequestInit) => Promise<T>;

export interface UpgradeDeps {
  fetchFn: ReleaseFetcher;
  wrangler: WranglerRunner;
  cfJson: CfJson;
  extract: (tarballPath: string, destDir: string) => void;
  prompt: (question: string) => Promise<boolean>;
  log: (message: string) => void;
  error: (message: string) => void;
}

export interface UpgradeOptions {
  dir: string;
  config: WorkerDeployConfig;
  prior: WorkerConfigJson;
  versionFlag?: string | undefined;
  token: string;
  dryRun: boolean;
  yes: boolean;
  force: boolean;
}

export type UpgradeOutcome =
  | {
      status: "dry-run";
      tag: string | null;
      currentVersion: string | null;
      latestVersion: string | null;
      checksum: "verified" | "unavailable";
      pending: string[];
    }
  | {
      status: "ok";
      tag: string;
      currentVersion: string | null;
      latestVersion: string;
      backupPath: string;
      pending: string[];
    }
  | { status: "refused"; reason: string }
  | { status: "failed"; reason: string; rolledBack: boolean };

// A pinned `--version` may be written `2.0.0` or `v2.0.0`; the release URLs
// anchor on the `v` tag.
function normalizeTag(version: string): string {
  return version.startsWith("v") ? version : `v${version}`;
}

async function fetchBytes(fetchFn: ReleaseFetcher, url: string): Promise<Uint8Array> {
  const res = await fetchFn(url, { headers: { "User-Agent": "lx" } });
  if (!res.ok) throw new Error(`download failed: ${url} (HTTP ${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

async function fetchText(fetchFn: ReleaseFetcher, url: string): Promise<string> {
  const res = await fetchFn(url, { headers: { "User-Agent": "lx" } });
  if (!res.ok) throw new Error(`download failed: ${url} (HTTP ${res.status})`);
  return res.text();
}

async function fetchAppliedMigrations(
  cfJson: CfJson,
  account: string,
  d1Id: string,
  ensure: boolean,
): Promise<Set<string>> {
  // A dry run must not mutate D1 — skip the idempotent journal init and read
  // only. A missing journal then surfaces as "unavailable", never a write.
  if (ensure) {
    await cfJson("D1 journal init", `/accounts/${account}/d1/database/${d1Id}/query`, {
      method: "POST",
      body: JSON.stringify({
        sql: "CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT DEFAULT (datetime('now')))",
      }),
    });
  }
  const rows = await cfJson<Array<{ results?: Array<{ name?: string }> }>>(
    "D1 journal read",
    `/accounts/${account}/d1/database/${d1Id}/query`,
    { method: "POST", body: JSON.stringify({ sql: "SELECT name FROM _migrations" }) },
  );
  const applied = new Set<string>();
  for (const block of rows) for (const row of block.results ?? []) if (row.name) applied.add(row.name);
  return applied;
}

async function applyMigrations(
  cfJson: CfJson,
  account: string,
  d1Id: string,
  stageDir: string,
  pending: string[],
): Promise<void> {
  for (const file of pending) {
    const sql = readFileSync(join(stageDir, "migrations", file), "utf-8");
    await cfJson(`D1 migration ${file}`, `/accounts/${account}/d1/database/${d1Id}/query`, {
      method: "POST",
      body: JSON.stringify({
        sql: `${sql}\nINSERT INTO _migrations (name) VALUES ('${file.replace(/'/g, "''")}');`,
      }),
    });
  }
}

// Custom-domain deploys bind a route to the worker; a redeploy of the same
// script already has it, but re-assert it so a changed worker name re-points.
async function rebindRoute(
  cfJson: CfJson,
  publicUrl: string,
  workerName: string,
  log: (m: string) => void,
): Promise<void> {
  const host = new URL(publicUrl).hostname;
  const zoneHost = host.split(".").slice(-2).join(".");
  const zones = await cfJson<Array<{ id: string }>>(`lookup zone ${zoneHost}`, `/zones?name=${zoneHost}`);
  const zone = zones[0]?.id;
  if (!zone) return;
  const pattern = `${host}/*`;
  const routes = await cfJson<Array<{ id: string; pattern?: string }>>("list worker routes", `/zones/${zone}/workers/routes`);
  for (const route of routes.filter((r) => r.pattern === pattern)) {
    await cfJson(`delete route ${pattern}`, `/zones/${zone}/workers/routes/${route.id}`, { method: "DELETE" });
  }
  await cfJson(`bind route ${pattern}`, `/zones/${zone}/workers/routes`, {
    method: "POST",
    body: JSON.stringify({ pattern, script: workerName }),
  });
  log(`  ✓ route ${pattern} → ${workerName}`);
}

// The update core. Never throws for expected failures — returns a discriminated
// outcome so the caller owns the exit code and tests can assert either way.
export async function runUpgrade(opts: UpgradeOptions, deps: UpgradeDeps): Promise<UpgradeOutcome> {
  const { config, prior } = opts;
  const current = readDeployedVersion(prior) ?? (config.version || null);
  if (!current) {
    deps.error("  Version:     unknown (deploy config predates the LXK_VERSION marker)");
  }

  // Resolve the release (pinned tag, else newest v[0-9] release).
  let release: ReleaseInfo | null = null;
  let latestVersion: string | null = null;
  let resolveError: Error | null = null;
  try {
    release = opts.versionFlag
      ? releaseForTag(normalizeTag(opts.versionFlag))
      : await resolveWorkersRelease(deps.fetchFn);
    latestVersion = webTagToVersion(release.tag);
  } catch (e) {
    resolveError = e instanceof Error ? e : new Error(String(e));
  }
  if (!release) {
    if (opts.dryRun) {
      deps.error(`  Release:     unavailable (${resolveError?.message ?? "unknown"})`);
      deps.log("  Dry run — no changes made.");
      return { status: "dry-run", tag: null, currentVersion: current, latestVersion: null, checksum: "unavailable", pending: [] };
    }
    return { status: "failed", reason: `could not resolve the release: ${resolveError?.message ?? "unknown"}`, rolledBack: false };
  }

  // A resolved release always carries a version; the null branch above
  // already returned.
  const latest = latestVersion ?? webTagToVersion(release.tag);

  if (!opts.force && sameVersion(current, latest)) {
    deps.error(`  Already at ${latest}. Pass --force to reinstall the same version.`);
    return { status: "refused", reason: `already at ${latest}` };
  }

  // Download + verify + extract to a stage (no deploy-dir mutation yet).
  let tmpRoot = "";
  let stageDir = "";
  let migrationFiles: string[] = [];
  let checksum: "verified" | "unavailable" = "unavailable";
  try {
    const bytes = await fetchBytes(deps.fetchFn, release.tarballUrl);
    const checksumsText = await fetchText(deps.fetchFn, release.checksumsUrl);
    verifyTarballChecksum(bytes, checksumsText, `lexa-workers-${release.tag}.tar.gz`);
    checksum = "verified";
    tmpRoot = mkdtempSync(join(tmpdir(), "lx-upgrade-"));
    const safeTag = release.tag.replace(/[^A-Za-z0-9._-]/g, "_");
    const tarballPath = join(tmpRoot, `lexa-workers-${safeTag}.tar.gz`);
    writeFileSync(tarballPath, bytes);
    stageDir = join(tmpRoot, "stage");
    mkdirSync(stageDir, { recursive: true });
    deps.extract(tarballPath, stageDir);
    migrationFiles = readMigrationFiles(stageDir);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
    return { status: "failed", reason: `release download/verification failed: ${reason}`, rolledBack: false };
  }

  const cleanup = (): void => {
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  };

  // Migration pre-flight against the live D1 `_migrations` journal.
  const account = prior.account_id || config.accountId;
  const d1Id = priorD1Id(prior);
  let applied = new Set<string>();
  let migrationsChecked = false;
  if (account && d1Id && opts.token) {
    try {
      applied = await fetchAppliedMigrations(deps.cfJson, account, d1Id, !opts.dryRun);
      migrationsChecked = true;
    } catch (e) {
      if (!opts.dryRun) {
        cleanup();
        return { status: "failed", reason: `migration pre-flight failed: ${e instanceof Error ? e.message : String(e)}`, rolledBack: false };
      }
      deps.error(`  Migrations:  unavailable (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  const pending = migrationsChecked ? pendingMigrations(migrationFiles, applied) : [];
  if (migrationsChecked) {
    const orderError = migrationOrderError(migrationFiles, applied);
    if (orderError) {
      cleanup();
      return { status: "failed", reason: orderError, rolledBack: false };
    }
  }

  if (opts.dryRun) {
    deps.log(`  Release:     ${release.tag}`);
    deps.log(`  Latest:      ${latest}${current ? ` (current ${current})` : " · current unknown"}`);
    deps.log(`  Checksum:    ${checksum === "verified" ? `sha256 verified (lexa-workers-${release.tag}.tar.gz)` : "unavailable"}`);
    deps.log(`  Migrations:  ${pending.length > 0 ? pending.join(", ") : migrationsChecked ? "up to date" : "unavailable"}`);
    deps.log("  Dry run — no changes made.");
    cleanup();
    return { status: "dry-run", tag: release.tag, currentVersion: current, latestVersion: latest, checksum, pending };
  }

  if (!opts.token) {
    cleanup();
    return { status: "failed", reason: "no Cloudflare credentials — pass --cf-token, set CF_API_TOKEN/CLOUDFLARE_API_TOKEN, save .cf-token, or run `wrangler login`", rolledBack: false };
  }
  if (!opts.yes) {
    const proceed = await deps.prompt(`  Update ${current ?? "unknown"} → ${latest}?`);
    if (!proceed) {
      cleanup();
      return { status: "refused", reason: "aborted — pass --yes to skip confirmation" };
    }
  }

  const publicUrl = priorPublicUrl(prior, config);
  let backupPath = "";
  let mutated = false;
  let appliedMigrations = 0;
  try {
    const bundle = readBundleManifest(stageDir);
    let root: RootWorkerConfig | undefined;
    try {
      root = readRootWranglerConfig(stageDir);
    } catch {
      root = undefined;
    }
    // Validate + rebuild the config BEFORE the deploy dir is touched: a bad
    // tarball or missing binding refuses with the prior deploy dir intact.
    const rebuilt = buildUpgradeConfig(prior, { version: latest, publicUrl, bundle, root });

    backupPath = backupDeployDir(config.dir);
    mutated = true;
    deps.log(`  ✓ backup → ${backupPath}`);

    stageBundle(stageDir, config.dir, bundle);
    writeFileSync(config.configPath, JSON.stringify(rebuilt, null, 2) + "\n", { mode: 0o600 });
    deps.log("  ✓ config rebuilt (account, bindings, custody preserved)");

    if (pending.length > 0) {
      await applyMigrations(deps.cfJson, account, d1Id, stageDir, pending);
      appliedMigrations = pending.length;
      deps.log(`  ✓ applied migrations: ${pending.join(", ")}`);
    }

    const deployed = deps.wrangler(["deploy", "--config", config.configPath]);
    if (deployed.status !== 0) {
      const tail = (deployed.stderr || deployed.stdout).split("\n").filter(Boolean).slice(-3).join(" | ");
      throw new Error(`wrangler deploy failed${tail ? `: ${tail.slice(-400)}` : ""}`);
    }
    deps.log("  ✓ deployed");

    if (isCustomDomain(publicUrl)) {
      try {
        await rebindRoute(deps.cfJson, publicUrl, config.workerName, deps.log);
      } catch (e) {
        deps.error(`  route rebind skipped: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    deps.log(`  Update complete: ${current ?? "unknown"} → ${latest} (backup kept at ${backupPath})`);
    cleanup();
    return { status: "ok", tag: release.tag, currentVersion: current, latestVersion: latest, backupPath, pending };
  } catch (e) {
    const baseReason = e instanceof Error ? e.message : String(e);
    // Rollback restores files only; applied D1 migrations are never reverted.
    const migrationNote = appliedMigrations > 0 ? ` (migrations applied: ${appliedMigrations} — not reverted)` : "";
    const reason = `${baseReason}${migrationNote}`;
    const rolledBack = mutated ? restoreDeployDir(config.dir) : false;
    if (rolledBack) deps.error(`  Rolled back to ${backupPath}`);
    if (appliedMigrations > 0) deps.error(`  migrations applied: ${appliedMigrations} — not reverted (dir-only rollback)`);
    deps.error(`  Update failed: ${baseReason}`);
    cleanup();
    return { status: "failed", reason, rolledBack };
  }
}

// ── default seams ──

function defaultCfJson(): CfJson {
  return async <T>(label: string, path: string, init?: RequestInit): Promise<T> => {
    const r = await cfFetch(path, init);
    if (!r.ok) {
      const detail = r.errors.map((e) => e.message).filter(Boolean).join("; ") || "unknown error";
      throw new Error(`Cloudflare ${label} failed: ${detail}`);
    }
    return r.json?.result as T;
  };
}

function defaultExtract(tarballPath: string, destDir: string): void {
  const result = spawnSync("tar", ["-xzf", tarballPath, "-C", destDir], { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`tarball extraction failed (status ${result.status ?? "?"})`);
  }
}

function defaultPrompt(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return Promise.resolve(false);
  process.stdout.write(`${question} [y/N] `);
  return new Promise((resolvePromise) => {
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", (chunk) => resolvePromise(/^y(es)?$/i.test(String(chunk).trim())));
  });
}

// LXK_UPGRADE_OFFLINE forces the release/migration seams to fail fast, so a
// dry run (and its tests) never touch GitHub or Cloudflare.
export function defaultUpgradeDeps(token: string, offline: boolean): UpgradeDeps {
  void token;
  const fetchFn: ReleaseFetcher = offline
    ? async () => {
        throw new Error("offline mode (LXK_UPGRADE_OFFLINE)");
      }
    : fetch;
  const cfJson: CfJson = offline
    ? async () => {
        throw new Error("offline mode (LXK_UPGRADE_OFFLINE)");
      }
    : defaultCfJson();
  return {
    fetchFn,
    cfJson,
    wrangler: cfWrangler,
    extract: defaultExtract,
    prompt: defaultPrompt,
    log: (m) => console.log(m),
    error: (m) => console.error(m),
  };
}

const USAGE =
  "  Usage: lx worker upgrade [--dir <cf-workers>] [--worker <name>] [--cf-token <tok>] [--version <tag>] [--dry-run] [--yes] [--force]";

export function cmdWorkerUpgrade(flags: Record<string, string | boolean>): Effect.Effect<void, never, CliConfigService> {
  return Effect.gen(function* () {
    const dirFlag = flags.dir;
    const workerFlag = flags.worker;
    const cfTokenFlag = flags["cf-token"];
    const versionFlag = flags.version;
    // Presence checks, never `=== true`: `--dry-run extra` parses the value
    // flag-style and must still be treated as dry-run.
    const dryRun = flags["dry-run"] !== undefined;
    const yes = flags.yes !== undefined;
    const force = flags.force !== undefined;
    // Bare (`--dir`, no value) and empty (`--dir=`) value flags are usage
    // errors — silently treating them as the default would resolve the wrong
    // target.
    const bare = [dirFlag, workerFlag, cfTokenFlag, versionFlag].some((v) => v === true);
    const empty = dirFlag === "" || workerFlag === "" || cfTokenFlag === "" || versionFlag === "";
    if (bare || empty) {
      console.error(USAGE);
      process.exit(1);
    }

    const rawDir = typeof dirFlag === "string" && dirFlag ? dirFlag : process.cwd();
    const dir = resolve(rawDir);
    const configs = discoverWorkerDeploys(dir);
    if (configs.length === 0) {
      console.error(`  No Cloudflare Workers deploy found in ${dir}.`);
      console.error("  Run this from your cf-workers/ deploy dir, or pass --dir <path>:");
      console.error("    cd cf-workers && lx worker upgrade");
      process.exit(1);
    }

    const login = yield* resolveLoginHost();
    const selection = selectWorkerDeploy(configs, {
      worker: typeof workerFlag === "string" ? workerFlag : undefined,
      loginHost: login?.host,
    });
    if (selection.kind === "none") {
      console.error(`  No Cloudflare Workers deploy found in ${dir}.`);
      process.exit(1);
    }
    if (selection.kind === "worker-not-found") {
      console.error(`  No deploy matches --worker '${selection.worker}'. Available: ${selection.available.join(", ")}`);
      process.exit(1);
    }
    if (selection.kind === "ambiguous") {
      console.error(`  Multiple deploys in ${dir}: ${selection.available.join(", ")}`);
      console.error("  Pass --worker <name> to choose one.");
      process.exit(1);
    }

    const config = selection.config;
    // Logged-in cross-check: the deploy's LXK_PUBLIC_URL must name the server
    // the operator is logged in to. A mismatch means the wrong custody dir.
    if (login && config.publicUrl) {
      const deployHost = normalizeHost(config.publicUrl);
      if (deployHost !== login.host) {
        console.error(`  Deploy '${config.workerName}' serves ${config.publicUrl} (${deployHost}) but you are logged in to ${login.url} (${login.host}).`);
        console.error("  Pass --dir pointing at the matching cf-workers/ dir, or login to that server first.");
        process.exit(1);
      }
    }

    // Offline mode is resolved before credentials: a stored `wrangler login`
    // probe shells out to `bun x wrangler auth token`, which on a cold cache
    // can install and block for the timeout. Offline must never spawn it.
    const offline = process.env.LXK_UPGRADE_OFFLINE === "1" || process.env.LXK_UPGRADE_OFFLINE === "true";
    const creds = resolveCfCredentials(
      cfTokenFlag,
      dir,
      config.dir,
      offline ? () => undefined : defaultWranglerTokenReader,
    );
    const custody = readCustody(dir);
    const prior = readDeployConfigFile(config.configPath) ?? {
      name: config.workerName,
      account_id: config.accountId,
    };

    console.log(`  Worker:      ${config.workerName}`);
    console.log(`  Account:     ${config.accountId || prior.account_id || "—"}`);
    console.log(`  Deploy dir:  ${config.dir}`);
    console.log(`  Config:      ${config.configPath}`);
    console.log(`  Public URL:  ${config.publicUrl || "—"}`);
    console.log(`  Version:     ${config.version || "unknown"}`);
    if (typeof versionFlag === "string") console.log(`  Target:      ${versionFlag}`);
    const custodyFiles = [custody.cfTokenPath, custody.envFilePath].filter((p): p is string => p !== null).map((p) => basename(p));
    console.log(`  Custody:     ${custodyFiles.length > 0 ? custodyFiles.join(", ") : "none"}`);
    if (custody.envFilePath && !custody.hasMasterKey) {
      console.error("  Warning: custody .env.toml has no LXK_SECRETS_MASTER_KEY — rotation/backfill will be stranded.");
    }
    console.log(`  CF token:    ${creds.source}`);

    if (creds.token) setCfToken(creds.token);
    const deps = defaultUpgradeDeps(creds.token, offline);
    const outcome = yield* Effect.promise(() =>
      runUpgrade(
        {
          dir,
          config,
          prior,
          versionFlag: typeof versionFlag === "string" ? versionFlag : undefined,
          token: creds.token,
          dryRun,
          yes,
          force,
        },
        deps,
      ),
    );

    if (outcome.status === "dry-run" || outcome.status === "ok") return;
    console.error(`  worker upgrade: ${outcome.reason}`);
    process.exit(1);
  });
}
