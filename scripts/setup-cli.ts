#!/usr/bin/env bun
/**
 * Lexa CLI setup wizard (dev / bare-metal bootstrap).
 *
 *   bun run setup
 *
 * Prompts for the admin email (LXK_ADMIN_EMAILS), ensures an API key
 * (LXK_API_KEY / VITE_LXK_API_KEY) exists in .env, runs migrations, and
 * optionally seeds sample data. Also mirrors the admin email into the
 * settings table so Docker/staging/prod web setups stay consistent.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { Database } from "bun:sqlite";
import { runMigrations } from "../server/db/migrate";
import { getSetting, setSetting } from "../server/db/settings";

const ENV_PATH = resolve(process.cwd(), ".env");
const DB_PATH = process.env.DATABASE_PATH || "./data/lexa.db";

// ── tiny prompt helper (Bun's prompt() is line-based and interactive) ──
function ask(question: string, fallback = ""): string {
  const answer = prompt(`  ${question}${fallback ? ` [${fallback}]` : ""}: `)?.trim();
  return answer || fallback;
}

function loadEnv(): Record<string, string> {
  if (!existsSync(ENV_PATH)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(ENV_PATH, "utf-8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function writeEnv(env: Record<string, string>) {
  mkdirSync(dirname(ENV_PATH), { recursive: true });
  const lines = Object.entries(env).map(([k, v]) => `${k}=${v}`);
  writeFileSync(ENV_PATH, lines.join("\n") + "\n");
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

async function main() {
  console.log("══════════════════════════════════════════════");
  console.log("  Lexa Setup");
  console.log("══════════════════════════════════════════════");

  const env = loadEnv();

  // 1. Admin email
  console.log("\n── Admin email ──");
  console.log("  The first person to log in with this email (via Cloudflare");
  console.log("  Access / Google OAuth) becomes an admin. For staging/prod,");
  console.log("  it must be a tester in your Google OAuth consent screen and");
  console.log("  within the Access allowed-domain policy.");
  const currentAdmins = (env.LXK_ADMIN_EMAILS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const adminInput = ask("Admin email" + (currentAdmins.length ? " (comma-separated, add more)" : ""), currentAdmins.join(","));
  if (adminInput.trim()) {
    env.LXK_ADMIN_EMAILS = adminInput.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean).join(",");
  }

  // 2. API key
  console.log("\n── API key ──");
  let apiKey = env.LXK_API_KEY || "";
  if (apiKey) {
    console.log(`  Existing key found: ${apiKey.slice(0, 10)}… (kept)`);
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
    env.LXK_API_KEY = apiKey;
    env.VITE_LXK_API_KEY = apiKey;
  }

  // 3. Persist .env
  if (!env.DATABASE_PATH) env.DATABASE_PATH = "./data/lexa.db";
  if (!env.PORT) env.PORT = "3000";
  writeEnv(env);
  console.log("\n  Wrote .env");

  // 4. Migrations
  console.log("\n── Database ──");
  ensureDirForDb(DB_PATH);
  runMigrations(DB_PATH);

  // Mirror admin email into settings table (helps Docker/web-wizard parity)
  try {
    const db = new Database(DB_PATH);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    if (env.LXK_ADMIN_EMAILS) {
      const existing = getSetting(db, "admin_emails") || "";
      const merged = [...new Set([...existing.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean), ...env.LXK_ADMIN_EMAILS.split(",").map((s) => s.trim().toLowerCase())])];
      setSetting(db, "admin_emails", merged.join(","));
    }
    // Ensure the seeded admin API key exists (entry.ts does this too, but be explicit)
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

  // 5. Seed sample data
  console.log("\n── Sample data ──");
  const db = new Database(DB_PATH);
  const projectCount = db.query("SELECT COUNT(*) c FROM projects").get() as { c: number };
  if (projectCount.c > 0) {
    console.log("  Projects exist — skipping seed.");
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
  db.close();

  // 6. Summary
  console.log("\n══════════════════════════════════════════════");
  console.log("  Setup complete");
  console.log("══════════════════════════════════════════════");
  console.log(`  Admin emails: ${env.LXK_ADMIN_EMAILS || "(none — set later in /setup)"}`);
  console.log(`  API key:      ${env.LXK_API_KEY || "(none)"}`);
  console.log(`  Database:     ${DB_PATH}`);
  console.log("");
  console.log("  Run the dev stack:  bun run dev:full");
  console.log("  Frontend:           http://localhost:5173  (vite, live reload)");
  console.log("  API (optional):     http://localhost:3000  (serves the built app)");
  console.log("");
  console.log("  First login      (staging/prod): add the admin email as a tester in");
  console.log("                   Google Cloud → OAuth consent screen, and to the");
  console.log("                   CF Access allow policy.");
  console.log("");
  console.log("  MCP (optional):  point your agent at https://<host>/mcp with an lxk_ API key");
}

main().catch((e) => {
  console.error("Setup failed:", e);
  process.exit(1);
});
