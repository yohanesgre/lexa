#!/usr/bin/env bun
/**
 * Lexa CLI setup wizard (dev bootstrap).
 *
 *   bun run setup                                      # interactive, dev (.env.toml)
 *   bun run setup --env-file .env.prod.toml --admin-email ops@x.com --yes
 *   bun run setup --migrate-env                        # convert a legacy .env non-interactively
 *   bun run setup --no-seed                            # empty workspace, no boot seed
 *   bun run setup --seed                               # force sample data non-interactively
 *
 * Prompts for the admin email (LXK_ADMIN_EMAILS) + the superadmin password,
 * runs migrations, creates the superadmin account (Better Auth
 * credential), and offers sample data. API keys are minted
 * post-setup (login → Settings → API Keys).
 *
 * LXK_ENV is written explicitly so the server knows its environment.
 * The target defaults to `.env.toml`; `--env-file` picks another path and the
 * extension decides the format (`.toml` → TOML, anything else → legacy dotenv).
 * When `.env.toml` is absent but a legacy `.env` sits next to it, setup offers
 * a one-time conversion (interactive confirm, or `--migrate-env`).
 * This script is the first thing you run on a fresh box
 * — no lx binary required.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, renameSync, rmSync } from "node:fs";
import { resolve, dirname, join, basename } from "node:path";
import { Database } from "bun:sqlite";
import { runMigrations } from "../server/db/migrate";
import { setSetting } from "../server/db/settings";
import { assertEnvWriteTarget, DEAD_KEYS, formatDotenv, readEnvFile, writeEnvFile } from "../server/env-file";

// ── tiny prompt helper (Bun's prompt() is line-based and interactive) ──
function ask(question: string, fallback = ""): string {
  const answer = prompt(`  ${question}${fallback ? ` [${fallback}]` : ""}: `)?.trim();
  return answer || fallback;
}

export function isTomlPath(path: string): boolean {
  return /\.toml(\.|$)/.test(basename(path));
}

function dropDeadKeys(values: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) if (!DEAD_KEYS.includes(k)) out[k] = v;
  return out;
}

// A fresh install must ship a secrets keyring key: generate one 32-byte key
// when the env file does not already carry one. Existing values (an operator's
// key, or a rotated pair) are preserved verbatim.
function ensureSecretsMasterKey(values: Record<string, string>): void {
  if (!values.LXK_SECRETS_MASTER_KEY) {
    values.LXK_SECRETS_MASTER_KEY = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
  }
}

// Merge `updates` over the existing file (dead keys dropped) and write 0600 in
// the format the extension implies. A temp file + rename guarantees the TOML
// merge cannot re-introduce a dropped key from the on-disk copy.
export function writeEnvByPath(path: string, updates: Record<string, string>): void {
  assertEnvWriteTarget(path);
  const existing = existsSync(path) ? readEnvFile(path) : {};
  const merged = dropDeadKeys({ ...existing, ...updates });
  const dir = dirname(path);
  if (dir && dir !== ".") mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  rmSync(tmp, { force: true });
  try {
    if (isTomlPath(path)) writeEnvFile(tmp, merged);
    else writeFileSync(tmp, formatDotenv(merged), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

// One-time flat `.env` → `.env.toml` conversion: dead keys dropped, verified
// against the written file, then the legacy file renamed `.env` → `.env.legacy`.
export function migrateLegacyEnv(dir: string): { target: string; legacy: string } {
  const legacy = join(dir, ".env");
  const target = join(dir, ".env.toml");
  const dest = join(dir, ".env.legacy");
  if (existsSync(target)) throw new Error(`${target} already exists`);
  if (existsSync(dest)) throw new Error(`${dest} already exists — move it aside before migrating`);
  const values = dropDeadKeys(readEnvFile(legacy));
  if (Object.keys(values).length === 0) throw new Error(`${legacy} has no live keys to migrate`);
  try {
    writeEnvFile(target, values);
    const written = readEnvFile(target);
    for (const [k, v] of Object.entries(values)) {
      if (written[k] !== v) throw new Error(`migration verification failed for ${k}`);
    }
  } catch (e) {
    rmSync(target, { force: true });
    throw e;
  }
  renameSync(legacy, dest);
  chmodSync(dest, 0o600);
  return { target, legacy: dest };
}

export interface EnvTarget {
  envFile: string;
  env: Record<string, string>;
  migrated: boolean;
}

// Resolve the target env file and its values. `.env.toml` is canonical; with
// no `--env-file` a legacy `.env` is offered for conversion, and on decline
// (or non-interactive without `--migrate-env`) it is used as-is for this run.
export function resolveEnvTarget(opts: {
  envFileArg: string | undefined;
  migrateEnvFlag: boolean;
  interactive: boolean;
  askFn?: (question: string, fallback?: string) => string;
  log?: (message: string) => void;
}): EnvTarget {
  const log = opts.log ?? ((m: string) => console.log(m));
  const askFn = opts.askFn ?? ask;
  let envFile = opts.envFileArg ?? ".env.toml";
  const legacyPath = join(dirname(envFile), ".env");
  let migrated = false;
  // Auto-migration targets `.env.toml` only. `--env-file other.toml` must not
  // silently convert the sibling `.env` into a `.env.toml` the caller never
  // asked for (and then read the wrong file).
  const canonicalTarget = basename(envFile) === ".env.toml";
  if (canonicalTarget && existsSync(legacyPath) && !existsSync(envFile)) {
    const confirmed =
      opts.migrateEnvFlag ||
      (opts.interactive && askFn("Migrate .env to .env.toml (renames .env to .env.legacy)?", "y").toLowerCase().startsWith("y"));
    if (confirmed) {
      const res = migrateLegacyEnv(dirname(envFile));
      log(`  Migrated ${legacyPath} → ${res.target}`);
      log(`  Legacy kept at ${res.legacy} (0600).`);
      log(`  Rollback: rm ${res.target} && mv ${res.legacy} ${legacyPath}`);
      migrated = true;
    } else {
      log(`  Found ${legacyPath} but no ${envFile} — keeping the legacy file for this run.`);
      log("  Re-run with --migrate-env to convert it to .env.toml.");
      envFile = legacyPath;
    }
  }
  if (!isTomlPath(envFile)) {
    log(`  Note: ${envFile} is a flat legacy env file — migrate to .env.toml when you can.`);
  }
  const env = existsSync(envFile) ? readEnvFile(envFile) : {};
  return { envFile, env, migrated };
}

function ensureDirForDb(path: string) {
  mkdirSync(dirname(resolve(path)), { recursive: true });
}

// ── flag parsing (no deps) ──
const args = process.argv.slice(2);
function flagValue(name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}
const hasFlag = (name: string) => args.includes(name);

const NON_INTERACTIVE = hasFlag("--yes") || !process.stdin.isTTY;

async function main() {
  console.log("══════════════════════════════════════════════");
  console.log("  Lexa Setup");
  console.log("══════════════════════════════════════════════");

  // Resolve the env file first, then the environment name. `.env.toml` is the
  // canonical target; `--env-file` overrides and the extension decides format.
  const { envFile, env } = resolveEnvTarget({
    envFileArg: flagValue("--env-file"),
    migrateEnvFlag: hasFlag("--migrate-env"),
    interactive: !NON_INTERACTIVE,
  });
  const flavor = env.LXK_ENV || "dev";
  // DB path: explicit flag/env wins, then the env file, then the default —
  // a custom DATABASE_PATH in the env file must drive migrations/settings too.
  const DB_PATH = process.env.DATABASE_PATH || env.DATABASE_PATH || "./data/lexa.db";

  console.log(`  Flavor: ${flavor}   Env file: ${envFile}`);
  if (NON_INTERACTIVE) console.log("  Non-interactive mode (--yes / no TTY).");

  // 1. Admin email
  console.log("\n── Admin email ──");
  console.log("  The superadmin account is created for this email (in-app");
  console.log("  email/password login, no external identity provider). Members join");
  console.log("  later via workspace invite links issued by a superadmin.");
  const currentAdmins = (env.LXK_ADMIN_EMAILS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const adminArg = flagValue("--admin-email");
  let adminInput = adminArg || "";
  if (!adminInput && NON_INTERACTIVE) {
    if (!currentAdmins.length) {
      console.error("  ERROR: --admin-email required in non-interactive mode");
      process.exit(1);
    }
    adminInput = currentAdmins.join(",");
  } else if (!adminInput) {
    adminInput = ask("Admin email" + (currentAdmins.length ? " (comma-separated, add more)" : ""), currentAdmins.join(","));
  }
  if (adminInput.trim()) {
    env.LXK_ADMIN_EMAILS = adminInput.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean).join(",");
  }

  // 2. Superadmin password (R3: no --admin-password flag — never in shell
  //    flags or env; interactive only). Non-interactive runs create the
  //    superadmin account without a password; the operator then sets one via
  //    the web /setup wizard (superadmin-issued set-password link).
  console.log("\n── Superadmin password ──");
  const adminEmailsList = (env.LXK_ADMIN_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const adminPassword = NON_INTERACTIVE ? "" : ask("Password for the superadmin account (min 8 chars)");
  if (!NON_INTERACTIVE && adminPassword.length < 8) {
    console.error("  ERROR: password must be at least 8 characters");
    process.exit(1);
  }
  if (NON_INTERACTIVE && adminEmailsList.length > 0) {
    console.log("  Non-interactive — superadmin account created without a password;");
    console.log("  set one via the web /setup wizard or a superadmin set-password link.");
  }

  // 3. Persist env file — LXK_ENV is always explicit so the seed gate works.
  // Drop legacy provisioned keys: the server no longer reads them (API keys
  // are minted post-setup).
  for (const k of DEAD_KEYS) delete env[k];
  if (!env.DATABASE_PATH) env.DATABASE_PATH = "./data/lexa.db";
  if (!env.PORT) env.PORT = "3000";
  env.LXK_ENV = flavor;
  ensureSecretsMasterKey(env);
  writeEnvByPath(envFile, env);
  console.log(`\n  Wrote ${envFile}`);

  // 4. Migrations
  console.log("\n── Database ──");
  ensureDirForDb(DB_PATH);
  runMigrations(DB_PATH);
  try { chmodSync(DB_PATH, 0o600); } catch {}
  // FTS5 optimize; table may be absent on a pre-0001 DB.
  try {
    const db = new Database(DB_PATH);
    db.exec("INSERT INTO wiki_fts(wiki_fts) VALUES('optimize')");
    db.close();
  } catch {}

  // 5. Superadmin account (interactive only — see step 2). Created via the
  //    same Better Auth provisioning path as the web wizard.
  if (adminEmailsList.length > 0) {
    process.env.DATABASE_PATH = DB_PATH;
    const { auth } = await import("../server/auth");
    const db = new Database(DB_PATH);
    try {
      for (const email of adminEmailsList) {
        const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email) as { id: string } | null;
        if (existing) {
          console.log(`  Superadmin ${email} already exists — skipped.`);
          continue;
        }
        await auth.api.createUser({
          body: {
            email,
            password: adminPassword,
            name: email.split("@")[0] || email,
            data: { role: "superadmin" },
          },
        });
        console.log(`  Superadmin created: ${email}${adminPassword ? "" : " (no password yet)"}`);
      }
    } finally {
      db.close();
    }
  }

  // 6. Seed sample data — offered in every environment. The choice is
  //    persisted as LXK_SEED_DEV so Workers boot-seeding respects an
  //    explicit N (otherwise the boot seed would resurrect sample data
  //    right after setup).
  console.log("\n── Sample data ──");
  const db = new Database(DB_PATH);
  const seedFile = resolve(process.cwd(), "scripts/seed-dev.sql");
  const runSeedFile = (): boolean => {
    if (!existsSync(seedFile)) {
      console.log("  Seed file missing — skipping.");
      return false;
    }
    try {
      db.exec(readFileSync(seedFile, "utf-8"));
      console.log("  Seeded sample data.");
      return true;
    } catch (e) {
      console.error(`  Seed failed: ${(e as Error).message}`);
      return false;
    }
  };
  let seededNow = false;
  let seedChoice: "yes" | "no" | null = null;
  const projectCount = db.query("SELECT COUNT(*) c FROM projects").get() as { c: number };
  if (projectCount.c > 0) {
    console.log("  Projects exist — skipping seed.");
  } else if (hasFlag("--seed") && hasFlag("--no-seed")) {
    console.error("  ERROR: --seed and --no-seed are mutually exclusive");
    process.exit(1);
  } else if (hasFlag("--seed")) {
    seededNow = runSeedFile();
    seedChoice = "yes";
  } else if (hasFlag("--no-seed")) {
    console.log("  Skipping sample data (--no-seed).");
    console.log("  Boot seeding disabled (LXK_SEED_DEV=0) — the dev flow will stay empty.");
    seedChoice = "no";
  } else if (NON_INTERACTIVE) {
    console.log("  Non-interactive — skipping sample data (run interactively to seed).");
  } else {
    const seed = ask("Include sample data (dev projects + wiki)?", "y");
    if (seed.trim().toLowerCase().startsWith("n")) {
      console.log("  Skipping sample data.");
      console.log("  Boot seeding disabled (LXK_SEED_DEV=0) — the dev flow will stay empty.");
      seedChoice = "no";
    } else {
      seededNow = runSeedFile();
      seedChoice = "yes";
    }
  }
  if (seedChoice !== null) {
    env.LXK_SEED_DEV = seedChoice === "yes" ? "1" : "0";
    ensureSecretsMasterKey(env);
    writeEnvByPath(envFile, env);
    console.log(`  Wrote ${envFile} (LXK_SEED_DEV=${env.LXK_SEED_DEV})`);
  }
  // 7. Lock setup — CLI-provisioned instances are complete; /api/setup/*
  //    mutating endpoints stay locked from now on.
  //    mutating endpoints stay locked from now on.
  setSetting(db, "setup_complete", "1");
  console.log("  Setup marked complete — /api/setup/* is now locked.");
  db.close();

  // 8. Summary
  console.log("\n══════════════════════════════════════════════");
  console.log("  Setup complete");
  console.log("══════════════════════════════════════════════");
  console.log(`  Flavor:         ${flavor}`);
  console.log(`  Env file:       ${envFile}`);
  console.log(`  Admin emails:   ${env.LXK_ADMIN_EMAILS || "(none — set later in /setup)"}`);
  console.log(`  Database:       ${DB_PATH}`);
  console.log("");
  if (flavor === "dev") {
  console.log("  Run the dev stack:  bun run dev");
  console.log("  App:                http://localhost:5173  (Workers flavor, live reload)");
  if (seededNow) {
  console.log("  NOTE: seeded member users have no password — log in as the");
  console.log("        superadmin and issue set-password links from the Members UI.");
  } else if (seedChoice === "no") {
  console.log("  Workspace is empty — create your first project from the UI.");
  console.log("  To seed later: LXK_SEED_DEV=1 bun run dev (empty DB only).");
  }
  } else {
    console.log("  Deploy via scripts/install.sh (see docs/DEPLOYMENT.md).");
    console.log("  Health:             curl https://<host>/api/health");
    console.log("  First login:        open https://<host>/setup once to create the");
    console.log("                      superadmin account, then onboard members via invite links.");
  }
  console.log("");
}

if (import.meta.main) {
  main().catch((e) => {
    console.error("Setup failed:", e);
    process.exit(1);
  });
}
