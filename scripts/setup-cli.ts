#!/usr/bin/env bun
/**
 * Lexa CLI setup wizard (dev bootstrap / prod bare-metal bootstrap).
 *
 *   bun run setup                                      # interactive, dev (.env)
 *   bun run setup --prod                               # interactive, prod (.env.prod)
 *   bun run setup --prod --admin-email ops@x.com --api-key lxk_... --yes
 *
 * Prompts for the admin email (LXK_ADMIN_EMAILS) + the superadmin password,
 * ensures an API key (LXK_API_KEY / VITE_LXK_API_KEY) exists in the flavor
 * env file, runs migrations, creates the superadmin account (Better Auth
 * credential), and (dev only) offers sample data.
 *
 * Staging/prod never seeds: LXK_ENV=<flavor> is written so the server,
 * the web wizard, and later `lexa-cli deploy` runs all know sample data
 * must stay empty. This script is the first thing you run on a fresh box
 * — no lexa-cli binary required.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { Database } from "bun:sqlite";
import { runMigrations } from "../server/db/migrate";
import { setSetting } from "../server/db/settings";

// ── tiny prompt helper (Bun's prompt() is line-based and interactive) ──
function ask(question: string, fallback = ""): string {
  const answer = prompt(`  ${question}${fallback ? ` [${fallback}]` : ""}: `)?.trim();
  return answer || fallback;
}

function loadEnv(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf-8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function writeEnv(file: string, env: Record<string, string>) {
  mkdirSync(dirname(file), { recursive: true });
  const lines = Object.entries(env).map(([k, v]) => `${k}=${v}`);
  writeFileSync(file, lines.join("\n") + "\n");
  try { chmodSync(file, 0o600); } catch {}
}

function generateRawKey(): string {
  const raw = randomBytes(32);
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  let value = 0n;
  for (const b of raw) value = (value << 8n) | BigInt(b);
  let result = "";
  const base = 62n;
  while (value > 0n) { result = chars[Number(value % base)] + result; value /= base; }
  while (result.length < 43) result = chars[0] + result;
  return `lxk_${result}`;
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

const FLAG_FLAVOR = hasFlag("--prod") ? "prod" : hasFlag("--staging") ? "staging" : flagValue("--flavor");
const NON_INTERACTIVE = hasFlag("--yes") || !process.stdin.isTTY;

async function main() {
  console.log("══════════════════════════════════════════════");
  console.log("  Lexa Setup");
  console.log("══════════════════════════════════════════════");

  // Resolve flavor first so we know which env file to read.
  const envFileArg = flagValue("--env-file");
  const envFile = envFileArg || (FLAG_FLAVOR && FLAG_FLAVOR !== "dev" ? `.env.${FLAG_FLAVOR}` : ".env");
  const env = loadEnv(envFile);
  const flavor = FLAG_FLAVOR || env.LXK_ENV || "dev";
  // DB path: explicit flag/env wins, then the env file, then the default —
  // a custom DATABASE_PATH in the env file must drive migrations/settings too.
  const DB_PATH = process.env.DATABASE_PATH || env.DATABASE_PATH || "./data/lexa.db";

  console.log(`  Flavor: ${flavor}   Env file: ${envFile}`);
  if (NON_INTERACTIVE) console.log("  Non-interactive mode (--yes / no TTY).");

  // 1. Admin email
  console.log("\n── Admin email ──");
  console.log("  The first person to log in with this email (via Cloudflare");
  console.log("  Access / Google OAuth) becomes an admin. For staging/prod,");
  console.log("  it must be a tester in your Google OAuth consent screen and");
  console.log("  within the Access allowed-domain policy.");
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

  // 3. API key
  console.log("\n── API key ──");
  let apiKey = flagValue("--api-key") || env.LXK_API_KEY || "";
  if (apiKey) {
    console.log(`  Existing key found: ${apiKey.slice(0, 10)}… (kept)`);
  } else if (NON_INTERACTIVE) {
    apiKey = generateRawKey();
    console.log(`  Generated: ${apiKey}`);
  } else {
    const gen = ask("Generate new API key?", "y");
    if (gen.toLowerCase() === "n") {
      apiKey = ask("Paste API key (lxk_...)");
      while (!/^lxk_[0-9A-Za-z]{43}$/.test(apiKey)) {
        apiKey = ask("  Invalid key. Must be lxk_ + 43 chars");
      }
    } else {
      apiKey = generateRawKey();
      console.log(`  Generated: ${apiKey}`);
    }
  }
  if (apiKey) {
    env.LXK_API_KEY = apiKey;
    env.VITE_LXK_API_KEY = apiKey;
  }

  // 3. Persist env file — LXK_ENV is always explicit so the seed gate works.
  if (!env.DATABASE_PATH) env.DATABASE_PATH = "./data/lexa.db";
  if (!env.PORT) env.PORT = "3000";
  env.LXK_ENV = flavor;
  writeEnv(envFile, env);
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

  // 6. Ensure the seeded admin API key exists (entry.ts does this too, but be explicit)
  try {
    const db = new Database(DB_PATH);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA busy_timeout = 5000");
    const keyHash = createHash("sha256").update(env.LXK_API_KEY).digest("hex");
    const row = db.prepare("SELECT id FROM api_keys WHERE key_hash = ?").get(keyHash) as { id: string } | null;
    if (!row && env.LXK_API_KEY) {
      db.prepare("INSERT INTO api_keys (id, name, key_hash) VALUES (?, ?, ?)").run(crypto.randomUUID(), "admin", keyHash);
      console.log("  Seeded admin API key into database");
    }
    db.close();
  } catch (e) {
    console.warn(`  (settings sync skipped: ${(e as Error).message})`);
  }

  // 7. Seed sample data — dev only; staging/prod always stays empty.
  console.log("\n── Sample data ──");
  const db = new Database(DB_PATH);
  const projectCount = db.query("SELECT COUNT(*) c FROM projects").get() as { c: number };
  if (projectCount.c > 0) {
    console.log("  Projects exist — skipping seed.");
  } else if (flavor !== "dev") {
    console.log(`  ${flavor} flavor — skipping sample data (production stays empty).`);
  } else if (NON_INTERACTIVE) {
    console.log("  Dev flavor, non-interactive — skipping sample data (run interactively to seed).");
  } else {
    const seed = ask("Include sample data (dev projects + wiki)?", "y");
    if (seed.toLowerCase() !== "n") {
      const seedFile = resolve(process.cwd(), "scripts/seed-dev.sql");
      if (existsSync(seedFile)) {
        try {
          db.exec(readFileSync(seedFile, "utf-8"));
          console.log("  Seeded sample data.");
        } catch (e) {
          console.error(`  Seed failed: ${(e as Error).message}`);
        }
      }
    }
  }
  // 8. Lock setup — CLI-provisioned instances are complete; /api/setup/*
  //    mutating endpoints stay locked from now on.
  //    mutating endpoints stay locked from now on.
  setSetting(db, "setup_complete", "1");
  console.log("  Setup marked complete — /api/setup/* is now locked.");
  db.close();

  // 9. Summary
  console.log("\n══════════════════════════════════════════════");
  console.log("  Setup complete");
  console.log("══════════════════════════════════════════════");
  console.log(`  Flavor:         ${flavor}`);
  console.log(`  Env file:       ${envFile}`);
  console.log(`  Admin emails:   ${env.LXK_ADMIN_EMAILS || "(none — set later in /setup)"}`);
  console.log(`  API key:        ${env.LXK_API_KEY || "(none)"}`);
  console.log(`  Database:       ${DB_PATH}`);
  console.log("");
  if (flavor === "dev") {
    console.log("  Run the dev stack:  bun run dev:full");
    console.log("  Frontend:           http://localhost:5173  (vite, live reload)");
    console.log("  API (optional):     http://localhost:3000  (serves the built app)");
  } else {
    console.log("  Deploy:             lexa-cli deploy <domain> " + flavor);
    console.log("  (or docker compose --env-file " + envFile + " up -d --build)");
    console.log("  Health:             curl https://<host>/api/health");
    console.log("  First login:        add the admin email as a tester in Google Cloud →");
    console.log("                      OAuth consent screen, and to the CF Access allow policy.");
  }
  console.log("");
  console.log("  MCP (optional):  point your agent at https://<host>/mcp with an lxk_ API key");
}

main().catch((e) => {
  console.error("Setup failed:", e);
  process.exit(1);
});
