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
 * Run: the machine listener spawns this as a child (`lexa-cli machine listen`,
 * or `bun run cli/src/index.ts machine listen` from source).
 */
import { spawn } from "node:child_process";
import { hostname as osHostname } from "node:os";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { classifyLogLine } from "../shared/forge-log";
import { join } from "node:path";
import { Effect, Data, Fiber } from "effect";

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

// Guards + main are behind import.meta.main (bun-only, undefined under node)
// so importing this module for tests does not boot the daemon or exit.
if (import.meta.main) {
  if (!BEARER_KEY && !X_FORGE_TOKEN) {
    console.error("No credential found. Set LEXA_API_KEY (server API key) or LXK_FORGE_DAEMON_TOKEN (shared secret),");
    console.error("or log in first with `lexa-cli login --url <base> --key <lxk_...>` — the daemon falls back to that saved config.");
    process.exit(1);
  }

  if (!MACHINE_ID) {
    console.error("No machine id found. Run `lexa-cli machine listen` after login so this daemon can register.");
    process.exit(1);
  }
}

export interface ForgeTask {
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

// Optional claim payload: source files fetched from the task's linked GitHub
// repos at claim time (server lane). Absent/null = no repo content.
interface RepoContentEntry {
  owner: string;
  repo: string;
  path: string;
  content: string;
}

// Per-request timeouts — a stalled server must not hang registration,
// heartbeats, claims, or the MCP probe forever.
const HTTP_TIMEOUT_MS = 15_000;
const MCP_TIMEOUT_MS = 5_000;

// Typed failures. `reason` carries the message the imperative version threw
// or logged, so callers that read `error.message` reproduce the output.
class DaemonError extends Data.TaggedError("DaemonError")<{
  reason: string;
}> {
  get message(): string {
    return this.reason;
  }
}

class AgentError extends Data.TaggedError("AgentError")<{
  reason: string;
}> {
  get message(): string {
    return this.reason;
  }
}

function toDaemonError(error: unknown): DaemonError {
  return new DaemonError({ reason: error instanceof Error ? error.message : String(error) });
}

function api(path: string, init?: RequestInit): Effect.Effect<Response, DaemonError> {
  return Effect.tryPromise({
    try: async () => {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (X_FORGE_TOKEN) headers["x-forge-token"] = X_FORGE_TOKEN;
      else if (BEARER_KEY) headers["Authorization"] = `Bearer ${BEARER_KEY}`;
      const res = await fetch(`${SERVER}${path}`, { ...init, headers, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
      if (res.status === 401) {
        // The runtime's API key was revoked/rotated. The listener won't respawn
        // us (exit code 3 = auth failure); re-run Setup runtime for a fresh key.
        // Kill serve first (SIGTERM) so it never orphans on the runtime machine;
        // sessions persist for the next boot.
        console.error("  API key revoked or invalid (HTTP 401) — re-run Setup runtime (Settings → Forge Runtimes).");
        killServeTree();
        process.exit(3);
      }
      return res;
    },
    catch: toDaemonError,
  });
}

// Streamable-HTTP MCP handshake against the Lexa server — the runtime
// agent's only way to touch Lexa is the `lexa` MCP server, so it must be
// connected before any task runs. Returns an error string when the endpoint
// is unreachable or rejects auth, null when it responds. Skipped when the
// daemon only has a shared token (nothing to authenticate to /mcp with) —
// the agent-side ERROR_MCP_UNAVAILABLE sentinel still guards those runs.
function checkMcpConnection(): Effect.Effect<string | null, never> {
  if (!BEARER_KEY) return Effect.succeed(null);
  const url = `${SERVER}/mcp`;
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${BEARER_KEY}`,
  };
  return Effect.gen(function* () {
    const init = yield* Effect.tryPromise({
      try: () => fetch(url, {
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
      }),
      catch: toDaemonError,
    });
    if (!init.ok) return `initialize HTTP ${init.status}`;
    const parsed = yield* Effect.tryPromise({
      try: () => init.json() as Promise<{ error?: { message?: string } }>,
      catch: toDaemonError,
    });
    if (parsed.error) return parsed.error.message ?? "initialize rejected";
    const ping = yield* Effect.tryPromise({
      try: () => fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }),
        signal: AbortSignal.timeout(MCP_TIMEOUT_MS),
      }),
      catch: toDaemonError,
    });
    if (!ping.ok) return `ping HTTP ${ping.status}`;
    return null;
  }).pipe(Effect.catchAll((e) => Effect.succeed(e.message)));
}

const main = Effect.gen(function* () {
  yield* Effect.sync(() => mkdirSync(WORKDIR_ROOT, { recursive: true }));

  console.log(`── Forge daemon ──`);
  console.log(`  Server:   ${SERVER}`);
  console.log(`  Agent:    ${AGENT}${MODEL ? ` (${MODEL})` : ""}`);
  console.log(`  Runtime:  ${RUNTIME_NAME}`);
  console.log(`  Poll:     ${POLL_MS}ms`);

  // Register
  const runtimeId = yield* Effect.gen(function* () {
    const res = yield* api("/api/forge/runtimes/register", {
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
    if (!res.ok) {
      const body = yield* Effect.tryPromise({ try: () => res.text(), catch: toDaemonError });
      return yield* Effect.fail(new DaemonError({ reason: `register failed: ${res.status} ${body}` }));
    }
    const runtime = yield* Effect.tryPromise({ try: () => res.json() as Promise<{ id: string }>, catch: toDaemonError });
    return runtime.id;
  }).pipe(
    Effect.catchAll((e) =>
      Effect.sync((): never => {
        console.error(`Could not register with ${SERVER}:`, e.message);
        console.error(`Is the server running? Start it with \`bun run dev:server\` or \`bun run dev:full\`.`);
        process.exit(1);
      }),
    ),
  );
  console.log(`  Registered: ${runtimeId}`);
  // Warm serve runtime: spawn after the stale-pid sweep; respawns with
  // backoff on crash. SIGTERM (listener stop) kills serve, then exits.
  yield* Effect.sync(() => {
    void startServe(runtimeId);
    process.on("SIGTERM", () => {
      serveState.shuttingDown = true;
      const pid = serveState.child?.pid;
      if (pid) {
        try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
        setTimeout(() => {
          killProcessTree(pid);
          process.exit(0);
        }, 1500);
      } else {
        process.exit(0);
      }
    });
  });
  if (NEEDS_MCP) {
    const mcpErr = yield* checkMcpConnection();
    console.log(`  MCP: ${mcpErr ? `not connected (${mcpErr})` : "connected"}`);
  } else {
    console.log("  MCP: skipped (CLI agent)");
  }

  // Heartbeat loop — reports liveness and the daemon's Lexa MCP connectivity.
  // Catalog discovery belongs to the parent lexa-cli listener.
  yield* Effect.fork(
    Effect.forever(
      Effect.gen(function* () {
        yield* Effect.sleep(15_000);
        yield* Effect.gen(function* () {
          const body: Record<string, unknown> = { runtimeId };
          body.mcpConnected = NEEDS_MCP ? (yield* checkMcpConnection()) === null : false;
          yield* api("/api/forge/daemon/heartbeat", {
            method: "POST",
            body: JSON.stringify(body),
          });
        }).pipe(Effect.catchAllCause(() => Effect.void));
      }),
    ),
  );

  // Poll loop
  console.log("  Waiting for Forge tasks…");
  return yield* Effect.forever(
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const res = yield* api("/api/forge/daemon/claim", {
          method: "POST",
          body: JSON.stringify({ runtimeId }),
        });
        if (res.ok) {
          const claim = yield* Effect.tryPromise({
            try: () => res.json() as Promise<{ task: ForgeTask | null; provider: string; agent: string; model: string; printLogs: boolean; logLevel: string; extraArgs: string[]; prompt: string; agentMarkdown: string; skillMarkdown: string; skillIds: string[]; repoContent: RepoContentEntry[] | null; runtimeSessionId?: string | null }>,
            catch: toDaemonError,
          });
          if (claim.task) {
            yield* runTask(claim.task, claim.provider, claim.agent, claim.model, claim.logLevel, claim.extraArgs, claim.prompt, claim.agentMarkdown, claim.skillMarkdown, claim.skillIds ?? [], claim.repoContent ?? null, runtimeId, claim.runtimeSessionId ?? null);
          }
        }
      }).pipe(
        Effect.catchAllCause((cause) =>
          Effect.sync(() => {
            const failure = cause._tag === "Fail" ? cause.error : cause._tag === "Die" ? cause.defect : null;
            const msg = failure === null ? "unknown error" : failure instanceof Error ? failure.message : String(failure);
            console.error("[poll]", msg);
          }),
        ),
      );
      yield* Effect.sleep(POLL_MS);
    }),
  );
});

// opencode ≥1.18 requires full "provider/model" ids — bare ids fail with
// "Unexpected server error". Bare ids can still reach us via FORGE_MODEL env
// or a custom entry, so resolve them against the live catalog first.
export function resolveModelId(model: string): string {
  if (!model || model.includes("/")) return model;
  return model;
}

// ── Warm opencode serve (persistent runtime) ──
// One `opencode serve` per runtime, spawned by the daemon and driven over
// pure HTTP (spike: the `run --attach` client is unreliable on 1.18.11 — it
// exits without mirroring text parts, so the daemon never spawns it).
// Sessions are minted per-workspace via POST /session?directory= and survive
// serve restarts (the session DB lives in the persistent forge-home).

const SERVE_PORT_OVERRIDE = process.env.FORGE_SERVE_PORT ?? "";
const SERVE_READY_TIMEOUT_MS = 30_000;
const SERVE_READY_POLL_MS = 500;
const SERVE_BACKOFF_MIN_MS = 5_000;
const SERVE_BACKOFF_MAX_MS = 30_000;
// Live-log poll cadence while a message POST is in flight (spike design
// delta §"Live logs": tee newly-completed text parts to the task log).
const LIVE_POLL_MS = 3_000;

const serveState = {
  child: null as ReturnType<typeof spawn> | null,
  port: 0,
  ready: false,
  lastError: "",
  backoffMs: SERVE_BACKOFF_MIN_MS,
  shuttingDown: false,
};

// Flavor-separated port bases keep dev/staging/prod listeners on one machine
// from colliding by construction (one listener per flavor per machine).
export function flavorBaseFor(lexaDir: string): number {
  const base = lexaDir.split("/").pop() ?? "";
  if (base === ".lexa-staging") return 4196;
  if (base === ".lexa-dev") return 4296;
  return 4096;
}

export function deriveServePort(runtimeId: string, flavorBase: number, override?: string): number[] {
  const forced = override ? Number(override) : NaN;
  if (Number.isFinite(forced)) return [forced];
  let hash = 2166136261;
  for (const ch of runtimeId) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  const base = flavorBase + (hash >>> 0) % 32;
  return [base, base + 1, base + 2, base + 3, base + 4];
}

function servePidPath(runtimeId: string): string {
  return join(LEXA_DIR, "runtimes", runtimeId, "serve.pid");
}

function forgeHomePath(runtimeId: string): string {
  return join(LEXA_DIR, "runtimes", runtimeId, "forge-home");
}

// ── HTTP message client (pure) ──
// The model must be an OBJECT {providerID, modelID} — a "provider/model"
// string is rejected with BadRequest by serve (spike-verified).

export function buildMessageBody(model: string, agent: string, prompt: string): string {
  const idx = model.indexOf("/");
  const providerID = idx >= 0 ? model.slice(0, idx) : "";
  const modelID = idx >= 0 ? model.slice(idx + 1) : model;
  const body: Record<string, unknown> = {
    parts: [{ type: "text", text: prompt }],
  };
  // Empty agent/model are omitted — serve falls back to the session's
  // defaults (a blank runtime row must not 500 the message POST).
  if (agent) body.agent = agent;
  if (providerID && modelID) body.model = { providerID, modelID };
  return JSON.stringify(body);
}

// The blocking POST response carries `parts` (text parts = the Markdown
// result; step-start/step-finish/reasoning filtered) + `error` (null on
// success; message under error.data.message). An aborted message resolves
// with truncated parts and error null — callers only abort on cancel/timeout
// and fail those paths regardless of the POST outcome.
export function parseMessageResponse(json: string): { result: string | null; error: string | null } {
  const body = JSON.parse(json) as { parts?: Array<{ type: string; text?: string }>; error?: { name?: string; data?: { message?: string } } | null };
  if (body.error) {
    const err = body.error;
    const message = err.data?.message || err.name || null;
    return { result: null, error: message };
  }
  const joined = (body.parts ?? []).filter((p) => p.type === "text" && typeof p.text === "string").map((p) => p.text as string).join("\n");
  const cap = 1024 * 1024;
  return { result: joined.length > cap ? joined.slice(-cap) : joined, error: null };
}

export function buildMessageUrl(port: number, sessionId: string): string {
  return `http://127.0.0.1:${port}/session/${sessionId}/message`;
}

export function pollMessageUrl(port: number, sessionId: string): string {
  return buildMessageUrl(port, sessionId);
}

export function abortUrl(port: number, sessionId: string): string {
  return `http://127.0.0.1:${port}/session/${sessionId}/abort`;
}

// ── Session mint helpers (pure) ──
// The directory query binds the session to the workspace at creation; the
// returned Info.directory must equal the workspace or the mint fails loudly.

export function buildMintUrl(port: number, workspace: string): string {
  return `http://127.0.0.1:${port}/session?directory=${encodeURIComponent(workspace).replace(/%2F/gi, "/")}`;
}

export function parseSessionInfo(json: string, workspace: string): { id: string } {
  const info = JSON.parse(json) as { id?: string; directory?: string };
  if (!info.id) throw new Error("session mint returned no id");
  if (info.directory !== workspace) {
    throw new Error(`session mint bound to ${info.directory ?? "unknown"} directory, expected ${workspace}`);
  }
  return { id: info.id };
}

// The agent env is a WHITELIST — the daemon's own env is never inherited
// wholesale. Lexa credentials must not reach the agent: LEXA_API_KEY
// breaks opencode (≥1.18 treats it as its own server auth key — every run
// fails with "Unexpected server error"), and LXK_FORGE_DAEMON_TOKEN /
// LXK_API_KEY / LEXA_URL / LEXA_DIR would leak the server credential to
// unsandboxed hermes/command-code runs (they read the real HOME, incl.
// ~/.lexa/config.json). Forge runs on the prompt alone (no Lexa MCP tool
// calls), so the agent needs no Lexa env at all. No provider reads
// FORGE_* either — FORGE_CMD_BIN only picks the binary the daemon spawns.
export function buildChildEnv(
  env: Record<string, string | undefined>,
  cwd: string,
  sandboxHome: string | null,
): Record<string, string | undefined> {
  const childEnv: Record<string, string | undefined> = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "TERM", "LANG"]) {
    const value = env[key];
    if (value !== undefined) childEnv[key] = value;
  }
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("LC_") && value !== undefined) childEnv[key] = value;
  }
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
  return childEnv;
}

// Fire-and-forget task log POST — never awaited (the imperative version
// dropped its promise). Runs on its own runtime so the raw spawn callbacks
// inside runAgent can post log lines too.
function logTask(taskId: string, message: string, meta: { stream?: "out" | "err"; level?: "info" | "warn" | "error" } = {}): void {
  void Effect.runPromise(
    api(`/api/forge/daemon/tasks/${taskId}/log`, {
      method: "POST",
      body: JSON.stringify({ message, ...(meta.stream ? { stream: meta.stream } : {}), ...(meta.level ? { level: meta.level } : {}) }),
    }).pipe(Effect.catchAll(() => Effect.void)),
  );
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

// Claim-carried repo content (files from the task's linked GitHub repos):
// written under <workdir>/repo-content/<owner>/<repo>/<path> so the agent's
// working directory contains the linked sources, plus MANIFEST.md listing
// every written file. The dir is daemon-owned — wiped and rewritten per
// claim (fresh per run), and removed when the claim carries none, so a
// persistent opencode workspace never shows stale files from an earlier run
// (legacy providers drop the whole run dir anyway). Paths are sanitized
// defensively (owner/repo single clean segments, path segments never ".." or
// empty) and skipped when unsafe; a write failure only logs — the claim
// continues. Mirrors writeRuleBundles: per-claim overwrite, never removed
// at run end.
export function writeRepoContent(workdir: string, task: ForgeTask, repoContent: RepoContentEntry[] | null) {
  const dir = join(workdir, "repo-content");
  try {
    if (!repoContent || repoContent.length === 0) {
      rmSync(dir, { recursive: true, force: true });
      return;
    }
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const written: string[] = [];
    for (const entry of repoContent) {
      const safeSeg = (seg: string) => seg.length > 0 && seg !== "." && seg !== ".." && !seg.includes("/");
      if (!safeSeg(entry.owner) || !safeSeg(entry.repo)) {
        console.warn(`[task ${task.id}] skipping repo-content entry with unsafe owner/repo: ${entry.owner}/${entry.repo}`);
        continue;
      }
      const pathSegs = entry.path.split("/");
      if (pathSegs.length === 0 || !pathSegs.every(safeSeg)) {
        console.warn(`[task ${task.id}] skipping repo-content entry with unsafe path: ${entry.owner}/${entry.repo}/${entry.path}`);
        continue;
      }
      try {
        const dest = join(dir, entry.owner, entry.repo, ...pathSegs);
        mkdirSync(join(dir, entry.owner, entry.repo, ...pathSegs.slice(0, -1)), { recursive: true });
        writeFileSync(dest, entry.content, { mode: 0o644 });
        written.push(`${entry.owner}/${entry.repo}/${entry.path}`);
      } catch (e) {
        console.warn(`[task ${task.id}] could not write repo-content file ${entry.owner}/${entry.repo}/${entry.path}: ${(e as Error).message}`);
      }
    }
    const manifest = `Repo content fetched from linked GitHub repos at claim time — ground your work in these files.\n${written.map((f) => `- \`${f}\``).join("\n")}\n`;
    writeFileSync(join(dir, "MANIFEST.md"), manifest, { mode: 0o644 });
  } catch (e) {
    console.warn(`[task ${task.id}] could not write repo-content: ${(e as Error).message}`);
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

// Persistent per-runtime sandbox HOME at
// <LEXA_DIR>/runtimes/<runtimeId>/forge-home/: the only config serve (and
// every session it hosts) loads is the deny-rule opencode.json — the global
// config (permission: allow, MCP servers, plugins) never reaches the agent —
// and provider auth is copied from the real HOME. Seeded once, write-once;
// never wiped by the daemon (removed only when the runtime is uninstalled).
// Containment model (empirically verified against opencode 1.18.11):
// `external_directory: deny` is the geometric boundary — evaluated on the
// RESOLVED path for read/edit/write/glob/grep, it blocks everything outside
// the session's bound workspace regardless of relative/absolute form (spike
// gate 2: server root ≠ workspace still allowed workspace reads, blocked
// /etc). File tools are therefore permissive inside (relative paths work);
// bash cannot be path-scoped so it is fully denied. The `skill` tool is
// denied because opencode discovers the host's GLOBAL skills (~/.agents,
// ~/.config/opencode — resolved via os.homedir, not $HOME) into every run:
// hiding them keeps the personal skill library out of Forge context (the
// run's skill is read from the workspace directly). `webfetch` is denied —
// Forge output is the document text; the model has no reason to touch the
// network. auth.json copies are the only sensitive file in the sandbox —
// explicitly denied.
function seedForgeHome(runtimeId: string): string {
  const home = forgeHomePath(runtimeId);
  const configDir = join(home, ".config", "opencode");
  const dataDir = join(home, ".local", "share", "opencode");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  if (!existsSync(join(configDir, "opencode.json"))) {
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
  }
  refreshSandboxAuth(home);
  return home;
}

// Fresh provider auth per claim (parity with the old per-run copy): a login
// or key rotation made while serve runs must reach the next task. Best-effort
// — a missing/unreadable host auth.json only logs.
export function refreshSandboxAuth(sandboxHome: string): void {
  const realAuth = join(process.env.HOME ?? "", ".local", "share", "opencode", "auth.json");
  try {
    if (existsSync(realAuth)) {
      const dest = join(sandboxHome, ".local", "share", "opencode", "auth.json");
      mkdirSync(join(dest, ".."), { recursive: true });
      copyFileSync(realAuth, dest);
    }
  } catch (e) {
    console.warn(`  [sandbox] auth copy failed: ${(e as Error).message}`);
  }
}

// Kill the process and its whole descendant tree — agent CLIs (opencode,
// cmd) and serve spawn their own tool processes. We walk /proc for
// descendants rather than relying on process groups, which are unreliable
// depending on how the daemon itself was launched (nohup, setsid, ...).
function killProcessTree(pid: number) {
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
}

function killWithGrace(pid: number) {
  try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
  setTimeout(() => {
    killProcessTree(pid);
  }, 1500).unref?.();
}

// Daemon boot: a stale serve.pid means serve was orphaned by a SIGKILL/power
// loss. Kill that pid (SIGTERM → 1.5s → SIGKILL tree, mirroring the
// listener's killStaleDaemon shape) and delete the pid file.
export function sweepStaleServe(runtimeId: string, lexaDir = LEXA_DIR): void {
  const path = join(lexaDir, "runtimes", runtimeId, "serve.pid");
  try {
    const raw = readTextFile(path);
    const pid = raw ? Number(raw) : NaN;
    if (Number.isFinite(pid) && pid > 0) {
      console.log(`[serve] sweeping stale serve pid ${pid}`);
      killWithGrace(pid);
    }
  } catch { /* no pid file */ }
  try { rmSync(path, { force: true }); } catch { /* ignore */ }
}

async function isServeReady(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/session`, { signal: AbortSignal.timeout(2_000) });
    return res.ok;
  } catch {
    return false;
  }
}

function scheduleServeRespawn(runtimeId: string) {
  if (serveState.shuttingDown) return;
  const delay = serveState.backoffMs;
  serveState.backoffMs = Math.min(serveState.backoffMs * 2, SERVE_BACKOFF_MAX_MS);
  setTimeout(() => {
    void startServe(runtimeId);
  }, delay).unref?.();
}

// Spawn serve on one candidate port and wait for readiness (GET /session,
// the spike gate-8 winner — side-effect-free, 200 only once fully up).
// The probe doubles as bind verification; a child that exits before ready
// (port taken, broken binary) fails that candidate and the loop moves on.
async function trySpawnServe(runtimeId: string, port: number, sandboxHome: string): Promise<ReturnType<typeof spawn> | null> {
  const child = spawn("opencode", ["serve", "--port", String(port), "--hostname", "127.0.0.1"], {
    cwd: process.cwd(),
    env: buildChildEnv(process.env, process.cwd(), sandboxHome) as NodeJS.ProcessEnv,
    detached: true,
    stdio: "inherit",
  });
  let gone = false;
  child.once("close", () => { gone = true; });
  child.once("error", (e) => {
    serveState.lastError = `spawn opencode serve: ${e.message}`;
    gone = true;
  });
  const deadline = Date.now() + SERVE_READY_TIMEOUT_MS;
  while (!gone && Date.now() < deadline) {
    if (await isServeReady(port)) return child;
    await new Promise((resolve) => setTimeout(resolve, SERVE_READY_POLL_MS));
  }
  if (!gone) killWithGrace(child.pid ?? 0);
  return null;
}

// Boot + respawn entry: sweep any stale pid, seed the persistent sandbox,
// try candidate ports (FORGE_SERVE_PORT override first). On success record
// { pid, port } and persist serve.pid; on failure keep retrying with the
// 5s→30s backoff — never give up, never exit the daemon.
async function startServe(runtimeId: string) {
  if (serveState.shuttingDown) return;
  sweepStaleServe(runtimeId);
  const sandboxHome = seedForgeHome(runtimeId);
  const candidates = deriveServePort(runtimeId, flavorBaseFor(LEXA_DIR), SERVE_PORT_OVERRIDE);
  for (const port of candidates) {
    const child = await trySpawnServe(runtimeId, port, sandboxHome);
    if (!child) continue;
    serveState.child = child;
    serveState.port = port;
    serveState.ready = true;
    serveState.lastError = "";
    serveState.backoffMs = SERVE_BACKOFF_MIN_MS;
    try { writeFileSync(servePidPath(runtimeId), String(child.pid ?? ""), { mode: 0o644 }); } catch (e) {
      console.warn(`  [serve] could not write serve.pid: ${(e as Error).message}`);
    }
    console.log(`[serve] opencode serve ready on 127.0.0.1:${port} (pid ${child.pid})`);
    child.once("close", (code) => {
      if (serveState.child === child) {
        serveState.child = null;
        serveState.ready = false;
        serveState.port = 0;
        try { rmSync(servePidPath(runtimeId), { force: true }); } catch { /* ignore */ }
        if (serveState.shuttingDown) { process.exit(0); return; }
        console.error(`[serve] opencode serve exited (code ${code}) — respawning in ${serveState.backoffMs}ms`);
        scheduleServeRespawn(runtimeId);
      }
    });
    return;
  }
  serveState.lastError = serveState.lastError || "all serve ports exhausted";
  console.error(`[serve] opencode serve did not start (${serveState.lastError}) — retrying with backoff`);
  scheduleServeRespawn(runtimeId);
}

function killServeTree() {
  const pid = serveState.child?.pid;
  if (pid) killWithGrace(pid);
}

// Report a task failure to the server (or just log a user cancel — the row
// is already 'cancelled' server-side, so a cancel skips the fail round-trip).
function failTask(task: ForgeTask, msg: string): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    if (msg === "cancelled") {
      console.log(`[task ${task.id}] cancelled`);
      logTask(task.id, "cancelled");
      return;
    }
    console.error(`[task ${task.id}] failed: ${msg}`);
    logTask(task.id, `failed: ${msg.slice(0, 200)}`);
    yield* api(`/api/forge/daemon/tasks/${task.id}/fail`, {
      method: "POST",
      body: JSON.stringify({ error: msg }),
    }).pipe(Effect.catchAll(() => Effect.void));
  });
}

function runTask(task: ForgeTask, serverProvider: string, serverAgent: string, serverModel: string, serverLogLevel: string, extraArgs: string[], serverPrompt: string, agentMarkdown: string, skillMarkdown: string, skillIds: string[] = [], repoContent: RepoContentEntry[] | null = null, runtimeId = "", claimRuntimeSessionId: string | null = null): Effect.Effect<void, never> {
  return Effect.gen(function* () {
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
    // bundles) against the warm serve runtime; other providers keep the
    // legacy ephemeral run-dir layout.
    const isOpencode = provider === "opencode";
    let workdir: string;
    if (isOpencode) {
      workdir = join(WORKSPACE_ROOT, task.projectId);
      mkdirSync(workdir, { recursive: true });
      const projName = projectIndex[task.projectId]?.name;
      console.log(`  Workspace: ${task.projectId}${projName ? ` (${projName})` : ""}`);
      pruneStaleSkillDirs(workdir, skillIds);
      writeRuleBundles(workdir, task, agentMarkdown, skillMarkdown);
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

    // Repo content lands in the same dir as the rule files — the agent's
    // working directory — for both layouts (workspace / ephemeral run dir).
    writeRepoContent(workdir, task, repoContent);

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

    // opencode session resolution (spec §8 step 3): the claim payload carries
    // the server's continue-vs-mint verdict (runtimeSessionId or null). Null
    // → mint POST /session?directory=<workspace> on serve (asserting the
    // returned Info.directory), then persist the mapping BEFORE the run.
    yield* Effect.gen(function* () {
      logTask(task.id, `claimed by ${RUNTIME_NAME}`);
      logTask(task.id, `model ${model}`);
      // opencode session resolution (spec §8 step 3): the claim payload
      // carries the server's continue-vs-mint verdict (runtimeSessionId or
      // null). Null → mint POST /session?directory=<workspace> on serve
      // (asserting the returned Info.directory), then persist the mapping
      // BEFORE the run.
      let sessionId = "";
      let servePort = 0;
      let mintAndMap: Effect.Effect<string, DaemonError> | null = null;
      if (isOpencode) {
        // Bounded wait for serve: the first claim after daemon boot can race
        // serve's spawn, and a crashed serve is respawning on the 5s→30s
        // backoff. Give it the readiness budget; only then fail the task.
        const serveUp = yield* Effect.gen(function* () {
          const deadline = Date.now() + SERVE_READY_TIMEOUT_MS;
          while (!serveState.ready && !serveState.shuttingDown && Date.now() < deadline) {
            yield* Effect.sleep(SERVE_READY_POLL_MS);
          }
          return serveState.ready;
        });
        if (!serveUp) {
          return yield* Effect.fail(new DaemonError({ reason: `Forge runtime unavailable — opencode serve did not start (${serveState.lastError || "not ready"})` }));
        }
        servePort = serveState.port;
        refreshSandboxAuth(forgeHomePath(runtimeId));
        const mapping: SessionMapping = {
          documentType: task.documentType,
          documentId: task.documentId,
          runtimeId,
          provider: "opencode",
          agentId: task.agentId,
          skillId: task.skillId,
        };
        mintAndMap = Effect.gen(function* () {
          const minted = yield* mintSession(servePort, workdir);
          yield* upsertMapping({ ...mapping, runtimeSessionId: minted.id }).pipe(
            Effect.catchAll((e) => Effect.sync(() => console.warn(`[task ${task.id}] mapping upsert failed: ${e.message}`))),
          );
          return minted.id;
        });
        if (claimRuntimeSessionId) {
          sessionId = claimRuntimeSessionId;
          console.log(`  Session: continuing ${sessionId}`);
        } else {
          sessionId = yield* mintAndMap;
          console.log(`  Session: new ${sessionId}`);
        }
        logTask(task.id, claimRuntimeSessionId ? "continuing session" : "new session");
      }
      logTask(task.id, "agent started");
      logTask(task.id, "reading document context");
      // Poll the task's status while the agent runs so a server-side cancel
      // (user clicked Cancel in the UI) aborts the run instead of letting it
      // run to completion and discard the result.
      const CANCEL_POLL_MS = 2000;
      const runOpts = {
        port: servePort,
        sessionId,
        model,
        agent: agentFlag,
        prompt,
        taskId: task.id,
        mapping: { documentType: task.documentType, documentId: task.documentId, runtimeId },
        pollMs: CANCEL_POLL_MS,
      };
      const output = isOpencode
        ? yield* runHttpTask(runOpts).pipe(
            // Stale-session retry (spec §12): mint a fresh session, rewrite
            // the mapping, retry once.
            Effect.catchAll((e) => {
              if (!claimRuntimeSessionId || !mintAndMap || !isSessionNotFound(e.message)) return Effect.fail(e);
              console.log(`[task ${task.id}] stale session ${sessionId} — minting a fresh session and retrying once`);
              logTask(task.id, "stale session — minting fresh and retrying once");
              return mintAndMap.pipe(
                Effect.flatMap((sid) => runHttpTask({ ...runOpts, sessionId: sid })),
                Effect.mapError((m) => m instanceof AgentError ? m : new AgentError({ reason: m.message })),
              );
            }),
          )
        : yield* runAgentWithCancel(prompt, workdir, provider, agentFlag, model, serverLogLevel, extraArgs, task.id, CANCEL_POLL_MS);
      if (output.startsWith("ERROR_MCP_UNAVAILABLE")) {
        return yield* Effect.fail(new DaemonError({ reason: output }));
      }
      logTask(task.id, "generating text…");
      const res = yield* api(`/api/forge/daemon/tasks/${task.id}/complete`, {
        method: "POST",
        body: JSON.stringify({ result: output }),
      });
      if (!res.ok) {
        // Complete on a cancelled task (cancel raced completion): the server
        // rejected the result, so the session must not survive — drop the
        // mapping so the next run cannot continue a cancelled run's session.
        yield* deleteMapping({
          documentType: task.documentType,
          documentId: task.documentId,
          runtimeId: CONFIGURED_RUNTIME_ID || runtimeId,
        });
        return yield* Effect.fail(new DaemonError({ reason: `complete failed: ${res.status}` }));
      }
      logTask(task.id, `done (${output.length} chars)`);
      console.log(`[task ${task.id}] completed (${output.length} chars)`);
    }).pipe(
      Effect.catchAllCause((cause) => {
        const failure = cause._tag === "Fail" ? cause.error : cause._tag === "Die" ? cause.defect : null;
        const msg = failure === null ? "unknown error" : failure instanceof Error ? failure.message : String(failure);
        return failTask(task, msg);
      }),
      Effect.ensuring(
        Effect.sync(() => {
          // opencode: no cleanup — the workspace root, seeds, and the
          // persistent forge-home sandbox stay (spec §8 step 9: no .forge/
          // wipe anymore). Legacy providers: the whole ephemeral run dir is
          // removed (Artifact retention is backlogged).
          if (!isOpencode) {
            rmSync(workdir, { recursive: true, force: true });
          }
        }),
      ),
    );
  });
}

function runAgent(prompt: string, cwd: string, provider: "opencode" | "hermes" | "command-code", agent: string, model: string, logLevel: string, extraArgs: string[], taskId: string, onSpawn?: (child: ReturnType<typeof spawn>) => void): Effect.Effect<string, AgentError> {
  return Effect.tryPromise({
    try: () => new Promise<string>((resolve, reject) => {
      let bin: string = provider;
      let args: string[];
      if (provider === "command-code") {
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
      // buildChildEnv whitelists the agent env (see its doc comment): the
      // daemon's own env is never inherited wholesale.
      const childEnv = buildChildEnv(process.env, cwd, null);
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

      // Bounded capture: a chatty agent can emit tens of MB, and buffering it
      // all would grow daemon RAM without limit (the 16MB server cap only
      // rejects the final POST, after buffering). Keep the LAST STDOUT_TAIL of
      // stdout (rolling tail) plus a total count; the complete POST sends the
      // tail. Server-side storage is capped separately (forge.repo: 1MB).
      const STDOUT_TAIL = 1024 * 1024;
      const STDERR_TAIL = 64 * 1024;
      let stdout = "";
      let stdoutTotal = 0;
      let stderrTail = "";
      const appendTail = (tail: string, chunk: string, cap: number) => {
        const next = tail + chunk;
        return next.length <= cap ? next : next.slice(-cap);
      };

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

      child.stdout.on("data", (d) => {
        const s = d.toString();
        stdoutTotal += s.length;
        stdout = appendTail(stdout, s, STDOUT_TAIL);
        tee("out", d);
      });
      child.stderr.on("data", (d) => {
        const s = d.toString();
        stderrTail = appendTail(stderrTail, s, STDERR_TAIL);
        tee("err", d);
      });

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
        if (stdoutTotal > stdout.length) {
          logTask(taskId, `agent output truncated — kept last ${stdout.length} of ${stdoutTotal} chars`);
        }
        const trimmed = stdout.trim();
        if (code === 0 && trimmed) {
          resolve(trimmed);
        } else {
          const errTail = stderrTail.trim().slice(-4000);
          reject(new Error(errTail || `agent exited with code ${code} and no output`));
        }
      });
    }),
    catch: (error) => new AgentError({ reason: error instanceof Error ? error.message : String(error) }),
  });
}

// ── HTTP run path (opencode, pure HTTP — no run client) ──
// The daemon never spawns a run client (spike gate 6: the attach client on
// 1.18.11 exits without mirroring text, so it is unusable as a result
// source). A task is one blocking POST /session/:id/message against serve;
// cancel/timeout POST /session/:id/abort (best-effort — it unblocks the
// blocked POST server-side) and drop the mapping row unconditionally.

interface SessionMapping {
  documentType: string;
  documentId: string;
  runtimeId: string;
  runtimeSessionId?: string;
  provider: "opencode";
  agentId: string;
  skillId: string;
}

// Pre-spawn mapping write (spec §8 step 3): the forge_sessions row exists
// before the run starts, so crash-resume and complete-failure retention work.
// A failed upsert only logs — the task still runs; the next claim mints a
// fresh session instead of continuing.
function upsertMapping(mapping: SessionMapping): Effect.Effect<void, DaemonError> {
  return Effect.gen(function* () {
    const res = yield* api("/api/forge/sessions", { method: "PUT", body: JSON.stringify(mapping) });
    if (!res.ok) return yield* Effect.fail(new DaemonError({ reason: `sessions PUT failed: ${res.status}` }));
  });
}

// Daemon-side mapping drop on cancel/timeout — always attempted, never a 409
// (that is the user-facing reset endpoint's job). Best-effort: a failure only
// logs; a fresh session can never inherit the aborted run's damage.
function deleteMapping(mapping: Pick<SessionMapping, "documentType" | "documentId" | "runtimeId">): Effect.Effect<void, never> {
  return api("/api/forge/sessions", { method: "DELETE", body: JSON.stringify(mapping) }).pipe(
    Effect.flatMap((res) => res.ok ? Effect.void : Effect.fail(new DaemonError({ reason: `sessions DELETE failed: ${res.status}` }))),
    Effect.catchAllCause((e) => Effect.sync(() => console.warn("  [serve] mapping drop failed:", e._tag === "Fail" ? e.error.message : "error"))),
  );
}

function mintSession(port: number, workspace: string): Effect.Effect<{ id: string }, DaemonError> {
  return Effect.tryPromise({
    try: async () => {
      const res = await fetch(buildMintUrl(port, workspace), { method: "POST", signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`session mint HTTP ${res.status}`);
      return parseSessionInfo(await res.text(), workspace);
    },
    catch: (error) => new DaemonError({ reason: error instanceof Error ? error.message : String(error) }),
  });
}

// Stale-session retry trigger (spec §12): the sandbox DB was wiped manually
// or the session died server-side — mint a fresh session and rewrite the
// mapping, at most once per task.
const SESSION_NOT_FOUND_RE = /session.*(not found|does not exist|no longer exists|missing)/i;

function isSessionNotFound(message: string): boolean {
  return SESSION_NOT_FOUND_RE.test(message);
}

// Best-effort server-side abort — unblocks the blocked message POST. Never
// throws: cancel/timeout must not fail because the abort POST failed.
function abortSession(port: number, sessionId: string): Effect.Effect<void, never> {
  return Effect.tryPromise(async () => {
    await fetch(abortUrl(port, sessionId), { method: "POST", signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  }).pipe(Effect.catchAllCause(() => Effect.void));
}

// GET /session/:id/message returns the conversation history (the POST body
// shape: { parts, error }); the poll normalizes both shapes defensively.
function normalizeParts(body: unknown): Array<{ id?: string; type: string; text?: string }> {
  if (!body || typeof body !== "object") return [];
  const b = body as { parts?: unknown; messages?: unknown };
  let parts: unknown = b.parts;
  if (!Array.isArray(parts) && Array.isArray(b.messages)) {
    parts = b.messages.flatMap((m) => {
      const mp = (m as { parts?: unknown }).parts;
      return Array.isArray(mp) ? mp : [];
    });
  }
  return Array.isArray(parts) ? (parts as Array<{ id?: string; type: string; text?: string }>) : [];
}

// Tee newly-completed text parts to the task log while the message POST is in
// flight (preserves the live-streaming UX without a client). Dedupe by part
// id; poll failures are non-fatal.
function pollLiveLogs(port: number, sessionId: string, taskId: string, seen: Set<string>): Effect.Effect<void, never> {
  return Effect.tryPromise(async () => {
    const res = await fetch(pollMessageUrl(port, sessionId), { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return;
    const parts = normalizeParts(await res.json());
    for (const part of parts) {
      if (part.type !== "text" || typeof part.text !== "string" || !part.text) continue;
      const key = part.id ?? `${part.type}:${part.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      logTask(taskId, `▸ ${part.text}`, { stream: "out", level: classifyLogLine("out", part.text).level });
    }
  }).pipe(Effect.catchAllCause(() => Effect.void));
}

export interface HttpRunOptions {
  port: number;
  sessionId: string;
  model: string;
  agent: string;
  prompt: string;
  taskId: string;
  mapping: Pick<SessionMapping, "documentType" | "documentId" | "runtimeId">;
  pollMs: number;
}

export function runHttpTask(opts: HttpRunOptions): Effect.Effect<string, AgentError> {
  return Effect.gen(function* () {
    let aborted = false;
    const seenParts = new Set<string>();

    const poller = yield* Effect.fork(
      Effect.gen(function* () {
        while (!aborted) {
          yield* Effect.sleep(LIVE_POLL_MS);
          yield* pollLiveLogs(opts.port, opts.sessionId, opts.taskId, seenParts);
        }
      }).pipe(Effect.catchAllCause(() => Effect.void)),
    );

    const cancelRun = (reason: string) =>
      Effect.gen(function* () {
        aborted = true;
        yield* abortSession(opts.port, opts.sessionId);
        yield* deleteMapping(opts.mapping);
        return yield* Effect.fail(new AgentError({ reason }));
      });

    // Cancel poll — the server-side cancel (user clicked Cancel) wins over a
    // late completion. Poll failures are non-fatal.
    const cancelPoll = Effect.forever(
      Effect.gen(function* () {
        yield* Effect.sleep(opts.pollMs);
        const cancelled = yield* Effect.gen(function* () {
          const res = yield* api(`/api/forge/daemon/tasks/${opts.taskId}/status`);
          if (!res.ok) return false;
          const body = yield* Effect.tryPromise({ try: () => res.json() as Promise<{ status: string }>, catch: toDaemonError });
          return body.status === "cancelled";
        }).pipe(Effect.catchAllCause(() => Effect.succeed(false)));
        if (cancelled) yield* cancelRun("cancelled");
      }),
    );

    // The blocking message POST — response arrives when the message completes
    // (or is aborted). Fetch timeout = RUN_TIMEOUT_MS; an abort mid-message
    // resolves with truncated parts and error null, but the aborted flag set
    // by cancelRun/timeout turns that into a failure — never a success.
    const messagePost = Effect.tryPromise({
      try: async () => {
        const res = await fetch(buildMessageUrl(opts.port, opts.sessionId), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: buildMessageBody(opts.model, opts.agent, opts.prompt),
          signal: AbortSignal.timeout(RUN_TIMEOUT_MS),
        });
        if (aborted) throw new Error("cancelled");
        if (res.status === 404) throw new Error("session not found");
        if (!res.ok) {
          let detail = `message POST HTTP ${res.status}`;
          try {
            const errBody = parseMessageResponse(await res.text());
            if (errBody.error) detail = errBody.error;
          } catch { /* keep the HTTP status detail */ }
          throw new Error(detail);
        }
        const text = await res.text();
        if (aborted) throw new Error("cancelled");
        const parsed = parseMessageResponse(text);
        if (parsed.error) throw new Error(parsed.error);
        return parsed.result ?? "";
      },
      catch: (error) => new AgentError({ reason: error instanceof Error ? error.message : String(error) }),
    });

    // Wall-clock timeout — abort the server-side session and drop the mapping
    // exactly like a cancel (a timed-out run is as poisoned as an aborted one).
    const timeout = Effect.gen(function* () {
      yield* Effect.sleep(RUN_TIMEOUT_MS);
      return yield* cancelRun(`run timed out after ${Math.round(RUN_TIMEOUT_MS / 1000)}s`);
    });

    try {
      return yield* Effect.raceFirst(Effect.raceFirst(messagePost, timeout), cancelPoll);
    } finally {
      aborted = true;
      void Fiber.interrupt(poller);
    }
  });
}

// Run the agent, racing its completion against a wall-clock timeout and a
// server cancel poll (legacy providers — hermes/command-code keep the spawn
// path; opencode runs over HTTP via runHttpTask). When the user cancels the
// task (POST /api/forge/tasks/:id/cancel flips the row to 'cancelled') or the
// timeout fires, SIGTERM the child, schedule a force-kill of the whole tree
// 1500ms later, and fail — runTask's catch then logs it and skips the
// complete/fail round-trips (the "cancelled" message keeps its special
// handling).
function runAgentWithCancel(prompt: string, cwd: string, provider: "opencode" | "hermes" | "command-code", agent: string, model: string, logLevel: string, extraArgs: string[], taskId: string, pollMs: number): Effect.Effect<string, AgentError> {
  return Effect.gen(function* () {
    let child: ReturnType<typeof spawn> | null = null;

    const timeout = Effect.gen(function* () {
      yield* Effect.sleep(RUN_TIMEOUT_MS);
      if (child && child.pid) killWithGrace(child.pid);
      return yield* Effect.fail(new AgentError({ reason: `run timed out after ${Math.round(RUN_TIMEOUT_MS / 1000)}s` }));
    });

    // Poll the task's status while the agent runs; cancel wins over a late
    // completion. Poll failures are non-fatal — the run continues; a later
    // cancel may still be observed.
    const cancelPoll = Effect.forever(
      Effect.gen(function* () {
        yield* Effect.sleep(pollMs);
        const cancelled = yield* Effect.gen(function* () {
          const res = yield* api(`/api/forge/daemon/tasks/${taskId}/status`);
          if (!res.ok) return false;
          const body = yield* Effect.tryPromise({ try: () => res.json() as Promise<{ status: string }>, catch: toDaemonError });
          return body.status === "cancelled";
        }).pipe(Effect.catchAllCause(() => Effect.succeed(false)));
        if (cancelled) {
          if (child && child.pid) killWithGrace(child.pid);
          yield* Effect.fail(new AgentError({ reason: "cancelled" }));
        }
      }),
    );

    return yield* Effect.raceFirst(
      Effect.raceFirst(
        runAgent(prompt, cwd, provider, agent, model, logLevel, extraArgs, taskId, (c) => { child = c; }),
        timeout,
      ),
      cancelPoll,
    );
  });
}

if (import.meta.main) {
  Effect.runPromise(main).catch((e) => {
    console.error("Fatal:", e);
    process.exit(1);
  });
}
