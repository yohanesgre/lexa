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
import { LexaClient, ApiError } from "./api";
import { CliConfigService, groupDir, migrateFlavorRootsSync, type CliConfig } from "./config";
import { cmdGithubStatus, cmdGithubSetup, cmdGithubCheck } from "./github";
import { cmdUpgradeCli } from "./upgrade";
import { CLI_VERSION } from "./version";
import { hostname as osHostname } from "node:os";

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

// Resolve the active config: flags > env > saved login. The saved login
// lives in the group of its server URL; without a URL hint the state root
// is scanned for the first saved login (one login per machine is the norm).
function resolveConfig(flags: Record<string, string | boolean>): Effect.Effect<CliConfig | null, never, CliConfigService> {
  return Effect.gen(function* () {
    const svc = yield* CliConfigService;
    const urlFlag = ((typeof flags.url === "string" && flags.url) || ENV_URL || "").replace(/\/+$/, "");
    const saved = urlFlag ? yield* svc.loadConfig(groupDir(urlFlag)) : yield* svc.savedLogin();
    const url = urlFlag || saved?.url || "";
    const apiKey = (typeof flags.key === "string" && flags.key) || ENV_KEY || saved?.apiKey || "";
    if (!url || !apiKey) return null;
    return { url, apiKey };
  });
}

function requireClient(flags: Record<string, string | boolean>): Effect.Effect<{ client: LexaClient; config: CliConfig }, NotLoggedIn, CliConfigService> {
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

// Interactive prompts — only ever used when stdin is a TTY and the login
// flags were omitted. Scripts and pipes never prompt.
// Plain line reading in cooked mode (no readline): the terminal driver
// handles echo and backspace, so there is no raw mode, no ANSI cursor
// queries, and nothing that can hang on a real terminal.
// Resolves null on EOF (Ctrl-D) so callers can distinguish a cancel from an
// empty line (an empty answer must re-prompt, not default).
function promptLogin(question: string): Promise<string | null> {
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

const DEVICE_POLL_INTERVAL_MS = 2000;
const DEVICE_POLL_TIMEOUT_MS = 5 * 60 * 1000;

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
    const deadline = Date.now() + DEVICE_POLL_TIMEOUT_MS;
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
        console.log(`  New API key: ${result.keyName}`);
        console.log(`  Logged in as ${result.approverName ?? "unknown"}`);
        console.log(`  Logged in to ${url}`);
        return;
      }
      yield* Effect.sleep(DEVICE_POLL_INTERVAL_MS);
    }
    console.error("  Login request timed out after 5 minutes — nobody approved it. Try again.");
    process.exit(1);
  });
}

function cmdLogin(flags: Record<string, string | boolean>, positionals: string[]): Effect.Effect<void, unknown, CliConfigService> {
  return Effect.gen(function* () {
    const svc = yield* CliConfigService;
    // --url flag beats a positional URL (`login <url>`); env stays last.
    let url = ((typeof flags.url === "string" && flags.url) || positionals[1] || ENV_URL || "").replace(/\/+$/, "");
    const key = (typeof flags.key === "string" && flags.key) || ENV_KEY || "";
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
      console.log(`  Logged in to ${url}`);
      return;
    }
    // No key → device login: browser-approval pairing on the same server.
    yield* deviceLoginFlow(url);
  });
}

function cmdLogout(flags: Record<string, string | boolean>): Effect.Effect<void, never, CliConfigService> {
  return Effect.gen(function* () {
    const svc = yield* CliConfigService;
    const urlFlag = ((typeof flags.url === "string" && flags.url) || ENV_URL || "").replace(/\/+$/, "");
    const saved = urlFlag ? null : yield* svc.savedLogin();
    const url = urlFlag || saved?.url || "";
    if (!url) {
      console.log("  Not logged in — nothing to remove.");
      return;
    }
    yield* svc.clearConfig(groupDir(url));
  });
}

function cmdStatus(flags: Record<string, string | boolean>): Effect.Effect<void, unknown, CliConfigService> {
  return Effect.gen(function* () {
    const { client } = yield* requireClient(flags);
    const h = yield* client.health();
    const projects = yield* client.listProjects();
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

// Resolve a column/swimlane/milestone name (or id) → id for the target
// project. Exact id match wins, else case-insensitive exact name; a miss
// prints the available names (existing style) and exits.
function resolveColumn(client: LexaClient, slug: string, name: string): Effect.Effect<string, unknown, never> {
  return Effect.gen(function* () {
    const cols = yield* client.listColumns(slug);
    const found = cols.find((c) => c.id === name) ?? cols.find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (!found) {
      console.error(`  Column "${name}" not found. Available: ${cols.map((c) => c.name).join(", ")}`);
      process.exit(1);
    }
    return found.id;
  });
}
function resolveSwimlane(client: LexaClient, slug: string, name: string): Effect.Effect<string, unknown, never> {
  return Effect.gen(function* () {
    const lanes = yield* client.listSwimlanes(slug);
    const found = lanes.find((l) => l.id === name) ?? lanes.find((l) => l.name.toLowerCase() === name.toLowerCase());
    if (!found) {
      console.error(`  Swimlane "${name}" not found. Available: ${lanes.map((l) => l.name).join(", ")}`);
      process.exit(1);
    }
    return found.id;
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
    const columnId = yield* resolveColumn(client, slug, column);
    const swimlaneId = yield* resolveSwimlane(client, slug, swimlane);
    let descriptionDoc: unknown;
    if (description) {
      const { markdownToDoc } = yield* Effect.promise(() => import("../../shared/markdown"));
      descriptionDoc = markdownToDoc(description);
    }
    const task = yield* client.createTask(slug, { columnId, swimlaneId, title, description: descriptionDoc });
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
    const columnId = yield* resolveColumn(client, slug, column);
    const taskId = yield* resolveTaskId(id);
    // Every task belongs to a swimlane (swimlane_id NOT NULL) — only a
    // user-supplied --swimlane changes it; otherwise keep the task's current
    // lane. Sending "" would fail the FK.
    const swimlaneId = swimlane
      ? yield* resolveSwimlane(client, slug, swimlane)
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

// ── main ──

const HELP = `lx — Lexa operator CLI

Usage: lx <command> [options]

Auth:
  login    [<url>] [--url <base>] [--key <lxk_...>]
                                           save credentials (chmod 600); without
                                           --key: browser-approval device login
                                           (prints a link to approve)
  logout                                 remove saved credentials
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
  swimlane list    --project <slug> [--json]
  milestone list   --project <slug> [--json]
  milestone create --project <slug> --name <n> [--description <s>] [--due <YYYY-MM-DD>]
  milestone update <ref> --project <slug> [--name <n>] [--description <s>]
                   [--due <YYYY-MM-DD>|--clear-due] [--position <n>]

Wiki:
  wiki list   --project <slug> [--json]
  wiki get    <pageSlug> --project <slug> [--json]
  wiki create --project <slug> --title <t> [--slug <s>] [--content <md>] [--parent <pageSlug>]
  wiki update <pageSlug> --project <slug> [--title <t>] [--slug <s>] [--content <md>]
              [--parent <pageSlug> | --parent-root] [--position <n>]
  wiki delete <pageSlug> --project <slug>

Projects:
  project list [--json]

GitHub sync (optional integration):
  github status [--local] [--env-file <path>]
                                       read the LIVE server state (default;
                                       needs login — the server DB is the
                                       source of truth); --local: validate
                                       GITHUB_* in the LOCAL env file
                                       (.env.toml; a legacy .env is
                                       auto-selected when .env.toml is
                                       absent, --env-file overrides —
                                       offline bootstrap check)
  github setup [--local] [--env-file <path>]
                                       configure App ID + PEM + webhook secret
                                       (default: push to the server API —
                                       applied immediately, REPLACES the
                                       current server values like web Settings;
                                       needs login; --local: write the env
                                       file as BOOTSTRAP — .env.toml by
                                       default (legacy .env auto-selected
                                       when .env.toml is absent; --env-file
                                       overrides) —
                                       imported on next boot only while unset,
                                       never overwrites web Settings values,
                                       inert once the server has DB config)
  github check <slug> <owner/repo>     acceptance round-trip against the live
                                       server (creates a real issue; needs
                                       login — config source irrelevant)
  github link <id> --project <slug> --repo <owner/name>
                                       create a GitHub issue from the task and
                                       link it (needs login)
  github link-existing <id> --project <slug> --repo <owner/name> --issue <n>
                                       link an existing GitHub issue to the task
                                       (needs login)
  github unlink <id> --project <slug> ( --issue-id <nodeId> | --repo <owner/name> --issue <n> )
                                       unlink a GitHub issue from the task
                                       (needs login)

Upgrade:
  upgrade                                self-update the CLI binary (GitHub release)

Env fallbacks: LEXA_URL, LEXA_API_KEY. Flags override saved login.
`;

const GROUP_HELP: Record<string, string> = {
  project: `Projects:
  project list [--json]`,
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
  column list --project <slug> [--json]`,
  swimlane: `Planning:
  swimlane list --project <slug> [--json]`,
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
  github status [--local] [--env-file <path>]
                                       read the LIVE server state (default —
                                       needs login; the server DB is the source
                                       of truth at runtime); --local: validate
                                       GITHUB_* in the LOCAL env file
                                       (.env.toml; a legacy .env is
                                       auto-selected when .env.toml is
                                       absent, --env-file overrides —
                                       offline bootstrap check)
  github setup [--local] [--env-file <path>]
                                       configure GITHUB_APP_ID + PEM + secret
                                       (default: push to the server API —
                                       applied immediately, REPLACES the
                                       current server values like web Settings;
                                       needs login; --local: write the env file
                                       as first-boot BOOTSTRAP — .env.toml by
                                       default (legacy .env auto-selected when
                                       .env.toml is absent; --env-file
                                       overrides) —
                                       imported on the next boot only while
                                       still unset, never overwrites web
                                       Settings values, inert once the server
                                       has DB config; --app-id, --pem-file,
                                       --webhook-secret for non-interactive
                                       runs)
  github check <slug> <owner/repo>     Lexa→GitHub acceptance round-trip
                                       against the live server (creates a real
                                       issue; needs login — config source
                                       irrelevant)
  github link <id> --project <slug> --repo <owner/name>
                                       create a GitHub issue from the task and
                                       link it (needs login)
  github link-existing <id> --project <slug> --repo <owner/name> --issue <n>
                                       link an existing GitHub issue to the task
                                       (needs login)
  github unlink <id> --project <slug> ( --issue-id <nodeId> | --repo <owner/name> --issue <n> )
                                       unlink a GitHub issue from the task
                                       (needs login)`,

  upgrade: `Upgrade:
  upgrade                                        self-update the CLI binary (GitHub release)`,
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
            const { client } = yield* requireClient(flags);
            yield* cmdGithubStatus(flags, client);
          });
          break;
        case "setup":
          program = Effect.gen(function* () {
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
      if (sub === "list") { program = cmdProjectList(flags); break; }
      usage("project", sub);

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
      if (sub === "list") { program = cmdColumnList(flags); break; }
      usage("column", sub);

    case "swimlane":
      if (sub === "list") { program = cmdSwimlaneList(flags); break; }
      usage("swimlane", sub);

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
