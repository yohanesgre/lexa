// lexa-cli deploy workers — Cloudflare Workers + D1 + R2 + KV + cron stack
// provisioning. Parallel to `deploy.ts` (the Bun+Docker path). Deploy
// credentials persist in ~/.lexa/<domain>/config.json (the group dir of the
// deployed domain) under the `deploy` key, so deploy works without a saved
// login (url/apiKey).
//
// Usage:
//   lexa-cli deploy <domain> [staging|prod] --runtime workers [flags]
//   lexa-cli undeploy <domain> [staging|prod] --runtime workers [--purge-data] [--yes]
//
// Provisioning order:
//   1. POST /accounts/{id}/d1/database                    → D1 database (lexa-<flavor>)
//   2. POST /accounts/{id}/r2/buckets                     → R2 bucket  (lexa-blobs-<flavor>)
//   3. POST /accounts/{id}/storage/kv/namespaces          → KV namespace
//   3b. wrangler d1 execute (per-file migration + registry row, one batch)
//                                                        → D1 schema (= runMigrationsD1 semantics;
//                                                           B5 owns the real D1 migration path —
//                                                           consume it, do not invent a second one)
//   4. LEXA_FLAVOR=workers bun run build                 → prebuilt vite bundle in dist/
//      stage dist/ into deploy-workers/<flavor>/; wrangler deploy
//        (generated config points main+assets at the staged bundle,
//        no_bundle)                                      → Worker serving real SSR
//      (Source bundling aliases the Start server entry to a shim, so a
//      source deploy yields an API-only worker with a fallback page. The
//      bundle is staged — not referenced in place — because workerd
//      resolves the entry's chunk imports relative to the config dir.)
//   5. POST /zones/{id}/workers/routes                    → Worker route at <subdomain>.<domain>/*
//   6. wrangler secret put LXK_API_KEY (and the rest)     → piped via stdin (non-interactive safe)
//
// Teardown (lexa-cli undeploy <domain> [staging|prod] --runtime workers):
//   1. DELETE Worker route
//   2. wrangler delete
//   3. --purge-data only: DELETE D1, R2 bucket, KV namespace
//
// CF plumbing (envelope, token flow, prompts) mirrors cli/src/deploy.ts —
// the helpers are local copies because deploy.ts is owned by another lane.
// GITHUB_PRIVATE_KEY_FILE is refused here: it is impossible on Workers (no
// filesystem) — set inline GITHUB_PRIVATE_KEY.

import { Effect, Data } from "effect";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { CliConfigService, groupDir } from "./config";

const CF_API = "https://api.cloudflare.com/client/v4";

interface WorkerFlavor {
  subdomain: string;
  workerName: string;
  d1Name: string;
  r2Name: string;
  kvTitle: string;
}

export const WORKER_FLAVORS: Record<string, WorkerFlavor> = {
  staging: { subdomain: "lexa-preview", workerName: "lexa-staging", d1Name: "lexa-staging", r2Name: "lexa-blobs-staging", kvTitle: "lexa-staging" },
  prod: { subdomain: "lexa", workerName: "lexa", d1Name: "lexa-prod", r2Name: "lexa-blobs-prod", kvTitle: "lexa-prod" },
};

function usage(): never {
  console.error("Usage: lexa-cli deploy <domain> [staging|prod] --runtime workers [flags]");
  console.error("  staging — lexa-preview.<domain> (D1 lexa-staging, R2 lexa-blobs-staging)");
  console.error("  prod    — lexa.<domain> (D1 lexa-prod, R2 lexa-blobs-prod)");
  console.error("");
  console.error("Flags (all optional — prompts fill what's missing on a TTY):");
  console.error("  --cf-token <token>        Cloudflare API token (env: CF_API_TOKEN)");
  console.error("  --deploy-dir <path>       wrangler working dir (default: ~/.lexa/<domain>/deploy-workers)");
  console.error("  --admin-email <email>     admin email (also LXK_ADMIN_EMAILS secret)");
  console.error("  --api-key <key>           lxk_ API key (generated when missing)");
  console.error("  --yes                     skip the confirmation prompt (non-TTY only)");
  console.error("");
  console.error("Usage: lexa-cli undeploy <domain> [staging|prod] --runtime workers [flags]");
  console.error("Flags:");
  console.error("  --cf-token <token>        Cloudflare API token (env: CF_API_TOKEN)");
  console.error("  --deploy-dir <path>       wrangler working dir (default: ~/.lexa/<domain>/deploy-workers)");
  console.error("  --purge-data              also delete D1, the R2 bucket, and the KV namespace (irreversible)");
  console.error("  --yes                     confirm teardown without a prompt (non-TTY only)");
  process.exit(1);
}

export class DeployWorkersError extends Data.TaggedError("DeployWorkersError")<{
  reason: string;
}> {
  override get message(): string {
    return this.reason;
  }
}

export class CfWorkersApiError extends Data.TaggedError("CfWorkersApiError")<{
  status: number;
  cfMessage?: string | undefined;
  code?: number | undefined;
}> {
  override get message(): string {
    return `Cloudflare API error: ${this.cfMessage ?? this.status}${this.code !== undefined ? ` (${this.code})` : ""}`;
  }
}

interface CfEnvelope {
  success: boolean;
  errors: Array<{ code?: number; message?: string }>;
  result: unknown;
}

function cfFetch(token: string, path: string, init?: RequestInit): Effect.Effect<unknown, CfWorkersApiError, never> {
  return Effect.tryPromise({
    try: async () => {
      const res = await fetch(`${CF_API}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...(init?.headers ?? {}),
        },
      });
      if (!res.ok) {
        throw new CfWorkersApiError({ status: res.status, cfMessage: `HTTP ${res.status}`, code: undefined });
      }
      const body = (await res.json()) as CfEnvelope;
      if (!body.success) {
        const e = body.errors?.[0];
        throw new CfWorkersApiError({ status: res.status, cfMessage: e?.message, code: e?.code });
      }
      return body.result;
    },
    catch: (e) => (e instanceof CfWorkersApiError ? e : new CfWorkersApiError({ status: 0, cfMessage: (e as Error).message ?? String(e) })),
  });
}

// Same base62 algorithm as server/entry.ts generateRawKey.
function generateApiKey(): string {
  const raw = randomBytes(32);
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  let value = 0n;
  for (const b of raw) value = (value << 8n) | BigInt(b);
  let result = "";
  const base = 62n;
  while (value > 0n) {
    result = chars[Number(value % base)] + result;
    value /= base;
  }
  while (result.length < 43) result = chars[0] + result;
  return `lxk_${result}`;
}

// Plain line reading in cooked mode; mirrors the promptLogin used by login.
function prompt(question: string, fallback = ""): Promise<string> {
  return new Promise((resolve) => {
    const done = (line: string) => {
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      process.off("SIGINT", onSigint);
      resolve(line.trim() || fallback);
    };
    let buffer = "";
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const nl = buffer.indexOf("\n");
      if (nl < 0) return;
      let line = buffer.slice(0, nl).replace(/\r$/, "");
      while (true) {
        const bs = line.search(/[\x7f\b]/);
        if (bs < 0) break;
        line = line.slice(0, Math.max(0, bs - 1)) + line.slice(bs + 1);
      }
      buffer = "";
      done(line);
    };
    const onEnd = () => done(fallback);
    const onSigint = () => {
      process.stdout.write("\n");
      process.exit(130);
    };
    process.stdout.write(question);
    process.stdin.on("data", onData);
    process.stdin.on("end", onEnd);
    process.once("SIGINT", onSigint);
  });
}

function flagStr(flags: Record<string, string | boolean>, name: string): string {
  const v = flags[name];
  return typeof v === "string" ? v : "";
}

function banner(flavorName: string, fullDomain: string): void {
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  Lexa Setup (Workers) — ${flavorName}`);
  if (fullDomain) console.log(`  ${fullDomain}`);
  console.log("═══════════════════════════════════════════════════════");
}

function finalBanner(workerName: string, fullDomain: string): void {
  console.log("");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  Lexa Workers ${workerName}`);
  if (fullDomain) console.log(`  https://${fullDomain}`);
  console.log("═══════════════════════════════════════════════════════");
}

function requireWrangler(): Effect.Effect<void, DeployWorkersError, never> {
  return Effect.gen(function* () {
    const probed = spawnSync("wrangler", ["--version"], { stdio: "ignore" });
    if (probed.status !== 0) {
      return yield* new DeployWorkersError({ reason: "  ERROR: wrangler not found — install it (npm i -g wrangler) then re-run" });
    }
  });
}

function cfTokenFlow(
  config: CliConfigService,
  flags: Record<string, string | boolean>,
  domain: string,
  isTTY: boolean
): Effect.Effect<string, DeployWorkersError, never> {
  return Effect.gen(function* () {
    const saved = yield* config.loadDeployCreds(groupDir(domain));
    let cfToken = flagStr(flags, "cf-token") || process.env.CF_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN || "";
    if (!cfToken && saved?.cfToken) cfToken = saved.cfToken;
    if (!cfToken) {
      if (!isTTY) {
        return yield* new DeployWorkersError({ reason: "  ERROR: CF API token required — set CF_API_TOKEN/CLOUDFLARE_API_TOKEN or run on a terminal" });
      }
      console.log("── Cloudflare API Token ──");
      console.log("  Permissions: Account → D1 (Write), R2 (Write), Workers KV (Write), Workers Scripts (Write), Zone → Workers Routes (Write), DNS (Write)");
      cfToken = yield* Effect.promise(() => prompt("  Paste token: "));
      if (!cfToken) {
        return yield* new DeployWorkersError({ reason: "  ERROR: CF API token required" });
      }
    }
    return cfToken;
  });
}

function accountAndZone(cfToken: string, domain: string): Effect.Effect<{ account: string; zone: string }, DeployWorkersError, never> {
  return Effect.gen(function* () {
    console.log("==> Account & Zone...");
    const accounts = (yield* cfFetch(cfToken, "/accounts").pipe(
      Effect.mapError((e) => new DeployWorkersError({ reason: `  ERROR: ${e.message}` }))
    )) as Array<{ id: string }>;
    if (accounts.length === 0) {
      return yield* new DeployWorkersError({ reason: "  ERROR: no Cloudflare accounts on this token — check the token permissions" });
    }
    const account = accounts[0]!.id;
    const zones = (yield* cfFetch(cfToken, `/zones?name=${domain}`).pipe(
      Effect.mapError((e) => new DeployWorkersError({ reason: `  ERROR: ${e.message}` }))
    )) as Array<{ id: string }>;
    if (zones.length === 0) {
      return yield* new DeployWorkersError({ reason: `  ERROR: no Cloudflare zone for "${domain}" — does the domain point at this CF account?` });
    }
    const zone = zones[0]!.id;
    console.log(`  Account: ${account}  Zone: ${zone}`);
    return { account, zone };
  });
}

function ensureD1(cfToken: string, account: string, name: string): Effect.Effect<string, DeployWorkersError, never> {
  return Effect.gen(function* () {
    console.log("==> D1 database...");
    const listed = (yield* cfFetch(cfToken, `/accounts/${account}/d1/database?name=${name}`).pipe(
      Effect.mapError((e) => new DeployWorkersError({ reason: `  ERROR: ${e.message}` }))
    )) as Array<{ uuid?: string; id?: string }>;
    const existing = listed[0];
    const existingId = existing?.uuid ?? existing?.id;
    if (existingId) {
      console.log(`  Using existing D1: ${name} (${existingId})`);
      return existingId;
    }
    const created = (yield* cfFetch(cfToken, `/accounts/${account}/d1/database`, {
      method: "POST",
      body: JSON.stringify({ name }),
    }).pipe(
      Effect.mapError((e) => new DeployWorkersError({ reason: `  ERROR: ${e.message}` }))
    )) as { uuid?: string; id?: string };
    const id = created.uuid ?? created.id;
    if (!id) return yield* new DeployWorkersError({ reason: "  ERROR: D1 create returned no database id" });
    console.log(`  Created D1: ${name} (${id})`);
    return id;
  });
}

function ensureR2(cfToken: string, account: string, name: string): Effect.Effect<void, DeployWorkersError, never> {
  return Effect.gen(function* () {
    console.log("==> R2 bucket...");
    const listed = (yield* cfFetch(cfToken, `/accounts/${account}/r2/buckets`).pipe(
      Effect.mapError((e) => new DeployWorkersError({ reason: `  ERROR: ${e.message}` }))
    )) as { buckets?: Array<{ name?: string }> } | Array<{ name?: string }>;
    const buckets = Array.isArray(listed) ? listed : (listed.buckets ?? []);
    if (buckets.some((b) => b.name === name)) {
      console.log(`  Using existing R2 bucket: ${name}`);
      return;
    }
    yield* cfFetch(cfToken, `/accounts/${account}/r2/buckets`, {
      method: "POST",
      body: JSON.stringify({ name }),
    }).pipe(Effect.mapError((e) => new DeployWorkersError({ reason: `  ERROR: ${e.message}` })));
    console.log(`  Created R2 bucket: ${name}`);
  });
}

function ensureKv(cfToken: string, account: string, title: string): Effect.Effect<string, DeployWorkersError, never> {
  return Effect.gen(function* () {
    console.log("==> KV namespace...");
    const listed = (yield* cfFetch(cfToken, `/accounts/${account}/storage/kv/namespaces`).pipe(
      Effect.mapError((e) => new DeployWorkersError({ reason: `  ERROR: ${e.message}` }))
    )) as Array<{ id: string; title?: string }>;
    const existing = listed.find((ns) => ns.title === title);
    if (existing) {
      console.log(`  Using existing KV namespace: ${title} (${existing.id})`);
      return existing.id;
    }
    const created = (yield* cfFetch(cfToken, `/accounts/${account}/storage/kv/namespaces`, {
      method: "POST",
      body: JSON.stringify({ title }),
    }).pipe(
      Effect.mapError((e) => new DeployWorkersError({ reason: `  ERROR: ${e.message}` }))
    )) as { id: string };
    if (!created.id) return yield* new DeployWorkersError({ reason: "  ERROR: KV create returned no namespace id" });
    console.log(`  Created KV namespace: ${title} (${created.id})`);
    return created.id;
  });
}

// Deploy runs from a repo checkout: the worker bundle is the prebuilt vite
// output (`LEXA_FLAVOR=workers bun run build` → dist/) and the D1 migrations
// come from migrations/.
function findRepoRoot(): Effect.Effect<string, DeployWorkersError, never> {
  return Effect.gen(function* () {
    let dir = process.cwd();
    for (;;) {
      if (existsSync(join(dir, "server", "workers-entry.ts")) && existsSync(join(dir, "migrations"))) return dir;
      const parent = dirname(dir);
      if (parent === dir) {
        return yield* new DeployWorkersError({
          reason: "  ERROR: not a Lexa repo checkout (server/workers-entry.ts + migrations/ not found) — run from the repo root",
        });
      }
      dir = parent;
    }
  });
}

function readBaseWrangler(repoRoot: string): { compatibility_date: string; compatibility_flags: string[]; crons: string[] } {
  const fallback = { compatibility_date: "2026-08-01", compatibility_flags: ["nodejs_compat"], crons: ["*/15 * * * *"] };
  try {
    const raw = readFileSync(join(repoRoot, "wrangler.jsonc"), "utf-8")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    const parsed = JSON.parse(raw) as {
      compatibility_date?: string;
      compatibility_flags?: string[];
      triggers?: { crons?: string[] };
    };
    return {
      compatibility_date: parsed.compatibility_date ?? fallback.compatibility_date,
      compatibility_flags: parsed.compatibility_flags ?? fallback.compatibility_flags,
      crons: parsed.triggers?.crons ?? fallback.crons,
    };
  } catch {
    return fallback;
  }
}

// The worker deployed to prod is the prebuilt vite bundle, never the TS
// source: source bundling aliases the Start server entry to a shim, so a
// source deploy yields an API-only worker serving the fallback page.
// Rebuild dist/ from this checkout on every deploy so the bundle always
// matches the deployed source.
function buildWorkersDist(repoRoot: string): Effect.Effect<void, DeployWorkersError, never> {
  return Effect.gen(function* () {
    console.log("==> Workers bundle (vite build)...");
    const res = spawnSync("bun", ["run", "build"], {
      cwd: repoRoot,
      env: { ...process.env, LEXA_FLAVOR: "workers" },
      stdio: "inherit",
    } as never) as unknown as { status: number | null; error?: unknown };
    if (res.error !== undefined && res.error !== null) {
      const detail = res.error instanceof Error ? res.error.message : String(res.error);
      return yield* new DeployWorkersError({
        reason: `  ERROR: could not run "bun run build" (${detail}) — bun is required to build the Workers bundle`,
      });
    }
    if ((res.status ?? 1) !== 0) {
      return yield* new DeployWorkersError({
        reason: `  ERROR: workers vite build failed (status ${res.status}) — fix "LEXA_FLAVOR=workers bun run build" locally, then re-run`,
      });
    }
  });
}

// Entry + static-asset paths come from the build's own manifest
// (dist/server/wrangler.json, emitted by @cloudflare/vite-plugin), resolved
// to absolute paths into the checkout's dist/. Upload instructions (rules,
// no_bundle) ride along verbatim so the deploy stays in lockstep with
// whatever the plugin emits.
function readDistManifest(repoRoot: string): Effect.Effect<{
  main: string;
  assetsDir: string;
  rules: unknown[] | undefined;
  noBundle: boolean;
}, DeployWorkersError, never> {
  return Effect.gen(function* () {
    let manifest: { main?: string; assets?: { directory?: string }; rules?: unknown[]; no_bundle?: boolean };
    try {
      manifest = JSON.parse(readFileSync(join(repoRoot, "dist", "server", "wrangler.json"), "utf-8")) as {
        main?: string;
        assets?: { directory?: string };
        rules?: unknown[];
        no_bundle?: boolean;
      };
    } catch {
      return yield* new DeployWorkersError({
        reason: "  ERROR: workers build emitted no dist/server/wrangler.json — was the vite build run with LEXA_FLAVOR=workers?",
      });
    }
    const main = join(repoRoot, "dist", "server", manifest.main ?? "index.js");
    const assetsDir = join(repoRoot, "dist", "server", manifest.assets?.directory ?? "../client");
    if (!existsSync(main)) {
      return yield* new DeployWorkersError({
        reason: `  ERROR: workers bundle entry missing: ${main} — rebuild with "LEXA_FLAVOR=workers bun run build"`,
      });
    }
    if (!existsSync(assetsDir)) {
      return yield* new DeployWorkersError({
        reason: `  ERROR: workers client assets missing: ${assetsDir} — rebuild with "LEXA_FLAVOR=workers bun run build"`,
      });
    }
    return { main, assetsDir, rules: manifest.rules, noBundle: manifest.no_bundle ?? false };
  });
}

// Copy the prebuilt bundle into a per-flavor dir (deployDir/<flavor>/):
// index.js + assets/ (server entry + its chunks) and client/ (browser
// assets). The layout is flat because workerd resolves the entry's chunk
// imports relative to the config dir, not the entry's own dir — the
// generated wrangler.<flavor>.jsonc sits alongside with main ./index.js.
// Stale output from previous deploys is wiped first so hashed chunk names
// never accumulate. Exported for smoke tooling; the deploy command is the
// only caller in the CLI.
export const stageDistBundle = Effect.fn("LexaCli/stageDistBundle")(function* (
  repoRoot: string,
  deployDir: string,
  flavorName: string,
) {
  const { main, assetsDir, rules, noBundle } = yield* readDistManifest(repoRoot);
  const flavorDir = join(deployDir, flavorName);
  rmSync(flavorDir, { recursive: true, force: true });
  mkdirSync(flavorDir, { recursive: true });
  const skipBuildMeta = (src: string) => {
    const base = basename(src);
    if (base[0] === ".") return false;
    // The plugin's own manifest stays in dist/ — the generated per-flavor
    // config alongside the staged bundle replaces it.
    if (base === "wrangler.json" || base === "wrangler.jsonc") return false;
    return true;
  };
  cpSync(join(repoRoot, "dist", "server"), flavorDir, { recursive: true, filter: skipBuildMeta });
  cpSync(assetsDir, join(flavorDir, "client"), { recursive: true, filter: skipBuildMeta });
  console.log(`  Staged bundle: ${flavorDir}`);
  return { main: basename(main), assetsDir: "client", rules, noBundle };
});

export function writeWorkersConfig(opts: {
  deployDir: string;
  flavorName: string;
  repoRoot: string;
  flavor: WorkerFlavor;
  d1Id: string;
  kvId: string;
  publicUrl: string;
  dist: { main: string; assetsDir: string; rules: unknown[] | undefined; noBundle: boolean };
}): string {
  const { deployDir, flavorName, repoRoot, flavor, d1Id, kvId, publicUrl, dist } = opts;
  mkdirSync(deployDir, { recursive: true });
  const base = readBaseWrangler(repoRoot);
  const configPath = join(deployDir, flavorName, `wrangler.${flavorName}.jsonc`);
  // main + assets are relative to the per-flavor dir (the staged bundle
  // sits next to this config, so the entry's chunk imports resolve).
  // Upload instructions (no_bundle, rules) pass through from the build's
  // own manifest. No alias: the bundle resolved everything at build time
  // (real Start SSR handler, not the source-dev shims).
  const config = {
    name: flavor.workerName,
    main: dist.main,
    compatibility_date: base.compatibility_date,
    compatibility_flags: base.compatibility_flags,
    ...(dist.noBundle ? { no_bundle: true } : {}),
    ...(dist.rules !== undefined ? { rules: dist.rules } : {}),
    assets: { directory: dist.assetsDir },
    vars: { LXK_ENV: flavorName === "staging" ? "staging" : "production", LXK_PUBLIC_URL: publicUrl },
    d1_databases: [{ binding: "DB", database_name: flavor.d1Name, database_id: d1Id }],
    r2_buckets: [{ binding: "BLOB", bucket_name: flavor.r2Name }],
    kv_namespaces: [{ binding: "KV", id: kvId }],
    triggers: { crons: base.crons },
    observability: { enabled: true },
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  console.log(`  Wrote ${configPath}`);
  console.log(`  Bundle: ${dist.main}`);
  return configPath;
}

function wrangler(args: string[], opts: { input?: string; capture?: boolean } = {}): Effect.Effect<{ status: number; stdout: string }, never, never> {
  return Effect.sync(() => {
    const res = spawnSync("wrangler", args, {
      input: opts.input,
      // --json reads (D1 journal) need piped stdout; everything else
      // streams to the terminal. Secrets arrive via piped stdin.
      stdio: opts.capture ? ["pipe", "pipe", "inherit"] : opts.input !== undefined ? ["pipe", "inherit", "inherit"] : "inherit",
      encoding: "utf-8",
    } as never) as unknown as { status: number | null; stdout?: unknown };
    return { status: res.status ?? 1, stdout: typeof res.stdout === "string" ? res.stdout : "" };
  });
}

// D1 schema bootstrap through the wrangler CLI (the runtime has no fs, so
// runMigrationsD1 cannot run in-worker). Mirrors its semantics: the
// _migrations journal decides; each missing file applies atomically — the
// migration SQL plus its registry INSERT are concatenated into one temp
// file so one `d1 execute --file` is a single batch.
function applyD1Migrations(repoRoot: string, dbName: string, configPath: string): Effect.Effect<void, DeployWorkersError, never> {
  return Effect.gen(function* () {
    console.log("==> D1 migrations...");
    const journal = yield* wrangler(["d1", "execute", dbName, "--remote", "--config", configPath, "--json", "--command",
      "CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT DEFAULT (datetime('now')))",
    ], { capture: true });
    if (journal.status !== 0) {
      return yield* new DeployWorkersError({ reason: `  ERROR: D1 journal init failed (status ${journal.status})` });
    }
    const listed = yield* wrangler(["d1", "execute", dbName, "--remote", "--config", configPath, "--json", "--command",
      "SELECT name FROM _migrations",
    ], { capture: true });
    if (listed.status !== 0) {
      return yield* new DeployWorkersError({ reason: `  ERROR: D1 journal read failed (status ${listed.status})` });
    }
    const applied = new Set<string>();
    try {
      const parsed = JSON.parse(listed.stdout || "[]") as Array<{ results?: Array<{ name?: string }> }>;
      for (const block of parsed) for (const row of block.results ?? []) if (row.name) applied.add(row.name);
    } catch {
      return yield* new DeployWorkersError({ reason: "  ERROR: could not parse D1 journal output" });
    }
    const dir = join(repoRoot, "migrations");
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    let count = 0;
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = readFileSync(join(dir, file), "utf-8");
      const tmp = join(tmpdir(), `lexa-mig-${Date.now()}-${count}.sql`);
      writeFileSync(tmp, `${sql}\nINSERT INTO _migrations (name) VALUES ('${file.replace(/'/g, "''")}');\n`);
      try {
        const appliedRes = yield* wrangler(["d1", "execute", dbName, "--remote", "--config", configPath, "--file", tmp]);
        if (appliedRes.status !== 0) {
          return yield* new DeployWorkersError({ reason: `  ERROR: D1 migration ${file} failed (status ${appliedRes.status})` });
        }
      } finally {
        rmSync(tmp, { force: true });
      }
      console.log(`  Applied migration: ${file}`);
      count++;
    }
    if (count === 0) console.log("  D1 schema up to date");
  });
}

function ensureRoute(cfToken: string, zone: string, pattern: string, script: string): Effect.Effect<void, DeployWorkersError, never> {
  return Effect.gen(function* () {
    console.log("==> Worker route...");
    const listed = (yield* cfFetch(cfToken, `/zones/${zone}/workers/routes`).pipe(
      Effect.mapError((e) => new DeployWorkersError({ reason: `  ERROR: ${e.message}` }))
    )) as Array<{ id: string; pattern?: string }>;
    for (const route of listed.filter((r) => r.pattern === pattern)) {
      yield* cfFetch(cfToken, `/zones/${zone}/workers/routes/${route.id}`, { method: "DELETE" }).pipe(
        Effect.mapError((e) => new DeployWorkersError({ reason: `  ERROR: ${e.message}` }))
      );
    }
    yield* cfFetch(cfToken, `/zones/${zone}/workers/routes`, {
      method: "POST",
      body: JSON.stringify({ pattern, script }),
    }).pipe(Effect.mapError((e) => new DeployWorkersError({ reason: `  ERROR: ${e.message}` })));
    console.log(`  ${pattern} → ${script}`);
  });
}

const SECRET_ENVS = ["LXK_ADMIN_EMAILS", "GITHUB_APP_ID", "GITHUB_PRIVATE_KEY", "GITHUB_WEBHOOK_SECRET", "LXK_HEARTH_DAEMON_TOKEN", "LOG_LEVEL"] as const;

function putSecret(configPath: string, name: string, value: string): Effect.Effect<void, DeployWorkersError, never> {
  return Effect.gen(function* () {
    const res = yield* wrangler(["secret", "put", name, "--config", configPath], { input: value + "\n" });
    if (res.status !== 0) {
      return yield* new DeployWorkersError({ reason: `  ERROR: wrangler secret put ${name} failed (status ${res.status})` });
    }
    console.log(`  Secret set: ${name}`);
  });
}

export const cmdDeployWorkers = Effect.fn("LexaCli/cmdDeployWorkers")(function* (
  flags: Record<string, string | boolean>,
  positionals: string[],
) {
  const config = yield* CliConfigService;
  const domain = positionals[0] ?? "";
  const flavorName = positionals[1] ?? "";
  if (!domain) usage();
  const flavor = WORKER_FLAVORS[flavorName];
  if (!flavor) usage();
  const isTTY = process.stdin.isTTY === true;
  const fullDomain = `${flavor.subdomain}.${domain}`;
  const publicUrl = `https://${fullDomain}`;

  if (process.env.GITHUB_PRIVATE_KEY_FILE) {
    console.warn("  WARNING: GITHUB_PRIVATE_KEY_FILE is set but impossible on Workers (no filesystem) —");
    console.warn("           set inline GITHUB_PRIVATE_KEY instead; the file value will be ignored.");
  }

  yield* requireWrangler();
  const cfToken = yield* cfTokenFlow(config, flags, domain, isTTY);
  const { account, zone } = yield* accountAndZone(cfToken, domain);

  const d1Id = yield* ensureD1(cfToken, account, flavor.d1Name);
  yield* ensureR2(cfToken, account, flavor.r2Name);
  const kvId = yield* ensureKv(cfToken, account, flavor.kvTitle);

  banner(flavorName, fullDomain);

  // ── Admin user + API key ──
  console.log("");
  console.log("── Admin user ──");
  console.log("  The web /setup wizard creates the superadmin account from this");
  console.log("  email on first boot (email + password login, no OAuth).");
  let adminEmail = flagStr(flags, "admin-email") || process.env.LXK_ADMIN_EMAILS || "";
  if (!adminEmail && !isTTY) {
    return yield* new DeployWorkersError({ reason: "  ERROR: admin email required — pass --admin-email or run on a terminal" });
  }
  if (!adminEmail) {
    adminEmail = yield* Effect.promise(() => prompt("  Admin email: "));
  }
  if (!adminEmail) {
    return yield* new DeployWorkersError({ reason: "  ERROR: admin email required" });
  }

  console.log("");
  console.log("── API Key ──");
  let apiKey = flagStr(flags, "api-key") || process.env.LXK_API_KEY || "";
  if (apiKey) {
    console.log("  Reusing provided key");
  } else {
    if (!isTTY) {
      return yield* new DeployWorkersError({ reason: "  ERROR: API key required — pass --api-key or run on a terminal" });
    }
    apiKey = yield* Effect.promise(() => prompt("  API key (lxk_...) [Enter to generate]: "));
    if (!apiKey) {
      apiKey = generateApiKey();
      console.log(`  Generated: ${apiKey}`);
    }
  }

  const repoRoot = yield* findRepoRoot();
  yield* buildWorkersDist(repoRoot);
  const deployDir = flagStr(flags, "deploy-dir") || join(groupDir(domain), "deploy-workers");
  const dist = yield* stageDistBundle(repoRoot, deployDir, flavorName);
  const configPath = writeWorkersConfig({ deployDir, flavorName, repoRoot, flavor, d1Id, kvId, publicUrl, dist });

  yield* applyD1Migrations(repoRoot, flavor.d1Name, configPath);

  console.log("==> Wrangler deploy...");
  const deployed = yield* wrangler(["deploy", "--config", configPath]);
  if (deployed.status !== 0) {
    return yield* new DeployWorkersError({ reason: `  ERROR: wrangler deploy failed (status ${deployed.status})` });
  }

  yield* ensureRoute(cfToken, zone, `${fullDomain}/*`, flavor.workerName);

  console.log("==> Secrets...");
  yield* putSecret(configPath, "LXK_API_KEY", apiKey);
  const secretValues: Record<string, string> = {
    LXK_ADMIN_EMAILS: adminEmail,
    GITHUB_APP_ID: process.env.GITHUB_APP_ID ?? "",
    GITHUB_PRIVATE_KEY: process.env.GITHUB_PRIVATE_KEY ?? "",
    GITHUB_WEBHOOK_SECRET: process.env.GITHUB_WEBHOOK_SECRET ?? "",
    LXK_HEARTH_DAEMON_TOKEN: process.env.LXK_HEARTH_DAEMON_TOKEN ?? "",
    LOG_LEVEL: process.env.LOG_LEVEL ?? "",
  };
  for (const name of SECRET_ENVS) {
    const value = secretValues[name] ?? "";
    if (value) yield* putSecret(configPath, name, value);
  }

  yield* config.saveDeployCreds({ cfToken: cfToken || undefined }, groupDir(domain)).pipe(
    Effect.catchAll(() => Effect.void)
  );

  finalBanner(flavor.workerName, fullDomain);
});

export const cmdUndeployWorkers = Effect.fn("LexaCli/cmdUndeployWorkers")(function* (
  flags: Record<string, string | boolean>,
  positionals: string[],
) {
  const config = yield* CliConfigService;
  const domain = positionals[0] ?? "";
  const flavorName = positionals[1] ?? "";
  if (!domain) usage();
  const flavor = WORKER_FLAVORS[flavorName];
  if (!flavor) usage();
  const isTTY = process.stdin.isTTY === true;
  const fullDomain = `${flavor.subdomain}.${domain}`;
  const pattern = `${fullDomain}/*`;
  const purgeData = flags["purge-data"] === true;

  console.log(`==> Workers undeploy: <${fullDomain}>`);
  if (isTTY) {
    console.log("");
    console.log("  Removes: the Worker route + the Worker." + (purgeData ? " --purge-data also deletes D1, R2, KV (irreversible)." : " Data (D1/R2/KV) is preserved — pass --purge-data to delete it."));
    const answer = yield* Effect.promise(() => prompt("  Type 'undeploy' to confirm: "));
    if (answer !== "undeploy") {
      console.log("  Aborted (confirmation did not match).");
      process.exit(1);
    }
  } else if (flags.yes !== true) {
    return yield* new DeployWorkersError({ reason: "  ERROR: destructive teardown requires --yes on a non-TTY (or run on a terminal to confirm)" });
  }

  yield* requireWrangler();
  const cfToken = yield* cfTokenFlow(config, flags, domain, isTTY);
  const { account, zone } = yield* accountAndZone(cfToken, domain);

  console.log("==> Worker route...");
  const routes = (yield* cfFetch(cfToken, `/zones/${zone}/workers/routes`).pipe(
    Effect.catchAll((e) => Effect.sync(() => {
      console.warn(`  Route lookup failed: ${e.message.slice(0, 200)} — remove manually if needed.`);
      return [] as Array<{ id: string; pattern?: string }>;
    }))
  )) as Array<{ id: string; pattern?: string }>;
  const matching = routes.filter((r) => r.pattern === pattern);
  for (const route of matching) {
    yield* cfFetch(cfToken, `/zones/${zone}/workers/routes/${route.id}`, { method: "DELETE" }).pipe(
      Effect.catchAll((e) => Effect.sync(() => {
        console.warn(`  Delete route ${route.id} failed: ${e.message.slice(0, 200)} — remove manually if needed.`);
      }))
    );
    console.log(`  Deleted route ${pattern}`);
  }
  if (matching.length === 0) console.log(`  No route ${pattern} — nothing to delete.`);

  console.log("==> Worker...");
  const deployDir = flagStr(flags, "deploy-dir") || join(groupDir(domain), "deploy-workers");
  const configPath = join(deployDir, flavorName, `wrangler.${flavorName}.jsonc`);
  if (existsSync(configPath)) {
    const deleted = yield* wrangler(["delete", "--config", configPath]);
    if (deleted.status !== 0) {
      console.warn(`  wrangler delete failed (status ${deleted.status}) — remove the Worker manually if needed.`);
    } else {
      console.log(`  Deleted worker ${flavor.workerName}`);
    }
  } else {
    console.warn(`  No ${configPath} — never deployed from here, skipping wrangler delete (remove ${flavor.workerName} manually if needed).`);
  }

  if (purgeData) {
    console.log("==> Purge data (--purge-data)...");
    const dbs = (yield* cfFetch(cfToken, `/accounts/${account}/d1/database?name=${flavor.d1Name}`).pipe(
      Effect.catchAll(() => Effect.succeed([] as Array<{ uuid?: string }>))
    )) as Array<{ uuid?: string }>;
    for (const db of dbs) {
      if (!db.uuid) continue;
      yield* cfFetch(cfToken, `/accounts/${account}/d1/database/${db.uuid}`, { method: "DELETE" }).pipe(
        Effect.catchAll((e) => Effect.sync(() => {
          console.warn(`  Delete D1 failed: ${e.message.slice(0, 200)} — remove manually if needed.`);
        }))
      );
      console.log(`  Deleted D1 ${flavor.d1Name}`);
    }
    yield* cfFetch(cfToken, `/accounts/${account}/r2/buckets/${flavor.r2Name}`, { method: "DELETE" }).pipe(
      Effect.matchEffect({
        onSuccess: () => Effect.sync(() => console.log(`  Deleted R2 bucket ${flavor.r2Name}`)),
        onFailure: (e) => Effect.sync(() => {
          console.warn(`  Delete R2 bucket failed: ${e.message.slice(0, 200)} — remove manually if needed.`);
        }),
      })
    );
    const namespaces = (yield* cfFetch(cfToken, `/accounts/${account}/storage/kv/namespaces`).pipe(
      Effect.catchAll(() => Effect.succeed([] as Array<{ id: string; title?: string }>))
    )) as Array<{ id: string; title?: string }>;
    for (const ns of namespaces.filter((n) => n.title === flavor.kvTitle)) {
      yield* cfFetch(cfToken, `/accounts/${account}/storage/kv/namespaces/${ns.id}`, { method: "DELETE" }).pipe(
        Effect.catchAll((e) => Effect.sync(() => {
          console.warn(`  Delete KV namespace failed: ${e.message.slice(0, 200)} — remove manually if needed.`);
        }))
      );
      console.log(`  Deleted KV namespace ${flavor.kvTitle}`);
    }
  } else {
    console.log("  Data preserved (D1/R2/KV) — pass --purge-data to delete it (irreversible).");
  }

  console.log(`  Undeployed ${flavorName} (${fullDomain}).`);
});
