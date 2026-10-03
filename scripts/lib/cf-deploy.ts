// Workers deploy core — the importable provisioning API. The installer entry
// point (`scripts/workers-install.ts`) imports `main` and runs it only when
// invoked directly; other consumers (e.g. `lx worker upgrade`) import the
// named helpers without triggering a deploy.
//
// Provisions D1/R2/KV via the Cloudflare API, stages the prebuilt bundle,
// writes a per-deploy wrangler config, applies D1 migrations, deploys via
// bunx wrangler, and (custom domain only) binds the worker route. Prompts live
// in install.sh (the bash side owns /dev/tty); this helper takes everything via
// flags.
//
// Usage (via the entry wrapper):
//   bun scripts/workers-install.ts --name <deploy> \
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
import { fileURLToPath } from "node:url";

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

// Root repo wrangler config — the per-deploy config mirrors
// `compatibility_date` and the observability block from it. Wrangler's JSONC
// schema allows line/block comments and trailing commas, so the file is
// scanned (string-aware) rather than regex-stripped: a `//` inside a string
// value (e.g. a URL) is data, not a comment, and genuinely malformed JSON must
// still be rejected with the parse error.
export interface RootWorkerConfig {
  compatibility_date?: string;
  observability?: Record<string, unknown>;
  durable_objects?: Record<string, unknown>;
  migrations?: Array<Record<string, unknown>>;
  services?: Array<Record<string, unknown>>;
  ai?: unknown;
}

// Remove // line comments and /* */ block comments while respecting string
// literals and escapes (a `//` or `/*` inside a quoted value is data; `\"`
// never ends a string).
function stripJsoncComments(input: string): string {
  let out = "";
  let i = 0;
  const n = input.length;
  let inString = false;
  while (i < n) {
    const ch = input[i]!;
    if (inString) {
      out += ch;
      if (ch === "\\" && i + 1 < n) {
        out += input[i + 1]!;
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === "/" && input[i + 1] === "/") {
      i += 2;
      while (i < n && input[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && input[i + 1] === "*") {
      i += 2;
      while (i < n && !(input[i] === "*" && input[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

// Drop trailing commas before a closing `}`/`]` (string-aware). Comments are
// already gone, so the lookahead only has to skip whitespace.
function stripTrailingCommas(input: string): string {
  let out = "";
  let i = 0;
  const n = input.length;
  let inString = false;
  while (i < n) {
    const ch = input[i]!;
    if (inString) {
      out += ch;
      if (ch === "\\" && i + 1 < n) {
        out += input[i + 1]!;
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < n && /\s/.test(input[j]!)) j++;
      if (input[j] === "}" || input[j] === "]") {
        i++;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

export function readRootWranglerConfig(dir: string): RootWorkerConfig {
  const path = join(dir, "wrangler.jsonc");
  const raw = readFileSync(path, "utf-8");
  try {
    return JSON.parse(
      stripTrailingCommas(stripJsoncComments(raw)),
    ) as RootWorkerConfig;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${path}: ${message}`);
  }
}

// Observability block written into the per-deploy config: root's block
// verbatim, or the bare legacy enable when root declares no block. A present
// but non-object block is refused loudly — never silently downgraded.
export function resolveObservability(
  root: RootWorkerConfig,
): Record<string, unknown> {
  const block = root.observability;
  if (block === undefined) return { enabled: true };
  if (typeof block !== "object" || block === null || Array.isArray(block)) {
    throw new Error(
      `root wrangler.jsonc 'observability' must be a JSON object (got ${
        Array.isArray(block) ? "array" : typeof block
      }) — fix the key or remove it`,
    );
  }
  return block;
}

// Durable Object blocks written into the per-deploy config: root's
// `durable_objects`/`migrations` verbatim. Installed deployments must deploy
// the assistant DO class (ADR-0003 §B.1 / risk R11) — without these blocks the
// generated config has no `ASSISTANT_AGENT` binding and chat dies. A missing or
// malformed block is refused loudly rather than silently omitted.
export function resolveDurableObjects(root: RootWorkerConfig): {
  durable_objects: Record<string, unknown>;
  migrations: Array<Record<string, unknown>>;
} {
  const durableObjects = root.durable_objects;
  if (
    typeof durableObjects !== "object" ||
    durableObjects === null ||
    Array.isArray(durableObjects)
  ) {
    throw new Error(
      "root wrangler.jsonc 'durable_objects' must be a JSON object declaring the ASSISTANT_AGENT binding — add the binding or remove the assistant deploy path",
    );
  }
  const bindings = durableObjects.bindings;
  if (!Array.isArray(bindings) || bindings.length === 0) {
    throw new Error(
      "root wrangler.jsonc 'durable_objects.bindings' must be a non-empty array containing { name: \"ASSISTANT_AGENT\", class_name: \"LexaAssistantAgent\" }",
    );
  }
  const hasAgentBinding = bindings.some((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return false;
    }
    const binding = entry as { name?: unknown; class_name?: unknown };
    return binding.name === "ASSISTANT_AGENT" && binding.class_name === "LexaAssistantAgent";
  });
  if (!hasAgentBinding) {
    throw new Error(
      "root wrangler.jsonc 'durable_objects.bindings' must contain { name: \"ASSISTANT_AGENT\", class_name: \"LexaAssistantAgent\" }",
    );
  }
  const migrations = root.migrations;
  if (!Array.isArray(migrations) || migrations.length === 0) {
    throw new Error(
      "root wrangler.jsonc 'migrations' must be a non-empty array declaring the new_sqlite_classes migration for LexaAssistantAgent",
    );
  }
  const hasSqliteMigration = migrations.some((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return false;
    }
    const migration = entry as { new_sqlite_classes?: unknown };
    return (
      Array.isArray(migration.new_sqlite_classes) &&
      migration.new_sqlite_classes.includes("LexaAssistantAgent")
    );
  });
  if (!hasSqliteMigration) {
    throw new Error(
      "root wrangler.jsonc 'migrations' must declare a migration whose new_sqlite_classes includes \"LexaAssistantAgent\"",
    );
  }
  return { durable_objects: durableObjects, migrations };
}

// Service bindings written into the per-deploy config (ADR-0003 §B.2/R7):
// the assistant DO reaches the Worker's internal routes through
// `ASSISTANT_SERVICE`. Root declares the binding name (and a placeholder
// `service`); the generated config pins `service` to the deployed worker's own
// name so a self-binding is correct on every flavor (lexa / lexa-staging).
// Root's `services` may be absent (older clones) — then the binding is omitted
// and the DO keeps its public-origin fallback.
export function resolveServiceBindings(
  root: RootWorkerConfig,
  workerName: string,
): Array<Record<string, unknown>> {
  const services = root.services;
  if (services === undefined) return [];
  if (!Array.isArray(services)) {
    throw new Error(
      "root wrangler.jsonc 'services' must be an array of service bindings",
    );
  }
  const out: Array<Record<string, unknown>> = [];
  for (const entry of services) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(
        "root wrangler.jsonc 'services' entries must be objects with a string 'binding'",
      );
    }
    const binding = (entry as { binding?: unknown }).binding;
    if (typeof binding !== "string" || binding.length === 0) {
      throw new Error(
        "root wrangler.jsonc 'services' entries must carry a non-empty string 'binding'",
      );
    }
    out.push({ binding, service: workerName });
  }
  return out;
}

// H9: Workers AI binding written into the per-deploy config. Root declares
// `"ai": { "binding": "AI" }`; installed deployments must transcribe it so a
// `workers_ai` assistant model can build `createWorkersAI({ binding: env.AI })`.
// An absent block is omitted (older clones keep deploying without Workers AI);
// a present but malformed block is refused loudly rather than silently dropped.
export function resolveAiBinding(root: RootWorkerConfig): Record<string, unknown> {
  const ai = root.ai;
  if (ai === undefined) return {};
  if (typeof ai !== "object" || ai === null || Array.isArray(ai)) {
    throw new Error(
      "root wrangler.jsonc 'ai' must be a JSON object declaring { binding: \"AI\" }",
    );
  }
  const binding = (ai as { binding?: unknown }).binding;
  // The runtime reads `env.AI` (server/assistant/agent.ts), so any other
  // binding name would type-check here but never reach the worker.
  if (binding !== "AI") {
    throw new Error(
      "root wrangler.jsonc 'ai' must declare { binding: \"AI\" } — the runtime resolves env.AI",
    );
  }
  return { ai };
}

// First readable `version` across the given package.json paths, or null.
export function readPackageVersion(paths: string[]): string | null {
  for (const path of paths) {
    try {
      const pkg = JSON.parse(readFileSync(path, "utf-8")) as {
        version?: unknown;
      };
      if (typeof pkg.version === "string" && pkg.version.length > 0) {
        return pkg.version;
      }
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

// The web-app version stamped into the per-deploy config so `lx worker
// upgrade` can compare the deployed app against the latest release. Candidates
// in order: the deploy dir `package.json` (from-repo runs and release tarballs,
// which ship one), then the CLI module's own repo root `package.json` as a
// fallback. The fallback reflects the CLI's package, not necessarily the
// deployed app, so it is a best-effort only; when no candidate yields a version
// the marker is omitted (the CLI warns).
export function readDeployVersion(dir: string): string | null {
  return readPackageVersion([
    join(dir, "package.json"),
    fileURLToPath(new URL("../../package.json", import.meta.url)),
  ]);
}

// Per-deploy `vars`. `LXK_PUBLIC_URL` is stamped on every deploy (custom
// domain, else the resolved workers.dev host) so `lx worker upgrade` can match
// the deployment to the logged-in server; `LXK_VERSION` carries the web-app
// version. Each key is omitted only when genuinely unknown — an empty
// LXK_PUBLIC_URL would shadow the app's localhost fallback.
export function resolveDeployVars(input: {
  version: string | null;
  publicUrl: string;
}): Record<string, string> {
  return {
    LXK_ENV: "production",
    ...(input.publicUrl ? { LXK_PUBLIC_URL: input.publicUrl } : {}),
    ...(input.version ? { LXK_VERSION: input.version } : {}),
  };
}

// The install-managed D1 journal lives in `_migrations`. Migration files are
// applied in lexicographic (numeric-prefix) order. This one is load-bearing:
// it must be applied with or before the build that removes reference mode
// (docs/CLOUDFLARE_WORKERS.md) — a new build on an un-migrated DB refuses a
// stored `secret_ref` at connect rather than falling back to anonymous access.
export const MCP_SECRET_REFS_MIGRATION = "0012_remove_mcp_secret_refs.sql";

// Migration files not yet recorded in the journal, sorted for deterministic
// apply order. Used by `lx worker upgrade`; the installer applies migrations
// with its own inline loop (same journal + ordering semantics).
export function pendingMigrations(
  files: readonly string[],
  applied: ReadonlySet<string>,
): string[] {
  return files
    .filter((f) => f.endsWith(".sql"))
    .slice()
    .sort()
    .filter((f) => !applied.has(f));
}

// A journal with a gap (a pending migration sorting before an applied one) is
// out of order — applying the lagging file now runs its statements after later
// DDL. Refuse it; the 0012 case names the managed-only deploy rule explicitly.
export function migrationOrderError(
  files: readonly string[],
  applied: ReadonlySet<string>,
): string | null {
  const known = new Set(files);
  const pending = pendingMigrations(files, applied);
  if (pending.length === 0) return null;
  const first = pending[0]!;
  const appliedAfter = [...applied].filter((f) => known.has(f) && f > first).sort();
  if (appliedAfter.length === 0) return null;
  const base = `migration journal is out of order: '${first}' is not applied but later migration(s) ${appliedAfter.join(", ")} are`;
  return first === MCP_SECRET_REFS_MIGRATION
    ? `${base} — ${MCP_SECRET_REFS_MIGRATION} must be applied with or before the managed-only build (docs/CLOUDFLARE_WORKERS.md)`
    : base;
}

const API = "https://api.cloudflare.com/client/v4";

let CF_TOKEN = "";
let account = "";

// Set the token cfFetch/cfJson present to the Cloudflare API. The installer
// assigns these in main(); `lx worker upgrade` sets them once from its creds
// chain (flag > env > .cf-token) before using the helpers.
export function setCfToken(token: string): void {
  CF_TOKEN = token;
}

export async function cfFetch(
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

export async function cfJson<T>(
  label: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const r = await cfFetch(path, init);
  if (!r.ok) dieCf(label, r);
  return r.json?.result as T;
}

export function wrangler(
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

export async function ensureD1(
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

export async function ensureR2(flavor: WorkerFlavor): Promise<string> {
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

export async function ensureKv(flavor: WorkerFlavor): Promise<string> {
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

export async function main(): Promise<void> {
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
  // A workers.dev host (or empty) is not a custom domain: honoring one would
  // point the zone lookup at workers.dev and die. Treat it as absent. Normalize
  // the guard input (drop any scheme, path, or query suffix, then lowercase) so
  // variants like `https://Lexa.Acct.Workers.Dev/` are still recognized.
  const requestedDomain = flag("domain");
  const requestedHost = requestedDomain
    ? requestedDomain
        .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
        .split(/[/?#]/)[0]!
        .toLowerCase()
    : "";
  const CUSTOM_DOMAIN =
    requestedDomain && !requestedHost.endsWith(".workers.dev")
      ? requestedDomain
      : "";
  if (requestedDomain && !CUSTOM_DOMAIN) {
    console.log(
      `  (ignoring --domain '${requestedDomain}' — a workers.dev host is not a custom domain)`,
    );
  }
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

  // Public URL stamped into the generated config: the custom domain when set,
  // else the account's workers.dev host (best-effort). Resolved before the
  // config is written so every deploy records it; the same value feeds the
  // .deployed-url write below.
  let publicUrl = CUSTOM_DOMAIN ? `https://${CUSTOM_DOMAIN}` : "";
  if (!publicUrl) {
    try {
      const sub = await cfFetch(`/accounts/${account}/workers/subdomain`);
      const result = sub.json?.result as { subdomain?: string } | null;
      const subdomain = result?.subdomain ?? "";
      if (sub.ok && subdomain) {
        publicUrl = `https://${FLAVOR.workerName}.${subdomain}.workers.dev`;
      }
    } catch {
      /* best-effort */
    }
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

  // The root config read/parse and the observability shape check both refuse
  // through die: a bad wrangler.jsonc must read as an installer refusal, not a
  // crash. `observability` carries root's block verbatim into the per-deploy
  // config (bare `{ enabled: true }` when root declares none).
  let config: Record<string, unknown>;
  try {
    const rootConfig = readRootWranglerConfig(DIR);
    const { durable_objects, migrations } = resolveDurableObjects(rootConfig);
    const services = resolveServiceBindings(rootConfig, FLAVOR.workerName);
    config = {
      name: FLAVOR.workerName,
      account_id: account,
      main: `./${(manifest.main ?? "index.js").split("/").pop()}`,
      compatibility_date: rootConfig.compatibility_date ?? "2026-08-01",
      compatibility_flags: ["nodejs_compat"],
      ...(manifest.no_bundle ? { no_bundle: true } : {}),
      ...(manifest.rules !== undefined ? { rules: manifest.rules } : {}),
      assets: { directory: "./assets", binding: "ASSETS" },
      vars: resolveDeployVars({ version: readDeployVersion(DIR), publicUrl }),
      d1_databases: [
        { binding: "DB", database_name: FLAVOR.d1Name, database_id: d1Id },
      ],
      r2_buckets: [{ binding: "BLOB", bucket_name: r2Name }],
      kv_namespaces: [{ binding: "KV", id: kvId }],
      durable_objects,
      migrations,
      ...(services.length > 0 ? { services } : {}),
      ...resolveAiBinding(rootConfig),
      observability: resolveObservability(rootConfig),
    };
  } catch (err) {
    die(err instanceof Error ? err.message : String(err));
  }
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
  // The installer banner needs a URL — resolved up front (LXK_PUBLIC_URL).
  const deployedUrl = publicUrl;
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
