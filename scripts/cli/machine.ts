import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname as osHostname, homedir } from "node:os";
import { join, dirname } from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { LexaClient, type RuntimeCatalogInfo, type RuntimeEventInfo } from "./api";
import { LEXA_DIR, migrateLegacyDirs, type CliConfig } from "./config";
import { DAEMON_SOURCE } from "./packed";

const SERVICE_NAME = "lexa-forge-listen";
// Compiled (`bun build --compile`) binaries have no real source dir —
// import.meta.dir points into the embedded bunfs. Running from source
// (`bun run scripts/cli/index.ts`) keeps it on disk. The daemon child
// source and the systemd ExecStart differ between the two layouts.
export const COMPILED = (import.meta.dir ?? "").startsWith("/$bunfs");
const INSTALL_DIR = join(homedir(), ".local", "share", "lexa-forge");
// Runtime state root — everything the host stores lives here (config.json,
// machine-id, env, runtimes/<id>/env, runs/). Legacy ~/.config/lexa-* dirs
// are migrated into it on listen (migrate-and-delete, no fallback).
const RUNTIMES_DIR = join(LEXA_DIR, "runtimes");
// Project workspaces — one persistent dir per project under ~/.lexa/projects/,
// seeded on first sight with README.md (project context) + AGENTS.md (static
// orchestrator). The Forge daemon runs opencode from the workspace dir with a
// sealed per-run HOME; per-agent rule bundles live in .agents/agents/<id>/.
const PROJECTS_DIR = join(LEXA_DIR, "projects");
const PROJECT_INDEX_PATH = join(LEXA_DIR, "projects.json");
const LISTENER_UNIT_PATH = join(homedir(), ".config", "systemd", "user", `${SERVICE_NAME}.service`);
const DAEMON_SRC = join(import.meta.dir, "..", "forge", "daemon.ts");
const CLI_ENTRY = join(import.meta.dir, "index.ts");
const MACHINE_ID_PATH = join(LEXA_DIR, "machine-id");
const MACHINE_SECRET_PATH = join(LEXA_DIR, "machine-secret");
const EVENT_POLL_MS = 3000;
const CATALOG_REFRESH_MS = 10 * 60 * 1000;
const COMMAND_TIMEOUT_MS = 30_000;
const CMD_BIN = process.env.FORGE_CMD_BIN ?? "cmd";

interface RuntimeEnv {
  runtimeId: string;
  agentCli: "opencode" | "hermes" | "command-code";
  path: string;
  env: Record<string, string>;
}

interface RuntimeChild {
  runtimeId: string;
  child: ChildProcess;
}

export interface MachineInstallOpts {
  noSystemd?: boolean;
}

function hasSystemd(): boolean {
  try {
    const result = spawnSync("systemctl", ["--user", "is-system-running"], { stdio: "ignore" });
    return result.status === 0 || result.status === 1;
  } catch {
    return false;
  }
}

function listenerUnit(): string {
  const exec = COMPILED ? `${process.execPath} machine listen` : `bun run ${CLI_ENTRY} machine listen`;
  return `[Unit]
Description=Lexa Forge machine listener (web wizard → runtime daemons)
After=network-online.target

[Service]
Type=simple
ExecStart=${exec}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

function ensureListenerUnit(): void {
  mkdirSync(dirname(LISTENER_UNIT_PATH), { recursive: true });
  writeFileSync(LISTENER_UNIT_PATH, listenerUnit());
  if (hasSystemd()) spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
}

export function machineInstall(opts: MachineInstallOpts = {}): void {
  mkdirSync(LEXA_DIR, { recursive: true, mode: 0o700 });
  if (opts.noSystemd) {
    console.log("  Runtime setup is driven from the web wizard.");
    console.log("  Start the machine listener under your supervisor:");
    console.log("    lexa-cli machine listen");
    return;
  }
  ensureListenerUnit();
  console.log(`  Listener unit → ${LISTENER_UNIT_PATH}`);
  if (!hasSystemd()) {
    console.log("  systemd not available — start the listener manually:");
    console.log("    lexa-cli machine listen");
    return;
  }
  machineStart();
}

function sysctl(args: string[]): number {
  if (!hasSystemd()) {
    console.error("  systemd (user) is not available on this machine.");
    process.exit(1);
  }
  const result = spawnSync("systemctl", ["--user", ...args], { stdio: "inherit" });
  return result.status ?? 1;
}

export function machineStart(): void {
  ensureListenerUnit();
  sysctl(["enable", "--now", SERVICE_NAME]);
  console.log(`  Started ${SERVICE_NAME}.`);
}

export function machineStop(): void {
  sysctl(["stop", SERVICE_NAME]);
  console.log(`  Stopped ${SERVICE_NAME}.`);
}

export function machineRestart(): void {
  sysctl(["restart", SERVICE_NAME]);
  console.log(`  Restarted ${SERVICE_NAME}.`);
}

export function machineStatus(): void {
  if (!hasSystemd()) {
    console.log("  systemd (user) not available — run `lexa-cli machine listen` in the foreground.");
    return;
  }
  spawnSync("systemctl", ["--user", "status", SERVICE_NAME], { stdio: "inherit" });
}

export function machineLogs(): void {
  if (!hasSystemd()) {
    console.error("  systemd (user) is not available.");
    process.exit(1);
  }
  const result = spawnSync("journalctl", ["--user", "-u", SERVICE_NAME, "-f"], { stdio: "inherit" });
  if (result.status !== 0 && result.status !== null) process.exit(result.status);
}

function readEnvFile(path: string): Record<string, string> {
  const result: Record<string, string> = {};
  try {
    if (!existsSync(path)) return result;
    for (const line of readFileSync(path, "utf-8").split("\n")) {
      const separator = line.indexOf("=");
      if (separator <= 0) continue;
      result[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
    }
  } catch {
    return result;
  }
  return result;
}

function listRuntimeEnvs(): RuntimeEnv[] {
  if (!existsSync(RUNTIMES_DIR)) return [];
  const result: RuntimeEnv[] = [];
  for (const runtimeId of readdirSync(RUNTIMES_DIR)) {
    const path = join(RUNTIMES_DIR, runtimeId, "env");
    const env = readEnvFile(path);
    const agentCli = env.FORGE_AGENT;
    if (!env.FORGE_RUNTIME_ID || !isAgentCli(agentCli)) continue;
    result.push({ runtimeId: env.FORGE_RUNTIME_ID, agentCli, path, env });
  }
  return result;
}

function isAgentCli(value: string | undefined): value is "opencode" | "hermes" | "command-code" {
  return value === "opencode" || value === "hermes" || value === "command-code";
}

// Machine identity: `hostname-<unique>` so machine ids are human-readable in
// the Settings machines list (existing UUID ids keep working — opaque to the
// server). Persisted in ~/.lexa/machine-id; never regenerated once written.
export function getOrCreateMachineId(): string {
  try {
    if (existsSync(MACHINE_ID_PATH)) {
      const existing = readFileSync(MACHINE_ID_PATH, "utf-8").trim();
      if (existing) return existing;
    }
    const id = `${osHostname()}-${crypto.randomUUID().slice(0, 8)}`;
    mkdirSync(dirname(MACHINE_ID_PATH), { recursive: true });
    writeFileSync(MACHINE_ID_PATH, `${id}\n`, { mode: 0o600 });
    return id;
  } catch {
    return `${osHostname()}-${crypto.randomUUID().slice(0, 8)}`;
  }
}

// Machine binding secret: minted by the server on first registration,
// returned exactly once and persisted here (chmod 600, alongside machine-id).
// Sent with register (re-binding) and as x-machine-secret on claim.
export function getOrCreateMachineSecret(): string {
  try {
    if (existsSync(MACHINE_SECRET_PATH)) {
      return readFileSync(MACHINE_SECRET_PATH, "utf-8").trim();
    }
  } catch { /* treated as missing */ }
  return "";
}

export function saveMachineSecret(secret: string): void {
  mkdirSync(dirname(MACHINE_SECRET_PATH), { recursive: true });
  writeFileSync(MACHINE_SECRET_PATH, `${secret}\n`, { mode: 0o600 });
  chmodSync(MACHINE_SECRET_PATH, 0o600);
}

// ── Project workspaces ──
// The server sends the project index on every machine heartbeat; the
// listener persists it (so the daemon can resolve names without a server
// round-trip) and provisions one workspace dir per project. Seeding is
// write-once: README.md and the orchestrator AGENTS.md are never overwritten
// once they exist (operator edits survive; daemon per-run files live in
// .agents/ and .forge/).
export interface WorkspaceProjectInfo {
  id: string;
  name: string;
  slug: string;
  description: string;
}

function writeProjectIndex(projects: WorkspaceProjectInfo[]): void {
  const index: Record<string, { name: string; slug: string; description: string }> = {};
  for (const p of projects) {
    index[p.id] = { name: p.name, slug: p.slug, description: p.description };
  }
  const tmp = `${PROJECT_INDEX_PATH}.tmp`;
  writeFileSync(tmp, JSON.stringify(index, null, 2), { mode: 0o644 });
  renameSync(tmp, PROJECT_INDEX_PATH);
}

function provisionWorkspaces(projects: WorkspaceProjectInfo[]): { total: number; created: number } {
  let created = 0;
  for (const p of projects) {
    const dir = join(PROJECTS_DIR, p.id);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      created += 1;
    }
    const readme = join(dir, "README.md");
    if (!existsSync(readme)) {
      writeFileSync(readme, [
        `# ${p.name}`,
        "",
        p.description || "(no description)",
        "",
        "This is the Lexa Forge workspace for this project. Clone or symlink the",
        "project's repository here — e.g. `ln -s /path/to/repo repo/`. The Forge",
        "agent works from this directory and can only read files inside it.",
        "",
      ].join("\n"), { mode: 0o644 });
    }
    const orchestrator = join(dir, "AGENTS.md");
    if (!existsSync(orchestrator)) {
      writeFileSync(orchestrator, [
        `# ${p.name}`,
        "",
        p.description || "",
        "",
        "You are one of Lexa's agents working on this project. Your agent id is",
        "named in your prompt — read `.agents/agents/<yourId>/AGENTS.md` and follow",
        "it exactly. Skills live in `.agents/skills/`.",
        "",
        "Work only inside this workspace directory. Project files (if any) are",
        "under `repo/`.",
        "",
        `File access: use ABSOLUTE paths under \`${dir}/\` (e.g. \`${dir}/repo/foo\`) —`,
        "relative paths are denied by the workspace policy. Never touch anything",
        "outside this directory.",
        "",
      ].join("\n"), { mode: 0o644 });
    }
  }
  return { total: projects.length, created };
}

// Installed agent CLIs on this machine (probed once at listener start) —
// sent with every heartbeat so Settings can show the machine↔CLI binding
// without waiting for a runtime env to exist.
export async function probeClis(): Promise<Array<{ provider: "opencode" | "hermes" | "command-code"; version: string }>> {
  const clis: Array<{ provider: "opencode" | "hermes" | "command-code"; version: string }> = [];
  const probe = async (bin: string, provider: "opencode" | "hermes" | "command-code") => {
    const out = await runCapture(bin, ["--version"]);
    const version = out.split("\n")[0]?.trim() || "";
    if (version) clis.push({ provider, version: version.slice(0, 60) });
  };
  await Promise.all([
    probe("opencode", "opencode"),
    probe(CMD_BIN, "command-code"),
    // hermes: no reliable --version flag — skipped.
  ]);
  return clis;
}

function runCapture(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (value: string) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* process may already be gone */ }
      finish("");
    }, COMMAND_TIMEOUT_MS);
    try {
      child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      clearTimeout(timer);
      finish("");
      return;
    }
    child.stdout?.on("data", (data) => { stdout += data.toString(); });
    child.stderr?.on("data", (data) => { stderr += data.toString(); });
    child.on("error", () => { clearTimeout(timer); finish(""); });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish(code === 0 ? stdout : stderr);
    });
  });
}

function parseModels(raw: string, fallbackProvider: string): Array<{ id: string; provider: string; name: string }> {
  const result: Array<{ id: string; provider: string; name: string }> = [];
  if (fallbackProvider === "command-code") {
    let provider = fallbackProvider;
    let previousBlank = true;
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) { previousBlank = true; continue; }
      if (trimmed.startsWith("Available models") || trimmed.startsWith("Pass the full id") || trimmed.startsWith("cmd --model") || trimmed.startsWith("Docs:")) continue;
      if (previousBlank) {
        provider = trimmed.toLowerCase();
        previousBlank = false;
        continue;
      }
      const parts = trimmed.split(/\s+/);
      const id = parts[0];
      if (!id || id.includes("{") || id.includes("[")) continue;
      const slash = id.indexOf("/");
      result.push({ id, provider: slash > 0 ? id.slice(0, slash) : provider, name: parts.slice(1).join(" ") || id });
    }
    return result;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("Available models") || trimmed.startsWith("Pass the full id") || trimmed.startsWith("Docs:")) continue;
    const parts = trimmed.split(/\s+/);
    const id = parts[0];
    if (!id || id.includes("{") || id.includes("[") || id === "model") continue;
    const slash = id.indexOf("/");
    const provider = slash > 0 ? id.slice(0, slash) : fallbackProvider;
    if (slash <= 0 && fallbackProvider === "opencode") continue;
    result.push({ id, provider, name: parts.slice(1).join(" ") || id.slice(id.lastIndexOf("/") + 1) });
  }
  return result;
}

function parseAgents(raw: string): Array<{ id: string; name: string }> {
  const result: Array<{ id: string; name: string }> = [];
  const seen = new Set<string>();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    const match = /^([A-Za-z][A-Za-z0-9_-]*)(?:\s+\(([^)]+)\))?$/.exec(trimmed);
    if (!match || trimmed.includes("permission") || trimmed === "Options" || trimmed === "Commands") continue;
    const id = match[1];
    if (seen.has(id)) continue;
    seen.add(id);
    result.push({ id, name: match[2] ?? id });
  }
  return result;
}

async function discoverCatalog(agentCli: RuntimeEnv["agentCli"]): Promise<Pick<RuntimeCatalogInfo, "models" | "agents">> {
  if (agentCli === "hermes") return { models: [], agents: [] };
  const [modelsRaw, agentsRaw] = agentCli === "opencode"
    ? await Promise.all([
        runCapture("opencode", ["models"]),
        runCapture("opencode", ["agent", "list"]),
      ])
    : await Promise.all([
        runCapture(CMD_BIN, ["--list-models"]),
        runCapture(CMD_BIN, ["--list-agents"]),
      ]);
  return {
    models: parseModels(modelsRaw, agentCli),
    agents: parseAgents(agentsRaw),
  };
}

function writeRuntimeEnv(path: string, env: Record<string, string>): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const lines = Object.entries(env).filter(([key]) => key !== "").map(([key, value]) => `${key}=${value}`);
  writeFileSync(path, `${lines.join("\n")}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

// The daemon imports shared modules (shared/forge-log.ts), so the standalone
// child must be BUNDLED before install — raw source would fail to resolve
// imports from INSTALL_DIR. `bun build` inlines everything into daemon.js.
function buildDaemon(outfile: string, sourceFile?: string): void {
  mkdirSync(INSTALL_DIR, { recursive: true });
  const entry = sourceFile ?? join(INSTALL_DIR, "daemon-src.ts");
  if (!sourceFile) writeFileSync(entry, DAEMON_SOURCE);
  const res = spawnSync("bun", ["build", "--target=bun", "--outfile", outfile, entry], { stdio: "pipe" });
  if (!sourceFile) rmSync(entry, { force: true });
  if (res.status !== 0) {
    throw new Error(`daemon bundle failed: ${res.stderr?.toString().slice(0, 500) || res.stdout?.toString().slice(0, 500)}`);
  }
}

function ensureDaemonInstalled(): void {
  const destination = join(INSTALL_DIR, "daemon.js");
  if (DAEMON_SOURCE) {
    // Compiled binary: the daemon ships inside the executable as a bundle.
    buildDaemon(destination);
  } else {
    if (!existsSync(DAEMON_SRC)) {
      throw new Error(`Daemon source missing at ${DAEMON_SRC}`);
    }
    // Refresh the bundled child on every listener start/restart so schema and
    // environment contract changes reach runtimes created by older versions.
    buildDaemon(destination, DAEMON_SRC);
  }
}

function normalizeRuntimeEnv(runtime: RuntimeEnv, serverUrl: string, machineId: string, hostname: string): RuntimeEnv {
  const env: Record<string, string> = {
    ...runtime.env,
    LEXA_URL: serverUrl,
    FORGE_RUNTIME_ID: runtime.runtimeId,
    FORGE_RUNTIME_NAME: runtime.env.FORGE_RUNTIME_NAME || `${hostname}-${runtime.agentCli}`,
    FORGE_MACHINE_ID: machineId,
  };
  const changed = Object.keys(env).some((key) => env[key] !== runtime.env[key]);
  if (changed) writeRuntimeEnv(runtime.path, env);
  return { ...runtime, env };
}

// Kill a process and its whole descendant tree via a /proc walk (children
// first). The daemon spawns agents with detached: true — each agent is its
// own process-group leader, so process.kill(-pid) on the daemon alone would
// orphan the agent and its tool children (they'd run to completion: burning
// tokens, writing the workspace). Process groups are unreliable depending on
// how the listener itself was launched (systemd, nohup, setsid), so walk
// /proc instead — same approach as the daemon's own in-run cancel path.
function collectDescendants(root: number): number[] {
  const out: number[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    let ppid = -1;
    try {
      ppid = Number(readFileSync(`/proc/${entry}/stat`, "utf8").split(" ")[3]);
    } catch { continue; }
    if (ppid === root) out.push(Number(entry), ...collectDescendants(Number(entry)));
  }
  return out;
}

function killTree(pid: number): void {
  // Collect BEFORE killing: once the daemon dies, its detached agent child
  // is reparented to init and a /proc walk from the daemon pid finds nothing.
  const all = [pid, ...collectDescendants(pid)];
  for (const p of all.reverse()) {
    try { process.kill(p, "SIGKILL"); } catch { /* already gone */ }
  }
}

async function killChild(runtimeId: string, children: Map<string, RuntimeChild>, stopping: Set<string>): Promise<void> {
  const runtime = children.get(runtimeId);
  if (!runtime) return;
  stopping.add(runtimeId);
  children.delete(runtimeId);
  const pid = runtime.child.pid;
  if (pid) {
    // Capture the daemon's descendant tree NOW — the agent is the daemon's
    // direct child until the daemon dies; once the daemon exits, the
    // detached agent is reparented to init and the /proc walk can't find it.
    const tree = [pid, ...collectDescendants(pid)];
    // Graceful first: SIGTERM the daemon and everything we captured (the
    // agent winds down its tool children), then force-kill children-first.
    for (const p of tree) {
      try { process.kill(p, "SIGTERM"); } catch { /* already gone */ }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    for (const p of tree.reverse()) {
      try { process.kill(p, "SIGKILL"); } catch { /* already gone */ }
    }
  }
  // The daemon is dead — drop its pid file so the next listener boot does
  // not try to sweep it (and a fresh spawn overwrites it anyway).
  try { rmSync(join(RUNTIMES_DIR, runtimeId, "daemon.pid"), { force: true }); } catch { /* ignore */ }
}

function spawnRuntime(
  runtime: RuntimeEnv,
  children: Map<string, RuntimeChild>,
  stopping: Set<string>,
  shuttingDown: () => boolean,
  onAuthFailure?: (runtimeId: string) => void,
): void {
  ensureDaemonInstalled();
  stopping.delete(runtime.runtimeId);
  const child = spawn("bun", ["run", join(INSTALL_DIR, "daemon.js")], {
    cwd: INSTALL_DIR,
    env: { ...process.env, ...runtime.env },
    stdio: "inherit",
    detached: true,
  });
  children.set(runtime.runtimeId, { runtimeId: runtime.runtimeId, child });
  // Persist the daemon pid — a crashed listener (SIGKILL/power loss) leaves
  // its detached daemons running; the next listener boot kills them by this
  // pid before spawning fresh ones (see killStaleDaemon). Without it, every
  // restart spawns a SECOND daemon for the same runtime and both claim tasks.
  if (child.pid) {
    try {
      writeFileSync(join(RUNTIMES_DIR, runtime.runtimeId, "daemon.pid"), `${child.pid}\n`, { mode: 0o600 });
    } catch { /* non-fatal — a stale daemon would linger until the next machine stop */ }
  }
  child.on("error", (error) => console.error(`  [runtime ${runtime.runtimeId}] ${error.message}`));
  child.on("exit", (code) => {
    if (children.get(runtime.runtimeId)?.child !== child) return;
    children.delete(runtime.runtimeId);
    // Clean daemon exit — the pid file is stale now; drop it so a future
    // boot does not probe (and killTree) a dead pid.
    try { rmSync(join(RUNTIMES_DIR, runtime.runtimeId, "daemon.pid"), { force: true }); } catch { /* ignore */ }
    if (shuttingDown() || stopping.has(runtime.runtimeId)) return;
    if (code === 3) {
      // Auth failure (revoked/rotated API key): the daemon cannot work and
      // would crash-loop — do NOT respawn. Report it so Settings shows the
      // runtime as "API key revoked — re-run Setup runtime"; the user fixes
      // it by re-running setup (install event rewrites the env with a fresh key).
      console.error(`  [runtime ${runtime.runtimeId}] daemon stopped: API key revoked — re-run Setup runtime`);
      onAuthFailure?.(runtime.runtimeId);
      return;
    }
    console.error(`  [runtime ${runtime.runtimeId}] daemon exited; retrying in 5s`);
    setTimeout(() => {
      const latest = listRuntimeEnvs().find((entry) => entry.runtimeId === runtime.runtimeId);
      if (latest && !shuttingDown()) spawnRuntime(latest, children, stopping, shuttingDown, onAuthFailure);
    }, 5000).unref?.();
  });
}

async function handleSetupEvent(
  client: LexaClient,
  serverUrl: string,
  machineId: string,
  hostname: string,
  event: RuntimeEventInfo,
  rawKey: string | null,
  children: Map<string, RuntimeChild>,
  stopping: Set<string>,
  shuttingDown: () => boolean,
): Promise<void> {
  console.log(`\n  [event] ${event.action} agent=${event.agentCli}`);
  try {
    if (event.action === "remove") {
      const targets = listRuntimeEnvs().filter((runtime) => runtime.agentCli === event.agentCli);
      for (const runtime of targets) {
        await killChild(runtime.runtimeId, children, stopping);
        rmSync(dirname(runtime.path), { recursive: true, force: true });
      }
    } else {
      const existing = listRuntimeEnvs().find((runtime) => runtime.agentCli === event.agentCli);
      const runtimeId = existing?.runtimeId ?? crypto.randomUUID();
      const path = existing?.path ?? join(RUNTIMES_DIR, runtimeId, "env");
      const env: Record<string, string> = {
        ...(existing?.env ?? {}),
        LEXA_URL: serverUrl,
        FORGE_AGENT: event.agentCli,
        FORGE_RUNTIME_ID: runtimeId,
        FORGE_RUNTIME_NAME: `${hostname}-${event.agentCli}`,
        FORGE_MACHINE_ID: machineId,
      };
      if (event.action === "install") {
        if (!rawKey) throw new Error("Install event did not include its one-time API key");
        env.LEXA_API_KEY = rawKey;
      }
      await killChild(runtimeId, children, stopping);
      writeRuntimeEnv(path, env);
      spawnRuntime({ runtimeId, agentCli: event.agentCli, path, env }, children, stopping, shuttingDown);
    }
    await client.completeRuntimeEvent(event.id);
    console.log(`  [event] ${event.id} complete`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`  [event] failed: ${message}`);
    await client.failRuntimeEvent(event.id, message).catch(() => {});
  }
}

// A listener crash (SIGKILL/power loss) leaves its daemons running —
// detached, reparented to init, still claiming tasks and heartbeating. On
// boot, kill each runtime's stale daemon (via the persisted daemon.pid)
// BEFORE spawning a fresh one; otherwise two daemons claim the same runtime,
// and repeated crashes multiply daemons.
function killStaleDaemon(runtime: RuntimeEnv): void {
  const pidFile = join(RUNTIMES_DIR, runtime.runtimeId, "daemon.pid");
  let raw: string;
  try {
    raw = readFileSync(pidFile, "utf-8").trim();
  } catch {
    return; // no pid file — nothing stale to sweep
  }
  const pid = Number(raw);
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(pid, 0);
  } catch (e) {
    // ESRCH = dead pid — stale file, the fresh spawn overwrites it.
    // EPERM/EACCES = alive but un-signallable — still stale; killTree
    // fails harmlessly per-process if it cannot signal them.
    if ((e as NodeJS.ErrnoException).code === "ESRCH") return;
  }
  console.log(`  [runtime ${runtime.runtimeId}] killing stale daemon (pid ${pid}) from a crashed listener`);
  killTree(pid);
}

export async function machineListen(config: CliConfig): Promise<void> {
  migrateLegacyDirs();
  mkdirSync(LEXA_DIR, { recursive: true, mode: 0o700 });
  const client = new LexaClient(config);
  const machineId = getOrCreateMachineId();
  const machineSecret = getOrCreateMachineSecret();
  if (!machineSecret) {
    console.error("  Machine secret missing — re-run `lexa-cli login` to re-register this machine");
    return;
  }
  const machineHostname = osHostname();
  const children = new Map<string, RuntimeChild>();
  const stopping = new Set<string>();
  let shuttingDown = false;
  let catalogs: RuntimeCatalogInfo[] = [];
  let catalogsDirty = true;
  let lastCatalogRefreshAt = 0;
  let refreshing = false;
  // Installed agent CLIs (probed once at start) — sent with every heartbeat.
  let clis: Array<{ provider: "opencode" | "hermes" | "command-code"; version: string }> = [];
  // Daemons that exited with auth failure (code 3) — relayed once so the
  // server can surface lastError on the runtime row.
  const pendingDaemonErrors = new Map<string, string>();
  // First heartbeat provisions workspaces and logs the count once.
  let workspacesLogged = false;

  const onAuthFailure = (runtimeId: string) => {
    pendingDaemonErrors.set(runtimeId, "API key revoked");
  };

  const refreshCatalogs = async () => {
    if (refreshing) return;
    refreshing = true;
    try {
      const envs = listRuntimeEnvs();
      catalogs = await Promise.all(envs.map(async (runtime) => ({
        runtimeId: runtime.runtimeId,
        agentCli: runtime.agentCli,
        ...(await discoverCatalog(runtime.agentCli)),
      })));
      catalogsDirty = true;
      lastCatalogRefreshAt = Date.now();
      console.log(`  Catalogs: ${catalogs.length} runtime${catalogs.length === 1 ? "" : "s"}`);
    } finally {
      refreshing = false;
    }
  };

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await Promise.all([...children.keys()].map((runtimeId) => killChild(runtimeId, children, stopping)));
  };
  process.once("SIGTERM", () => { void shutdown().finally(() => process.exit(0)); });
  process.once("SIGINT", () => { void shutdown().finally(() => process.exit(0)); });

  for (const runtime of listRuntimeEnvs()) {
    killStaleDaemon(runtime);
    spawnRuntime(normalizeRuntimeEnv(runtime, config.url, machineId, machineHostname), children, stopping, () => shuttingDown, onAuthFailure);
  }
  void refreshCatalogs();
  clis = await probeClis().catch(() => []);
  if (clis.length > 0) {
    console.log(`  CLIs: ${clis.map((c) => `${c.provider} ${c.version}`).join(", ")}`);
  }
  console.log(`  Lexa Forge machine listener — ${machineId}`);
  console.log(`  Polling ${config.url} every ${EVENT_POLL_MS}ms. Press Ctrl-C to stop.`);

  for (;;) {
    try {
      if (Date.now() - lastCatalogRefreshAt >= CATALOG_REFRESH_MS) void refreshCatalogs();
      const daemonErrors = pendingDaemonErrors.size > 0
        ? [...pendingDaemonErrors.entries()].map(([runtimeId, error]) => ({ runtimeId, error }))
        : undefined;
      const heartbeat = await client.machineHeartbeat({
        id: machineId,
        hostname: machineHostname,
        ...(catalogsDirty ? { runtimes: catalogs } : {}),
        ...(clis.length > 0 ? { clis } : {}),
        ...(daemonErrors ? { daemonErrors } : {}),
      });
      if (heartbeat) {
        pendingDaemonErrors.clear();
        if (catalogsDirty) catalogsDirty = false;
        if (Array.isArray(heartbeat.projects) && heartbeat.projects.length > 0) {
          writeProjectIndex(heartbeat.projects);
          const provisioned = provisionWorkspaces(heartbeat.projects);
          if (!workspacesLogged) {
            workspacesLogged = true;
            console.log(`  Workspaces: ${provisioned.total} project${provisioned.total === 1 ? "" : "s"} (${provisioned.created} created)`);
          }
        }
      }
      const claim = await client.claimRuntimeEvent(machineId, machineSecret);
      if (claim) {
        await handleSetupEvent(client, config.url, machineId, machineHostname, claim.event, claim.rawKey, children, stopping, () => shuttingDown);
        await refreshCatalogs();
        catalogsDirty = true;
      }
    } catch (error) {
      console.error(`  [listen] ${error instanceof Error ? error.message : String(error)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, EVENT_POLL_MS));
  }
}

function readProjectIndex(): Record<string, { name: string; slug: string; description: string }> {
  try {
    if (!existsSync(PROJECT_INDEX_PATH)) return {};
    return JSON.parse(readFileSync(PROJECT_INDEX_PATH, "utf-8")) as Record<string, { name: string; slug: string; description: string }>;
  } catch {
    return {};
  }
}

// ── lexa-cli machine workspace ──

// Local workspace view — one row per provisioned dir under ~/.lexa/projects/.
// Orphan = dir exists but the project is gone from the server index (kept
// deliberately, never auto-deleted — it may hold operator files).
export function workspaceList(): void {
  const index = readProjectIndex();
  const dirs = existsSync(PROJECTS_DIR) ? readdirSync(PROJECTS_DIR).sort() : [];
  if (dirs.length === 0) {
    console.log("  No workspaces yet — run `lexa-cli machine listen` (or `machine workspace sync`); the listener provisions them from the server heartbeat.");
    return;
  }
  const rows = dirs.map((id) => {
    const info = index[id];
    const dir = join(PROJECTS_DIR, id);
    let hasFiles = false;
    try {
      hasFiles = readdirSync(dir).some((name) => !name.startsWith("."));
    } catch { /* unreadable dir */ }
    return {
      NAME: info?.name ?? "—",
      ID: id,
      PATH: dir,
      STATUS: info ? (hasFiles ? "provisioned" : "empty") : "orphan",
    };
  });
  printTable(rows);
  console.log("  Populate: clone or symlink the project repo into the workspace dir, e.g. `ln -s /path/to/repo <dir>/repo`.");
}

// Force a re-index from the server (useful without a running listener) and
// provision any missing workspace dirs.
export async function workspaceSync(config: CliConfig): Promise<void> {
  const client = new LexaClient(config);
  const projects = await client.listProjects();
  const index = projects.map((p) => ({ id: p.id, name: p.name, slug: p.slug, description: p.description ?? "" }));
  writeProjectIndex(index);
  const provisioned = provisionWorkspaces(index);
  console.log(`  Synced ${provisioned.total} project${provisioned.total === 1 ? "" : "s"} into ${PROJECTS_DIR} (${provisioned.created} workspace dir(s) created)`);
}

export async function listMachines(config: CliConfig): Promise<void> {
  const client = new LexaClient(config);
  try {
    const machines = await client.listMachines();
    if (machines.length === 0) {
      console.log("  No machines registered. Start `lexa-cli machine listen`.");
      return;
    }
    printTable(machines.map((machine) => ({
      ID: machine.id,
      HOST: machine.hostname || "—",
      CLIS: machine.clis?.length ? machine.clis.map((c) => `${c.provider} ${c.version}`).join(", ") : "—",
      STATUS: machine.lastSeen ? "online" : "bound",
      "LAST SEEN": machine.lastSeen ? machine.lastSeen.slice(0, 19) : "never",
    })));
  } catch (error) {
    console.error(`  Failed to list machines: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

export async function listRuntimes(config: CliConfig): Promise<void> {
  const client = new LexaClient(config);
  try {
    const runtimes = await client.listRuntimes();
    if (runtimes.length === 0) {
      console.log("  No runtimes registered. Run the web setup wizard.");
      return;
    }
    printTable(runtimes.map((runtime) => ({
      ID: runtime.id,
      NAME: runtime.name,
      AGENT: runtime.provider,
      MODEL: runtime.model || "—",
      HOST: runtime.hostname || "—",
      STATUS: runtime.lastError ? `offline (${runtime.lastError.slice(0, 40)})` : runtime.status,
      MCP: runtime.mcpConnected ? "connected" : "not set",
      "LAST SEEN": runtime.lastSeen ? runtime.lastSeen.slice(0, 19).replace("T", " ") : "never",
    })));
  } catch (error) {
    console.error(`  Failed to list runtimes: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

function printTable(rows: Record<string, string>[]): void {
  if (rows.length === 0) return;
  const keys = Object.keys(rows[0]);
  const widths = keys.map((key) => Math.max(key.length, ...rows.map((row) => (row[key] ?? "").length)));
  const pad = (value: string, width: number) => value + " ".repeat(Math.max(0, width - value.length));
  console.log("  " + keys.map((key, index) => pad(key, widths[index])).join("  "));
  console.log("  " + widths.map((width) => "-".repeat(width)).join("  "));
  for (const row of rows) console.log("  " + keys.map((key, index) => pad(row[key] ?? "", widths[index])).join("  "));
}
