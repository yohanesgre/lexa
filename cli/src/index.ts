#!/usr/bin/env bun
/**
 * lx — Lexa operator CLI.
 *
 *   lx <command> [options]        (prod: compiled binary)
 *   lx-dev <command> [options]    (dev: bun run cli/index.ts)
 *
 * Wraps the Lexa REST API with the same lxk_ Bearer auth as the web app, and
 * gives humans/scripts (external agent harnesses included) a non-browser way
 * to drive Lexa.
 *
 * Env fallbacks (overridden by --url/--key or saved login):
 *   LEXA_URL, LEXA_API_KEY
 *
 * `lx login` without a key starts browser-approval (device) login: it
 * prints a verify link and polls until a logged-in user approves, then saves
 * the minted key. Legacy --url/--key and LEXA_URL/LEXA_API_KEY keep working
 * for scripts; the URL alone prompts interactively (TTY only).
 *
 * Effect boundary: command dispatch is an Effect program; the CliConfigService
 * is provided at the edge and failures print with the command's prefix then
 * exit(1). The only exit the program path takes is via the boundary.
 */
import { Effect, Data } from "effect";
import { LexaClient, ApiError, type ColumnInfo, type SwimlaneInfo } from "./api";
import { CliConfigService, groupDir, normalizeHost, resolveServerUrl, migrateFlavorRootsSync, type CliConfig } from "./config";
import { cmdGithubStatus, cmdGithubSetup, cmdGithubCheck, envFlagsRemoved } from "./github";
import { cmdUpgradeCli } from "./upgrade";
import { cmdWorkerUpgrade } from "./worker";
import { CLI_VERSION } from "./version";
import { hostname as osHostname } from "node:os";
import { readFile } from "node:fs/promises";

const ENV_URL = process.env.LEXA_URL ?? "";
const ENV_KEY = process.env.LEXA_API_KEY ?? "";

// ── tiny arg parsing (no deps) ──
interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}
function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!; // argv length guarantees presence
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

// ── errors ──
export class NotLoggedIn extends Data.TaggedError("NotLoggedIn")<{}> {
  override get message(): string {
    return "Not logged in. Run: lx login [--url <base>] [--key <lxk_...>]";
  }
}

// Several saved logins and no way to pick one (no --url/LEXA_URL, no active
// marker) — never silently pick alphabetically; list the hosts and instruct.
export class AmbiguousHost extends Data.TaggedError("AmbiguousHost")<{ hosts: string[] }> {
  override get message(): string {
    return `Multiple saved logins: ${this.hosts.join(", ")}. Pass --url <base-url> to pick one.`;
  }
}

// Resolve the active config: flags > env > active host > single saved login.
// The saved login lives in the group of its normalized host; an explicit
// --url/LEXA_URL names the host, otherwise the active marker wins, and only a
// lone saved login may be picked without a hint. Several logins and no hint
// is an error (AmbiguousHost), never an alphabetical guess.
function resolveConfig(flags: Record<string, string | boolean>): Effect.Effect<CliConfig | null, AmbiguousHost, CliConfigService> {
  return Effect.gen(function* () {
    const svc = yield* CliConfigService;
    const urlFlag = typeof flags.url === "string" && flags.url ? flags.url : "";
    const envUrl = ENV_URL;
    const hint = urlFlag || envUrl;
    const logins = yield* svc.listSavedLogins();

    let resolvedHint = "";
    let host = "";
    if (hint) {
      // --url/LEXA_URL may be a bare host (`lexa.example.com`); resolve it to
      // a full base URL with the same resolver `lx login` uses before it ever
      // reaches the client. Invalid input exits 1 with the resolver's message.
      try {
        resolvedHint = resolveServerUrl(hint);
      } catch (e) {
        console.error(`  ${(e as Error).message}`);
        process.exit(1);
      }
      host = normalizeHost(resolvedHint);
    } else {
      const active = yield* svc.activeHost();
      if (active && logins.some((l) => l.host === active)) {
        host = active;
      } else {
        const single = yield* svc.singleSavedLogin();
        if (single) host = single.host;
        else if (logins.length > 1) return yield* new AmbiguousHost({ hosts: logins.map((l) => l.host) });
      }
    }

    const saved = host ? (logins.find((l) => l.host === host) ?? null) : null;
    const url = resolvedHint || saved?.url || "";
    const keyFlag = (typeof flags.key === "string" && flags.key) || "";
    // LEXA_API_KEY is ambient: trusted only when LEXA_URL names the resolved
    // host, or when no LEXA_URL hint exists and there is no saved login at
    // all. --url X must never ship another host's ambient key to X. Env beats
    // a saved login when allowed (a matching LEXA_URL is an explicit ask).
    let envKeyAllowed: boolean;
    if (envUrl === "") {
      envKeyAllowed = logins.length === 0;
    } else {
      try {
        envKeyAllowed = normalizeHost(resolveServerUrl(envUrl)) === host;
      } catch {
        envKeyAllowed = false;
      }
    }
    const apiKey = keyFlag || (envKeyAllowed ? ENV_KEY : "") || saved?.apiKey || "";
    if (!url || !apiKey) return null;
    return { url, apiKey };
  });
}

function requireClient(flags: Record<string, string | boolean>): Effect.Effect<{ client: LexaClient; config: CliConfig }, NotLoggedIn | AmbiguousHost, CliConfigService> {
  return Effect.gen(function* () {
    const config = yield* resolveConfig(flags);
    if (!config) return yield* new NotLoggedIn();
    return { client: new LexaClient(config), config };
  });
}

// Run a command effect at the boundary: print failures with the command's
// prefix and exit(1).
function runCommand<A>(prefix: string, program: Effect.Effect<A, unknown, CliConfigService>): Promise<A> {
  return Effect.runPromise(
    program.pipe(
      Effect.provide(CliConfigService.Default),
      Effect.catchAll((e) =>
        Effect.sync((): never => {
          const msg = e instanceof Error ? e.message : String(e);
          const code = e instanceof ApiError && e.code ? ` [${e.code}]` : "";
          console.error(`  ${prefix}: ${msg}${code}`);
          process.exit(1);
        })
      )
    )
  );
}

// ── table printing (shared) ──
function printTable(rows: Record<string, string>[]): void {
  if (rows.length === 0) return;
  const keys = Object.keys(rows[0]!);
  const widths = keys.map((k) => Math.max(k.length, ...rows.map((r) => (r[k] ?? "").length)));
  const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - s.length));
  console.log(keys.map((k, i) => pad(k, widths[i]!)).join("  "));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const r of rows) {
    console.log(keys.map((k, i) => pad(r[k] ?? "", widths[i]!)).join("  "));
  }
}

// ── commands ──

// Date-only fields (dueAt / startAt) share one shape across the CLI.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// The literal token "none" means "send JSON null" — only on the NullOr fields
// that advertise it (wipLimit / githubState / dueAt / startAt / milestoneId).
function noneIf(v: string | undefined): string | null | undefined {
  if (v === undefined) return undefined;
  return v === "none" ? null : v;
}

// Strict boolean flag body: "true" | "false", anything else (bare flag, empty,
// typo) is undefined so callers can treat it as a usage error.
function parseBool(v: string | undefined): boolean | undefined {
  if (v === "true") return true;
  if (v === "false") return false;
  return undefined;
}

// A value-taking flag written bare (`--color`, no `=` and no following value)
// parses to boolean true and would otherwise be silently dropped — a usage
// error. Mirrors the W2 badAnchor pattern.
function bareValueFlag(flags: Record<string, string | boolean>, names: string[]): boolean {
  return names.some((n) => flags[n] === true);
}

// Read a JSON payload argument: "-" reads stdin (pipes / non-TTY safe), any
// other value is a file path. The promise rejects on read failure.
function readJsonFile(pathOrDash: string): Promise<string> {
  if (pathOrDash === "-") {
    return new Promise((resolve) => {
      let data = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => (data += chunk));
      process.stdin.on("end", () => resolve(data));
    });
  }
  return readFile(pathOrDash, "utf8");
}

function readJsonFileSafe(pathOrDash: string): Promise<{ ok: true; text: string } | { ok: false; msg: string }> {
  return readJsonFile(pathOrDash).then(
    (text) => ({ ok: true as const, text }),
    (e: unknown) => ({ ok: false as const, msg: (e as Error).message })
  );
}

// Interactive prompts — only ever used when stdin is a TTY and the login
// flags were omitted. Scripts and pipes never prompt.
// Plain line reading in cooked mode (no readline): the terminal driver
// handles echo and backspace, so there is no raw mode, no ANSI cursor
// queries, and nothing that can hang on a real terminal.
// Resolves null on EOF (Ctrl-D) so callers can distinguish a cancel from an
// empty line (an empty answer must re-prompt, not default).
export function promptLogin(question: string): Promise<string | null> {
  return new Promise((resolve) => {
    const done = (line: string | null) => {
      // Remove all stdin listeners — bun keeps a read interest on a TTY
      // stdin alive, which would keep the event loop running forever after
      // login; main() then exits explicitly.
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      process.off("SIGINT", onSigint);
      resolve(line);
    };
    let buffer = "";
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const nl = buffer.indexOf("\n");
      if (nl < 0) return; // line may arrive in multiple chunks
      // Strip erase chars in case the terminal is in raw mode (cooked
      // terminals already apply backspace at the driver level).
      let line = buffer.slice(0, nl).replace(/\r$/, "");
      while (true) {
        const bs = line.search(/[\x7f\b]/);
        if (bs < 0) break;
        line = line.slice(0, Math.max(0, bs - 1)) + line.slice(bs + 1);
      }
      buffer = "";
      done(line.trim());
    };
    const onEnd = () => done(null);
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

// TTY prompt with NO default: an empty answer prints the message and loops
// until filled (Ctrl-C/EOF cancel, exit 130).
function promptRequired(question: string, requiredMessage: string): Effect.Effect<string, never, never> {
  return Effect.gen(function* () {
    for (;;) {
      const answer = yield* Effect.promise(() => promptLogin(question));
      if (answer === null) process.exit(130);
      if (answer) return answer;
      console.log(requiredMessage);
    }
  });
}

// Growing poll cadence: 2s, then 5s, then 10s for every later attempt, each
// scaled by ±20% jitter so logins don't resynchronize into a thundering herd.
const DEVICE_POLL_DELAYS_MS = [2000, 5000, 10_000] as const;
const DEVICE_POLL_JITTER = 0.2;
const DEVICE_POLL_TIMEOUT_MS = 5 * 60 * 1000;
// The server owns the pairing TTL; the CLI deadline derives from the create
// response's expiresMs plus a small grace for clock skew and the in-flight
// poll. Absent/nonsensical expiresMs falls back to the constant above, and the
// window is clamped so a bogus far-future value cannot keep the loop alive.
const DEVICE_POLL_GRACE_MS = 10 * 1000;
const DEVICE_POLL_MAX_MS = 30 * 60 * 1000;

export function devicePollDeadline(expiresMs: number | undefined, now: number): number {
  if (typeof expiresMs === "number" && Number.isFinite(expiresMs) && expiresMs > now) {
    return Math.min(expiresMs + DEVICE_POLL_GRACE_MS, now + DEVICE_POLL_MAX_MS);
  }
  return now + DEVICE_POLL_TIMEOUT_MS;
}

// Delay before poll attempt N (0-based): 2s, 5s, then a 10s cap, with ±20%
// jitter. `rand` is injectable for deterministic tests and defaults to Math.random.
export function nextDevicePollDelayMs(attempt: number, rand: () => number = Math.random): number {
  const index = Math.min(Math.max(Math.floor(attempt), 0), DEVICE_POLL_DELAYS_MS.length - 1);
  const base = DEVICE_POLL_DELAYS_MS[index]!;
  const factor = 1 - DEVICE_POLL_JITTER + rand() * DEVICE_POLL_JITTER * 2;
  return Math.round(base * factor);
}

// Browser-approval login: create a pairing request, print the verify URL,
// poll until a logged-in user approves, then save the minted user-bound key
// exactly like the legacy key login. No prompts — works with non-TTY stdin.
function deviceLoginFlow(url: string): Effect.Effect<void, unknown, CliConfigService> {
  return Effect.gen(function* () {
    const svc = yield* CliConfigService;
    const client = new LexaClient({ url, apiKey: "" });
    const h = yield* client.health();
    if (!h.ok) yield* new ApiError({ status: 0, serverMessage: "health check failed" });
    const req = yield* client.createDeviceLoginRequest(`cli-${osHostname()}`);
    let token = "";
    try {
      token = new URL(req.verifyUrl).searchParams.get("token") ?? "";
    } catch {
      token = "";
    }
    if (!token) yield* new ApiError({ status: 0, serverMessage: "server returned a verify URL without a token" });
    console.log("  Open this link to approve the login:");
    console.log(`    ${req.verifyUrl}`);
    console.log(`  Backup code (shown on the approve page): ${req.code}`);
    console.log("  Waiting for approval…");
    const startedAt = Date.now();
    const deadline = devicePollDeadline(req.expiresMs, startedAt);
    let attempt = 0;
    while (Date.now() < deadline) {
      const result = yield* client.pollDeviceLoginRequest(req.id, token).pipe(
        Effect.catchAll((e) => {
          if (e instanceof ApiError && e.code === "DEVICE_LOGIN_NOT_FOUND") {
            console.error("  This server does not support device login — use `lx login --key <lxk_...>`.");
            process.exit(1);
          }
          if (e instanceof ApiError && e.code === "DEVICE_LOGIN_DENIED") {
            console.error("  Login request was denied.");
            process.exit(1);
          }
          if (e instanceof ApiError && e.code === "DEVICE_LOGIN_EXPIRED") {
            console.error("  Login request expired — please try again.");
            process.exit(1);
          }
          return Effect.fail(e);
        })
      );
      if (result.status === "approved") {
        const dir = groupDir(url);
        yield* svc.saveConfig({ url, apiKey: result.rawKey }, dir);
        yield* svc.setActiveHost(url);
        console.log(`  New API key: ${result.keyName}`);
        console.log(`  Logged in as ${result.approverName ?? "unknown"}`);
        console.log(`  Logged in to ${url}`);
        return;
      }
      yield* Effect.sleep(Math.min(nextDevicePollDelayMs(attempt), Math.max(0, deadline - Date.now())));
      attempt++;
    }
    const windowMin = Math.max(1, Math.round((deadline - startedAt) / 60000));
    console.error(`  Login request timed out after ${windowMin} minute${windowMin === 1 ? "" : "s"} — nobody approved it. Try again.`);
    process.exit(1);
  });
}

function cmdLogin(flags: Record<string, string | boolean>, positionals: string[]): Effect.Effect<void, unknown, CliConfigService> {
  return Effect.gen(function* () {
    const svc = yield* CliConfigService;
    // --url flag beats a positional URL (`login <url>`); env stays last.
    const rawUrl = (typeof flags.url === "string" && flags.url) || positionals[1] || ENV_URL || "";
    const key = (typeof flags.key === "string" && flags.key) || ENV_KEY || "";
    let url = rawUrl;
    if (!url) {
      if (!process.stdin.isTTY) {
        // Cannot prompt without stdin — message + usage, exit 1. (The device
        // flow below needs no stdin, so a missing KEY never lands here.)
        console.error("  Server URL is required — please fill it");
        console.error("  Usage: lx login [<url>] [--url <base>] [--key <lxk_...>]");
        process.exit(1);
      }
      url = yield* promptRequired("  Server URL: ", "  Server URL is required — please fill it");
    }
    // A bare host (`lexa.example.com`) has no scheme — resolve to a full base
    // URL before any `new URL()` sees it. Loopback defaults to http.
    try {
      url = resolveServerUrl(url);
    } catch (e) {
      console.error(`  ${(e as Error).message}`);
      process.exit(1);
    }
    if (key) {
      // Legacy key login — validate the lxk_ shape, confirm server + key, save.
      if (!/^lxk_[0-9A-Za-z]{43}$/.test(key)) {
        console.error("  Invalid API key — must be lxk_ + 43 chars (from Settings → API Keys).");
        process.exit(1);
      }
      // Validate: server reachable + key works.
      const client = new LexaClient({ url, apiKey: key });
      const h = yield* client.health();
      if (!h.ok) yield* new ApiError({ status: 0, serverMessage: "health check failed" });
      yield* client.listProjects();
      // State lands in the group of THIS server — ~/.lexa/<host>/.
      const dir = groupDir(url);
      yield* svc.saveConfig({ url, apiKey: key }, dir);
      yield* svc.setActiveHost(url);
      console.log(`  Logged in to ${url}`);
      return;
    }
    // No key → device login: browser-approval pairing on the same server.
    yield* deviceLoginFlow(url);
  });
}

function cmdLogout(flags: Record<string, string | boolean>): Effect.Effect<void, AmbiguousHost, CliConfigService> {
  return Effect.gen(function* () {
    const svc = yield* CliConfigService;
    const logins = yield* svc.listSavedLogins();
    if (flags.all === true) {
      if (logins.length === 0) {
        console.log("  Not logged in — nothing to remove.");
      } else {
        for (const login of logins) {
          yield* svc.clearConfig(login.dir);
        }
      }
      yield* svc.clearActiveHost();
      return;
    }
    const rawUrl = (typeof flags.url === "string" && flags.url) || ENV_URL || "";
    const active = yield* svc.activeHost();
    let host = "";
    if (rawUrl) {
      // Same resolver as login: a bare `--url lexa.example.com` must map to
      // the same normalized host its saved login was stored under.
      try {
        host = normalizeHost(resolveServerUrl(rawUrl));
      } catch (e) {
        console.error(`  ${(e as Error).message}`);
        process.exit(1);
      }
    }
    if (!host && active && logins.some((l) => l.host === active)) host = active;
    if (!host && logins.length === 1) host = logins[0]!.host;
    if (!host && logins.length > 1) return yield* new AmbiguousHost({ hosts: logins.map((l) => l.host) });
    if (!host) {
      console.log("  Not logged in — nothing to remove.");
      return;
    }
    const login = logins.find((l) => l.host === host);
    if (!login) {
      console.log(`  Not logged in for ${host} — nothing to remove.`);
      return;
    }
    yield* svc.clearConfig(login.dir);
    if (active === host) yield* svc.clearActiveHost();
  });
}

function cmdStatus(flags: Record<string, string | boolean>): Effect.Effect<void, unknown, CliConfigService> {
  return Effect.gen(function* () {
    const { client, config } = yield* requireClient(flags);
    const h = yield* client.health();
    const projects = yield* client.listProjects();
    console.log(`  Host:     ${config.url}`);
    console.log(`  Server:   reachable (health ${h.ok ? "ok" : "?"})`);
    console.log(`  Projects: ${projects.length}`);
    console.log(`  Auth:     API key accepted`);
  });
}

function cmdProjectList(flags: Record<string, string | boolean>): Effect.Effect<void, unknown, CliConfigService> {
  return Effect.gen(function* () {
    const { client } = yield* requireClient(flags);
    const json = flags.json === true;
    const projects = yield* client.listProjects();
    if (json) { console.log(JSON.stringify(projects, null, 2)); return; }
    if (projects.length === 0) { console.log("  No projects."); return; }
    printTable(projects.map((p) => ({ SLUG: p.slug, NAME: p.name, DESCRIPTION: p.description ?? "" })));
  });
}

// Resolve a column/swimlane/milestone name (or id) → the entity for the target
// project. Exact id match wins, else case-insensitive exact name; a miss
// prints the available names (existing style) and exits.
function resolveColumn(client: LexaClient, slug: string, name: string): Effect.Effect<ColumnInfo, unknown, never> {
  return Effect.gen(function* () {
    const cols = yield* client.listColumns(slug);
    const found = cols.find((c) => c.id === name) ?? cols.find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (!found) {
      console.error(`  Column "${name}" not found. Available: ${cols.map((c) => c.name).join(", ")}`);
      process.exit(1);
    }
    return found;
  });
}
function resolveSwimlane(client: LexaClient, slug: string, name: string): Effect.Effect<SwimlaneInfo, unknown, never> {
  return Effect.gen(function* () {
    const lanes = yield* client.listSwimlanes(slug);
    const found = lanes.find((l) => l.id === name) ?? lanes.find((l) => l.name.toLowerCase() === name.toLowerCase());
    if (!found) {
      console.error(`  Swimlane "${name}" not found. Available: ${lanes.map((l) => l.name).join(", ")}`);
      process.exit(1);
    }
    return found;
  });
}
function resolveMilestone(client: LexaClient, slug: string, ref: string): Effect.Effect<string, unknown, never> {
  return Effect.gen(function* () {
    const milestones = yield* client.listMilestones(slug);
    const found = milestones.find((m) => m.id === ref) ?? milestones.find((m) => m.name.toLowerCase() === ref.toLowerCase());
    if (!found) {
      console.error(`  Milestone "${ref}" not found. Available: ${milestones.map((m) => m.name).join(", ")}`);
      process.exit(1);
    }
    return found.id;
  });
}

// Task ids are accepted verbatim: the full UUID or the ticket key (PREFIX-N,
// e.g. "NIM-12"). The server resolves both (`server/api/task-id.ts`), so no
// client-side lookup is needed.
function resolveTaskId(id: string): Effect.Effect<string, never, never> {
  return Effect.succeed(id);
}

function cmdTaskList(flags: Record<string, string | boolean>, args: string[]): Effect.Effect<void, unknown, CliConfigService> {
  return Effect.gen(function* () {
    const { client } = yield* requireClient(flags);
    const slug = (typeof flags.project === "string" && flags.project) || args[0]! || "";
    if (!slug) { console.error("  Usage: lx task list --project <slug>"); process.exit(1); }
    const limit = typeof flags.limit === "string" ? parseInt(flags.limit, 10) : 20;
    const json = flags.json === true;
    const tasks = yield* client.listTasks(slug, limit);
    if (json) { console.log(JSON.stringify(tasks, null, 2)); return; }
    if (tasks.length === 0) { console.log("  No tasks."); return; }
    // Tasks don't carry a status — resolve the column name for context.
    const columns = yield* client.listColumns(slug);
    const colName = new Map(columns.map((c) => [c.id, c.name]));
    printTable(tasks.map((t) => ({
      KEY: t.key ?? "",
      ID: t.id,
      TITLE: t.title,
      COLUMN: colName.get(t.columnId) ?? t.columnId,
      PRIORITY: t.priority ?? "",
      TYPE: t.type ?? "",
    })));
  });
}

function cmdTaskCreate(flags: Record<string, string | boolean>): Effect.Effect<void, unknown, CliConfigService> {
  return Effect.gen(function* () {
    const { client } = yield* requireClient(flags);
    const slug = (typeof flags.project === "string" && flags.project) || "";
    const column = (typeof flags.column === "string" && flags.column) || "";
    const swimlane = (typeof flags.swimlane === "string" && flags.swimlane) || "";
    const title = (typeof flags.title === "string" && flags.title) || "";
    const description = typeof flags.description === "string" && flags.description ? flags.description : undefined;
    if (!slug || !column || !swimlane || !title) {
      console.error("  Usage: lx task create --project <slug> --column <name> --swimlane <name> --title <t> [--description <markdown>]");
      process.exit(1);
    }
    const columnInfo = yield* resolveColumn(client, slug, column);
    const swimlaneInfo = yield* resolveSwimlane(client, slug, swimlane);
    let descriptionDoc: unknown;
    if (description) {
      const { markdownToDoc } = yield* Effect.promise(() => import("../../shared/markdown"));
      descriptionDoc = markdownToDoc(description);
    }
    const task = yield* client.createTask(slug, { columnId: columnInfo.id, swimlaneId: swimlaneInfo.id, title, description: descriptionDoc });
    console.log(`  Created task ${task.id} — ${task.title}`);
  });
}

function cmdTaskMove(flags: Record<string, string | boolean>, args: string[]): Effect.Effect<void, unknown, CliConfigService> {
  return Effect.gen(function* () {
    const { client } = yield* requireClient(flags);
    const slug = (typeof flags.project === "string" && flags.project) || "";
    const id = args[0]! || "";
    const column = (typeof flags.column === "string" && flags.column) || "";
    const swimlane = (typeof flags.swimlane === "string" && flags.swimlane) || "";
    const before = typeof flags.before === "string" ? flags.before : undefined;
    const after = typeof flags.after === "string" ? flags.after : undefined;
    const clearDue = flags["clear-due"] === true;
    // Bare (--before) and empty (--before=) anchors are usage errors: the
    // former would be silently dropped, the latter reaches the server as a 404.
    const badAnchor = flags.before === true || flags.after === true || before === "" || after === "";
    if (!slug || !id || !column || badAnchor || (before !== undefined && after !== undefined)) {
      console.error("  Usage: lx task move <id> --project <slug> --column <name|id> [--swimlane <name|id>] [--before <id|PREFIX-N>] [--after <id|PREFIX-N>] [--clear-due]");
      process.exit(1);
    }
    const columnId = (yield* resolveColumn(client, slug, column)).id;
    const taskId = yield* resolveTaskId(id);
    // Every task belongs to a swimlane (swimlane_id NOT NULL) — only a
    // user-supplied --swimlane changes it; otherwise keep the task's current
    // lane. Sending "" would fail the FK.
    const swimlaneId = swimlane
      ? (yield* resolveSwimlane(client, slug, swimlane)).id
      : (yield* client.getTask(slug, taskId)).swimlaneId;
    // --before / --after pass through verbatim (server resolves PREFIX-N too).
    const target: { columnId: string; swimlaneId: string; beforeTaskId?: string; afterTaskId?: string; clearDueAt?: boolean } = { columnId, swimlaneId };
    if (before !== undefined) target.beforeTaskId = before;
    if (after !== undefined) target.afterTaskId = after;
    if (clearDue) target.clearDueAt = true;
    const task = yield* client.moveTask(slug, taskId, target);
    console.log(`  Moved ${taskId} → ${column}`);
  });
}

function cmdTaskGet(flags: Record<string, string | boolean>, args: string[]): Effect.Effect<void, unknown, CliConfigService> {
  return Effect.gen(function* () {
    const { client } = yield* requireClient(flags);
    const slug = (typeof flags.project === "string" && flags.project) || "";
    const id = args[0]! || "";
    if (!slug || !id) { console.error("  Usage: lx task get <id> --project <slug>"); process.exit(1); }
    const taskId = yield* resolveTaskId(id);
    const t = yield* client.getTask(slug, taskId);
    if (flags.json === true) { console.log(JSON.stringify(t, null, 2)); return; }
    console.log(`  ${t.key} — ${t.title}`);
    console.log(`  id: ${t.id}  priority: ${t.priority ?? "—"}  type: ${t.type ?? "—"}`);
    console.log(`  column: ${t.columnId}  swimlane: ${t.swimlaneId}`);
    // Description is TipTap JSON — render to Markdown so agents/humans can
    // actually read it.
    const { docToMarkdown } = yield* Effect.promise(() => import("../../shared/markdown"));
    const md = docToMarkdown(t.description as import("../../shared/types").TipTapDoc).trim();
    console.log(`  description: ${md ? `\n${md}` : "(empty)"}`);
  });
}

function cmdTaskUpdate(flags: Record<string, string | boolean>, args: string[]): Effect.Effect<void, unknown, CliConfigService> {
  return Effect.gen(function* () {
    const { client } = yield* requireClient(flags);
    const slug = (typeof flags.project === "string" && flags.project) || "";
    const id = args[0]! || "";
    const title = typeof flags.title === "string" ? flags.title : undefined;
    const priority = typeof flags.priority === "string" ? flags.priority : undefined;
    const type = typeof flags.type === "string" ? flags.type : undefined;
    const hasDescription = typeof flags.description === "string";
    const hasAssignees = "assignees" in flags;
    const assignees = hasAssignees
      ? (typeof flags.assignees === "string" ? flags.assignees : "").split(",").map((s) => s.trim()).filter((s) => s !== "")
      : undefined;
    const hasDue = flags.due !== undefined;
    const due = typeof flags.due === "string" ? flags.due : undefined;
    const clearDue = flags["clear-due"] === true;
    const usageMsg = "  Usage: lx task update <id> --project <slug> [--title <t>] [--description <md>] [--priority <id>] [--type <id>] [--assignees <a,b> | --assignees=] [--due <YYYY-MM-DD>] [--clear-due]";
    const bad =
      !slug || !id ||
      flags.assignees === true ||
      (hasDue && (due === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(due))) ||
      (hasDue && clearDue) ||
      (title === undefined && !hasDescription && priority === undefined && type === undefined && !hasAssignees && !hasDue && !clearDue);
    if (bad) { console.error(usageMsg); process.exit(1); }
    const input: { title?: string; description?: unknown; priority?: string; type?: string; assignees?: string[]; dueAt?: string | null } = {};
    if (title !== undefined) input.title = title;
    if (hasDescription) {
      const { markdownToDoc } = yield* Effect.promise(() => import("../../shared/markdown"));
      input.description = markdownToDoc(flags.description as string);
    }
    if (priority !== undefined) input.priority = priority;
    if (type !== undefined) input.type = type;
    if (assignees !== undefined) input.assignees = assignees;
    if (clearDue) input.dueAt = null;
    else if (due !== undefined) input.dueAt = due;
    const taskId = yield* resolveTaskId(id);
    const t = yield* client.updateTask(slug, taskId, input);
    console.log(`  Updated ${taskId} — ${t.title}`);
  });
}

function cmdTaskDelete(flags: Record<string, string | boolean>, args: string[]): Effect.Effect<void, unknown, CliConfigService> {
  return Effect.gen(function* () {
    const { client } = yield* requireClient(flags);
    const slug = (typeof flags.project === "string" && flags.project) || "";
    const id = args[0]! || "";
    if (!slug || !id) { console.error("  Usage: lx task delete <id> --project <slug>"); process.exit(1); }
    const taskId = yield* resolveTaskId(id);
    yield* client.deleteTask(slug, taskId);
    console.log(`  Deleted ${taskId}`);
  });
}

// ── Planning reads (columns / swimlanes / milestones) ──

function cmdColumnList(flags: Record<string, string | boolean>): Effect.Effect<void, unknown, CliConfigService> {
  return Effect.gen(function* () {
    const { client } = yield* requireClient(flags);
    const slug = (typeof flags.project === "string" && flags.project) || "";
    if (!slug) { console.error("  Usage: lx column list --project <slug> [--json]"); process.exit(1); }
    const columns = yield* client.listColumns(slug);
    if (flags.json === true) { console.log(JSON.stringify(columns, null, 2)); return; }
    if (columns.length === 0) { console.log("  No columns."); return; }
    printTable(columns.map((c) => ({
      ID: c.id,
      NAME: c.name,
      WIP: c.wipLimit != null ? String(c.wipLimit) : "—",
      DONE: c.isDone ? "yes" : "",
      GITHUB: c.githubState ?? "—",
    })));
  });
}

function cmdSwimlaneList(flags: Record<string, string | boolean>): Effect.Effect<void, unknown, CliConfigService> {
  return Effect.gen(function* () {
    const { client } = yield* requireClient(flags);
    const slug = (typeof flags.project === "string" && flags.project) || "";
    if (!slug) { console.error("  Usage: lx swimlane list --project <slug> [--json]"); process.exit(1); }
    const lanes = yield* client.listSwimlanes(slug);
    if (flags.json === true) { console.log(JSON.stringify(lanes, null, 2)); return; }
    if (lanes.length === 0) { console.log("  No swimlanes."); return; }
    printTable(lanes.map((l) => ({
      ID: l.id,
      NAME: l.name,
      KIND: l.kind,
      MILESTONE: l.milestoneId ?? "—",
      START: l.startAt ?? "—",
      DUE: l.dueAt ?? "—",
      ARCHIVED: l.archivedAt ? "yes" : "",
    })));
  });
}

function cmdMilestoneList(flags: Record<string, string | boolean>): Effect.Effect<void, unknown, CliConfigService> {
  return Effect.gen(function* () {
    const { client } = yield* requireClient(flags);
    const slug = (typeof flags.project === "string" && flags.project) || "";
    if (!slug) { console.error("  Usage: lx milestone list --project <slug> [--json]"); process.exit(1); }
    const milestones = yield* client.listMilestones(slug);
    if (flags.json === true) { console.log(JSON.stringify(milestones, null, 2)); return; }
    if (milestones.length === 0) { console.log("  No milestones."); return; }
    printTable(milestones.map((m) => ({
      ID: m.id,
      NAME: m.name,
      DUE: m.dueAt ?? "—",
      ARCHIVED: m.archivedAt ? "yes" : "",
      SPRINTS: String(m.sprintCount),
    })));
  });
}

function cmdMilestoneCreate(flags: Record<string, string | boolean>): Effect.Effect<void, unknown, CliConfigService> {
  return Effect.gen(function* () {
    const { client } = yield* requireClient(flags);
    const slug = (typeof flags.project === "string" && flags.project) || "";
    const name = typeof flags.name === "string" && flags.name ? flags.name : "";
    const description = typeof flags.description === "string" && flags.description ? flags.description : undefined;
    const hasDue = flags.due !== undefined;
    const due = typeof flags.due === "string" ? flags.due : undefined;
    const bad = !slug || !name || (hasDue && (due === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(due)));
    if (bad) {
      console.error("  Usage: lx milestone create --project <slug> --name <n> [--description <s>] [--due <YYYY-MM-DD>]");
      process.exit(1);
    }
    const milestone = yield* client.createMilestone(slug, {
      name,
      ...(description !== undefined ? { description } : {}),
      ...(hasDue && due !== undefined ? { dueAt: due } : {}),
    });
    console.log(`  Created milestone ${milestone.id} — ${milestone.name}`);
  });
}

function cmdMilestoneUpdate(flags: Record<string, string | boolean>, args: string[]): Effect.Effect<void, unknown, CliConfigService> {
  return Effect.gen(function* () {
    const { client } = yield* requireClient(flags);
    const slug = (typeof flags.project === "string" && flags.project) || "";
    const ref = args[0]! || "";
    const name = typeof flags.name === "string" ? flags.name : undefined;
    const hasDescription = typeof flags.description === "string";
    const hasDue = flags.due !== undefined;
    const due = typeof flags.due === "string" ? flags.due : undefined;
    const clearDue = flags["clear-due"] === true;
    const hasPosition = flags.position !== undefined;
    const position = typeof flags.position === "string" && /^\d+$/.test(flags.position) ? Number(flags.position) : undefined;
    const usageMsg = "  Usage: lx milestone update <ref> --project <slug> [--name <n>] [--description <s>] [--due <YYYY-MM-DD>|--clear-due] [--position <n>]";
    const bad =
      !slug || !ref ||
      name === "" ||
      (hasDue && (due === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(due))) ||
      (hasDue && clearDue) ||
      (hasPosition && position === undefined) ||
      (name === undefined && !hasDescription && !hasDue && !clearDue && !hasPosition);
    if (bad) { console.error(usageMsg); process.exit(1); }
    const input: { name?: string; description?: string; dueAt?: string | null; position?: number } = {};
    if (name !== undefined) input.name = name;
    if (hasDescription) input.description = flags.description as string;
    if (clearDue) input.dueAt = null;
    else if (due !== undefined) input.dueAt = due;
    if (position !== undefined) input.position = position;
    const milestoneId = yield* resolveMilestone(client, slug, ref);
    const milestone = yield* client.updateMilestone(slug, milestoneId, input);
    console.log(`  Updated milestone ${milestone.id} — ${milestone.name}`);
  });
}

function cmdWikiList(flags: Record<string, string | boolean>): Effect.Effect<void, unknown, CliConfigService> {
  return Effect.gen(function* () {
    const { client } = yield* requireClient(flags);
    const slug = (typeof flags.project === "string" && flags.project) || "";
    if (!slug) { console.error("  Usage: lx wiki list --project <slug>"); process.exit(1); }
    const pages = yield* client.listWikiPages(slug);
    if (flags.json === true) { console.log(JSON.stringify(pages, null, 2)); return; }
    if (pages.length === 0) { console.log("  No wiki pages."); return; }
    printTable(pages.map((p) => ({ SLUG: p.slug, TITLE: p.title, POS: String(p.position), CHILDREN: p.hasChildren ? "yes" : "" })));
  });
}

function cmdWikiGet(flags: Record<string, string | boolean>, args: string[]): Effect.Effect<void, unknown, CliConfigService> {
  return Effect.gen(function* () {
    const { client } = yield* requireClient(flags);
    const slug = (typeof flags.project === "string" && flags.project) || "";
    const pageSlug = args[0]! || "";
    if (!slug || !pageSlug) { console.error("  Usage: lx wiki get <pageSlug> --project <slug>"); process.exit(1); }
    const page = yield* client.getWikiPage(slug, pageSlug);
    if (flags.json === true) { console.log(JSON.stringify(page, null, 2)); return; }
    console.log(`# ${page.title}`);
    console.log("");
    // Wiki content is TipTap JSON — render to Markdown so the CLI stays
    // human-readable.
    const { docToMarkdown } = yield* Effect.promise(() => import("../../shared/markdown"));
    const md = docToMarkdown(page.content as import("../../shared/types").TipTapDoc);
    console.log(md.trim() || "(empty page)");
  });
}

// Resolve a parent page slug → its page id (the API takes parentId, not slug).
function resolveWikiParent(client: LexaClient, slug: string, pageSlug: string): Effect.Effect<string, unknown, never> {
  return Effect.gen(function* () {
    const page = yield* client.getWikiPage(slug, pageSlug);
    return page.id;
  });
}

function cmdWikiCreate(flags: Record<string, string | boolean>): Effect.Effect<void, unknown, CliConfigService> {
  return Effect.gen(function* () {
    const { client } = yield* requireClient(flags);
    const slug = (typeof flags.project === "string" && flags.project) || "";
    const title = typeof flags.title === "string" ? flags.title : "";
    const pageSlug = typeof flags.slug === "string" ? flags.slug : undefined;
    const hasContent = typeof flags.content === "string";
    const parent = typeof flags.parent === "string" ? flags.parent : undefined;
    const emptyFlag = flags.slug === "" || flags.content === "" || flags.parent === "";
    if (!slug || !title || emptyFlag) {
      console.error("  Usage: lx wiki create --project <slug> --title <t> [--slug <s>] [--content <md>] [--parent <pageSlug>]");
      process.exit(1);
    }
    let content: unknown;
    if (hasContent) {
      const { markdownToDoc } = yield* Effect.promise(() => import("../../shared/markdown"));
      content = markdownToDoc(flags.content as string);
    }
    const parentId = parent ? yield* resolveWikiParent(client, slug, parent) : undefined;
    const page = yield* client.createWikiPage(slug, {
      title,
      ...(pageSlug !== undefined ? { slug: pageSlug } : {}),
      ...(hasContent ? { content } : {}),
      ...(parentId !== undefined ? { parentId } : {}),
    });
    console.log(`  Created page ${page.slug} — ${page.title}`);
  });
}

function cmdWikiUpdate(flags: Record<string, string | boolean>, args: string[]): Effect.Effect<void, unknown, CliConfigService> {
  return Effect.gen(function* () {
    const { client } = yield* requireClient(flags);
    const slug = (typeof flags.project === "string" && flags.project) || "";
    const pageSlug = args[0]! || "";
    const title = typeof flags.title === "string" ? flags.title : undefined;
    const newSlug = typeof flags.slug === "string" ? flags.slug : undefined;
    const hasContent = typeof flags.content === "string";
    const parent = typeof flags.parent === "string" ? flags.parent : undefined;
    const parentRoot = flags["parent-root"] === true;
    const hasPosition = flags.position !== undefined;
    const position = typeof flags.position === "string" && /^\d+$/.test(flags.position) ? Number(flags.position) : undefined;
    const usageMsg = "  Usage: lx wiki update <pageSlug> --project <slug> [--title <t>] [--slug <s>] [--content <md>] [--parent <pageSlug> | --parent-root] [--position <n>]";
    const emptyFlag = flags.title === "" || flags.slug === "" || flags.content === "" || flags.parent === "";
    const bad =
      !slug || !pageSlug ||
      emptyFlag ||
      (parent !== undefined && parentRoot) ||
      (hasPosition && position === undefined) ||
      (title === undefined && newSlug === undefined && !hasContent && parent === undefined && !parentRoot && !hasPosition);
    if (bad) { console.error(usageMsg); process.exit(1); }
    const input: { title?: string; slug?: string; content?: unknown; parentId?: string | null; position?: number } = {};
    if (title !== undefined) input.title = title;
    if (newSlug !== undefined) input.slug = newSlug;
    if (hasContent) {
      const { markdownToDoc } = yield* Effect.promise(() => import("../../shared/markdown"));
      input.content = markdownToDoc(flags.content as string);
    }
    if (parentRoot) input.parentId = null;
    else if (parent !== undefined) input.parentId = yield* resolveWikiParent(client, slug, parent);
    if (position !== undefined) input.position = position;
    const page = yield* client.updateWikiPage(slug, pageSlug, input);
    if (newSlug !== undefined && newSlug !== pageSlug) console.log(`  Updated page ${pageSlug} → ${page.slug} — ${page.title}`);
    else console.log(`  Updated page ${page.slug} — ${page.title}`);
  });
}

function cmdWikiDelete(flags: Record<string, string | boolean>, args: string[]): Effect.Effect<void, unknown, CliConfigService> {
  return Effect.gen(function* () {
    const { client } = yield* requireClient(flags);
    const slug = (typeof flags.project === "string" && flags.project) || "";
    const pageSlug = args[0]! || "";
    if (!slug || !pageSlug) { console.error("  Usage: lx wiki delete <pageSlug> --project <slug>"); process.exit(1); }
    yield* client.deleteWikiPage(slug, pageSlug);
    console.log(`  Deleted page ${pageSlug}`);
  });
}

function cmdGithubLink(flags: Record<string, string | boolean>, args: string[]): Effect.Effect<void, unknown, CliConfigService> {
  return Effect.gen(function* () {
    const { client } = yield* requireClient(flags);
    const slug = (typeof flags.project === "string" && flags.project) || "";
    const id = args[0]! || "";
    const repo = (typeof flags.repo === "string" && flags.repo) || "";
    if (!slug || !id || !repo) {
      console.error("  Usage: lx github link <id> --project <slug> --repo <owner/name>");
      process.exit(1);
    }
    const taskId = yield* resolveTaskId(id);
    yield* client.linkGithubIssue(slug, taskId, repo);
    console.log(`  Linked ${taskId} → ${repo}`);
  });
}

function cmdGithubLinkExisting(flags: Record<string, string | boolean>, args: string[]): Effect.Effect<void, unknown, CliConfigService> {
  return Effect.gen(function* () {
    const { client } = yield* requireClient(flags);
    const slug = (typeof flags.project === "string" && flags.project) || "";
    const id = args[0]! || "";
    const repo = (typeof flags.repo === "string" && flags.repo) || "";
    const issueRaw = flags.issue;
    const issue = typeof issueRaw === "string" && /^\d+$/.test(issueRaw) ? Number(issueRaw) : undefined;
    if (!slug || !id || !repo || issue === undefined) {
      console.error("  Usage: lx github link-existing <id> --project <slug> --repo <owner/name> --issue <n>");
      process.exit(1);
    }
    const taskId = yield* resolveTaskId(id);
    yield* client.linkExistingGithubIssue(slug, taskId, repo, issue);
    console.log(`  Linked ${taskId} → ${repo}#${issue}`);
  });
}

function cmdGithubUnlink(flags: Record<string, string | boolean>, args: string[]): Effect.Effect<void, unknown, CliConfigService> {
  return Effect.gen(function* () {
    const { client } = yield* requireClient(flags);
    const slug = (typeof flags.project === "string" && flags.project) || "";
    const id = args[0]! || "";
    const directIssueId = typeof flags["issue-id"] === "string" ? flags["issue-id"] : undefined;
    const repo = (typeof flags.repo === "string" && flags.repo) || "";
    const issueRaw = flags.issue;
    const issue = typeof issueRaw === "string" && /^\d+$/.test(issueRaw) ? Number(issueRaw) : undefined;
    const usageMsg = "  Usage: lx github unlink <id> --project <slug> ( --issue-id <nodeId> | --repo <owner/name> --issue <n> )";
    if (!slug || !id) { console.error(usageMsg); process.exit(1); }
    const taskId = yield* resolveTaskId(id);
    let issueId = directIssueId;
    if (!issueId) {
      if (!repo || issue === undefined) { console.error(usageMsg); process.exit(1); }
      // Address by repo+issueNumber: resolve the node id via the task's links.
      const task = yield* client.getTask(slug, taskId);
      const match = (task.githubs ?? []).find((g) => g.repo === repo && g.issueNumber === issue);
      if (!match) { console.error(`  No linked issue ${repo}#${issue} on ${id}.`); process.exit(1); }
      issueId = match.issueId;
    }
    yield* client.unlinkGithubIssue(slug, taskId, issueId);
    console.log(`  Unlinked ${taskId} (${issueId})`);
  });
}

// ── Project admin ──

function cmdProjectCreate(flags: Record<string, string | boolean>): Effect.Effect<void, unknown, CliConfigService> {
  return Effect.gen(function* () {
    const { client } = yield* requireClient(flags);
    const name = typeof flags.name === "string" ? flags.name : "";
    const slug = typeof flags.slug === "string" ? flags.slug : undefined;
    const description = typeof flags.description === "string" ? flags.description : undefined;
    const teamId = typeof flags.team === "string" ? flags.team : undefined;
    const emptyFlag = flags.slug === "" || flags.description === "" || flags.team === "";
    const bare = bareValueFlag(flags, ["slug", "description", "team"]);
    if (!name || bare || emptyFlag) {
      console.error("  Usage: lx project create --name <n> [--slug <s>] [--description <s>] [--team <teamId>]");
      process.exit(1);
    }
    const project = yield* client.createProject({
      name,
      ...(slug !== undefined ? { slug } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(teamId !== undefined ? { teamId } : {}),
    });
    console.log(`  Created project ${project.slug} — ${project.name}`);
  });
}

function cmdProjectUpdate(flags: Record<string, string | boolean>, args: string[]): Effect.Effect<void, unknown, CliConfigService> {
  return Effect.gen(function* () {
    const { client } = yield* requireClient(flags);
    const slug = args[0]! || "";
    const name = typeof flags.name === "string" ? flags.name : undefined;
    const description = typeof flags.description === "string" ? flags.description : undefined;
    const usageMsg = "  Usage: lx project update <slug> [--name <n>] [--description <s>]";
    const bad = !slug || name === "" || bareValueFlag(flags, ["name", "description"]) || (name === undefined && description === undefined);
    if (bad) { console.error(usageMsg); process.exit(1); }
    const input: { name?: string; description?: string } = {};
    if (name !== undefined) input.name = name;
    if (description !== undefined) input.description = description;
    const project = yield* client.updateProject(slug, input);
    console.log(`  Updated project ${project.slug} — ${project.name}`);
  });
}

function cmdProjectDelete(flags: Record<string, string | boolean>, args: string[]): Effect.Effect<void, unknown, CliConfigService> {
  return Effect.gen(function* () {
    const { client } = yield* requireClient(flags);
    const slug = args[0]! || "";
    if (!slug || flags.yes !== true) {
      console.error("  Usage: lx project delete <slug> --yes");
      process.exit(1);
    }
    yield* client.deleteProject(slug);
    console.log(`  Deleted project ${slug}`);
  });
}

// ── Column admin ──

// Shared parse of the `--required-fields` flag: undefined = absent, true =
// bare flag (bad), [] = cleared (`--required-fields=`), else comma-split.
function parseRequiredFields(raw: string | boolean | undefined): { bad: boolean; value: string[] | undefined } {
  if (raw === undefined) return { bad: false, value: undefined };
  if (typeof raw !== "string") return { bad: true, value: undefined };
  if (raw === "") return { bad: false, value: [] };
  return { bad: false, value: raw.split(",").map((s) => s.trim()).filter((s) => s !== "") };
}

function cmdColumnCreate(flags: Record<string, string | boolean>): Effect.Effect<void, unknown, CliConfigService> {
  return Effect.gen(function* () {
    const { client } = yield* requireClient(flags);
    const slug = (typeof flags.project === "string" && flags.project) || "";
    const name = typeof flags.name === "string" ? flags.name : "";
    const color = typeof flags.color === "string" ? flags.color : undefined;
    const hasWip = flags["wip-limit"] !== undefined;
    const wipRaw = flags["wip-limit"];
    const wipLimit = typeof wipRaw === "string" && /^\d+$/.test(wipRaw) ? Number(wipRaw) : undefined;
    const hasPosition = flags.position !== undefined;
    const position = typeof flags.position === "string" && /^\d+$/.test(flags.position) ? Number(flags.position) : undefined;
    const githubRaw = flags["github-state"];
    const githubState = githubRaw === "open" || githubRaw === "closed" ? githubRaw : undefined;
    const rf = parseRequiredFields(flags["required-fields"]);
    const usageMsg = "  Usage: lx column create --project <slug> --name <n> [--color <hex>] [--wip-limit <n>] [--required-fields <a,b,c>] [--github-state open|closed] [--position <n>]";
    const bad =
      !slug || !name || color === "" || color === "none" ||
      bareValueFlag(flags, ["name", "color", "wip-limit", "required-fields", "github-state", "position"]) ||
      (hasWip && wipLimit === undefined) ||
      (hasPosition && position === undefined) ||
      (flags["github-state"] !== undefined && githubState === undefined) ||
      rf.bad;
    if (bad) { console.error(usageMsg); process.exit(1); }
    const column = yield* client.createColumn(slug, {
      name,
      ...(color !== undefined ? { color } : {}),
      ...(wipLimit !== undefined ? { wipLimit } : {}),
      ...(rf.value !== undefined ? { requiredFields: rf.value } : {}),
      ...(githubState !== undefined ? { githubState } : {}),
      ...(position !== undefined ? { position } : {}),
    });
    console.log(`  Created column ${column.id} — ${column.name}`);
  });
}

function cmdColumnUpdate(flags: Record<string, string | boolean>, args: string[]): Effect.Effect<void, unknown, CliConfigService> {
  return Effect.gen(function* () {
    const { client } = yield* requireClient(flags);
    const slug = (typeof flags.project === "string" && flags.project) || "";
    const ref = args[0]! || "";
    const name = typeof flags.name === "string" ? flags.name : undefined;
    const color = typeof flags.color === "string" ? flags.color : undefined;
    const hasWip = flags["wip-limit"] !== undefined;
    const wipRaw = flags["wip-limit"];
    const wipNone = wipRaw === "none";
    const wipLimit = wipNone || (typeof wipRaw === "string" && /^\d+$/.test(wipRaw))
      ? (wipNone ? null : Number(wipRaw))
      : undefined;
    const hasPosition = flags.position !== undefined;
    const position = typeof flags.position === "string" && /^\d+$/.test(flags.position) ? Number(flags.position) : undefined;
    const githubRaw = flags["github-state"];
    const githubState = githubRaw === "none" ? null : githubRaw === "open" || githubRaw === "closed" ? githubRaw : undefined;
    const rf = parseRequiredFields(flags["required-fields"]);
    const hasDone = flags.done !== undefined;
    const done = parseBool(typeof flags.done === "string" ? flags.done : undefined);
    const usageMsg = "  Usage: lx column update <ref> --project <slug> [--name <n>] [--color <hex>] [--wip-limit <n|none>] [--required-fields <a,b,c>|--required-fields=] [--github-state open|closed|none] [--done true|false] [--position <n>]";
    const bad =
      !slug || !ref || name === "" || color === "" || color === "none" ||
      bareValueFlag(flags, ["name", "color", "wip-limit", "required-fields", "github-state", "position"]) ||
      (hasWip && wipLimit === undefined) ||
      (flags["github-state"] !== undefined && githubState === undefined) ||
      rf.bad ||
      (hasPosition && position === undefined) ||
      (hasDone && done === undefined) ||
      (name === undefined && color === undefined && !hasWip && flags["required-fields"] === undefined && flags["github-state"] === undefined && !hasDone && !hasPosition);
    if (bad) { console.error(usageMsg); process.exit(1); }
    const input: { name?: string; position?: number; color?: string; wipLimit?: number | null; requiredFields?: string[]; githubState?: "open" | "closed" | null; isDone?: boolean } = {};
    if (name !== undefined) input.name = name;
    if (color !== undefined) input.color = color;
    if (hasWip) input.wipLimit = wipLimit!;
    if (rf.value !== undefined) input.requiredFields = rf.value;
    if (githubState !== undefined) input.githubState = githubState;
    if (done !== undefined) input.isDone = done;
    if (position !== undefined) input.position = position;
    const column = yield* resolveColumn(client, slug, ref);
    const updated = yield* client.updateColumn(slug, column.id, input);
    console.log(`  Updated column ${updated.id} — ${updated.name}`);
  });
}

function cmdColumnDelete(flags: Record<string, string | boolean>, args: string[]): Effect.Effect<void, unknown, CliConfigService> {
  return Effect.gen(function* () {
    const { client } = yield* requireClient(flags);
    const slug = (typeof flags.project === "string" && flags.project) || "";
    const ref = args[0]! || "";
    if (!slug || !ref) { console.error("  Usage: lx column delete <ref> --project <slug>"); process.exit(1); }
    const column = yield* resolveColumn(client, slug, ref);
    yield* client.deleteColumn(slug, column.id);
    console.log(`  Deleted column ${column.id} — ${column.name}`);
  });
}

// ── Swimlane admin ──

function cmdSwimlaneCreate(flags: Record<string, string | boolean>): Effect.Effect<void, unknown, CliConfigService> {
  return Effect.gen(function* () {
    const { client } = yield* requireClient(flags);
    const slug = (typeof flags.project === "string" && flags.project) || "";
    const name = typeof flags.name === "string" ? flags.name : "";
    const description = typeof flags.description === "string" && flags.description ? flags.description : undefined;
    const hasDue = flags.due !== undefined;
    const due = typeof flags.due === "string" ? flags.due : undefined;
    const hasStart = flags.start !== undefined;
    const start = typeof flags.start === "string" ? flags.start : undefined;
    const msRef = typeof flags.milestone === "string" ? flags.milestone : undefined;
    const hasPosition = flags.position !== undefined;
    const position = typeof flags.position === "string" && /^\d+$/.test(flags.position) ? Number(flags.position) : undefined;
    const usageMsg = "  Usage: lx swimlane create --project <slug> --name <n> [--description <s>] [--due <date>] [--start <date>] [--milestone <id|name>] [--position <n>]";
    const bad =
      !slug || !name ||
      bareValueFlag(flags, ["name", "description", "due", "start", "milestone", "position"]) ||
      (hasDue && (due === undefined || !DATE_RE.test(due))) ||
      (hasStart && (start === undefined || !DATE_RE.test(start))) ||
      flags.milestone === true || msRef === "" ||
      (hasPosition && position === undefined);
    if (bad) { console.error(usageMsg); process.exit(1); }
    const milestoneId = msRef !== undefined ? yield* resolveMilestone(client, slug, msRef) : undefined;
    const lane = yield* client.createSwimlane(slug, {
      name,
      ...(description !== undefined ? { description } : {}),
      ...(due !== undefined ? { dueAt: due } : {}),
      ...(start !== undefined ? { startAt: start } : {}),
      ...(milestoneId !== undefined ? { milestoneId } : {}),
      ...(position !== undefined ? { position } : {}),
    });
    console.log(`  Created swimlane ${lane.id} — ${lane.name}`);
  });
}

function cmdSwimlaneUpdate(flags: Record<string, string | boolean>, args: string[]): Effect.Effect<void, unknown, CliConfigService> {
  return Effect.gen(function* () {
    const { client } = yield* requireClient(flags);
    const slug = (typeof flags.project === "string" && flags.project) || "";
    const ref = args[0]! || "";
    const name = typeof flags.name === "string" ? flags.name : undefined;
    const hasDescription = typeof flags.description === "string";
    const hasDue = flags.due !== undefined;
    const dueRaw = typeof flags.due === "string" ? flags.due : undefined;
    const due = noneIf(dueRaw);
    const hasStart = flags.start !== undefined;
    const startRaw = typeof flags.start === "string" ? flags.start : undefined;
    const start = noneIf(startRaw);
    const msRaw = typeof flags.milestone === "string" ? flags.milestone : undefined;
    const ms = noneIf(msRaw);
    const hasPosition = flags.position !== undefined;
    const position = typeof flags.position === "string" && /^\d+$/.test(flags.position) ? Number(flags.position) : undefined;
    const usageMsg = "  Usage: lx swimlane update <ref> --project <slug> [--name <n>] [--description <s>] [--due <date|none>] [--start <date|none>] [--milestone <id|name|none>] [--position <n>]";
    const bad =
      !slug || !ref || name === "" ||
      bareValueFlag(flags, ["name", "description", "due", "start", "milestone", "position"]) ||
      (hasDue && !(due === null || (typeof due === "string" && DATE_RE.test(due)))) ||
      (hasStart && !(start === null || (typeof start === "string" && DATE_RE.test(start)))) ||
      flags.milestone === true || msRaw === "" ||
      (hasPosition && position === undefined) ||
      (name === undefined && !hasDescription && !hasDue && !hasStart && flags.milestone === undefined && !hasPosition);
    if (bad) { console.error(usageMsg); process.exit(1); }
    const input: { name?: string; description?: string; position?: number; dueAt?: string | null; startAt?: string | null; milestoneId?: string | null } = {};
    if (name !== undefined) input.name = name;
    if (hasDescription) input.description = flags.description as string;
    if (hasDue) input.dueAt = due!;
    if (hasStart) input.startAt = start!;
    if (ms !== undefined) input.milestoneId = ms === null ? null : yield* resolveMilestone(client, slug, ms);
    if (position !== undefined) input.position = position;
    const lane = yield* resolveSwimlane(client, slug, ref);
    const updated = yield* client.updateSwimlane(slug, lane.id, input);
    console.log(`  Updated swimlane ${updated.id} — ${updated.name}`);
  });
}

function cmdSwimlaneDelete(flags: Record<string, string | boolean>, args: string[]): Effect.Effect<void, unknown, CliConfigService> {
  return Effect.gen(function* () {
    const { client } = yield* requireClient(flags);
    const slug = (typeof flags.project === "string" && flags.project) || "";
    const ref = args[0]! || "";
    if (!slug || !ref) { console.error("  Usage: lx swimlane delete <ref> --project <slug>"); process.exit(1); }
    const lane = yield* resolveSwimlane(client, slug, ref);
    yield* client.deleteSwimlane(slug, lane.id);
    console.log(`  Deleted swimlane ${lane.id} — ${lane.name}`);
  });
}

// ── Field config ──

function cmdFieldConfigGet(flags: Record<string, string | boolean>): Effect.Effect<void, unknown, CliConfigService> {
  return Effect.gen(function* () {
    const { client } = yield* requireClient(flags);
    const slug = (typeof flags.project === "string" && flags.project) || "";
    if (!slug) { console.error("  Usage: lx field-config get --project <slug> [--json]"); process.exit(1); }
    const config = yield* client.getFieldConfig(slug);
    if (flags.json === true) { console.log(JSON.stringify(config, null, 2)); return; }
    console.log("Priorities:");
    printTable(config.priorities.map((p) => ({ POS: String(p.position), LABEL: p.label, COLOR: p.color, ID: p.id })));
    console.log("Types:");
    printTable(config.types.map((t) => ({ POS: String(t.position), LABEL: t.label, COLOR: t.color, ID: t.id })));
  });
}

function cmdFieldConfigPut(flags: Record<string, string | boolean>): Effect.Effect<void, unknown, CliConfigService> {
  return Effect.gen(function* () {
    const { client } = yield* requireClient(flags);
    const slug = (typeof flags.project === "string" && flags.project) || "";
    const file = typeof flags.file === "string" ? flags.file : "";
    if (!slug || !file || bareValueFlag(flags, ["file"])) { console.error("  Usage: lx field-config put --project <slug> --file <path|->"); process.exit(1); }
    const read = yield* Effect.promise(() => readJsonFileSafe(file));
    if (!read.ok) {
      console.error(`  Failed to read ${file}: ${read.msg}`);
      process.exit(1);
    }
    const parsed = ((): { ok: true; value: import("./api").FieldConfigInput } | { ok: false; msg: string } => {
      try {
        return { ok: true, value: JSON.parse(read.text) as import("./api").FieldConfigInput };
      } catch (e) {
        return { ok: false, msg: (e as Error).message };
      }
    })();
    if (!parsed.ok) {
      console.error(`  Invalid JSON in ${file}: ${parsed.msg}`);
      process.exit(1);
    }
    const config = yield* client.putFieldConfig(slug, parsed.value);
    console.log(`  Updated field-config (priorities: ${config.priorities.length}, types: ${config.types.length})`);
  });
}

// ── Settings ──

function cmdSettingsRateLimit(flags: Record<string, string | boolean>, args: string[]): Effect.Effect<void, unknown, CliConfigService> {
  return Effect.gen(function* () {
    const { client } = yield* requireClient(flags);
    const action = args[0]! || "";
    if (action === "get") {
      const r = yield* client.getRateLimit();
      console.log(`  max:      ${r.max}`);
      console.log(`  windowMs: ${r.windowMs}`);
      return;
    }
    if (action === "set") {
      const maxRaw = typeof flags.max === "string" ? flags.max : undefined;
      const winRaw = typeof flags["window-min"] === "string" ? flags["window-min"] : undefined;
      const max = maxRaw !== undefined && /^\d+$/.test(maxRaw) ? Number(maxRaw) : undefined;
      const windowMin = winRaw !== undefined && /^\d+$/.test(winRaw) ? Number(winRaw) : undefined;
      if (max === undefined || windowMin === undefined || bareValueFlag(flags, ["max", "window-min"])) {
        console.error("  Usage: lx settings rate-limit set --max <n> --window-min <m>");
        process.exit(1);
      }
      const r = yield* client.putRateLimit({ max, windowMs: windowMin * 60_000 });
      console.log(`  Updated rate-limit (max: ${r.max}, windowMs: ${r.windowMs})`);
      return;
    }
    console.error("  Usage: lx settings rate-limit <get|set> [--max <n> --window-min <m>]");
    process.exit(1);
  });
}

function cmdSettingsApiKeys(flags: Record<string, string | boolean>, args: string[]): Effect.Effect<void, unknown, CliConfigService> {
  return Effect.gen(function* () {
    const { client } = yield* requireClient(flags);
    const action = args[0]! || "";
    if (action === "list") {
      const keys = yield* client.listSettingsApiKeys();
      if (keys.length === 0) { console.log("  No API keys."); return; }
      printTable(keys.map((k) => ({ ID: k.id, NAME: k.name, CREATED: k.createdAt, LAST_USED: k.lastUsedAt ?? "—" })));
      return;
    }
    if (action === "create") {
      const name = typeof flags.name === "string" ? flags.name : "";
      if (!name || bareValueFlag(flags, ["name"])) { console.error("  Usage: lx settings api-keys create --name <n>"); process.exit(1); }
      const result = yield* client.createSettingsApiKey({ name });
      console.log(`  Created API key ${result.key.id} — ${result.key.name}`);
      console.log(`  Raw key (shown once): ${result.rawKey}`);
      return;
    }
    if (action === "revoke") {
      const id = args[1]! || "";
      if (!id) { console.error("  Usage: lx settings api-keys revoke <id>"); process.exit(1); }
      yield* client.revokeSettingsApiKey(id);
      console.log(`  Revoked API key ${id}`);
      return;
    }
    console.error("  Usage: lx settings api-keys <list|create|revoke> [--name <n>|<id>]");
    process.exit(1);
  });
}

// ── main ──

const HELP = `lx — Lexa operator CLI

Usage: lx <command> [options]

Auth:
  login    [<url>] [--url <base>] [--key <lxk_...>]
                                           save credentials (chmod 600); without
                                           --key: browser-approval device login
                                           (prints a link to approve)
  logout   [--url <base>] [--all]        remove saved credentials (active host
                                           by default; --all clears every login)
  status                                 server health + auth + counts

Tasks:
  task list    --project <slug> [--limit N] [--json]
  task create  --project <slug> --column <name> --swimlane <name> --title <t> [--description <md>]
  task get     <id> --project <slug> [--json]
  task move    <id> --project <slug> --column <name|id> [--swimlane <name|id>]
               [--before <id|PREFIX-N>] [--after <id|PREFIX-N>] [--clear-due]
  task update  <id> --project <slug> [--title <t>] [--description <md>] [--priority <id>] [--type <id>]
               [--assignees <a,b> | --assignees=] [--due <YYYY-MM-DD>] [--clear-due]
  task delete  <id> --project <slug>

Planning:
  column list      --project <slug> [--json]
  column create    --project <slug> --name <n> [--color <hex>] [--wip-limit <n>]
                   [--required-fields <a,b,c>] [--github-state open|closed] [--position <n>]
  column update    <ref> --project <slug> [--name <n>] [--color <hex>] [--wip-limit <n|none>]
                   [--required-fields <a,b,c>|--required-fields=] [--github-state open|closed|none]
                   [--done true|false] [--position <n>]
  column delete    <ref> --project <slug>
  swimlane list    --project <slug> [--json]
  swimlane create  --project <slug> --name <n> [--description <s>] [--due <date>] [--start <date>]
                   [--milestone <id|name>] [--position <n>]
  swimlane update  <ref> --project <slug> [--name <n>] [--description <s>] [--due <date|none>]
                   [--start <date|none>] [--milestone <id|name|none>] [--position <n>]
  swimlane delete  <ref> --project <slug>
  milestone list   --project <slug> [--json]
  milestone create --project <slug> --name <n> [--description <s>] [--due <YYYY-MM-DD>]
  milestone update <ref> --project <slug> [--name <n>] [--description <s>]
                   [--due <YYYY-MM-DD>|--clear-due] [--position <n>]

Field config:
  field-config get --project <slug> [--json]
  field-config put --project <slug> --file <path|->

Settings (admin):
  settings rate-limit get
  settings rate-limit set --max <n> --window-min <m>
  settings api-keys list
  settings api-keys create --name <n>
  settings api-keys revoke <id>

Wiki:
  wiki list   --project <slug> [--json]
  wiki get    <pageSlug> --project <slug> [--json]
  wiki create --project <slug> --title <t> [--slug <s>] [--content <md>] [--parent <pageSlug>]
  wiki update <pageSlug> --project <slug> [--title <t>] [--slug <s>] [--content <md>]
              [--parent <pageSlug> | --parent-root] [--position <n>]
  wiki delete <pageSlug> --project <slug>

Projects:
  project list [--json]
  project create --name <n> [--slug <s>] [--description <s>] [--team <teamId>]
  project update <slug> [--name <n>] [--description <s>]
  project delete <slug> --yes

GitHub sync (optional integration):
  github status                        read the LIVE server state (needs
                                       login; the server DB is the source of
                                       truth; GitHub config is managed in the
                                       web app: Settings → Workspace →
                                       Integrations → GitHub Sync)
  github setup                         configure App ID + PEM + webhook secret
                                       via the server API — applied
                                       immediately, REPLACES the current server
                                       values like web Settings (needs login;
                                       --app-id, --pem-file, --webhook-secret
                                       for non-interactive runs)
  github check <slug> <owner/repo>     acceptance round-trip against the live
                                       server (creates a real issue; needs
                                       login)
  github link <id> --project <slug> --repo <owner/name>
                                       create a GitHub issue from the task and
                                       link it (needs login)
  github link-existing <id> --project <slug> --repo <owner/name> --issue <n>
                                       link an existing GitHub issue to the task
                                       (needs login)
  github unlink <id> --project <slug> ( --issue-id <nodeId> | --repo <owner/name> --issue <n> )
                                       unlink a GitHub issue from the task
                                       (needs login)

Workers (self-hosted):
  worker upgrade [--dir <cf-workers>] [--worker <name>] [--cf-token <tok>]
                 [--version <tag>] [--dry-run] [--yes] [--force]
                                           update a Cloudflare Workers deploy:
                                           fetch + verify the release, preserve
                                           custody/bindings, back up the deploy
                                           dir, apply pending D1 migrations,
                                           deploy, roll back on failure (run
                                           from your cf-workers/ custody dir)

Upgrade:
  upgrade                                self-update the CLI binary (GitHub release)

Skill:
  skill install [--global | --local] [--force]
                                           install the lexa-cli agent skill into
                                           ~/.agents/skills (--global) or
                                           ./.agents/skills (--local); prompts
                                           when neither is given; --force
                                           overwrites an existing file

Env fallbacks: LEXA_URL, LEXA_API_KEY. Flags override saved login.
`;

const GROUP_HELP: Record<string, string> = {
  project: `Projects:
  project list [--json]
  project create --name <n> [--slug <s>] [--description <s>] [--team <teamId>]
  project update <slug> [--name <n>] [--description <s>]
  project delete <slug> --yes`,
  task: `Tasks:
  task list    --project <slug> [--limit N] [--json]
  task create  --project <slug> --column <name> --swimlane <name> --title <t> [--description <md>]
  task get     <id> --project <slug> [--json]
  task move    <id> --project <slug> --column <name|id> [--swimlane <name|id>]
               [--before <id|PREFIX-N>] [--after <id|PREFIX-N>] [--clear-due]
  task update  <id> --project <slug> [--title <t>] [--description <md>] [--priority <id>] [--type <id>]
               [--assignees <a,b> | --assignees=] [--due <YYYY-MM-DD>] [--clear-due]
  task delete  <id> --project <slug>`,
  column: `Planning:
  column list   --project <slug> [--json]
  column create --project <slug> --name <n> [--color <hex>] [--wip-limit <n>]
                [--required-fields <a,b,c>] [--github-state open|closed] [--position <n>]
  column update <ref> --project <slug> [--name <n>] [--color <hex>] [--wip-limit <n|none>]
                [--required-fields <a,b,c>|--required-fields=] [--github-state open|closed|none]
                [--done true|false] [--position <n>]
  column delete <ref> --project <slug>`,
  swimlane: `Planning:
  swimlane list   --project <slug> [--json]
  swimlane create --project <slug> --name <n> [--description <s>] [--due <date>] [--start <date>]
                  [--milestone <id|name>] [--position <n>]
  swimlane update <ref> --project <slug> [--name <n>] [--description <s>] [--due <date|none>]
                  [--start <date|none>] [--milestone <id|name|none>] [--position <n>]
  swimlane delete <ref> --project <slug>`,
  "field-config": `Field config:
  field-config get --project <slug> [--json]
  field-config put --project <slug> --file <path|->`,
  settings: `Settings (admin):
  settings rate-limit get
  settings rate-limit set --max <n> --window-min <m>
  settings api-keys list
  settings api-keys create --name <n>
  settings api-keys revoke <id>`,
  milestone: `Planning:
  milestone list   --project <slug> [--json]
  milestone create --project <slug> --name <n> [--description <s>] [--due <YYYY-MM-DD>]
  milestone update <ref> --project <slug> [--name <n>] [--description <s>]
                   [--due <YYYY-MM-DD>|--clear-due] [--position <n>]`,
  wiki: `Wiki:
  wiki list   --project <slug> [--json]
  wiki get    <pageSlug> --project <slug> [--json]
  wiki create --project <slug> --title <t> [--slug <s>] [--content <md>] [--parent <pageSlug>]
  wiki update <pageSlug> --project <slug> [--title <t>] [--slug <s>] [--content <md>]
              [--parent <pageSlug> | --parent-root] [--position <n>]
  wiki delete <pageSlug> --project <slug>`,
  github: `GitHub sync (optional integration):
  github status                        read the LIVE server state (needs
                                       login; the server DB is the source of
                                       truth; GitHub config is managed in the
                                       web app: Settings → Workspace →
                                       Integrations → GitHub Sync)
  github setup                         configure App ID + PEM + webhook secret
                                       via the server API — applied
                                       immediately, REPLACES the current server
                                       values like web Settings (needs login;
                                       --app-id, --pem-file, --webhook-secret
                                       for non-interactive runs)
  github check <slug> <owner/repo>     Lexa→GitHub acceptance round-trip
                                       against the live server (creates a real
                                       issue; needs login)
  github link <id> --project <slug> --repo <owner/name>
                                       create a GitHub issue from the task and
                                       link it (needs login)
  github link-existing <id> --project <slug> --repo <owner/name> --issue <n>
                                       link an existing GitHub issue to the task
                                       (needs login)
  github unlink <id> --project <slug> ( --issue-id <nodeId> | --repo <owner/name> --issue <n> )
                                       unlink a GitHub issue from the task
                                       (needs login)`,

  worker: `Workers (self-hosted):
  worker upgrade [--dir <cf-workers>] [--worker <name>] [--cf-token <tok>]
                 [--version <tag>] [--dry-run] [--yes] [--force]
                                           update a Cloudflare Workers deploy:
                                           fetch + verify the release, preserve
                                           custody/bindings, back up the deploy
                                           dir, apply pending D1 migrations,
                                           deploy, roll back on failure (run
                                           from your cf-workers/ custody dir)`,
  upgrade: `Upgrade:
  upgrade                                        self-update the CLI binary (GitHub release)`,
  skill: `Skill:
  skill install [--global | --local] [--force]
                                           install the lexa-cli agent skill into
                                           ~/.agents/skills (--global) or
                                           ./.agents/skills (--local); prompts
                                           when neither is given; --force
                                           overwrites an existing file`,
};

function usage(cmd: string, sub: string): never {
  if (sub !== "") console.error(`  Unknown: ${cmd} ${sub}`);
  console.log(GROUP_HELP[cmd] ?? HELP);
  process.exit(sub === "" ? 0 : 1);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0]! === "--help" || argv[0]! === "-h" || argv[0]! === "help") {
    console.log(HELP);
    return;
  }
  if (argv[0]! === "--version" || argv[0]! === "-v" || argv[0]! === "version") {
    console.log(`lx ${CLI_VERSION}`);
    return;
  }
  // One-shot host-keyed migration (legacy flavor roots → groups), before any
  // command dispatches. No-op when LEXA_DIR is set or no legacy roots exist.
  migrateFlavorRootsSync();
  const { positionals, flags } = parseArgs(argv);
  const cmd = positionals[0]!;
  const sub = positionals[1]! ?? "";
  const rest = positionals.slice(2);

  let program: Effect.Effect<unknown, unknown, CliConfigService> | null = null;
  let prefix = "Failed";

  switch (cmd) {
    case "login": program = cmdLogin(flags, positionals); prefix = "Login failed"; break;
    case "logout": program = cmdLogout(flags); break;
    case "status": program = cmdStatus(flags); prefix = "Status check failed"; break;
    case "upgrade":
      if (sub !== "") usage("upgrade", sub);
      program = cmdUpgradeCli(); break;

    case "github":
      switch (sub) {
        case "status":
          program = Effect.gen(function* () {
            if (envFlagsRemoved(flags)) {
              yield* cmdGithubStatus(flags, null);
              return;
            }
            const { client } = yield* requireClient(flags);
            yield* cmdGithubStatus(flags, client);
          });
          break;
        case "setup":
          program = Effect.gen(function* () {
            if (envFlagsRemoved(flags)) {
              yield* cmdGithubSetup(flags, null);
              return;
            }
            const { client } = yield* requireClient(flags);
            yield* cmdGithubSetup(flags, client);
          });
          break;
        case "check":
          program = Effect.gen(function* () {
            const { client } = yield* requireClient(flags);
            yield* cmdGithubCheck(client, flags, rest);
          });
          break;
        case "link": program = cmdGithubLink(flags, rest); break;
        case "link-existing": program = cmdGithubLinkExisting(flags, rest); break;
        case "unlink": program = cmdGithubUnlink(flags, rest); break;
        default: usage("github", sub);
      }
      break;

    case "project":
      switch (sub) {
        case "list": program = cmdProjectList(flags); break;
        case "create": program = cmdProjectCreate(flags); break;
        case "update": program = cmdProjectUpdate(flags, rest); break;
        case "delete": program = cmdProjectDelete(flags, rest); break;
        default: usage("project", sub);
      }
      break;

    case "task":
      switch (sub) {
        case "list": program = cmdTaskList(flags, rest); break;
        case "create": program = cmdTaskCreate(flags); break;
        case "get": program = cmdTaskGet(flags, rest); break;
        case "move": program = cmdTaskMove(flags, rest); break;
        case "update": program = cmdTaskUpdate(flags, rest); break;
        case "delete": program = cmdTaskDelete(flags, rest); break;
        default: usage("task", sub);
      }
      break;

    case "column":
      switch (sub) {
        case "list": program = cmdColumnList(flags); break;
        case "create": program = cmdColumnCreate(flags); break;
        case "update": program = cmdColumnUpdate(flags, rest); break;
        case "delete": program = cmdColumnDelete(flags, rest); break;
        default: usage("column", sub);
      }
      break;

    case "swimlane":
      switch (sub) {
        case "list": program = cmdSwimlaneList(flags); break;
        case "create": program = cmdSwimlaneCreate(flags); break;
        case "update": program = cmdSwimlaneUpdate(flags, rest); break;
        case "delete": program = cmdSwimlaneDelete(flags, rest); break;
        default: usage("swimlane", sub);
      }
      break;

    case "field-config":
      switch (sub) {
        case "get": program = cmdFieldConfigGet(flags); break;
        case "put": program = cmdFieldConfigPut(flags); break;
        default: usage("field-config", sub);
      }
      break;

    case "settings":
      switch (sub) {
        case "rate-limit": program = cmdSettingsRateLimit(flags, rest); break;
        case "api-keys": program = cmdSettingsApiKeys(flags, rest); break;
        default: usage("settings", sub);
      }
      break;

    case "milestone":
      switch (sub) {
        case "list": program = cmdMilestoneList(flags); break;
        case "create": program = cmdMilestoneCreate(flags); break;
        case "update": program = cmdMilestoneUpdate(flags, rest); break;
        default: usage("milestone", sub);
      }
      break;

    case "wiki":
      switch (sub) {
        case "list": program = cmdWikiList(flags); break;
        case "get": program = cmdWikiGet(flags, rest); break;
        case "create": program = cmdWikiCreate(flags); break;
        case "update": program = cmdWikiUpdate(flags, rest); break;
        case "delete": program = cmdWikiDelete(flags, rest); break;
        default: usage("wiki", sub);
      }
      break;

    case "worker":
      switch (sub) {
        case "upgrade": program = cmdWorkerUpgrade(flags); break;
        default: usage("worker", sub);
      }
      break;

    case "skill":
      switch (sub) {
        case "install":
          // Lazy so the embedded SKILL.md text import stays out of the module
          // graph that imports index.ts without running the CLI.
          program = Effect.gen(function* () {
            const { cmdSkillInstall } = yield* Effect.promise(() => import("./skill"));
            yield* cmdSkillInstall(flags);
          });
          break;
        default: usage("skill", sub);
      }
      break;

    default:
      console.error(`  Unknown command: ${cmd}`);
      console.log(HELP);
      process.exit(1);
  }

  if (!program) usage("", "");
  await runCommand(prefix, program as Effect.Effect<unknown, unknown, CliConfigService>);
  // Explicit exit: bun keeps a read interest on TTY stdin after interactive
  // prompts, which would otherwise keep the event loop alive forever.
  process.exit(0);
}

// import.meta.main is bun-only (true for the entry script, undefined under
// node) — the guard keeps the module importable for tests without running the
// CLI. Shipped behavior is unchanged: bun executes main when run directly.
if (import.meta.main) {
  main().catch((e) => {
    console.error("  lx error:", (e as Error).message);
    process.exit(1);
  });
}
