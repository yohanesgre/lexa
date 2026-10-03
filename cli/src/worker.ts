// lx worker upgrade — update a self-hosted Lexa web app on Cloudflare
// Workers. This scaffold resolves the target deployment from the installer's
// cf-workers/ custody dir and prints the plan. The update execution
// (release fetch, checksum, migrations, deploy) lands in later lanes
// (LX-36..39), so the run path stops with a clear "not yet implemented"
// message.
//
// Custody layout (written by scripts/install.sh, WORK_DIR default
// `cf-workers/`):
//   cf-workers/deploy-<flavor>/wrangler.<flavor>.json   per-deploy config
//   cf-workers/.cf-token                                saved CF token (0600)
//   cf-workers/.env.toml                                master-key custody (0600)
// The deploy dir is required: cwd by default, `--dir` to point elsewhere —
// the same `flag("dir") || process.cwd()` pattern as
// scripts/lib/cf-deploy.ts.
import { Effect } from "effect";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CliConfigService, normalizeHost } from "./config";

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

// `deploy-<flavor>/wrangler.<flavor>.json`, but tolerate a bare
// `wrangler.json`. Sorted for deterministic output when both exist.
function findWranglerConfig(deployDir: string): string | null {
  let entries: string[];
  try {
    entries = readdirSync(deployDir);
  } catch {
    return null;
  }
  const matches = entries.filter((f) => /^wrangler(\..+)?\.json$/.test(f)).sort();
  return matches.length > 0 ? join(deployDir, matches[0]!) : null;
}

// Every deploy config under the custody dir, sorted by flavor for stable
// output. A dir without a readable config is skipped (not a deploy).
export function discoverWorkerDeploys(dir: string): WorkerDeployConfig[] {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: WorkerDeployConfig[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("deploy-")) continue;
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
  const available = configs.map((c) => c.flavor);
  if (configs.length === 0) return { kind: "none" };
  if (opts.worker) {
    const matches = configs.filter((c) => c.flavor === opts.worker || c.workerName === opts.worker);
    if (matches.length === 0) return { kind: "worker-not-found", worker: opts.worker, available };
    if (matches.length > 1) return { kind: "ambiguous", available };
    return { kind: "resolved", config: matches[0]! };
  }
  if (configs.length === 1) return { kind: "resolved", config: configs[0]! };
  if (opts.loginHost) {
    const matches = configs.filter((c) => c.publicUrl !== "" && normalizeHost(c.publicUrl) === opts.loginHost);
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

// Token source for the plan line — never prints the token itself. Chain:
// --cf-token > environment > saved .cf-token > none.
function tokenSource(flagValue: string | boolean | undefined, dir: string): string {
  if (typeof flagValue === "string" && flagValue) return "--cf-token";
  if (process.env.CF_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN) return "environment";
  if (existsSync(join(dir, ".cf-token"))) return ".cf-token";
  return "none";
}

const USAGE =
  "  Usage: lx worker upgrade [--dir <cf-workers>] [--worker <name>] [--cf-token <tok>] [--dry-run] [--yes] [--version <v>]";

export function cmdWorkerUpgrade(flags: Record<string, string | boolean>): Effect.Effect<void, never, CliConfigService> {
  return Effect.gen(function* () {
    const dirFlag = flags.dir;
    const workerFlag = flags.worker;
    const cfTokenFlag = flags["cf-token"];
    const versionFlag = flags.version;
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

    console.log(`  Worker:      ${config.workerName}`);
    console.log(`  Account:     ${config.accountId || "—"}`);
    console.log(`  Deploy dir:  ${config.dir}`);
    console.log(`  Config:      ${config.configPath}`);
    console.log(`  Public URL:  ${config.publicUrl || "—"}`);
    console.log(`  Version:     ${config.version || "unknown"}`);
    if (typeof versionFlag === "string") console.log(`  Target:      ${versionFlag}`);
    const custody = [".cf-token", ".env.toml"].filter((f) => existsSync(join(dir, f)));
    console.log(`  Custody:     ${custody.length > 0 ? custody.join(", ") : "none"}`);
    console.log(`  CF token:    ${tokenSource(cfTokenFlag, dir)}`);

    if (flags["dry-run"] === true) {
      console.log("  Dry run — no changes made.");
      return;
    }
    console.error("  Update execution is not yet implemented in this build (worker-upgrade scaffold).");
    process.exit(1);
  });
}
