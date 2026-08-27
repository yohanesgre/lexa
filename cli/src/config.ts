// lexa-cli config — state is host-keyed: one root ~/.lexa/ (LEXA_DIR env
// override wins, used by tests), grouped per server host:
//   ~/.lexa/<host>/config.json      { url, apiKey } + deploy creds (chmod 600)
//   ~/.lexa/<host>/machine-id       machine identity for THAT server
//   ~/.lexa/<host>/machine-secret   server-minted listener secret
//   ~/.lexa/<host>/runtimes/, projects/, projects.json, runs/, deploy/
// The host is normalizeHost()'d so the same server always lands in the same
// group regardless of scheme/port/case. Deploy creds live under the group's
// config.json `deploy` key.
//
// Effect service: reads/writes are best-effort by design (corrupt/missing
// files yield null, never typed failures) — the CLI treats config as
// advisory state, so the error channel is `never`.
import { Effect } from "effect";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, rmSync, renameSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export interface CliConfig {
  url: string;
  apiKey: string;
}

// Deploy credentials (Cloudflare) persisted alongside the login so
// `lexa-cli deploy` works without a saved url/apiKey.
export interface DeployCreds {
  cfToken?: string | undefined;
}

export const LEXA_DIR = process.env.LEXA_DIR ?? join(homedir(), ".lexa");

export type LexaFlavor = "dev" | "staging" | "prod";

// ── Host normalization ──
// Accepts a full URL or a bare host[:port]. Strip scheme, lowercase, strip
// default ports (80/443) while keeping explicit ports, map loopback
// (localhost, 127.0.0.0/8, ::1) to "localhost" (explicit ports survive:
// localhost:3000 ≠ localhost:8794), strip IPv6 URL brackets while keeping
// the colons (Linux/macOS group names only).
export function normalizeHost(urlOrHost: string): string {
  let host = urlOrHost.trim();
  let port = "";
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(host)) {
    try {
      const u = new URL(host);
      host = u.hostname;
      port = u.port;
    } catch {
      return host.toLowerCase();
    }
  } else {
    const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(host);
    if (bracketed) {
      host = bracketed[1]!;
      port = bracketed[2]! ?? "";
    } else {
      // Bare host:port (single colon); multi-colon input is a bare IPv6.
      const singleColon = /^([^:]+):(\d+)$/.exec(host);
      if (singleColon) {
        host = singleColon[1]!;
        port = singleColon[2]!;
      }
    }
  }
  // URL.hostname keeps IPv6 brackets (WHATWG) — strip them here too.
  host = host.replace(/^\[|\]$/g, "").toLowerCase();
  const keepPort = port !== "" && port !== "80" && port !== "443";
  if (isLoopback(host)) return keepPort ? `localhost:${port}` : "localhost";
  return keepPort ? `${host}:${port}` : host;
}

function isLoopback(host: string): boolean {
  return host === "localhost" || host === "::1" || host.startsWith("127.");
}

// Group dir for a host (full URL or bare host) under the state root.
export function groupDir(host: string): string {
  return join(LEXA_DIR, normalizeHost(host));
}

// Derived flavor label — loopback servers are dev, everything else prod.
// LEXA_FLAVOR env overrides (e.g. a non-loopback staging server). Used for
// exactly one thing: the daemon serve-port base (flavorBaseFor in
// hearth/daemon.ts). Never a state location, never a login default.
export function flavorFor(host: string): LexaFlavor {
  const override = process.env.LEXA_FLAVOR;
  if (override === "dev" || override === "staging" || override === "prod") return override;
  // Loopback servers (with or without an explicit port) are dev.
  return /^localhost(:\d+)?$/.test(normalizeHost(host)) ? "dev" : "prod";
}

function loadConfigSync(dir: string): CliConfig | null {
  try {
    const path = join(dir, "config.json");
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<CliConfig>;
    if (!raw.url || !raw.apiKey) return null;
    return { url: raw.url.replace(/\/+$/, ""), apiKey: raw.apiKey };
  } catch {
    return null;
  }
}

function saveConfigSync(config: CliConfig, dir: string): void {
  migrateLegacyDirsSync();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify({ url: config.url.replace(/\/+$/, ""), apiKey: config.apiKey }, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
  console.log(`  Saved login to ${path} (chmod 600)`);
}

function clearConfigSync(dir: string): void {
  const path = join(dir, "config.json");
  try {
    if (existsSync(path)) {
      rmSync(path, { force: true });
    }
    console.log("  Logged out. Removed " + path);
  } catch (e) {
    console.error(`  Could not remove ${path}: ${(e as Error).message}`);
  }
}

// The saved login without knowing the group upfront: scan the state root's
// group dirs (sorted, deterministic) and return the first valid login. With
// one login per machine this is unambiguous; with several, pass --url to
// pick a group explicitly.
function savedLoginSync(): CliConfig | null {
  try {
    if (!existsSync(LEXA_DIR)) return null;
    for (const entry of readdirSync(LEXA_DIR).sort()) {
      const cfg = loadConfigSync(join(LEXA_DIR, entry));
      if (cfg) return cfg;
    }
  } catch { /* unreadable root — no saved login */ }
  return null;
}

function loadDeployCredsSync(dir: string): DeployCreds | null {
  const path = join(dir, "config.json");
  try {
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, "utf-8")) as { deploy?: DeployCreds };
    return raw.deploy ?? null;
  } catch {
    return null;
  }
}

function saveDeployCredsSync(creds: DeployCreds, dir: string): void {
  migrateLegacyDirsSync();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "config.json");
  let existing: Record<string, unknown> = {};
  try {
    if (existsSync(path)) {
      existing = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    }
  } catch {
    existing = {};
  }
  existing.deploy = creds;
  writeFileSync(path, JSON.stringify(existing, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
}

function clearDeployCredsSync(dir: string): void {
  const path = join(dir, "config.json");
  try {
    if (!existsSync(path)) return;
    const existing = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    if (!("deploy" in existing)) return;
    delete existing.deploy;
    writeFileSync(path, JSON.stringify(existing, null, 2) + "\n", { mode: 0o600 });
    chmodSync(path, 0o600);
  } catch {
    // best-effort like the other config writes
  }
}

// Legacy pre-group ~/.config/lexa-cli|lexa-forge locations. Migrate-and-
// delete, no fallback: the group is derived from the legacy config.json url;
// if the group file already exists it wins and the old one is removed; empty
// legacy parents are deleted. No legacy config.json → skip silently.
const LEGACY_CLI_DIR = join(homedir(), ".config", "lexa-cli");
const LEGACY_FORGE_DIR = join(homedir(), ".config", "lexa-forge");

function migrateLegacyDirsSync(): void {
  const legacyConfig = join(LEGACY_CLI_DIR, "config.json");
  if (!existsSync(legacyConfig)) return;
  let url = "";
  try {
    const raw = JSON.parse(readFileSync(legacyConfig, "utf-8")) as { url?: string };
    url = raw.url ?? "";
  } catch {
    return; // corrupt legacy config — leave it alone
  }
  if (!url) return;
  const group = join(LEXA_DIR, normalizeHost(url));
  const pairs: Array<{ from: string; to: string }> = [
    { from: legacyConfig, to: join(group, "config.json") },
    { from: join(LEGACY_CLI_DIR, "machine-id"), to: join(group, "machine-id") },
    { from: join(LEGACY_FORGE_DIR, "env"), to: join(group, "env") },
    { from: join(LEGACY_FORGE_DIR, "runtimes"), to: join(group, "runtimes") },
  ];
  let touched = false;
  for (const { from, to } of pairs) {
    if (!existsSync(from)) continue;
    touched = true;
    if (existsSync(to)) {
      rmSync(from, { recursive: true, force: true });
    } else {
      mkdirSync(dirname(to), { recursive: true });
      renameSync(from, to);
    }
  }
  if (!touched) return;
  for (const dir of [LEGACY_CLI_DIR, LEGACY_FORGE_DIR]) {
    try {
      if (existsSync(dir) && readdirSync(dir).length === 0) rmSync(dir, { force: true });
    } catch { /* leave non-empty parents alone */ }
  }
  console.log(`  Migrated legacy ~/.config/lexa-* state into ${group}`);
}

// Flavor-root migration (one-shot, idempotent): legacy ~/.lexa-staging and
// ~/.lexa-dev (and old-layout ~/.lexa) each move into the group named by
// their config.json url. Runs at CLI startup, only when LEXA_DIR is unset
// (the env override is a test/operator root that must stay untouched). A
// group that already exists (new layout) is skipped; a root without a
// config.json url is skipped with a warning; ~/.lexa itself migrates only
// when it carries old-layout top-level state (a root of only <host>/ dirs is
// already new-layout). Best-effort per root — a failed move never blocks
// startup.
export function migrateFlavorRootsSync(): void {
  if (process.env.LEXA_DIR) return;
  const roots = [
    join(homedir(), ".lexa"),
    join(homedir(), ".lexa-staging"),
    join(homedir(), ".lexa-dev"),
  ];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    try {
      const configPath = join(root, "config.json");
      let url = "";
      try {
        if (existsSync(configPath)) {
          url = (JSON.parse(readFileSync(configPath, "utf-8")) as { url?: string }).url ?? "";
        }
      } catch { /* corrupt config.json — treated as no url */ }
      if (root === join(homedir(), ".lexa")) {
        const oldLayout = existsSync(configPath) || existsSync(join(root, "machine-id")) || existsSync(join(root, "runtimes"));
        if (!oldLayout) continue; // already new-layout — untouched
      }
      if (!url) {
        console.log(`  Migration: skipped ${root} (no config.json url — a fresh login will create its group)`);
        continue;
      }
      const group = join(LEXA_DIR, normalizeHost(url));
      if (existsSync(group)) continue; // idempotent — group already exists
      // Snapshot BEFORE creating the group: when the root is ~/.lexa itself
      // the group lands inside it, and the move loop must not pick it up.
      const entries = readdirSync(root);
      mkdirSync(group, { recursive: true, mode: 0o700 });
      for (const entry of entries) {
        renameSync(join(root, entry), join(group, entry));
      }
      // Old roots are removed only after a successful move; ~/.lexa itself
      // keeps its <host>/ group children, so it is never empty here.
      if (readdirSync(root).length === 0) rmSync(root, { recursive: true, force: true });
      console.log(`  Migration: moved ${root} → ${group}`);
    } catch (e) {
      console.error(`  Migration: failed for ${root}: ${(e as Error).message}`);
    }
  }
}

export class CliConfigService extends Effect.Service<CliConfigService>()("LexaCli/CliConfigService", {
  effect: Effect.gen(function* () {
    return {
      lexaDir: (): string => LEXA_DIR,
      migrateLegacyDirs: (): Effect.Effect<void, never> => Effect.sync(migrateLegacyDirsSync),
      migrateFlavorRoots: (): Effect.Effect<void, never> => Effect.sync(migrateFlavorRootsSync),
      savedLogin: (): Effect.Effect<CliConfig | null, never> => Effect.sync(savedLoginSync),
      loadConfig: (dir: string): Effect.Effect<CliConfig | null, never> => Effect.sync(() => loadConfigSync(dir)),
      saveConfig: (config: CliConfig, dir: string): Effect.Effect<void, never> => Effect.sync(() => saveConfigSync(config, dir)),
      clearConfig: (dir: string): Effect.Effect<void, never> => Effect.sync(() => clearConfigSync(dir)),
      loadDeployCreds: (dir: string): Effect.Effect<DeployCreds | null, never> => Effect.sync(() => loadDeployCredsSync(dir)),
      saveDeployCreds: (creds: DeployCreds, dir: string): Effect.Effect<void, never> => Effect.sync(() => saveDeployCredsSync(creds, dir)),
      clearDeployCreds: (dir: string): Effect.Effect<void, never> => Effect.sync(() => clearDeployCredsSync(dir)),
    };
  }),
}) {}
