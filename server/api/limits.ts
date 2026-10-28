import type { RuntimeEnv } from "../env";
import { getEnv } from "../env";
export const X_LEXA_REMOTE_IP = "x-lexa-remote-ip";

// Marks the in-process REST request a `/mcp` tool call dispatches. The /mcp
// boundary already charged the shared per-IP limiter for the outer request, so
// the API middleware skips only its limiter for a matching marker — never auth,
// body, or header handling. Both entries delete any inbound copy before routing.
export const X_LEXA_INTERNAL_MCP = "x-lexa-internal-mcp";

// The marker value is a per-process random nonce, but production workerd rejects
// random value generation during module evaluation (global scope) — the Workers
// build fails its prerender import — so it is created lazily on first use inside
// a request handler and memoized. Unpredictability is unchanged; nothing calls
// this at module scope.
let internalMcpToken: string | null = null;

export function getInternalMcpToken(): string {
  if (internalMcpToken === null) internalMcpToken = crypto.randomUUID();
  return internalMcpToken;
}

// Body cap resolver — Bun path uses a snapshot from `getEnv()` at boot, the
// per-request Workers path uses `env` from the workerd binding. Callers
// pass their env in explicitly; no module-scope process.env reads.
export function resolveMaxApiBody(env: RuntimeEnv): number {
  const bodyMb = Number(env.LXK_MAX_BODY_MB ?? 16);
  return (Number.isFinite(bodyMb) && bodyMb > 0 ? bodyMb : 16) * 1024 * 1024;
}

// Boot-time body cap snapshot for the Bun-path callers (middleware/entry).
// The per-request Workers path calls `resolveMaxApiBody(env)` instead.
export const MAX_API_BODY: number = resolveMaxApiBody(getEnv());
