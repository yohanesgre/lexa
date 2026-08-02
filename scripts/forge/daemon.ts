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
 *   FORGE_AGENT         opencode | hermes (default: opencode)
 *   FORGE_RUNTIME_NAME  human name for this runtime (default: hostname)
 *   FORGE_POLL_MS       poll interval (default 3000)
 *
 * Run: bun run forge:daemon
 */
import { spawn } from "node:child_process";
import { hostname as osHostname } from "node:os";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SERVER = process.env.LEXA_URL ?? "http://localhost:3000";
const API_KEY = process.env.LEXA_API_KEY ?? "";
const DAEMON_TOKEN = process.env.LXK_FORGE_DAEMON_TOKEN ?? "";
const AGENT = (process.env.FORGE_AGENT ?? "opencode") as "opencode" | "hermes" | "command-code";
const RUNTIME_NAME = process.env.FORGE_RUNTIME_NAME ?? `${osHostname()}-${AGENT}`;
const POLL_MS = Number(process.env.FORGE_POLL_MS ?? 3000);
const WORKDIR_ROOT = join(tmpdir(), "lexa-forge");

// Command Code CLI binary (non-interactive print mode).
const CMD_BIN = process.env.FORGE_CMD_BIN ?? "cmd";

if (!API_KEY && !DAEMON_TOKEN) {
  console.error("Set LEXA_API_KEY (server API key) or LXK_FORGE_DAEMON_TOKEN (shared secret).");
  process.exit(1);
}

interface ForgeTask {
  id: string;
  documentType: "task" | "wiki";
  documentId: string;
  action: string;
  selection: string;
  docContext: string;
  status: string;
  result: string | null;
  error: string | null;
}

async function api(path: string, init?: RequestInit): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (DAEMON_TOKEN) headers["x-forge-token"] = DAEMON_TOKEN;
  else if (API_KEY) headers["Authorization"] = `Bearer ${API_KEY}`;
  return fetch(`${SERVER}${path}`, { ...init, headers });
}

async function main() {
  mkdirSync(WORKDIR_ROOT, { recursive: true });

  console.log(`── Forge daemon ──`);
  console.log(`  Server:   ${SERVER}`);
  console.log(`  Agent:    ${AGENT}`);
  console.log(`  Runtime:  ${RUNTIME_NAME}`);
  console.log(`  Poll:     ${POLL_MS}ms`);

  // Register
  let runtimeId: string;
  try {
    const res = await api("/api/forge/runtimes/register", {
      method: "POST",
      body: JSON.stringify({ name: RUNTIME_NAME, provider: AGENT, hostname: osHostname() }),
    });
    if (!res.ok) throw new Error(`register failed: ${res.status} ${await res.text()}`);
    const runtime = (await res.json()) as { id: string };
    runtimeId = runtime.id;
    console.log(`  Registered: ${runtimeId}`);
  } catch (e) {
    console.error(`Could not register with ${SERVER}:`, (e as Error).message);
    console.error(`Is the server running? Start it with \`bun run dev:server\` or \`bun run dev:full\`.`);
    process.exit(1);
  }

  // Heartbeat loop
  setInterval(() => {
    api("/api/forge/daemon/heartbeat", {
      method: "POST",
      body: JSON.stringify({ runtimeId }),
    }).catch(() => {});
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
        const task = (await res.json()) as ForgeTask | null;
        if (task) {
          await runTask(task);
        }
      }
    } catch (e) {
      console.error("[poll]", (e as Error).message);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

async function runTask(task: ForgeTask) {
  console.log(`\n[task ${task.id}] ${task.action} — ${task.documentType}:${task.documentId}`);

  const workdir = join(WORKDIR_ROOT, task.id);
  mkdirSync(workdir, { recursive: true });

  // Build the full prompt server-side (resolves sources, doc context).
  let prompt: string;
  try {
    const res = await api(`/api/forge/tasks/${task.id}`, {});
    const full = (await res.json()) as ForgeTask;
    prompt = [
      full.docContext,
      task.selection ? `Selected text:\n"""\n${task.selection}\n"""` : "",
      `Action: ${task.action}`,
      "Output only the requested text. No preamble, no markdown fences.",
    ].filter(Boolean).join("\n\n");
  } catch {
    prompt = `Action: ${task.action}\n\n${task.docContext ?? ""}\n\nSelected:\n${task.selection ?? ""}`;
  }

  try {
    const output = await runAgent(prompt, workdir);
    const res = await api(`/api/forge/daemon/tasks/${task.id}/complete`, {
      method: "POST",
      body: JSON.stringify({ result: output }),
    });
    if (!res.ok) throw new Error(`complete failed: ${res.status}`);
    console.log(`[task ${task.id}] completed (${output.length} chars)`);
  } catch (e) {
    const msg = (e as Error).message;
    console.error(`[task ${task.id}] failed: ${msg}`);
    await api(`/api/forge/daemon/tasks/${task.id}/fail`, {
      method: "POST",
      body: JSON.stringify({ error: msg }),
    }).catch(() => {});
  }
}

function runAgent(prompt: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let bin = AGENT;
    let args: string[];
    if (AGENT === "opencode") {
      args = ["--print", prompt];
    } else if (AGENT === "command-code") {
      // Command Code: non-interactive print mode, no session persistence,
      // skip onboarding, auto-accept so it doesn't stall on permission prompts.
      bin = CMD_BIN;
      args = ["-p", prompt, "--no-session", "--skip-onboarding", "--permission-mode", "auto-accept", "--no-auto-update"];
    } else {
      // hermes: fall back to a plain stdin prompt if no one-shot flag exists.
      args = ["-p", prompt];
    }

    console.log(`  $ ${bin} ${args.map((a) => (a.length > 60 ? `${a.slice(0, 60)}…` : a)).join(" ")}`);
    const child = spawn(bin, args, {
      cwd,
      env: {
        ...process.env,
        // Give the agent its Lexa MCP context (already configured via scripts/mcp/configure-agent.sh).
        LEXA_MCP_URL: `${SERVER}/mcp`,
        ...(API_KEY ? { LEXA_API_KEY: API_KEY } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });

    child.on("error", (e) => reject(new Error(`spawn ${bin}: ${e.message}`)));
    child.on("close", (code) => {
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

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
