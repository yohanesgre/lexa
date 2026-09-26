// Node-only MCP stdio transport. Imported lazily by server/assistant/mcp.ts so
// the Workers bundle never reaches `node:child_process` at module scope.
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { isWorkers, resolveSecretRef, type RuntimeEnv } from "../env";

export const STDIO_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TMPDIR",
  "XDG_RUNTIME_DIR",
] as const;

export interface StdioTransportOptions {
  command: string;
  args: string[];
  env: RuntimeEnv;
  secretRef: string | null;
  cwd?: string;
}

// The child process inherits only allowlisted host variables plus the
// credential named by `secret_ref` (never the whole host environment).
// `env:NAME` is read from the host process env; `file:/abs/path` resolves to a
// single `MCP_SECRET` slot.
export function buildStdioEnv(secretRef: string | null | undefined, env: RuntimeEnv): Record<string, string> {
  const out: Record<string, string> = {};
  const host = typeof process !== "undefined" ? process.env : undefined;
  for (const key of STDIO_ENV_ALLOWLIST) {
    const value = host?.[key];
    if (typeof value === "string" && value.length > 0) out[key] = value;
  }
  if (secretRef && secretRef.startsWith("env:")) {
    const name = secretRef.slice(4);
    const value = host?.[name] ?? resolveSecretRef(secretRef, env);
    if (typeof value === "string" && value.length > 0) out[name] = value;
  } else if (secretRef && secretRef.startsWith("file:")) {
    const value = resolveSecretRef(secretRef, env);
    if (value !== null) out.MCP_SECRET = value;
  }
  return out;
}

export async function buildStdioTransport(options: StdioTransportOptions): Promise<Transport> {
  if (isWorkers()) throw new Error("stdio transport is unavailable on Cloudflare Workers");
  const { stdioTransport } = await import("@tanstack/ai-mcp/stdio");
  return stdioTransport({
    command: options.command,
    args: options.args,
    env: buildStdioEnv(options.secretRef, options.env),
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
  });
}
