#!/usr/bin/env bun
// Workers deploy installer — runs from inside the release workers tarball
// (bun scripts/workers-install.ts) with no repo checkout: provisions D1/R2/KV
// via the Cloudflare API, stages the prebuilt bundle, writes a per-deploy
// wrangler config, applies D1 migrations, deploys via bunx wrangler, and
// (custom domain only) binds the worker route. Prompts live in install.sh
// (the bash side owns /dev/tty); this helper takes everything via flags.
//
// Usage:
//   bun workers-install.ts --name <deploy> \
//     [--cf-token <tok>]              # else CF_API_TOKEN / CLOUDFLARE_API_TOKEN
//     [--account <id>]                # else CLOUDFLARE_ACCOUNT_ID / prior config
//     [--domain lexa.example.com]     # custom domain; absent = workers.dev
//     [--dir <unpack dir>]            # default: cwd
//
// The CF token is read from --cf-token when present, otherwise from the
// CF_API_TOKEN / CLOUDFLARE_API_TOKEN environment (the installer passes it via
// the environment so it never appears in argv).
//
// The Cloudflare account is resolved BEFORE any resource is created: an
// explicit --account / CLOUDFLARE_ACCOUNT_ID, else the previous deploy's
// wrangler config (read before staging wipes it), else the token's account
// list (one → use it; several → TTY pick, headless die). A refusal here must
// create nothing — the incident this guards against used accounts[0] blindly
// and provisioned resources on the wrong account.
//
// Superadmin provisioning is NOT done here — the web /setup wizard owns it
// (owner decision: free-choice email + password at first install). API
// keys are minted post-setup (login → Settings → API Keys).

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join, dirname, basename } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

function die(msg: string): never {
  console.error(`  ✗ ${msg}`);
  process.exit(1);
}

function flag(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : "";
}

// Deploy name keys worker/D1/R2/KV resource names + the deploy dir.
// "staging"/"prod" are deprecated compat aliases reproducing the pre-flavor
// resource sets (prod's worker is bare "lexa"); anything else maps uniformly.
export interface WorkerFlavor {
  workerName: string;
  d1Name: string;
  r2Name: string;
  kvTitle: string;
}
export function resolveNames(name: string): WorkerFlavor {
  if (name === "staging")
    return {
      workerName: "lexa-staging",
      d1Name: "lexa-staging",
      r2Name: "lexa-blobs-staging",
      kvTitle: "lexa-staging",
    };
  if (name === "prod")
    return {
      workerName: "lexa",
      d1Name: "lexa-prod",
      r2Name: "lexa-blobs-prod",
      kvTitle: "lexa-prod",
    };
  return {
    workerName: name,
    d1Name: name,
    r2Name: `${name}-blobs`,
    kvTitle: name,
  };
}

// D1 row shape — the list/create APIs name it `uuid`, not `id`.
export interface D1Row {
  uuid: string;
  name: string;
}

// Deterministic D1 selection. Cloudflare's `?name=` filter is not exact
// (`?name=lexa` returns `lexa-prod`), so never trust it: list every database
// and match here. Candidates are the exact deploy name or a `${name}-` prefix
// (the flavor aliases: deploy `lexa` → `lexa-prod`/`lexa-staging`).
//   exact       the deploy name exists — reuse it
//   sole        exactly one prefixed candidate — reuse it with a notice
//   ambiguous   several candidates — refuse (never guess, never drop-all)
//   none        no candidate — create the deploy name
export type D1Selection =
  | { kind: "exact"; db: D1Row }
  | { kind: "sole"; db: D1Row }
  | { kind: "ambiguous"; names: string[] }
  | { kind: "none" };

export function selectD1(deployName: string, listed: D1Row[]): D1Selection {
  const candidates = listed.filter(
    (db) => db.name === deployName || db.name.startsWith(`${deployName}-`),
  );
  const exact = candidates.find((db) => db.name === deployName);
  if (exact) return { kind: "exact", db: exact };
  if (candidates.length === 1) return { kind: "sole", db: candidates[0]! };
  if (candidates.length > 1)
    return { kind: "ambiguous", names: candidates.map((db) => db.name) };
  return { kind: "none" };
}

// The refusal text for an ambiguous D1 selection — names the candidates and
// the two ways out. Kept pure so the die path is unit-testable.
export function d1AmbiguousMessage(
  deployName: string,
  names: string[],
): string {
  return `multiple D1 databases match deploy '${deployName}': ${names.join(", ")} — remove the stale one, or pass --name <deploy> to start a distinct deployment under that name`;
}

// A Cloudflare account row. The `/accounts` API names the id `id`; `name` is
// informational (shown when the operator must pick).
export interface AccountRow {
  id: string;
  name?: string;
}

// Deterministic account selection. Precedence: explicit --account flag >
// CLOUDFLARE_ACCOUNT_ID env > the previous deploy config's account_id > the
// token's account list. Anything explicit is matched against the token's list:
//   resolved   an account was chosen (present on the token)
//   ambiguous  no explicit id and the token has several accounts — the caller
//              must pick (TTY) or refuse (headless); resources must not be
//              created in this state
//   none       no explicit id and the token lists no account
//   stale      an explicit/prior id is NOT on the token — refuse with guidance
// The account is never guessed: `accounts[0]` is exactly the bug this replaces.
export type AccountSelection =
  | { kind: "resolved"; id: string }
  | { kind: "ambiguous"; accounts: AccountRow[] }
  | { kind: "none" }
  | { kind: "stale"; id: string };

export function selectAccount(input: {
  flag?: string;
  env?: string;
  priorConfig?: string;
  accounts: AccountRow[];
}): AccountSelection {
  const explicit = input.flag || input.env || input.priorConfig || "";
  if (explicit) {
    const match = input.accounts.find((a) => a.id === explicit);
    if (match) return { kind: "resolved", id: match.id };
    return { kind: "stale", id: explicit };
  }
  if (input.accounts.length === 1)
    return { kind: "resolved", id: input.accounts[0]!.id };
  if (input.accounts.length > 1)
    return { kind: "ambiguous", accounts: input.accounts };
  return { kind: "none" };
}

function accountLabel(a: AccountRow): string {
  return a.name ? `${a.id} (${a.name})` : a.id;
}

// The refusal text when the token exposes several accounts and there is no
// terminal to pick from — names every account so the operator can pass one.
export function accountAmbiguousMessage(accounts: AccountRow[]): string {
  const rows = accounts.map(accountLabel).join(", ");
  return `this token can access ${accounts.length} Cloudflare accounts: ${rows} — pass --account <id> or set CLOUDFLARE_ACCOUNT_ID to choose one`;
}

// The refusal text when an explicit/prior account id is not on the token —
// names what the token does see and every way to correct it.
export function accountStaleMessage(
  id: string,
  accounts: AccountRow[],
): string {
  if (accounts.length === 0) {
    return `Cloudflare account ${id} is not on this token, and this token sees no accounts — run \`wrangler login\` to authenticate an account, or pass --account <id> for an account this token can access`;
  }
  const known = accounts.map(accountLabel).join(", ");
  return `Cloudflare account ${id} is not on this token (it sees: ${known}) — pass --account <id> for one of those, set CLOUDFLARE_ACCOUNT_ID, or run \`wrangler login\` for an account that has it`;
}

// Interactively pick an account (ambiguous selection). Reuses ttyPrompt so the
// read comes from /dev/tty, never stdin (curl|bash owns stdin). A blank or
// out-of-range answer refuses — never guess.
function chooseAccountInteractive(accounts: AccountRow[]): string {
  const lines = accounts
    .map((a, i) => `    ${i + 1}) ${accountLabel(a)}`)
    .join("\n");
  const answer = ttyPrompt(
    `Multiple Cloudflare accounts are available:\n${lines}\n  Choose an account [1-${accounts.length}]:`,
  );
  const idx = Number.parseInt(answer, 10) - 1;
  const picked = accounts[idx];
  if (!picked)
    die(
      "no Cloudflare account selected — pass --account <id> or set CLOUDFLARE_ACCOUNT_ID",
    );
  return picked.id;
}

// Turn a pure selection into an account id or a die. Resolution runs before
// any ensure*/create call, so a refusal creates nothing.
export function resolveAccountOrDie(
  selection: AccountSelection,
  accounts: AccountRow[],
): string {
  switch (selection.kind) {
    case "resolved":
      console.log(`  ✓ Cloudflare account ${selection.id}`);
      return selection.id;
    case "ambiguous":
      if (process.stdout.isTTY) return chooseAccountInteractive(accounts);
      die(accountAmbiguousMessage(accounts));
    case "stale":
      die(accountStaleMessage(selection.id, accounts));
    case "none":
      die("no Cloudflare accounts on this token");
  }
}

// Read the account_id a previous deploy recorded. Must run BEFORE staging
// wipes deploy-<name>/ — otherwise a re-run loses the account it deployed to
// and falls back to the token's list (which is how the wrong account got
// provisioned). Absent/unreadable config → "".
export function readPriorAccount(dir: string, flavorName: string): string {
  const path = join(dir, `deploy-${flavorName}`, `wrangler.${flavorName}.json`);
  if (!existsSync(path)) return "";
  try {
    const cfg = JSON.parse(readFileSync(path, "utf-8")) as {
      account_id?: unknown;
    };
    return typeof cfg.account_id === "string" ? cfg.account_id : "";
  } catch {
    return "";
  }
}

// Root repo wrangler config (JSONC comments stripped) — the per-deploy config
// mirrors `compatibility_date` and the observability block from it.
export interface RootWorkerConfig {
  compatibility_date?: string;
  observability?: Record<string, unknown>;
}
export function readRootWranglerConfig(dir: string): RootWorkerConfig {
  return JSON.parse(
    readFileSync(join(dir, "wrangler.jsonc"), "utf-8").replace(
      /\/\/[^\n]*/g,
      "",
    ),
  ) as RootWorkerConfig;
}

// Observability block written into the per-deploy config: root's block
// verbatim, or the bare legacy enable when root declares none.
export function resolveObservability(
  root: RootWorkerConfig,
): Record<string, unknown> {
  return root.observability ?? { enabled: true };
}

const API = "https://api.cloudflare.com/client/v4";

let CF_TOKEN = "";
let account = "";

async function cfFetch(
  path: string,
  init?: RequestInit,
): Promise<{
  ok: boolean;
  json: {
    result?: unknown;
    result_info?: { page?: number; total_pages?: number } | undefined;
    errors: Array<{ message?: string }>;
  } | null;
  errors: Array<{ message?: string }>;
}> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${CF_TOKEN}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const json = (await res.json().catch(() => null)) as {
    success?: boolean;
    result?: unknown;
    result_info?: { page?: number; total_pages?: number };
    errors?: Array<{ message?: string }>;
  } | null;
  const ok = res.ok && json?.success === true;
  return {
    ok,
    json: json
      ? {
          result: json.result,
          result_info: json.result_info,
          errors: json.errors ?? [],
        }
      : null,
    errors: json?.errors ?? [],
  };
}

function dieCf(
  label: string,
  r: { errors: Array<{ message?: string }> },
): never {
  const msg = r.errors.map((e) => e.message).join("; ") || "unknown CF error";
  const hint = /authentication|forbidden|invalid request headers/i.test(msg)
    ? " — check the API token's permissions (Account scope: Workers Scripts, D1, Workers KV Storage, Workers R2 Storage — all Edit)"
    : "";
  die(`${label}: ${msg}${hint}`);
}

async function cfJson<T>(
  label: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const r = await cfFetch(path, init);
  if (!r.ok) dieCf(label, r);
  return r.json?.result as T;
}

function wrangler(
  args: string[],
  opts: { input?: string; capture?: boolean } = {},
): { status: number; stdout: string; stderr: string } {
  // `bun x wrangler`, not `bunx`: recent bun no longer ships a bunx shim,
  // and a missing binary shows up as ENOENT — status null → 1 with empty
  // pipes, which read as a silent failure.
  const res = spawnSync("bun", ["x", "wrangler", ...args], {
    input: opts.input,
    stdio: opts.capture
      ? ["pipe", "pipe", "pipe"]
      : opts.input !== undefined
        ? ["pipe", "inherit", "inherit"]
        : "inherit",
    // The REST calls authenticate with the token directly; wrangler only
    // sees it through the environment. Without this it prompts for login
    // (instantly failing under capture) and every d1/deploy step dies.
    env: { ...process.env, CLOUDFLARE_API_TOKEN: CF_TOKEN },
    encoding: "utf-8",
  } as never) as unknown as {
    status: number | null;
    stdout?: unknown;
    stderr?: unknown;
    error?: Error;
  };
  return {
    status: res.status ?? 1,
    stdout: typeof res.stdout === "string" ? res.stdout : "",
    stderr:
      typeof res.stderr === "string"
        ? res.stderr
        : res.error
          ? String(res.error)
          : "",
  };
}

function dieWrangler(
  label: string,
  r: { stdout: string; stderr: string },
): never {
  const tail = (r.stderr || r.stdout)
    .split("\n")
    .filter(Boolean)
    .slice(-3)
    .join(" | ");
  die(`${label} failed (status 1)${tail ? `: ${tail.slice(-400)}` : ""}`);
}

// ── CF: D1 / R2 / KV (find-or-create) ──
// Interactive confirmations read /dev/tty, never stdin: under curl|bash the
// installer's stdin is the piped script (EOF), so prompt() would return
// instantly and auto-pick the default. Returns "" when no terminal is
// reachable — callers must treat that as the safe (non-destructive) answer.
function ttyPrompt(question: string): string {
  try {
    const tty = openSync("/dev/tty", "r+");
    writeSync(tty, `\n${question} `);
    const buf = Buffer.alloc(256);
    const n = readSync(tty, buf, 0, buf.length, null);
    closeSync(tty);
    return buf.subarray(0, n).toString().trim();
  } catch {
    return "";
  }
}

// D1 database list, following Cloudflare pagination. An explicit page size is
// requested; `result_info.total_pages` is followed up to a 50-page cap. When
// the envelope carries no `result_info`, behave as before (a single page).
async function listD1Databases(): Promise<D1Row[]> {
  const perPage = 100;
  const rows: D1Row[] = [];
  for (let page = 1; page <= 50; page++) {
    const r = await cfFetch(
      `/accounts/${account}/d1/database?page=${page}&per_page=${perPage}`,
    );
    if (!r.ok) dieCf("list D1 databases", r);
    rows.push(...((r.json?.result ?? []) as D1Row[]));
    const totalPages = r.json?.result_info?.total_pages;
    if (!totalPages || totalPages <= page) break;
  }
  return rows;
}

// Cloudflare account list, following pagination exactly like listD1Databases.
// An explicit page size is requested; `result_info.total_pages` is followed up
// to a 50-page cap. No `result_info` → behave as before (a single page). The
// account list feeds selectAccount, so a truncated list would hide an account
// and misclassify a valid explicit id as stale.
async function listAccounts(): Promise<AccountRow[]> {
  const perPage = 50;
  const rows: AccountRow[] = [];
  for (let page = 1; page <= 50; page++) {
    const r = await cfFetch(`/accounts?page=${page}&per_page=${perPage}`);
    if (!r.ok) dieCf("list CF accounts", r);
    rows.push(...((r.json?.result ?? []) as AccountRow[]));
    const totalPages = r.json?.result_info?.total_pages;
    if (!totalPages || totalPages <= page) break;
  }
  return rows;
}

async function ensureD1(
  flavor: WorkerFlavor,
  resetDb: boolean,
): Promise<string> {
  // List EVERY database — Cloudflare's `?name=` filter is fuzzy, so the
  // exact/prefix match happens client-side (mirrors ensureR2/ensureKv).
  const listed = await listD1Databases();
  const selection = selectD1(flavor.d1Name, listed);
  if (selection.kind === "ambiguous") {
    die(d1AmbiguousMessage(flavor.d1Name, selection.names));
  }
  if (selection.kind === "exact" || selection.kind === "sole") {
    const db = selection.db;
    let drop = resetDb;
    if (!drop && process.stdout.isTTY) {
      const answer = ttyPrompt(
        `The database '${db.name}' already exists. Delete it and start over? This erases all data and can't be undone. [y/N]`,
      );
      drop = /^y(es)?$/i.test(answer);
    }
    if (!drop) {
      if (selection.kind === "sole")
        console.log(
          `  (reusing D1 '${db.name}' for deploy '${flavor.d1Name}')`,
        );
      console.log(`  ✓ D1 '${db.name}' exists — reused`);
      return db.uuid;
    }
    // Reset drops ONLY the resolved database — never every listed one.
    await cfJson(
      `drop D1 ${db.name}`,
      `/accounts/${account}/d1/database/${db.uuid}`,
      { method: "DELETE" },
    );
    console.log(`  ✓ D1 '${db.name}' dropped`);
  }
  const created = await cfJson<{ uuid: string }>(
    `create D1 ${flavor.d1Name}`,
    `/accounts/${account}/d1/database`,
    {
      method: "POST",
      body: JSON.stringify({ name: flavor.d1Name }),
    },
  );
  console.log(`  ✓ D1 '${flavor.d1Name}' created`);
  return created.uuid;
}

async function ensureR2(flavor: WorkerFlavor): Promise<string> {
  // R2 list returns { result: { buckets: [...] } } — unlike D1/KV, whose
  // result is a bare array.
  const listed = await cfJson<{ buckets?: Array<{ name: string }> }>(
    `list R2 buckets`,
    `/accounts/${account}/r2/buckets`,
  );
  const names = listed.buckets ?? [];
  if (names.some((b) => b.name === flavor.r2Name)) {
    console.log(`  ✓ R2 '${flavor.r2Name}' exists — reused`);
    return flavor.r2Name;
  }
  await cfJson(
    `create R2 ${flavor.r2Name}`,
    `/accounts/${account}/r2/buckets`,
    {
      method: "POST",
      body: JSON.stringify({ name: flavor.r2Name }),
    },
  );
  console.log(`  ✓ R2 '${flavor.r2Name}' created`);
  return flavor.r2Name;
}

async function ensureKv(flavor: WorkerFlavor): Promise<string> {
  const listed = await cfJson<Array<{ id: string; title: string }>>(
    `list KV`,
    `/accounts/${account}/storage/kv/namespaces`,
  );
  const existing = listed.find((n) => n.title === flavor.kvTitle);
  if (existing) {
    console.log(`  ✓ KV '${flavor.kvTitle}' exists — reused`);
    return existing.id;
  }
  const created = await cfJson<{ id: string }>(
    `create KV ${flavor.kvTitle}`,
    `/accounts/${account}/storage/kv/namespaces`,
    {
      method: "POST",
      body: JSON.stringify({ title: flavor.kvTitle }),
    },
  );
  console.log(`  ✓ KV '${flavor.kvTitle}' created`);
  return created.id;
}

async function main(): Promise<void> {
  CF_TOKEN =
    flag("cf-token") ||
    process.env.CF_API_TOKEN ||
    process.env.CLOUDFLARE_API_TOKEN ||
    die("no Cloudflare credentials — set CF_API_TOKEN or pass --cf-token");
  // Boolean flag: drops the resolved D1 database matching the deploy name
  // before creating a fresh one (all data in it is gone).
  const RESET_DB = process.argv.includes("--reset-db");
  const NAME = flag("name") || "lexa";
  const FLAVOR = resolveNames(NAME);
  const FLAVOR_NAME = NAME;
  if (NAME === "staging" || NAME === "prod") {
    console.log(
      `  (deploy name '${NAME}' is a deprecated flavor alias — prefer an explicit --name)`,
    );
  }
  const CUSTOM_DOMAIN = flag("domain"); // absent → workers.dev
  const DIR = flag("dir") || process.cwd();

  const accounts = await listAccounts();
  // Resolve the account BEFORE any ensure*/create call, and read the prior
  // deploy config BEFORE staging wipes deploy-<name>/ — a refusal here must
  // create nothing.
  account = resolveAccountOrDie(
    selectAccount({
      flag: flag("account"),
      env: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
      priorConfig: readPriorAccount(DIR, FLAVOR_NAME),
      accounts,
    }),
    accounts,
  );

  let zone = "";
  if (CUSTOM_DOMAIN) {
    const zoneHost = CUSTOM_DOMAIN.split("/")[0]!
      .split(".")
      .slice(-2)
      .join(".");
    const zones = await cfJson<Array<{ id: string; name: string }>>(
      `lookup zone ${zoneHost}`,
      `/zones?name=${zoneHost}`,
    );
    zone =
      zones[0]?.id ??
      die(
        `no Cloudflare zone for '${zoneHost}' — add the site to this CF account first`,
      );
  }

  const d1Id = await ensureD1(FLAVOR, RESET_DB);
  const r2Name = await ensureR2(FLAVOR);
  const kvId = await ensureKv(FLAVOR);

  // ── Bundle: manifest emitted by the workers vite build ──
  const repoDist = join(DIR, "dist");
  const manifestPath = join(repoDist, "server", "wrangler.json");
  if (!existsSync(manifestPath)) {
    die(
      "workers build emitted no dist/server/wrangler.json — bad workers tarball",
    );
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
    main?: string;
    assets?: { directory?: string };
    rules?: unknown[];
    no_bundle?: boolean;
  };
  const mainAbs = join(repoDist, "server", manifest.main ?? "index.js");
  const assetsAbs = join(
    repoDist,
    "server",
    manifest.assets?.directory ?? "../client",
  );
  if (!existsSync(mainAbs)) die(`workers bundle entry missing: ${mainAbs}`);
  if (!existsSync(assetsAbs))
    die(`workers client assets missing: ${assetsAbs}`);

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
  const rootConfig = readRootWranglerConfig(DIR);
  const config = {
    name: FLAVOR.workerName,
    account_id: account,
    main: `./${(manifest.main ?? "index.js").split("/").pop()}`,
    compatibility_date: rootConfig.compatibility_date ?? "2026-08-01",
    compatibility_flags: ["nodejs_compat"],
    ...(manifest.no_bundle ? { no_bundle: true } : {}),
    ...(manifest.rules !== undefined ? { rules: manifest.rules } : {}),
    assets: { directory: "./assets" },
    vars: {
      LXK_ENV: "production",
      ...(publicUrl ? { LXK_PUBLIC_URL: publicUrl } : {}),
    },
    d1_databases: [
      { binding: "DB", database_name: FLAVOR.d1Name, database_id: d1Id },
    ],
    r2_buckets: [{ binding: "BLOB", bucket_name: r2Name }],
    kv_namespaces: [{ binding: "KV", id: kvId }],
    observability: resolveObservability(rootConfig),
  };
  const configPath = join(deployDir, `wrangler.${FLAVOR_NAME}.json`);
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", {
    mode: 0o600,
  });
  console.log(`  ✓ wrangler config → ${configPath}`);

  // ── D1 migrations (via the D1 query API, not wrangler's import endpoint) ──
  // Same semantics as runMigrationsD1: the whole file executes as one batch
  // with FKs enforced. The wrangler import endpoint reports constraint
  // failures without context; the query API returns them structured, and the
  // registry row rides in the same batch.
  async function d1Query(
    label: string,
    databaseId: string,
    sql: string,
  ): Promise<void> {
    await cfJson(
      label,
      `/accounts/${account}/d1/database/${databaseId}/query`,
      {
        method: "POST",
        body: JSON.stringify({ sql }),
      },
    );
  }

  await d1Query(
    "D1 journal init",
    d1Id,
    "CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT DEFAULT (datetime('now')))",
  );
  const journalRows = await cfJson<
    Array<{ results?: Array<{ name?: string }> }>
  >("D1 journal read", `/accounts/${account}/d1/database/${d1Id}/query`, {
    method: "POST",
    body: JSON.stringify({ sql: "SELECT name FROM _migrations" }),
  });
  const applied = new Set<string>();
  for (const block of journalRows)
    for (const row of block.results ?? []) if (row.name) applied.add(row.name);

  const migrationsDir = join(DIR, "migrations");
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  let count = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(migrationsDir, file), "utf-8");
    await d1Query(
      `D1 migration ${file}`,
      d1Id,
      `${sql}\nINSERT INTO _migrations (name) VALUES ('${file.replace(/'/g, "''")}');`,
    );
    console.log(`  ✓ Applied migration: ${file}`);
    count++;
  }
  if (count === 0) console.log("  ✓ D1 schema up to date");

  // ── Deploy ──
  const deployed = wrangler(["deploy", "--config", configPath]);
  if (deployed.status !== 0) dieWrangler("wrangler deploy", deployed);

  // ── Custom domain: bind the route (workers.dev needs no route) ──
  if (CUSTOM_DOMAIN && zone) {
    const pattern = `${CUSTOM_DOMAIN}/*`;
    const routes = await cfJson<Array<{ id: string; pattern?: string }>>(
      `list worker routes`,
      `/zones/${zone}/workers/routes`,
    );
    for (const route of routes.filter((r) => r.pattern === pattern)) {
      await cfFetch(`/zones/${zone}/workers/routes/${route.id}`, {
        method: "DELETE",
      });
    }
    await cfJson(`bind route ${pattern}`, `/zones/${zone}/workers/routes`, {
      method: "POST",
      body: JSON.stringify({ pattern, script: FLAVOR.workerName }),
    });
    console.log(`  ✓ route ${pattern} → ${FLAVOR.workerName}`);
  }

  // ── Done: API keys are minted post-setup (login → Settings → API Keys) ──
  // The installer banner needs a URL. A custom domain is known; otherwise ask
  // the account for its workers.dev subdomain (best-effort — no failure if the
  // endpoint is unavailable).
  let deployedUrl = CUSTOM_DOMAIN ? `https://${CUSTOM_DOMAIN}` : "";
  if (!deployedUrl) {
    try {
      const sub = await cfFetch(`/accounts/${account}/workers/subdomain`);
      const result = sub.json?.result as { subdomain?: string } | null;
      const subdomain = result?.subdomain ?? "";
      if (sub.ok && subdomain)
        deployedUrl = `https://${FLAVOR.workerName}.${subdomain}.workers.dev`;
    } catch {
      /* best-effort */
    }
  }
  if (deployedUrl) {
    writeFileSync(join(DIR, ".deployed-url"), `${deployedUrl}\n`, {
      mode: 0o600,
    });
  }
  console.log(`  ✓ deployed${deployedUrl ? ` → ${deployedUrl}` : ""}`);

  // ── Tarball cleanup: keep the 2 newest downloads, drop older ones ──
  // DIR is the tarball work dir in release runs (in --from-repo runs no
  // lexa-workers-*.tar.gz exists, so this is a no-op there).
  {
    const tars = readdirSync(DIR)
      .filter((f) => f.startsWith("lexa-workers-") && f.endsWith(".tar.gz"))
      .map((f) => ({ f, m: statSync(join(DIR, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    for (const { f } of tars.slice(2)) {
      rmSync(join(DIR, f));
      console.log(`  (cleanup: removed old tarball ${f})`);
    }
  }
}

// Guard: the module exports the pure selector for unit tests; runtime side
// effects (CF calls, file writes) only run as the entry script.
if (import.meta.main) {
  await main();
}
