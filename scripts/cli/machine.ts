import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname as osHostname, homedir } from "node:os";
import { join, dirname } from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { LexaClient, type RuntimeCatalogInfo, type RuntimeEventInfo } from "./api";
import { LEXA_DIR, migrateLegacyDirs, type CliConfig } from "./config";

const SERVICE_NAME = "lexa-forge-listen";
const INSTALL_DIR = join(homedir(), ".local", "share", "lexa-forge");
// Runtime state root — everything the host stores lives here (config.json,
// machine-id, env, runtimes/<id>/env, runs/). Legacy ~/.config/lexa-* dirs
// are migrated into it on listen (migrate-and-delete, no fallback).
const RUNTIMES_DIR = join(LEXA_DIR, "runtimes");
const LISTENER_UNIT_PATH = join(homedir(), ".config", "systemd", "user", `${SERVICE_NAME}.service`);
const DAEMON_SRC = join(import.meta.dir, "..", "forge", "daemon.ts");
const CLI_ENTRY = join(import.meta.dir, "index.ts");
const MACHINE_ID_PATH = join(LEXA_DIR, "machine-id");
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
  return `[Unit]
Description=Lexa Forge machine listener (web wizard → runtime daemons)
After=network-online.target

[Service]
Type=simple
ExecStart=bun run ${CLI_ENTRY} machine listen
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

function loadOrCreateMachineId(): string {
  try {
    if (existsSync(MACHINE_ID_PATH)) {
      const existing = readFileSync(MACHINE_ID_PATH, "utf-8").trim();
      if (existing) return existing;
    }
    const id = crypto.randomUUID();
    mkdirSync(dirname(MACHINE_ID_PATH), { recursive: true });
    writeFileSync(MACHINE_ID_PATH, `${id}\n`, { mode: 0o600 });
    return id;
  } catch {
    return crypto.randomUUID();
  }
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

function ensureDaemonInstalled(): void {
  const destination = join(INSTALL_DIR, "daemon.ts");
  if (!existsSync(DAEMON_SRC)) {
    throw new Error(`Daemon source missing at ${DAEMON_SRC}`);
  }
  mkdirSync(INSTALL_DIR, { recursive: true });
  // Refresh the copied child on every listener start/restart so schema and
  // environment contract changes reach runtimes created by older versions.
  copyFileSync(DAEMON_SRC, destination);
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

async function killChild(runtimeId: string, children: Map<string, RuntimeChild>, stopping: Set<string>): Promise<void> {
  const runtime = children.get(runtimeId);
  if (!runtime) return;
  stopping.add(runtimeId);
  children.delete(runtimeId);
  const pid = runtime.child.pid;
  if (pid) {
    try { process.kill(-pid, "SIGTERM"); } catch { try { runtime.child.kill("SIGTERM"); } catch { /* already exited */ } }
    await new Promise((resolve) => setTimeout(resolve, 500));
    try { process.kill(-pid, "SIGKILL"); } catch { /* already exited */ }
  }
}

function spawnRuntime(
  runtime: RuntimeEnv,
  children: Map<string, RuntimeChild>,
  stopping: Set<string>,
  shuttingDown: () => boolean,
): void {
  ensureDaemonInstalled();
  stopping.delete(runtime.runtimeId);
  const child = spawn("bun", ["run", join(INSTALL_DIR, "daemon.ts")], {
    cwd: INSTALL_DIR,
    env: { ...process.env, ...runtime.env },
    stdio: "inherit",
    detached: true,
  });
  children.set(runtime.runtimeId, { runtimeId: runtime.runtimeId, child });
  child.on("error", (error) => console.error(`  [runtime ${runtime.runtimeId}] ${error.message}`));
  child.on("exit", () => {
    if (children.get(runtime.runtimeId)?.child !== child) return;
    children.delete(runtime.runtimeId);
    if (shuttingDown() || stopping.has(runtime.runtimeId)) return;
    console.error(`  [runtime ${runtime.runtimeId}] daemon exited; retrying in 5s`);
    setTimeout(() => {
      const latest = listRuntimeEnvs().find((entry) => entry.runtimeId === runtime.runtimeId);
      if (latest && !shuttingDown()) spawnRuntime(latest, children, stopping, shuttingDown);
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

export async function machineListen(config: CliConfig): Promise<void> {
  migrateLegacyDirs();
  mkdirSync(LEXA_DIR, { recursive: true, mode: 0o700 });
  const client = new LexaClient(config);
  const machineId = loadOrCreateMachineId();
  const machineHostname = osHostname();
  const children = new Map<string, RuntimeChild>();
  const stopping = new Set<string>();
  let shuttingDown = false;
  let catalogs: RuntimeCatalogInfo[] = [];
  let catalogsDirty = true;
  let lastCatalogRefreshAt = 0;
  let refreshing = false;

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
    spawnRuntime(normalizeRuntimeEnv(runtime, config.url, machineId, machineHostname), children, stopping, () => shuttingDown);
  }
  void refreshCatalogs();
  console.log(`  Lexa Forge machine listener — ${machineId}`);
  console.log(`  Polling ${config.url} every ${EVENT_POLL_MS}ms. Press Ctrl-C to stop.`);

  for (;;) {
    try {
      if (Date.now() - lastCatalogRefreshAt >= CATALOG_REFRESH_MS) void refreshCatalogs();
      const heartbeat = await client.machineHeartbeat({
        id: machineId,
        hostname: machineHostname,
        ...(catalogsDirty ? { runtimes: catalogs } : {}),
      });
      if (catalogsDirty && heartbeat) catalogsDirty = false;
      const claim = await client.claimRuntimeEvent(machineId);
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
      STATUS: machine.lastSeen ? "online" : "offline",
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
      NAME: runtime.name,
      AGENT: runtime.provider,
      MODEL: runtime.model || "—",
      HOST: runtime.hostname || "—",
      STATUS: runtime.status,
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
