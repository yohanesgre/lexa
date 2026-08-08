#!/usr/bin/env bun
/**
 * lexa-cli — Lexa operator & daemon-management CLI.
 *
 *   lexa-cli <command> [options]        (prod: compiled binary)
 *   lexa-cli-dev <command> [options]    (dev: bun run scripts/cli/index.ts)
 *
 * Wraps the Lexa REST API with the same lxk_ Bearer auth as the web app.
 * The Forge daemon stays a polling process; this CLI installs/starts/stops it
 * and gives humans/scripts a non-browser way to drive Lexa.
 *
 * Env fallbacks (overridden by --url/--key or saved login):
 *   LEXA_URL, LEXA_API_KEY
 *
 * `lexa-cli login` without flags prompts interactively (TTY only); scripts
 * always pass --url/--key or env vars.
 */
import { LexaClient, ApiError } from "./api";
import { loadConfig, saveConfig, clearConfig, type CliConfig } from "./config";
import { cmdDeploy } from "./deploy";
import { COMPILED, getOrCreateMachineId, getOrCreateMachineSecret, saveMachineSecret } from "./machine";
import { hostname as osHostname } from "node:os";
import { machineInstall, machineStart, machineStop, machineRestart, machineStatus, machineLogs, listMachines, listRuntimes, machineListen, workspaceList, workspaceSync } from "./machine";

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
    const a = argv[i];
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

// Resolve the active config: flags > env > saved login.
function resolveConfig(flags: Record<string, string | boolean>): CliConfig | null {
  const saved = loadConfig();
  const url = (typeof flags.url === "string" && flags.url) || ENV_URL || saved?.url || "";
  const apiKey = (typeof flags.key === "string" && flags.key) || ENV_KEY || saved?.apiKey || "";
  if (!url || !apiKey) return null;
  return { url: url.replace(/\/+$/, ""), apiKey };
}

function requireClient(flags: Record<string, string | boolean>): { client: LexaClient; config: CliConfig } {
  const config = resolveConfig(flags);
  if (!config) {
    console.error("  Not logged in. Run: lexa-cli login [--url <base>] [--key <lxk_...>]");
    console.error("  Or set LEXA_URL + LEXA_API_KEY.");
    process.exit(1);
  }
  return { client: new LexaClient(config), config };
}

// ── table printing (shared) ──
function printTable(rows: Record<string, string>[]): void {
  if (rows.length === 0) return;
  const keys = Object.keys(rows[0]);
  const widths = keys.map((k) => Math.max(k.length, ...rows.map((r) => (r[k] ?? "").length)));
  const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - s.length));
  console.log(keys.map((k, i) => pad(k, widths[i])).join("  "));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const r of rows) {
    console.log(keys.map((k, i) => pad(r[k] ?? "", widths[i])).join("  "));
  }
}

// ── commands ──

// Interactive prompts — only ever used when stdin is a TTY and the login
// flags were omitted. Scripts and pipes never prompt.
// Plain line reading in cooked mode (no readline): the terminal driver
// handles echo and backspace, so there is no raw mode, no ANSI cursor
// queries, and nothing that can hang on a real terminal.
function promptLogin(question: string, fallback = ""): Promise<string> {
  return new Promise((resolve) => {
    const done = (line: string) => {
      // Remove all stdin listeners — bun keeps a read interest on a TTY
      // stdin alive, which would keep the event loop running forever after
      // login; main() then exits explicitly.
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      process.off("SIGINT", onSigint);
      resolve(line.trim() || fallback);
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

async function cmdLogin(flags: Record<string, string | boolean>): Promise<void> {
  let url = ((typeof flags.url === "string" && flags.url) || ENV_URL || "").replace(/\/+$/, "");
  let key = (typeof flags.key === "string" && flags.key) || ENV_KEY || "";
  if (!url || !key) {
    if (!process.stdin.isTTY) {
      console.error("  Usage: lexa-cli login --url <base> --key <lxk_...>");
      console.error("  Or run `lexa-cli login` on a terminal for interactive prompts.");
      process.exit(1);
    }
    if (!url) {
      // Dev flavor (running from source) defaults to the local dev server;
      // the compiled prod binary requires an explicit URL.
      const fallback = COMPILED ? "" : "http://localhost:3000";
      url = await promptLogin(fallback ? `  Server URL (default: ${fallback}): ` : "  Server URL: ", fallback);
      url = url.replace(/\/+$/, "");
    }
    if (!key) key = await promptLogin("  API key — from Settings → API Keys, starts with lxk_: ");
  }
  if (!url || !key) {
    console.error("  Usage: lexa-cli login --url <base> --key <lxk_...>");
    process.exit(1);
  }
  if (!/^lxk_[0-9A-Za-z]{43}$/.test(key)) {
    console.error("  Invalid API key — must be lxk_ + 43 chars (from Settings → API Keys).");
    process.exit(1);
  }
  // Validate: server reachable + key works.
  const client = new LexaClient({ url, apiKey: key });
  try {
    const h = await client.health();
    if (!h.ok) throw new Error("health check failed");
    await client.listProjects();
  } catch (e) {
    console.error(`  Login failed: ${(e as Error).message}`);
    process.exit(1);
  }
  saveConfig({ url, apiKey: key });
  console.log(`  Logged in to ${url}`);
  // Bind the machine: registration creates the machines row (last_seen NULL
  // = "bound, not listening") so it shows up in Settings before the
  // listener ever runs. The server mints a per-machine secret on first
  // registration (returned once) — persisted for the listener's claims.
  // Non-fatal — login must succeed even if the server hiccups.
  try {
    const machineId = getOrCreateMachineId();
    const registered = await client.registerMachine({ id: machineId, hostname: osHostname(), secret: getOrCreateMachineSecret() });
    if (registered.secret) saveMachineSecret(registered.secret);
    console.log(`  Registered machine ${machineId} — run \`lexa-cli machine listen\` to go online`);
  } catch (e) {
    if (e instanceof ApiError && e.code === "MACHINE_ID_TAKEN") {
      console.log(`  ${e.message}`);
    } else {
      console.log("  (machine registration skipped — run `lexa-cli machine listen` to register)");
    }
  }
}

async function cmdLogout(): Promise<void> {
  clearConfig();
}

async function cmdStatus(flags: Record<string, string | boolean>): Promise<void> {
  const { client } = requireClient(flags);
  try {
    const h = await client.health();
    const projects = await client.listProjects();
    console.log(`  Server:   reachable (health ${h.ok ? "ok" : "?"})`);
    console.log(`  Projects: ${projects.length}`);
    console.log(`  Auth:     API key accepted`);
  } catch (e) {
    console.error(`  Status check failed: ${(e as Error).message}`);
    process.exit(1);
  }
}

async function cmdProjectList(flags: Record<string, string | boolean>): Promise<void> {
  const { client } = requireClient(flags);
  const json = flags.json === true;
  try {
    const projects = await client.listProjects();
    if (json) { console.log(JSON.stringify(projects, null, 2)); return; }
    if (projects.length === 0) { console.log("  No projects."); return; }
    printTable(projects.map((p) => ({ SLUG: p.slug, NAME: p.name, DESCRIPTION: p.description ?? "" })));
  } catch (e) {
    console.error(`  Failed: ${(e as Error).message}`);
    process.exit(1);
  }
}

// Resolve a column/swimlane name → id for the target project.
async function resolveColumn(client: LexaClient, slug: string, name: string): Promise<string> {
  const cols = await client.listColumns(slug);
  const found = cols.find((c) => c.name.toLowerCase() === name.toLowerCase());
  if (!found) {
    console.error(`  Column "${name}" not found. Available: ${cols.map((c) => c.name).join(", ")}`);
    process.exit(1);
  }
  return found.id;
}
async function resolveSwimlane(client: LexaClient, slug: string, name: string): Promise<string> {
  const lanes = await client.listSwimlanes(slug);
  const found = lanes.find((l) => l.name.toLowerCase() === name.toLowerCase());
  if (!found) {
    console.error(`  Swimlane "${name}" not found. Available: ${lanes.map((l) => l.name).join(", ")}`);
    process.exit(1);
  }
  return found.id;
}

async function cmdTaskList(flags: Record<string, string | boolean>, args: string[]): Promise<void> {
  const { client } = requireClient(flags);
  const slug = (typeof flags.project === "string" && flags.project) || args[0] || "";
  if (!slug) { console.error("  Usage: lexa-cli task list --project <slug>"); process.exit(1); }
  const limit = typeof flags.limit === "string" ? parseInt(flags.limit, 10) : 20;
  const json = flags.json === true;
  try {
    const tasks = await client.listTasks(slug, limit);
    if (json) { console.log(JSON.stringify(tasks, null, 2)); return; }
    if (tasks.length === 0) { console.log("  No tasks."); return; }
    // Tasks don't carry a status — resolve the column name for context.
    const columns = await client.listColumns(slug);
    const colName = new Map(columns.map((c) => [c.id, c.name]));
    printTable(tasks.map((t) => ({
      ID: t.id.slice(0, 8),
      TITLE: t.title,
      COLUMN: colName.get(t.columnId) ?? t.columnId,
      PRIORITY: t.priority ?? "",
      TYPE: t.type ?? "",
    })));
  } catch (e) {
    console.error(`  Failed: ${(e as Error).message}`);
    process.exit(1);
  }
}

async function cmdTaskCreate(flags: Record<string, string | boolean>): Promise<void> {
  const { client } = requireClient(flags);
  const slug = (typeof flags.project === "string" && flags.project) || "";
  const column = (typeof flags.column === "string" && flags.column) || "";
  const swimlane = (typeof flags.swimlane === "string" && flags.swimlane) || "";
  const title = (typeof flags.title === "string" && flags.title) || "";
  if (!slug || !column || !swimlane || !title) {
    console.error("  Usage: lexa-cli task create --project <slug> --column <name> --swimlane <name> --title <t>");
    process.exit(1);
  }
  try {
    const columnId = await resolveColumn(client, slug, column);
    const swimlaneId = await resolveSwimlane(client, slug, swimlane);
    const task = await client.createTask(slug, { columnId, swimlaneId, title });
    console.log(`  Created task ${task.id} — ${task.title}`);
  } catch (e) {
    console.error(`  Failed: ${(e as Error).message}`);
    process.exit(1);
  }
}

async function cmdTaskMove(flags: Record<string, string | boolean>, args: string[]): Promise<void> {
  const { client } = requireClient(flags);
  const slug = (typeof flags.project === "string" && flags.project) || "";
  const id = args[0] || "";
  const column = (typeof flags.column === "string" && flags.column) || "";
  const swimlane = (typeof flags.swimlane === "string" && flags.swimlane) || "";
  if (!slug || !id || !column) {
    console.error("  Usage: lexa-cli task move <id> --project <slug> --column <name> [--swimlane <name>]");
    process.exit(1);
  }
  try {
    const columnId = await resolveColumn(client, slug, column);
    const swimlaneId = swimlane ? await resolveSwimlane(client, slug, swimlane) : "";
    const task = await client.moveTask(slug, id, { columnId, swimlaneId });
    console.log(`  Moved ${id} → ${column}`);
  } catch (e) {
    console.error(`  Failed: ${(e as Error).message}`);
    process.exit(1);
  }
}

async function cmdTaskGet(flags: Record<string, string | boolean>, args: string[]): Promise<void> {
  const { client } = requireClient(flags);
  const slug = (typeof flags.project === "string" && flags.project) || "";
  const id = args[0] || "";
  if (!slug || !id) { console.error("  Usage: lexa-cli task get <id> --project <slug>"); process.exit(1); }
  try {
    const t = await client.getTask(slug, id);
    if (flags.json === true) { console.log(JSON.stringify(t, null, 2)); return; }
    console.log(`  ${t.title}`);
    console.log(`  id: ${t.id}  priority: ${t.priority ?? "—"}  type: ${t.type ?? "—"}`);
    console.log(`  column: ${t.columnId}  swimlane: ${t.swimlaneId}`);
  } catch (e) {
    console.error(`  Failed: ${(e as Error).message}`);
    process.exit(1);
  }
}

async function cmdTaskUpdate(flags: Record<string, string | boolean>, args: string[]): Promise<void> {
  const { client } = requireClient(flags);
  const slug = (typeof flags.project === "string" && flags.project) || "";
  const id = args[0] || "";
  const title = typeof flags.title === "string" ? flags.title : undefined;
  const priority = typeof flags.priority === "string" ? flags.priority : undefined;
  const type = typeof flags.type === "string" ? flags.type : undefined;
  if (!slug || !id || (title === undefined && priority === undefined && type === undefined)) {
    console.error("  Usage: lexa-cli task update <id> --project <slug> [--title <t>] [--priority <p>] [--type <t>]");
    process.exit(1);
  }
  try {
    const t = await client.updateTask(slug, id, { title, priority, type });
    console.log(`  Updated ${id} — ${t.title}`);
  } catch (e) {
    console.error(`  Failed: ${(e as Error).message}`);
    process.exit(1);
  }
}

async function cmdWikiList(flags: Record<string, string | boolean>): Promise<void> {
  const { client } = requireClient(flags);
  const slug = (typeof flags.project === "string" && flags.project) || "";
  if (!slug) { console.error("  Usage: lexa-cli wiki list --project <slug>"); process.exit(1); }
  try {
    const pages = await client.listWikiPages(slug);
    if (flags.json === true) { console.log(JSON.stringify(pages, null, 2)); return; }
    if (pages.length === 0) { console.log("  No wiki pages."); return; }
    printTable(pages.map((p) => ({ SLUG: p.slug, TITLE: p.title, POS: String(p.position), CHILDREN: p.hasChildren ? "yes" : "" })));
  } catch (e) {
    console.error(`  Failed: ${(e as Error).message}`);
    process.exit(1);
  }
}

async function cmdWikiGet(flags: Record<string, string | boolean>, args: string[]): Promise<void> {
  const { client } = requireClient(flags);
  const slug = (typeof flags.project === "string" && flags.project) || "";
  const pageSlug = args[0] || "";
  if (!slug || !pageSlug) { console.error("  Usage: lexa-cli wiki get <pageSlug> --project <slug>"); process.exit(1); }
  try {
    const page = await client.getWikiPage(slug, pageSlug);
    if (flags.json === true) { console.log(JSON.stringify(page, null, 2)); return; }
    console.log(`# ${page.title}`);
    console.log("");
    // Wiki content is TipTap JSON — render to Markdown so the CLI stays
    // human-readable (same conversion the MCP boundary uses).
    const { docToMarkdown } = await import("../../shared/markdown");
    const md = docToMarkdown(page.content as import("../../shared/types").TipTapDoc);
    console.log(md.trim() || "(empty page)");
  } catch (e) {
    console.error(`  Failed: ${(e as Error).message}`);
    process.exit(1);
  }
}

// ── runtime commands ──

async function cmdRuntimeDelete(flags: Record<string, string | boolean>, args: string[]): Promise<void> {
  const { client } = requireClient(flags);
  const id = args[0] || "";
  if (!id) {
    console.error("  Usage: lexa-cli runtime delete <id>");
    console.error("  (ids from `lexa-cli runtime list`)");
    process.exit(1);
  }
  try {
    await client.deleteRuntime(id);
    console.log(`  Deleted runtime ${id}`);
    console.log("  Its daemon + env are cleaned up by the machine listener on its next heartbeat.");
  } catch (e) {
    console.error(`  Failed: ${(e as Error).message}`);
    process.exit(1);
  }
}

async function cmdMachineDelete(flags: Record<string, string | boolean>, args: string[]): Promise<void> {
  const { client } = requireClient(flags);
  const id = args[0] || "";
  if (!id) {
    console.error("  Usage: lexa-cli machine delete <id>");
    console.error("  (ids from `lexa-cli machine list`)");
    process.exit(1);
  }
  try {
    await client.deleteMachine(id);
    console.log(`  Deleted machine ${id} (with its runtimes)`);
    console.log("  Note: if its listener is still running, the machine will reappear — run `lexa-cli machine stop` on it to fully remove.");
  } catch (e) {
    console.error(`  Failed: ${(e as Error).message}`);
    process.exit(1);
  }
}

function cmdMachineInstall(flags: Record<string, string | boolean>): void {
  if (!resolveConfig(flags)) {
    console.error("  Not logged in. Run: lexa-cli login first.");
    process.exit(1);
  }
  machineInstall({ noSystemd: flags["no-systemd"] === true });
}

// ── main ──

const HELP = `lexa-cli — Lexa operator CLI

Usage: lexa-cli <command> [options]

Auth:
  login    --url <base> --key <lxk_...>   save credentials (chmod 600)
                                           prompts interactively when omitted
  logout                                 remove saved credentials
  status                                 server health + auth + counts

Tasks:
  task list    --project <slug> [--limit N] [--json]
  task create  --project <slug> --column <name> --swimlane <name> --title <t>
  task get     <id> --project <slug> [--json]
  task move    <id> --project <slug> --column <name> [--swimlane <name>]
  task update  <id> --project <slug> [--title <t>] [--priority <p>] [--type <t>]

Wiki:
  wiki list --project <slug> [--json]
  wiki get  <pageSlug> --project <slug> [--json]

Projects:
  project list [--json]

Runtimes (Forge daemon):
  runtime list                                   server-side daemon view
  runtime delete <id>                            remove a runtime (daemon + env
                                                  cleaned up by its machine's
                                                  listener on next heartbeat)

Machine listener:
  machine list                                   registered machine view
  machine install                                ensure listener + start (systemd)
                                                  --no-systemd: run listener yourself
  machine listen                                 run the machine listener (foreground)
  machine start | stop | restart                 systemctl --user lexa-forge-listen
  machine status                                 systemd state
  machine logs                                   journalctl --user -u lexa-forge-listen -f
  machine delete <id>                            remove a machine + its runtimes
                                                  (reappears if still listening — stop
                                                  the listener first for permanent removal)

Forge workspaces (local machine view):
  machine workspace list                         per-project dirs under ~/.lexa/projects/
  machine workspace sync                         re-index projects from the server + provision

Deploy (Docker + cloudflared tunnel + Access):
  deploy <domain> [dev|staging|prod] [--bare]   dev: setup wizard + .env;
                                                 staging/prod: Cloudflare tunnel,
                                                 Access + Google IdP provisioning,
                                                 .env.<flavor> + docker compose up;
                                                 --bare prints bare-metal steps

Env fallbacks: LEXA_URL, LEXA_API_KEY. Flags override saved login.
`;

const GROUP_HELP: Record<string, string> = {
  project: `Projects:
  project list [--json]`,
  task: `Tasks:
  task list    --project <slug> [--limit N] [--json]
  task create  --project <slug> --column <name> --swimlane <name> --title <t>
  task get     <id> --project <slug> [--json]
  task move    <id> --project <slug> --column <name> [--swimlane <name>]
  task update  <id> --project <slug> [--title <t>] [--priority <p>] [--type <t>]`,
  wiki: `Wiki:
  wiki list --project <slug> [--json]
  wiki get  <pageSlug> --project <slug> [--json]`,
  runtime: `Runtimes (Forge daemon):
  runtime list                                   server-side daemon view
  runtime delete <id>                            remove a runtime (daemon + env
                                                  cleaned up by its machine's
                                                  listener on next heartbeat)`,
  machine: `Machine listener:
  machine list                                   registered machine view
  machine install                                ensure listener + start (systemd)
                                                  --no-systemd: run listener yourself
  machine listen                                 run the machine listener (foreground)
  machine start | stop | restart                 systemctl --user lexa-forge-listen
  machine status                                 systemd state
  machine logs                                   journalctl --user -u lexa-forge-listen -f
  machine delete <id>                            remove a machine + its runtimes
                                                  (reappears if still listening — stop
                                                  the listener first for permanent removal)

Forge workspaces (local machine view):
  machine workspace list                         per-project dirs under ~/.lexa/projects/
  machine workspace sync                         re-index projects from the server + provision`,
};

function usage(cmd: string, sub: string): never {
  if (sub !== "") console.error(`  Unknown: ${cmd} ${sub}`);
  console.log(GROUP_HELP[cmd] ?? HELP);
  process.exit(sub === "" ? 0 : 1);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
    console.log(HELP);
    return;
  }
  const { positionals, flags } = parseArgs(argv);
  const cmd = positionals[0];
  const sub = positionals[1] ?? "";
  const rest = positionals.slice(2);

  switch (cmd) {
    case "login": await cmdLogin(flags); break;
    case "logout": await cmdLogout(); break;
    case "status": await cmdStatus(flags); break;
    case "deploy": await cmdDeploy(flags, positionals.slice(1)); break;

    case "project":
      if (sub === "list") await cmdProjectList(flags);
      else usage("project", sub);
      break;

    case "task":
      switch (sub) {
        case "list": await cmdTaskList(flags, rest); break;
        case "create": await cmdTaskCreate(flags); break;
        case "get": await cmdTaskGet(flags, rest); break;
        case "move": await cmdTaskMove(flags, rest); break;
        case "update": await cmdTaskUpdate(flags, rest); break;
        default: usage("task", sub);
      }
      break;

    case "wiki":
      switch (sub) {
        case "list": await cmdWikiList(flags); break;
        case "get": await cmdWikiGet(flags, rest); break;
        default: usage("wiki", sub);
      }
      break;

    case "runtime":
      switch (sub) {
        case "list": { const { config } = requireClient(flags); await listRuntimes(config); break; }
        case "delete": { await cmdRuntimeDelete(flags, rest); break; }
        default: usage("runtime", sub);
      }
      break;

    case "machine":
      switch (sub) {
        case "list": { const { config } = requireClient(flags); await listMachines(config); break; }
        case "install": cmdMachineInstall(flags); break;
        case "listen": { const { config } = requireClient(flags); await machineListen(config); break; }
        case "start": machineStart(); break;
        case "stop": machineStop(); break;
        case "restart": machineRestart(); break;
        case "status": machineStatus(); break;
        case "logs": machineLogs(); break;
        case "delete": { await cmdMachineDelete(flags, rest); break; }
        case "workspace":
          switch (rest[0]) {
            case "list": workspaceList(); break;
            case "sync": { const { config } = requireClient(flags); await workspaceSync(config); break; }
            default: usage("machine", rest[0] === undefined ? "" : `workspace ${rest[0]}`);
          }
          break;
        default: usage("machine", sub);
      }
      break;

    default:
      console.error(`  Unknown command: ${cmd}`);
      console.log(HELP);
      process.exit(1);
  }
  // Explicit exit: bun keeps a read interest on TTY stdin after interactive
  // prompts, which would otherwise keep the event loop alive forever.
  process.exit(0);
}

main().catch((e) => {
  console.error("  lexa-cli error:", (e as Error).message);
  process.exit(1);
});
