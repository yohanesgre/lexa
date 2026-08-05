#!/usr/bin/env bun
/**
 * Forge daemon — the multica-style runtime for Lexa.
 *
 * Runs on a machine with an agent CLI installed (opencode or hermes),
 * registers itself with the Lexa server, polls for Forge tasks, spawns the
 * agent CLI in one-shot mode per task, and reports the result back.
 *
 * Env:
 *   LEXA_URL            server base URL (default http://localhost:3000)
 *   LEXA_API_KEY        server API key (Bearer) — or LXK_FORGE_DAEMON_TOKEN
 *   LXK_FORGE_DAEMON_TOKEN  shared secret (sent as x-forge-token)
 *   FORGE_AGENT         opencode | hermes | command-code (default: opencode)
 *   FORGE_MODEL         bootstrap model id; the server's runtime row config
 *                       (Settings → Edit runtime) overrides it at spawn time
 *   FORGE_RUNTIME_NAME  human name for this runtime (default: hostname)
 *   FORGE_RUNTIME_ID    stable runtime id managed by the CLI listener
 *   FORGE_MACHINE_ID    stable machine id managed by the CLI listener
 *   FORGE_POLL_MS       poll interval (default 3000)
 *
 * Run: bun run forge:daemon
 */
import { spawn } from "node:child_process";
import { hostname as osHostname } from "node:os";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { classifyLogLine } from "../../shared/forge-log";
import { join } from "node:path";

// ── Machine state root ──
// Everything the host stores lives under LEXA_DIR (~/.lexa by default):
// config.json (login creds), machine-id, env (bootstrap), runtimes/<id>/env
// (per-runtime, written by the listener), projects/ (per-project workspaces,
// provisioned by the listener from the heartbeat project index), and runs/
// (legacy per-task workdirs for non-opencode providers).
// The listener migrates the legacy ~/.config/lexa-cli + ~/.config/lexa-forge
// dirs into here on boot (migrate-and-delete, no fallback).
const LEXA_DIR = process.env.LEXA_DIR ?? join(process.env.HOME ?? "", ".lexa");

// ── Credential resolution ──
// Priority: process env → ~/.lexa/config.json (saved `lexa-cli login`) →
// the per-runtime env written by the CLI listener. This makes a manual
// `bun run daemon.ts` work even when the shell has no LEXA_* vars, matching
// what the systemd unit gets via EnvironmentFile.
function readJson(path: string): Record<string, string> | null {
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Record<string, string>;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}
function readEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    if (!existsSync(path)) return out;
    for (const line of readFileSync(path, "utf-8").split("\n")) {
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
  } catch { /* ignore */ }
  return out;
}
function readTextFile(path: string): string {
  try {
    return existsSync(path) ? readFileSync(path, "utf-8").trim() : "";
  } catch {
    return "";
  }
}
const cliConfig = readJson(join(LEXA_DIR, "config.json"));
const forgeEnv = readEnvFile(join(LEXA_DIR, "env"));
const persistedMachineId = readTextFile(join(LEXA_DIR, "machine-id"));

const SERVER = process.env.LEXA_URL || forgeEnv.LEXA_URL || cliConfig?.url || "http://localhost:3000";
const API_KEY = process.env.LEXA_API_KEY || forgeEnv.LEXA_API_KEY || cliConfig?.apiKey || "";
const DAEMON_TOKEN = process.env.LXK_FORGE_DAEMON_TOKEN || forgeEnv.LXK_FORGE_DAEMON_TOKEN || "";

// Server-issued API keys (Settings → API Keys) always start with "lxk_".
// A Settings key may arrive in either env var — the daemon shared secret
// (LXK_FORGE_DAEMON_TOKEN) is a plain hex value. If the "daemon token" is
// actually an API key, use it as the Bearer credential instead of sending
// it as x-forge-token (which the server rejects — it only equals its own
// LXK_FORGE_DAEMON_TOKEN secret).
const isApiKey = (v: string) => v.startsWith("lxk_");
const BEARER_KEY = API_KEY || (DAEMON_TOKEN && isApiKey(DAEMON_TOKEN) ? DAEMON_TOKEN : "");
const X_FORGE_TOKEN = DAEMON_TOKEN && !isApiKey(DAEMON_TOKEN) ? DAEMON_TOKEN : "";
const AGENT = (process.env.FORGE_AGENT ?? "opencode") as "opencode" | "hermes" | "command-code";
// MCP is the cloud-agent surface (hermes drives Lexa through the `lexa` MCP
// server). Local CLI agents (opencode, command-code) run Forge on the CLI
// directly — for them the MCP probe is noise and is skipped entirely.
const NEEDS_MCP = AGENT === "hermes";
const MODEL = process.env.FORGE_MODEL ?? "";
const RUNTIME_NAME = process.env.FORGE_RUNTIME_NAME ?? `${osHostname()}-${AGENT}`;
const MACHINE_ID = process.env.FORGE_MACHINE_ID || persistedMachineId;
const CONFIGURED_RUNTIME_ID = process.env.FORGE_RUNTIME_ID ?? "";
const POLL_MS = Number(process.env.FORGE_POLL_MS ?? 3000);
// Max wall-clock time for one agent run. A hung agent CLI (provider outage,
// model stall) must not pin the runtime forever; the server-side cancel poll
// still handles explicit user cancels. Override with FORGE_RUN_TIMEOUT_MS.
const RUN_TIMEOUT_MS = (() => {
  const v = Number(process.env.FORGE_RUN_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 900_000;
})();
// Per-task workdirs under the machine state root — ephemeral by design:
// seeded from the claim payload, cleaned up after every run. Only used by
// non-opencode providers (opencode runs from the persistent project
// workspace with a sealed per-run HOME instead).
const WORKDIR_ROOT = join(LEXA_DIR, "runs");

// Project workspaces — one persistent dir per project, provisioned by the
// listener (README.md + orchestrator AGENTS.md). opencode runs from the
// workspace root; per-agent rule bundles + skills are written under
// .agents/ at claim time; the per-run sandbox HOME lives under .forge/.
const WORKSPACE_ROOT = join(LEXA_DIR, "projects");

// Project index written by the listener from the server heartbeat payload —
// maps projectId → { name, slug, description } for friendly logs without a
// server round-trip. Absent/stale index degrades to id-only logs.
const projectIndex: Record<string, { name: string; slug: string; description: string }> = (() => {
  try {
    const raw = readTextFile(join(LEXA_DIR, "projects.json"));
    return raw ? (JSON.parse(raw) as Record<string, { name: string; slug: string; description: string }>) : {};
  } catch {
    return {};
  }
})();

const CMD_BIN = process.env.FORGE_CMD_BIN ?? "cmd";

if (!BEARER_KEY && !X_FORGE_TOKEN) {
  console.error("No credential found. Set LEXA_API_KEY (server API key) or LXK_FORGE_DAEMON_TOKEN (shared secret),");
  console.error("or log in first with `lexa-cli login --url <base> --key <lxk_...>` — the daemon falls back to that saved config.");
  process.exit(1);
}

if (!MACHINE_ID) {
  console.error("No machine id found. Run `lexa-cli machine listen` after login so this daemon can register.");
  process.exit(1);
}

interface ForgeTask {
  id: string;
  projectId: string;
  documentType: "task" | "wiki";
  documentId: string;
  agentId: string;
  agentName: string;
  skillId: string;
  skillName: string;
  selection: string;
  docContext: string;
  status: string;
  result: string | null;
  error: string | null;
}

// Per-request timeouts — a stalled server must not hang registration,
// heartbeats, claims, or the MCP probe forever.
const HTTP_TIMEOUT_MS = 15_000;
const MCP_TIMEOUT_MS = 5_000;

async function api(path: string, init?: RequestInit): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (X_FORGE_TOKEN) headers["x-forge-token"] = X_FORGE_TOKEN;
  else if (BEARER_KEY) headers["Authorization"] = `Bearer ${BEARER_KEY}`;
  const res = await fetch(`${SERVER}${path}`, { ...init, headers, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  if (res.status === 401) {
    // The runtime's API key was revoked/rotated. The listener won't respawn
    // us (exit code 3 = auth failure); re-run Setup runtime for a fresh key.
    console.error("  API key revoked or invalid (HTTP 401) — re-run Setup runtime (Settings → Forge Runtimes).");
    process.exit(3);
  }
  return res;
}

// Streamable-HTTP MCP handshake against the Lexa server — the runtime
// agent's only way to touch Lexa is the `lexa` MCP server, so it must be
// connected before any task runs. Returns an error string when the endpoint
// is unreachable or rejects auth, null when it responds. Skipped when the
// daemon only has a shared token (nothing to authenticate to /mcp with) —
// the agent-side ERROR_MCP_UNAVAILABLE sentinel still guards those runs.
async function checkMcpConnection(): Promise<string | null> {
  if (!BEARER_KEY) return null;
  const url = `${SERVER}/mcp`;
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${BEARER_KEY}`,
  };
  try {
    const init = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "lexa-forge-daemon", version: "0.1.0" },
        },
      }),
      signal: AbortSignal.timeout(MCP_TIMEOUT_MS),
    });
    if (!init.ok) return `initialize HTTP ${init.status}`;
    const parsed = (await init.json()) as { error?: { message?: string } };
    if (parsed.error) return parsed.error.message ?? "initialize rejected";
    const ping = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }),
      signal: AbortSignal.timeout(MCP_TIMEOUT_MS),
    });
    if (!ping.ok) return `ping HTTP ${ping.status}`;
  } catch (e) {
    return (e as Error).message;
  }
  return null;
}

async function main() {
  mkdirSync(WORKDIR_ROOT, { recursive: true });

  console.log(`── Forge daemon ──`);
  console.log(`  Server:   ${SERVER}`);
  console.log(`  Agent:    ${AGENT}${MODEL ? ` (${MODEL})` : ""}`);
  console.log(`  Runtime:  ${RUNTIME_NAME}`);
  console.log(`  Poll:     ${POLL_MS}ms`);

  // Register
  let runtimeId = CONFIGURED_RUNTIME_ID;
  try {
    const res = await api("/api/forge/runtimes/register", {
      method: "POST",
      body: JSON.stringify({
        id: CONFIGURED_RUNTIME_ID || undefined,
        name: RUNTIME_NAME,
        provider: AGENT,
        machineId: MACHINE_ID,
        model: MODEL,
        hostname: osHostname(),
      }),
    });
    if (!res.ok) throw new Error(`register failed: ${res.status} ${await res.text()}`);
    const runtime = (await res.json()) as { id: string };
    runtimeId = runtime.id;
    console.log(`  Registered: ${runtimeId}`);
    if (NEEDS_MCP) {
      const mcpErr = await checkMcpConnection();
      console.log(`  MCP: ${mcpErr ? `not connected (${mcpErr})` : "connected"}`);
    } else {
      console.log("  MCP: skipped (CLI agent)");
    }
  } catch (e) {
    console.error(`Could not register with ${SERVER}:`, (e as Error).message);
    console.error(`Is the server running? Start it with \`bun run dev:server\` or \`bun run dev:full\`.`);
    process.exit(1);
  }

  // Heartbeat loop — reports liveness and the daemon's Lexa MCP connectivity.
  // Catalog discovery belongs to the parent lexa-cli listener.
  setInterval(() => {
    void (async () => {
      const body: Record<string, unknown> = { runtimeId };
      body.mcpConnected = NEEDS_MCP ? (await checkMcpConnection()) === null : false;
      api("/api/forge/daemon/heartbeat", {
        method: "POST",
        body: JSON.stringify(body),
      }).catch(() => {});
    })();
  }, 15_000).unref();

  // Poll loop
  console.log("  Waiting for Forge tasks…");
  for (;;) {
    try {
      const res = await api("/api/forge/daemon/claim", {
        method: "POST",
        body: JSON.stringify({ runtimeId }),
      });
      if (res.ok) {
        const claim = (await res.json()) as { task: ForgeTask | null; provider: string; agent: string; model: string; printLogs: boolean; logLevel: string; extraArgs: string[]; prompt: string; agentMarkdown: string; skillMarkdown: string; skillIds: string[] };
        if (claim.task) {
          await runTask(claim.task, claim.provider, claim.agent, claim.model, claim.logLevel, claim.extraArgs, claim.prompt, claim.agentMarkdown, claim.skillMarkdown, claim.skillIds ?? []);
        }
      }
    } catch (e) {
      console.error("[poll]", (e as Error).message);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

// opencode ≥1.18 requires full "provider/model" ids — bare ids fail with
// "Unexpected server error". Bare ids can still reach us via FORGE_MODEL env
// or a custom entry, so resolve them against the live catalog first.
function resolveModelId(model: string): string {
  if (!model || model.includes("/")) return model;
  return model;
}

async function logTask(taskId: string, message: string, meta: { stream?: "out" | "err"; level?: "info" | "warn" | "error" } = {}) {
  api(`/api/forge/daemon/tasks/${taskId}/log`, {
    method: "POST",
    body: JSON.stringify({ message, ...(meta.stream ? { stream: meta.stream } : {}), ...(meta.level ? { level: meta.level } : {}) }),
  }).catch(() => {});
}

// Persistent rule bundles: the selected lexa-agent's instructions become
// .agents/agents/<agentId>/AGENTS.md and the skill becomes
// .agents/skills/<skillId>/SKILL.md (with discovery frontmatter — name +
// description). Written/overwritten per claim from the server payload, never
// deleted; the static orchestrator AGENTS.md + the prompt name the active
// bundle each run. Path + frontmatter match opencode's skill discovery
// (.agents/skills/<name>/SKILL.md).
function writeRuleBundles(workspace: string, task: ForgeTask, agentMarkdown: string, skillMarkdown: string) {
  try {
    if (agentMarkdown) {
      const agentDir = join(workspace, ".agents", "agents", task.agentId);
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(join(agentDir, "AGENTS.md"), agentMarkdown, { mode: 0o644 });
    }
    if (skillMarkdown) {
      const skillDir = join(workspace, ".agents", "skills", task.skillId);
      mkdirSync(skillDir, { recursive: true });
      const frontmatter = `---\nname: ${task.skillId}\ndescription: ${task.skillName}\n---\n\n`;
      writeFileSync(join(skillDir, "SKILL.md"), frontmatter + skillMarkdown, { mode: 0o644 });
    }
  } catch (e) {
    console.warn(`[task ${task.id}] could not write rule bundles: ${(e as Error).message}`);
  }
}

// opencode auto-discovers EVERY skill bundle under .agents/skills/, so stale
// dirs (renamed/deleted skills) still get read into runs. The claim carries
// the server's current skill-id set; remove any dir not in it. Race-free:
// concurrent runtimes share the same current set, so only obsolete ids are
// ever removed.
function pruneStaleSkillDirs(workspace: string, skillIds: string[]) {
  if (skillIds.length === 0) return; // empty set = server error; never wipe on it
  const dir = join(workspace, ".agents", "skills");
  if (!existsSync(dir)) return;
  const known = new Set(skillIds);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && !known.has(entry.name)) {
      try {
        rmSync(join(dir, entry.name), { recursive: true, force: true });
        console.log(`  [bundle] pruned stale skill dir .agents/skills/${entry.name}`);
      } catch (e) {
        console.warn(`  [bundle] could not prune .agents/skills/${entry.name}: ${(e as Error).message}`);
      }
    }
  }
}

// Sealed per-run HOME at the workspace's .forge/ dir: the only config
// opencode loads is the deny-rule opencode.json — the global config
// (permission: allow, MCP servers, plugins) never reaches the agent — and
// provider auth is copied from the real HOME so runs can authenticate.
// .forge/ is daemon-owned exclusively (workspace root is operator-owned,
// .agents/ + seeds persist); it is wiped before seeding so every run starts
// pristine even after a crash, and removed when the run ends. Safe to share
// across runs: one runtime per agent CLI per machine claims one task at a
// time, so .forge/ is never in use concurrently.
function seedSandboxHome(workspace: string): string {
  const home = join(workspace, ".forge");
  rmSync(home, { recursive: true, force: true });
  const configDir = join(home, ".config", "opencode");
  const dataDir = join(home, ".local", "share", "opencode");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  // Containment model (empirically verified against opencode 1.18.11):
  // `external_directory: deny` is the geometric boundary — evaluated on the
  // RESOLVED path for read/edit/write/glob/grep, it blocks everything outside
  // the workspace regardless of relative/absolute form. File tools are
  // therefore permissive inside (relative paths work); bash cannot be
  // path-scoped so it is fully denied. The `skill` tool is denied because
  // opencode discovers the host's GLOBAL skills (~/.agents, ~/.config/opencode
  // — resolved via os.homedir, not $HOME) into every run: hiding them keeps
  // the personal skill library out of Forge context (the run's skill is read
  // from the workspace directly). `webfetch` is denied — Forge output is the
  // document text; the model has no reason to touch the network.
  // auth.json copies are the only sensitive file inside the workspace —
  // explicitly denied.
  writeFileSync(
    join(configDir, "opencode.json"),
    JSON.stringify(
      {
        permission: {
          bash: { "*": "deny" },
          skill: { "*": "deny" },
          webfetch: "deny",
          read: { "*auth.json*": "deny", "*": "allow" },
          edit: { "*": "allow" },
          write: { "*": "allow" },
          glob: { "*": "allow" },
          grep: { "*": "allow" },
          external_directory: "deny",
        },
      },
      null,
      2
    ),
    { mode: 0o644 }
  );
  const realAuth = join(process.env.HOME ?? "", ".local", "share", "opencode", "auth.json");
  try {
    if (existsSync(realAuth)) copyFileSync(realAuth, join(dataDir, "auth.json"));
  } catch (e) {
    console.warn(`  [sandbox] auth copy failed: ${(e as Error).message}`);
  }
  return home;
}

async function runTask(task: ForgeTask, serverProvider: string, serverAgent: string, serverModel: string, serverLogLevel: string, extraArgs: string[], serverPrompt: string, agentMarkdown: string, skillMarkdown: string, skillIds: string[] = []) {
  console.log(`\n[task ${task.id}] ${task.skillName} — ${task.documentType}:${task.documentId}`);

  // Server-authoritative config: agent (provider) + agent persona + model +
  // injected args from the runtime row (edited in Settings), env values as
  // fallback. The provider decides WHICH CLI is spawned; agent (opencode
  // --agent build/plan) selects the persona inside that CLI. Editing either
  // switches the runtime without restarting the daemon.
  const provider = (serverProvider || AGENT) as "opencode" | "hermes" | "command-code";
  const agentFlag = serverAgent || "";
  const model = resolveModelId(serverModel || MODEL);
  console.log(`  Config: ${provider}${agentFlag ? ` --agent ${agentFlag}` : ""} · ${model}${extraArgs.length ? ` + ${extraArgs.join(" ")}` : ""}`);

  // opencode runs from the persistent project workspace (rules as static
  // bundles, sealed per-run HOME); other providers keep the legacy
  // ephemeral run-dir layout.
  const isOpencode = provider === "opencode";
  let workdir: string;
  let sandboxHome: string | null = null;
  if (isOpencode) {
    workdir = join(WORKSPACE_ROOT, task.projectId);
    mkdirSync(workdir, { recursive: true });
    const projName = projectIndex[task.projectId]?.name;
    console.log(`  Workspace: ${task.projectId}${projName ? ` (${projName})` : ""}`);
    pruneStaleSkillDirs(workdir, skillIds);
    writeRuleBundles(workdir, task, agentMarkdown, skillMarkdown);
    sandboxHome = seedSandboxHome(workdir);
  } else {
    workdir = join(WORKDIR_ROOT, task.id);
    mkdirSync(workdir, { recursive: true });
    // Legacy claim-carried rule files: AGENTS.md + .agents/<skill>/SKILL.md
    // in the ephemeral run dir, removed with it after the run.
    try {
      if (agentMarkdown) {
        writeFileSync(join(workdir, "AGENTS.md"), agentMarkdown, { mode: 0o644 });
      }
      if (skillMarkdown) {
        const skillDir = join(workdir, ".agents", "skills", task.skillId);
        mkdirSync(skillDir, { recursive: true });
        writeFileSync(join(skillDir, "SKILL.md"), skillMarkdown, { mode: 0o644 });
      }
    } catch (e) {
      console.warn(`[task ${task.id}] could not write rule files: ${(e as Error).message}`);
    }
  }

  // The server builds the authoritative prompt (resolves linked sources,
  // enforces output rules) and sends it with the claim. Fall back to a local
  // minimal build only when the server sent an empty one.
  const prompt = serverPrompt || [
    `Agent: ${task.agentName || task.agentId} (id ${task.agentId}) — read .agents/agents/${task.agentId}/AGENTS.md and follow it exactly.`,
    `Skill: ${task.skillName || task.skillId} (id ${task.skillId}) — read .agents/skills/${task.skillId}/SKILL.md and follow it exactly.`,
    task.docContext,
    task.selection ? `Selected text:\n"""\n${task.selection}\n"""` : "",
    `Task: ${task.skillName}`,
    "Your working directory contains AGENTS.md (project rules) and .agents/ (your rules and skills) — follow them.",
    "Output ONLY the requested text — no narration, no explanations.",
    "Return Markdown. Preserve the document's existing structure and inline formatting (headings, lists, task lists, bold/italic, code spans, code fences) and mirror the selection's style exactly.",
    "Make it beautiful: use ## / ### headings (never H1), short scannable paragraphs, bullet lists for parallel points, numbered lists for steps, task lists for checklists, bold key terms, code spans for technical names, and fenced code blocks with a language tag (```ts, ```sql, ```bash).",
    "Never wrap the whole output in a markdown fence.",
  ].filter(Boolean).join("\n\n");

  try {
    logTask(task.id, `claimed by ${RUNTIME_NAME}`);
    logTask(task.id, `model ${model}`);
    logTask(task.id, "agent started");
    logTask(task.id, "reading document context");
    // Poll the task's status while the agent runs so a server-side cancel
    // (user clicked Cancel in the UI) aborts the child process instead of
    // letting it run to completion and discard the result.
    const CANCEL_POLL_MS = 2000;
    const output = await runAgentWithCancel(prompt, workdir, provider, agentFlag, model, serverLogLevel, extraArgs, task.id, sandboxHome, CANCEL_POLL_MS);
    if (output.startsWith("ERROR_MCP_UNAVAILABLE")) {
      throw new Error(output);
    }
    logTask(task.id, "generating text…");
    const res = await api(`/api/forge/daemon/tasks/${task.id}/complete`, {
      method: "POST",
      body: JSON.stringify({ result: output }),
    });
    if (!res.ok) throw new Error(`complete failed: ${res.status}`);
    logTask(task.id, `done (${output.length} chars)`);
    console.log(`[task ${task.id}] completed (${output.length} chars)`);
  } catch (e) {
    const msg = (e as Error).message;
    // A user cancel is not a failure — the row is already 'cancelled'
    // server-side, so skip the fail round-trip and log the cancel.
    if (msg === "cancelled") {
      console.log(`[task ${task.id}] cancelled — agent process killed`);
      logTask(task.id, "cancelled");
      return;
    }
    console.error(`[task ${task.id}] failed: ${msg}`);
    logTask(task.id, `failed: ${msg.slice(0, 200)}`);
    await api(`/api/forge/daemon/tasks/${task.id}/fail`, {
      method: "POST",
      body: JSON.stringify({ error: msg }),
    }).catch(() => {});
  } finally {
    // opencode: remove the sealed sandbox HOME (.forge/ — daemon-owned, wiped
    // + reseeded each run) — the workspace root, seeds, and persistent rule
    // bundles stay. Legacy providers: the whole ephemeral run dir is removed
    // (Artifact retention is backlogged).
    if (sandboxHome) {
      rmSync(sandboxHome, { recursive: true, force: true });
    } else {
      rmSync(workdir, { recursive: true, force: true });
    }
  }
}

function runAgent(prompt: string, cwd: string, provider: "opencode" | "hermes" | "command-code", agent: string, model: string, logLevel: string, extraArgs: string[], taskId: string, sandboxHome: string | null, onSpawn?: (child: ReturnType<typeof spawn>) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    let bin = provider;
    let args: string[];
    if (provider === "opencode") {
      // opencode ≥1.18: `run` is the non-interactive one-shot (--print was
      // removed). Full "provider/model" ids are accepted by --model; --agent
      // selects the agent persona (build, plan, ...) when configured.
      // --print-logs + --log-level are server-configured logging flags.
      args = ["run", prompt, ...(agent ? ["--agent", agent] : []), ...(model ? ["--model", model] : [])];
      // Forge always captures opencode's diagnostic stderr stream into the
      // activity log. `--log-level` only changes its verbosity.
      args.push("--print-logs");
      if (logLevel) args.push("--log-level", logLevel);
    } else if (provider === "command-code") {
      // Command Code: non-interactive print mode, no session persistence,
      // skip onboarding, auto-accept so it doesn't stall on permission prompts.
      bin = CMD_BIN;
      args = ["-p", prompt, ...(model ? ["--model", model] : []), "--no-session", "--skip-onboarding", "--permission-mode", "auto-accept", "--no-auto-update"];
    } else {
      // hermes: fall back to a plain stdin prompt if no one-shot flag exists.
      args = ["-p", prompt, ...(model ? ["--model", model] : [])];
    }
    // Server-injected args (Settings → Edit runtime). Passed verbatim — spawn
    // never goes through a shell, so there is no shell-injection surface.
    args = args.concat(extraArgs);

    const cmdline = args.map((a) => (a.length > 60 ? `${a.slice(0, 60)}…` : a)).join(" ");
    console.log(`  $ ${bin} ${cmdline}`);
    logTask(taskId, `$ ${bin} ${cmdline}`);
    const childEnv: Record<string, string | undefined> = {
      ...process.env,
      // LEXA_API_KEY must NOT reach the agent — opencode ≥1.18 treats it as
      // its own server auth key and every run fails with "Unexpected server
      // error". Forge runs on the prompt alone (no Lexa MCP tool calls), so
      // the agent needs no Lexa credentials.
    };
    delete childEnv.LEXA_API_KEY;
    // PWD must match the spawn cwd: opencode resolves its session/project
    // directory from env.PWD, and a stale inherited PWD (the daemon's own
    // launch dir) makes it treat the real workspace as "external" — which
    // the external_directory deny then blocks. Without this, agents cannot
    // read project files at all.
    childEnv.PWD = cwd;
    // Sealed per-run HOME (opencode): agent config/state/auth live inside the
    // sandbox and die with the run. The global opencode config — permissions,
    // MCP servers, plugins — never loads; the deny-rule opencode.json seeded
    // into the sandbox is the only config the agent gets.
    if (sandboxHome) {
      childEnv.HOME = sandboxHome;
      childEnv.XDG_CONFIG_HOME = join(sandboxHome, ".config");
      childEnv.XDG_DATA_HOME = join(sandboxHome, ".local", "share");
      childEnv.XDG_CACHE_HOME = join(sandboxHome, ".cache");
      childEnv.XDG_STATE_HOME = join(sandboxHome, ".local", "state");
    }
    const child = spawn(bin, args, {
      cwd,
      env: childEnv as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
      // Detached makes the child its own process-group leader, so a cancel
      // can kill the whole tree (process.kill(-pid)) — including any
      // grandchildren the agent CLI spawns (opencode tools, etc.).
      detached: true,
    });
    onSpawn?.(child);

    let stdout = "";
    let stderr = "";

    // Verbose streaming: tee the agent's stdout/stderr into the task log as
    // it arrives. Lines are batched and flushed every STREAM_FLUSH_MS so a
    // chatty agent doesn't POST per line. stream + level are classified ONCE
    // here (shared/forge-log.ts — stderr ≠ error; retries/rate-limits land in
    // warn) and stored; the UI renders the stored level. The [stderr]/▸
    // markers still prefix the raw message so Copy output is unchanged.
    const STREAM_FLUSH_MS = 300;
    const LINE_CAP = 500;
    const pending: Array<{ message: string; stream: "out" | "err"; level: "info" | "warn" | "error" }> = [];
    const buffers: Record<"out" | "err", string> = { out: "", err: "" };
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    const flush = () => {
      if (pending.length === 0) return;
      const batch = pending.splice(0, pending.length);
      for (const line of batch) logTask(taskId, line.message.slice(0, LINE_CAP), { stream: line.stream, level: line.level });
    };
    const scheduleFlush = () => {
      if (flushTimer) return;
      flushTimer = setTimeout(() => {
        flushTimer = null;
        flush();
      }, STREAM_FLUSH_MS);
    };
    const tee = (stream: "out" | "err", chunk: Buffer) => {
      buffers[stream] += chunk.toString();
      let nl: number;
      while ((nl = buffers[stream].indexOf("\n")) >= 0) {
        const raw = buffers[stream].slice(0, nl).trim();
        buffers[stream] = buffers[stream].slice(nl + 1);
        if (!raw) continue;
        const message = stream === "err" ? `[stderr] ${raw}` : `▸ ${raw}`;
        pending.push({ message, stream, level: classifyLogLine(stream, raw).level });
      }
      scheduleFlush();
    };

    child.stdout.on("data", (d) => { stdout += d.toString(); tee("out", d); });
    child.stderr.on("data", (d) => { stderr += d.toString(); tee("err", d); });

    child.on("error", (e) => { flush(); reject(new Error(`spawn ${bin}: ${e.message}`)); });
    child.on("close", (code) => {
      // Drain any partial trailing line, then flush the batch.
      for (const stream of ["out", "err"] as const) {
        const raw = buffers[stream].trim();
        if (raw) {
          const message = stream === "err" ? `[stderr] ${raw}` : `▸ ${raw}`;
          pending.push({ message, stream, level: classifyLogLine(stream, raw).level });
        }
      }
      flush();
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      const trimmed = stdout.trim();
      if (code === 0 && trimmed) {
        resolve(trimmed);
      } else {
        const errTail = stderr.trim().slice(-4000);
        reject(new Error(errTail || `agent exited with code ${code} and no output`));
      }
    });
  });
}

// Run the agent, polling the server for a cancel while it works. When the
// user cancels the task (POST /api/forge/tasks/:id/cancel flips the row to
// 'cancelled'), kill the child so the orphaned agent process doesn't keep
// running. Throws an Error("cancelled") so runTask's catch logs it and skips
// the complete/fail round-trips.
function runAgentWithCancel(prompt: string, cwd: string, provider: "opencode" | "hermes" | "command-code", agent: string, model: string, logLevel: string, extraArgs: string[], taskId: string, sandboxHome: string | null, pollMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn> | null = null;
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    const run = runAgent(prompt, cwd, provider, agent, model, logLevel, extraArgs, taskId, sandboxHome, (c) => { child = c; });
    const timeout = setTimeout(() => {
      clearInterval(timer);
      if (child && child.pid) {
        try { process.kill(child.pid, "SIGTERM"); } catch { /* already gone */ }
        // Grace for the agent to clean up, then force-kill the tree.
        setTimeout(() => {
          if (child.pid) killTree(child.pid);
        }, 1500).unref?.();
      }
      finish(() => reject(new Error(`run timed out after ${Math.round(RUN_TIMEOUT_MS / 1000)}s`)));
    }, RUN_TIMEOUT_MS);
    timeout.unref?.();
    run.then(
      (out) => { clearTimeout(timeout); finish(() => resolve(out)); },
      (err) => { clearTimeout(timeout); finish(() => reject(err)); }
    );

    // Poll the task's status while the agent runs; cancel wins over a late
    // completion. Kill the child and its whole descendant tree — agent CLIs
    // (opencode, cmd) spawn their own tool processes. We walk /proc for
    // descendants rather than relying on process groups, which are unreliable
    // depending on how the daemon itself was launched (nohup, setsid, ...).
    const killTree = (pid: number) => {
      const collect = (root: number): number[] => {
        const out: number[] = [];
        for (const entry of readdirSync("/proc")) {
          if (!/^\d+$/.test(entry)) continue;
          let ppid = -1;
          try {
            ppid = Number(readFileSync(`/proc/${entry}/stat`, "utf8").split(" ")[3]);
          } catch { continue; }
          if (ppid === root) out.push(Number(entry), ...collect(Number(entry)));
        }
        return out;
      };
      const all = [pid, ...collect(pid)];
      for (const p of all.reverse()) {
        try { process.kill(p, "SIGKILL"); } catch { /* already gone */ }
      }
    };
    const timer = setInterval(async () => {
      if (settled) { clearInterval(timer); return; }
      try {
        const res = await api(`/api/forge/daemon/tasks/${taskId}/status`);
        if (res.ok) {
          const body = (await res.json()) as { status: string };
          if (body.status === "cancelled") {
            clearInterval(timer);
            clearTimeout(timeout);
            if (child && child.pid) {
              try { process.kill(child.pid, "SIGTERM"); } catch { /* already gone */ }
              // Grace for the agent to clean up, then force-kill the tree.
              setTimeout(() => {
                if (child.pid) killTree(child.pid);
              }, 1500).unref?.();
            }
            finish(() => reject(new Error("cancelled")));
          }
        }
      } catch {
        // Poll failure is non-fatal — the run continues; a later cancel may
        // still be observed.
      }
    }, pollMs);
    timer.unref?.();
  });
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
