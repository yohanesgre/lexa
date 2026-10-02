import type { RuntimeEnv } from "../env";
import { getEnv } from "../env";
export const X_LEXA_REMOTE_IP = "x-lexa-remote-ip";

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
