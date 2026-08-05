// lexa-cli config — login credentials stored per-user under the machine
// state root:
//   ~/.lexa/config.json  { url, apiKey }
// Everything the host stores lives in ~/.lexa (LEXA_DIR override): config,
// machine-id, bootstrap env, per-runtime envs, and per-run workdirs.
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, rmSync, renameSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export interface CliConfig {
  url: string;
  apiKey: string;
}

// Deploy credentials (Cloudflare + Google OAuth) persisted alongside the
// login so `lexa-cli deploy` works without a saved url/apiKey.
export interface DeployCreds {
  cfToken?: string;
  googleClientId?: string;
  googleClientSecret?: string;
  cfTeamDomain?: string;
  emailDomain?: string;
}

export const LEXA_DIR = process.env.LEXA_DIR ?? join(homedir(), ".lexa");
const CONFIG_PATH = join(LEXA_DIR, "config.json");

// Legacy pre-~/.lexa locations. Migrate-and-delete, no fallback: on any
// entry point (login, machine listen) old files move into ~/.lexa; if the
// new path already exists it wins and the old one is removed; empty legacy
// parents are deleted. Old binaries run after a migration can't see the new
// state — upgrade all components together.
const LEGACY_PATHS: Array<{ from: string; to: string }> = [
  { from: join(homedir(), ".config", "lexa-cli", "config.json"), to: join(LEXA_DIR, "config.json") },
  { from: join(homedir(), ".config", "lexa-cli", "machine-id"), to: join(LEXA_DIR, "machine-id") },
  { from: join(homedir(), ".config", "lexa-forge", "env"), to: join(LEXA_DIR, "env") },
  { from: join(homedir(), ".config", "lexa-forge", "runtimes"), to: join(LEXA_DIR, "runtimes") },
];

export function migrateLegacyDirs(): void {
  let touched = false;
  for (const { from, to } of LEGACY_PATHS) {
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
  for (const dir of [join(homedir(), ".config", "lexa-cli"), join(homedir(), ".config", "lexa-forge")]) {
    try {
      if (existsSync(dir) && readdirSync(dir).length === 0) rmSync(dir, { force: true });
    } catch { /* leave non-empty parents alone */ }
  }
  console.log(`  Migrated legacy ~/.config/lexa-* state into ${LEXA_DIR}`);
}

export function loadConfig(): CliConfig | null {
  try {
    if (!existsSync(CONFIG_PATH)) return null;
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as Partial<CliConfig>;
    if (!raw.url || !raw.apiKey) return null;
    return { url: raw.url.replace(/\/+$/, ""), apiKey: raw.apiKey };
  } catch {
    return null;
  }
}

export function saveConfig(config: CliConfig): void {
  migrateLegacyDirs();
  mkdirSync(LEXA_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_PATH, JSON.stringify({ url: config.url.replace(/\/+$/, ""), apiKey: config.apiKey }, null, 2) + "\n", { mode: 0o600 });
  chmodSync(CONFIG_PATH, 0o600);
  console.log(`  Saved login to ${CONFIG_PATH} (chmod 600)`);
}

export function clearConfig(): void {
  try {
    if (existsSync(CONFIG_PATH)) {
      rmSync(CONFIG_PATH, { force: true });
    }
    console.log("  Logged out. Removed " + CONFIG_PATH);
  } catch (e) {
    console.error(`  Could not remove ${CONFIG_PATH}: ${(e as Error).message}`);
  }
}

export function loadDeployCreds(): DeployCreds | null {
  try {
    if (!existsSync(CONFIG_PATH)) return null;
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as { deploy?: DeployCreds };
    return raw.deploy ?? null;
  } catch {
    return null;
  }
}

export function saveDeployCreds(creds: DeployCreds): void {
  migrateLegacyDirs();
  mkdirSync(LEXA_DIR, { recursive: true, mode: 0o700 });
  let existing: Record<string, unknown> = {};
  try {
    if (existsSync(CONFIG_PATH)) {
      existing = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as Record<string, unknown>;
    }
  } catch {
    existing = {};
  }
  existing.deploy = creds;
  writeFileSync(CONFIG_PATH, JSON.stringify(existing, null, 2) + "\n", { mode: 0o600 });
  chmodSync(CONFIG_PATH, 0o600);
}
