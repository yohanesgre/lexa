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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ── Machine state root ──
// Everything the host stores lives under LEXA_DIR (~/.lexa by default):
// config.json (login creds), machine-id, env (bootstrap), runtimes/<id>/env
// (per-runtime, written by the listener), and runs/ (per-task workdirs).
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
const MODEL = process.env.FORGE_MODEL ?? "";
const RUNTIME_NAME = process.env.FORGE_RUNTIME_NAME ?? `${osHostname()}-${AGENT}`;
const MACHINE_ID = process.env.FORGE_MACHINE_ID || persistedMachineId;
const CONFIGURED_RUNTIME_ID = process.env.FORGE_RUNTIME_ID ?? "";
const POLL_MS = Number(process.env.FORGE_POLL_MS ?? 3000);
// Per-task workdirs under the machine state root — ephemeral by design:
// seeded from the claim payload, cleaned up after every run.
const WORKDIR_ROOT = join(LEXA_DIR, "runs");

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
  documentType: "task" | "wiki";
  documentId: string;
  agentId: string;
  skillId: string;
  skillName: string;
  selection: string;
  docContext: string;
  status: string;
  result: string | null;
  error: string | null;
}

async function api(path: string, init?: RequestInit): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (X_FORGE_TOKEN) headers["x-forge-token"] = X_FORGE_TOKEN;
  else if (BEARER_KEY) headers["Authorization"] = `Bearer ${BEARER_KEY}`;
  return fetch(`${SERVER}${path}`, { ...init, headers });
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
    });
    if (!init.ok) return `initialize HTTP ${init.status}`;
    const parsed = (await init.json()) as { error?: { message?: string } };
    if (parsed.error) return parsed.error.message ?? "initialize rejected";
    const ping = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }),
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
    const mcpErr = await checkMcpConnection();
    console.log(`  MCP: ${mcpErr ? `not connected (${mcpErr}) — informational; Forge runs on the agent CLI directly, MCP is only needed for cloud agents` : "connected"}`);
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
      body.mcpConnected = (await checkMcpConnection()) === null;
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
        const claim = (await res.json()) as { task: ForgeTask | null; provider: string; agent: string; model: string; printLogs: boolean; logLevel: string; extraArgs: string[]; prompt: string; agentMarkdown: string; skillMarkdown: string };
        if (claim.task) {
          await runTask(claim.task, claim.provider, claim.agent, claim.model, claim.printLogs, claim.logLevel, claim.extraArgs, claim.prompt, claim.agentMarkdown, claim.skillMarkdown);
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

async function logTask(taskId: string, message: string) {
  api(`/api/forge/daemon/tasks/${taskId}/log`, {
    method: "POST",
    body: JSON.stringify({ message }),
  }).catch(() => {});
}

async function runTask(task: ForgeTask, serverProvider: string, serverAgent: string, serverModel: string, serverPrintLogs: boolean, serverLogLevel: string, extraArgs: string[], serverPrompt: string, agentMarkdown: string, skillMarkdown: string) {
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

  const workdir = join(WORKDIR_ROOT, task.id);
  mkdirSync(workdir, { recursive: true });

  // Claim-carried rule files: the server sends the task's agent + skill
  // instructions as Markdown; we write them into the run dir so AGENTS.md-
  // capable CLIs (opencode) read them natively. No host store, no fetch —
  // this payload is always current.
  try {
    if (agentMarkdown) {
      writeFileSync(join(workdir, "AGENTS.md"), agentMarkdown, { mode: 0o644 });
    }
    if (skillMarkdown) {
      const skillDir = join(workdir, ".agents", task.skillId);
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, "SKILL.md"), skillMarkdown, { mode: 0o644 });
    }
  } catch (e) {
    console.warn(`[task ${task.id}] could not write rule files: ${(e as Error).message}`);
  }

  // The server builds the authoritative prompt (resolves linked sources,
  // enforces output rules) and sends it with the claim. Fall back to a local
  // minimal build only when the server sent an empty one.
  const prompt = serverPrompt || [
    task.docContext,
    task.selection ? `Selected text:\n"""\n${task.selection}\n"""` : "",
    `Task: ${task.skillName}`,
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
    const output = await runAgentWithCancel(prompt, workdir, provider, agentFlag, model, serverPrintLogs, serverLogLevel, extraArgs, task.id, CANCEL_POLL_MS);
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
    // Ephemeral by design: the run dir (rules + any agent output) is removed
    // after the run. Artifact retention is backlogged.
    rmSync(workdir, { recursive: true, force: true });
  }
}

function runAgent(prompt: string, cwd: string, provider: "opencode" | "hermes" | "command-code", agent: string, model: string, printLogs: boolean, logLevel: string, extraArgs: string[], taskId: string, onSpawn?: (child: ReturnType<typeof spawn>) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    let bin = provider;
    let args: string[];
    if (provider === "opencode") {
      // opencode ≥1.18: `run` is the non-interactive one-shot (--print was
      // removed). Full "provider/model" ids are accepted by --model; --agent
      // selects the agent persona (build, plan, ...) when configured.
      // --print-logs + --log-level are server-configured logging flags.
      args = ["run", prompt, ...(agent ? ["--agent", agent] : []), ...(model ? ["--model", model] : [])];
      if (printLogs) args.push("--print-logs");
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
    // chatty agent doesn't POST per line. stderr lines are prefixed [stderr]
    // so the UI can tint them. Line cap keeps each row small.
    const STREAM_FLUSH_MS = 300;
    const LINE_CAP = 500;
    const pending: string[] = [];
    const buffers: Record<"out" | "err", string> = { out: "", err: "" };
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    const flush = () => {
      if (pending.length === 0) return;
      const batch = pending.splice(0, pending.length);
      for (const line of batch) logTask(taskId, line.slice(0, LINE_CAP));
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
        pending.push(stream === "err" ? `[stderr] ${raw}` : `▸ ${raw}`);
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
        if (raw) pending.push(stream === "err" ? `[stderr] ${raw}` : `▸ ${raw}`);
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
function runAgentWithCancel(prompt: string, cwd: string, provider: "opencode" | "hermes" | "command-code", agent: string, model: string, printLogs: boolean, logLevel: string, extraArgs: string[], taskId: string, pollMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn> | null = null;
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    const run = runAgent(prompt, cwd, provider, agent, model, printLogs, logLevel, extraArgs, taskId, (c) => { child = c; });
    run.then(
      (out) => finish(() => resolve(out)),
      (err) => finish(() => reject(err))
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
