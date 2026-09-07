#!/usr/bin/env bun
// Workers flavor installer — port of the former `lexa-cli deploy --runtime
// workers`. Runs from inside the release workers tarball (bun scripts/
// workers-install.ts) with no repo checkout: provisions D1/R2/KV via the
// Cloudflare API, stages the prebuilt bundle, writes a per-deploy wrangler
// config, applies D1 migrations, deploys via bunx wrangler, and (custom
// domain only) binds the worker route. Prompts live in install.sh (the bash
// side owns /dev/tty); this helper takes everything via flags.
//
// Usage:
//   bun workers-install.ts --cf-token <tok> --api-key <key> --flavor staging|prod \
//     [--domain lexa.example.com]     # custom domain; absent = workers.dev
//     [--dir <unpack dir>]            # default: cwd
//
// Superadmin provisioning is NOT done here — the web /setup wizard owns it
// (owner decision: free-choice email + password at first install).

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

interface WorkerFlavor {
  workerName: string;
  d1Name: string;
  r2Name: string;
  kvTitle: string;
}

const WORKER_FLAVORS: Record<string, WorkerFlavor> = {
  staging: { workerName: "lexa-staging", d1Name: "lexa-staging", r2Name: "lexa-blobs-staging", kvTitle: "lexa-staging" },
  prod: { workerName: "lexa", d1Name: "lexa-prod", r2Name: "lexa-blobs-prod", kvTitle: "lexa-prod" },
};

function die(msg: string): never {
  console.error(`  ✗ ${msg}`);
  process.exit(1);
}

function flag(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : "";
}

const CF_TOKEN = flag("cf-token") || die("--cf-token required");
const API_KEY = flag("api-key") || die("--api-key required");
const FLAVOR_NAME = flag("flavor") || "staging";
const FLAVOR = WORKER_FLAVORS[FLAVOR_NAME] ?? die(`unknown flavor '${FLAVOR_NAME}' (staging|prod)`);
const CUSTOM_DOMAIN = flag("domain"); // absent → workers.dev
const DIR = flag("dir") || process.cwd();
const API = "https://api.cloudflare.com/client/v4";

async function cfFetch(path: string, init?: RequestInit): Promise<{ ok: boolean; json: { result?: unknown; errors: Array<{ message?: string }> } | null; errors: Array<{ message?: string }> }> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${CF_TOKEN}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const json = (await res.json().catch(() => null)) as { success?: boolean; result?: unknown; errors?: Array<{ message?: string }> } | null;
  const ok = res.ok && json?.success === true;
  return { ok, json: json ? { result: json.result, errors: json.errors ?? [] } : null, errors: json?.errors ?? [] };
}

function dieCf(label: string, r: { errors: Array<{ message?: string }> }): never {
  const msg = r.errors.map((e) => e.message).join("; ") || "unknown CF error";
  die(`${label}: ${msg}`);
}

async function cfJson<T>(label: string, path: string, init?: RequestInit): Promise<T> {
  const r = await cfFetch(path, init);
  if (!r.ok) dieCf(label, r);
  return r.json?.result as T;
}

function wrangler(args: string[], opts: { input?: string; capture?: boolean } = {}): { status: number; stdout: string } {
  const res = spawnSync("bunx", ["wrangler", ...args], {
    input: opts.input,
    stdio: opts.capture ? ["pipe", "pipe", "inherit"] : opts.input !== undefined ? ["pipe", "inherit", "inherit"] : "inherit",
    encoding: "utf-8",
  } as never) as unknown as { status: number | null; stdout?: unknown };
  return { status: res.status ?? 1, stdout: typeof res.stdout === "string" ? res.stdout : "" };
}

// ── CF: account, zone (custom domain only) ──
const accounts = await cfJson<Array<{ id: string }>>("list CF accounts", "/accounts");
const account = accounts[0]?.id ?? die("no Cloudflare accounts on this token");

let zone = "";
if (CUSTOM_DOMAIN) {
  const zoneHost = CUSTOM_DOMAIN.split("/")[0]!.split(".").slice(-2).join(".");
  const zones = await cfJson<Array<{ id: string; name: string }>>(`lookup zone ${zoneHost}`, `/zones?name=${zoneHost}`);
  zone = zones[0]?.id ?? die(`no Cloudflare zone for '${zoneHost}' — add the site to this CF account first`);
}

// ── CF: D1 / R2 / KV (find-or-create) ──
async function ensureD1(): Promise<string> {
  const listed = await cfJson<Array<{ id: string; name: string }>>(`list D1 ${FLAVOR.d1Name}`, `/accounts/${account}/d1/database?name=${FLAVOR.d1Name}`);
  if (listed[0]?.id) {
    console.log(`  ✓ D1 '${FLAVOR.d1Name}' exists — reused`);
    return listed[0]!.id;
  }
  const created = await cfJson<{ uuid: string }>(`create D1 ${FLAVOR.d1Name}`, `/accounts/${account}/d1/database`, {
    method: "POST",
    body: JSON.stringify({ name: FLAVOR.d1Name }),
  });
  console.log(`  ✓ D1 '${FLAVOR.d1Name}' created`);
  return created.uuid;
}

async function ensureR2(): Promise<string> {
  const listed = await cfJson<Array<{ name: string }>>(`list R2 buckets`, `/accounts/${account}/r2/buckets`);
  if (listed.some((b) => b.name === FLAVOR.r2Name)) {
    console.log(`  ✓ R2 '${FLAVOR.r2Name}' exists — reused`);
    return FLAVOR.r2Name;
  }
  await cfJson(`create R2 ${FLAVOR.r2Name}`, `/accounts/${account}/r2/buckets`, {
    method: "POST",
    body: JSON.stringify({ name: FLAVOR.r2Name }),
  });
  console.log(`  ✓ R2 '${FLAVOR.r2Name}' created`);
  return FLAVOR.r2Name;
}

async function ensureKv(): Promise<string> {
  const listed = await cfJson<Array<{ id: string; title: string }>>(`list KV`, `/accounts/${account}/storage/kv/namespaces`);
  if (listed[0]?.id) {
    console.log(`  ✓ KV '${FLAVOR.kvTitle}' exists — reused`);
    return listed[0]!.id;
  }
  const created = await cfJson<{ id: string }>(`create KV ${FLAVOR.kvTitle}`, `/accounts/${account}/storage/kv/namespaces`, {
    method: "POST",
    body: JSON.stringify({ title: FLAVOR.kvTitle }),
  });
  console.log(`  ✓ KV '${FLAVOR.kvTitle}' created`);
  return created.id;
}

const d1Id = await ensureD1();
const r2Name = await ensureR2();
const kvId = await ensureKv();

// ── Bundle: manifest emitted by the workers vite build ──
const repoDist = join(DIR, "dist");
const manifestPath = join(repoDist, "server", "wrangler.json");
if (!existsSync(manifestPath)) {
  die("workers build emitted no dist/server/wrangler.json — bad workers tarball");
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
  main?: string;
  assets?: { directory?: string };
  rules?: unknown[];
  no_bundle?: boolean;
};
const mainAbs = join(repoDist, "server", manifest.main ?? "index.js");
const assetsAbs = join(repoDist, "server", manifest.assets?.directory ?? "../client");
if (!existsSync(mainAbs)) die(`workers bundle entry missing: ${mainAbs}`);
if (!existsSync(assetsAbs)) die(`workers client assets missing: ${assetsAbs}`);

// ── Stage into a deploy dir + write the per-deploy wrangler config ──
const deployDir = join(DIR, `deploy-${FLAVOR_NAME}`);
rmSync(deployDir, { force: true, recursive: true });
mkdirSync(deployDir, { recursive: true });

// Flat layout: workerd resolves chunk imports relative to the config dir.
// The build emitted all server chunks in one dir — copying its CONTENTS into
// the deploy root preserves the chunk filenames, so `./chunk-x.js` imports
// keep resolving. The browser assets dir lands at ./assets.
function copyContents(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from)) {
    const src = join(from, entry);
    const dst = join(to, entry);
    if (statSync(src).isDirectory()) copyContents(src, dst);
    else writeFileSync(dst, readFileSync(src));
  }
}
copyContents(dirname(mainAbs), deployDir);
copyContents(assetsAbs, join(deployDir, "assets"));

const publicUrl = CUSTOM_DOMAIN ? `https://${CUSTOM_DOMAIN}` : "";
const config = {
  name: FLAVOR.workerName,
  main: `./${(manifest.main ?? "index.js").split("/").pop()}`,
  compatibility_date: (JSON.parse(readFileSync(join(DIR, "wrangler.jsonc"), "utf-8").replace(/\/\/[^\n]*/g, "")) as { compatibility_date?: string }).compatibility_date ?? "2026-08-01",
  compatibility_flags: ["nodejs_compat"],
  ...(manifest.no_bundle ? { no_bundle: true } : {}),
  ...(manifest.rules !== undefined ? { rules: manifest.rules } : {}),
  assets: { directory: "./assets" },
  vars: { LXK_ENV: FLAVOR_NAME === "staging" ? "staging" : "production", ...(publicUrl ? { LXK_PUBLIC_URL: publicUrl } : {}) },
  d1_databases: [{ binding: "DB", database_name: FLAVOR.d1Name, database_id: d1Id }],
  r2_buckets: [{ binding: "BLOB", bucket_name: r2Name }],
  kv_namespaces: [{ binding: "KV", id: kvId }],
  observability: { enabled: true },
};
const configPath = join(deployDir, `wrangler.${FLAVOR_NAME}.json`);
writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
console.log(`  ✓ wrangler config → ${configPath}`);

// ── D1 migrations (journal semantics mirrored from the CLI deploy) ──
const journalInit = wrangler(["d1", "execute", FLAVOR.d1Name, "--remote", "--config", configPath, "--json", "--command",
  "CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT DEFAULT (datetime('now')))"], { capture: true });
if (journalInit.status !== 0) die(`D1 journal init failed (status ${journalInit.status})`);
const journalList = wrangler(["d1", "execute", FLAVOR.d1Name, "--remote", "--config", configPath, "--json", "--command",
  "SELECT name FROM _migrations"], { capture: true });
if (journalList.status !== 0) die(`D1 journal read failed (status ${journalList.status})`);
const applied = new Set<string>();
try {
  const parsed = JSON.parse(journalList.stdout || "[]") as Array<{ results?: Array<{ name?: string }> }>;
  for (const block of parsed) for (const row of block.results ?? []) if (row.name) applied.add(row.name);
} catch {
  die("could not parse D1 journal output");
}
const migrationsDir = join(DIR, "migrations");
const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
let count = 0;
for (const file of files) {
  if (applied.has(file)) continue;
  const sql = readFileSync(join(migrationsDir, file), "utf-8");
  const tmp = join(tmpdir(), `lexa-mig-${Date.now()}-${count}.sql`);
  writeFileSync(tmp, `${sql}\nINSERT INTO _migrations (name) VALUES ('${file.replace(/'/g, "''")}');\n`);
  try {
    const res = wrangler(["d1", "execute", FLAVOR.d1Name, "--remote", "--config", configPath, "--file", tmp]);
    if (res.status !== 0) die(`D1 migration ${file} failed (status ${res.status})`);
  } finally {
    rmSync(tmp, { force: true });
  }
  console.log(`  ✓ Applied migration: ${file}`);
  count++;
}
if (count === 0) console.log("  ✓ D1 schema up to date");

// ── Deploy ──
const deployed = wrangler(["deploy", "--config", configPath]);
if (deployed.status !== 0) die(`wrangler deploy failed (status ${deployed.status})`);

// ── Custom domain: bind the route (workers.dev needs no route) ──
if (CUSTOM_DOMAIN && zone) {
  const pattern = `${CUSTOM_DOMAIN}/*`;
  const routes = await cfJson<Array<{ id: string; pattern?: string }>>(`list worker routes`, `/zones/${zone}/workers/routes`);
  for (const route of routes.filter((r) => r.pattern === pattern)) {
    await cfFetch(`/zones/${zone}/workers/routes/${route.id}`, { method: "DELETE" });
  }
  await cfJson(`bind route ${pattern}`, `/zones/${zone}/workers/routes`, {
    method: "POST",
    body: JSON.stringify({ pattern, script: FLAVOR.workerName }),
  });
  console.log(`  ✓ route ${pattern} → ${FLAVOR.workerName}`);
}

// ── Secret: the machine Bearer key (superadmin provisioning lives in /setup) ──
const secret = wrangler(["secret", "put", "LXK_API_KEY", "--config", configPath], { input: `${API_KEY}\n` });
if (secret.status !== 0) die(`wrangler secret put LXK_API_KEY failed (status ${secret.status})`);
console.log("  ✓ secret set: LXK_API_KEY");

console.log(`  ✓ deployed${CUSTOM_DOMAIN ? ` → https://${CUSTOM_DOMAIN}` : ""}`);
