// MCP descriptor discovery for the DO (ADR-0004 §5; H6).
//
// The DO never sees MCP secrets or clients: the Worker discovers the project's
// enabled servers, keeps only default-deny read-only tools, and hands the DO a
// JSON-safe descriptor (`name`/`description`/`inputSchema`). Execution stays
// Worker-side on the read-tool route (`executeMcpTool`), so managed tokens never
// leave the Worker. Discovery is cached ~60s per project and invalidated by the
// MCP registry write handlers; every failure is fail-open empty.

import { Effect } from "effect";
import { queryAll, type DbDriver } from "../db/db";
import type { RuntimeEnv } from "../env";
import type { McpServerRowWithSecret } from "../repos/assistant-mcp.repo";
import { buildMcpTools, ENABLED_MCP_SERVERS_SQL, MCP_DISCOVERY_TIMEOUT_MS, type McpToolset } from "./mcp";

export const MCP_DESCRIPTOR_CACHE_TTL_MS = 60_000;

export interface McpToolDescriptor {
  name: string;
  description: string;
  /** JSON-safe schema (or `{ type: "object" }` when the client schema is not). */
  inputSchema: unknown;
}

interface CacheEntry {
  tools: McpToolDescriptor[];
  expiresAt: number;
}

const descriptorCache = new Map<string, CacheEntry>();

/** Drop the descriptor cache (all projects) or one project's entry. */
export function invalidateMcpDescriptorCache(projectId?: string): void {
  if (projectId === undefined) descriptorCache.clear();
  else descriptorCache.delete(projectId);
}

export interface McpDescriptorDeps {
  driver: DbDriver;
  env: RuntimeEnv | null | undefined;
  allowlist: string | null;
  projectId: string;
  now?: (() => number) | undefined;
  /** Test seam: override the live `buildMcpTools` bridge. */
  buildTools?: typeof buildMcpTools | undefined;
}

async function loadEnabledServers(driver: DbDriver, projectId: string): Promise<McpServerRowWithSecret[]> {
  try {
    return await Effect.runPromise(queryAll<McpServerRowWithSecret>(driver, ENABLED_MCP_SERVERS_SQL, projectId));
  } catch {
    return [];
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Extract a JSON-safe descriptor from one already-wrapped read-only MCP tool.
 * A client schema that is not a plain JSON object is replaced by a permissive
 * object schema (the tool still calls; the model just gets no field hints).
 */
function descriptorOf(tool: unknown): McpToolDescriptor | null {
  if (typeof tool !== "object" || tool === null) return null;
  const candidate = tool as { name?: unknown; description?: unknown; inputSchema?: unknown };
  if (typeof candidate.name !== "string" || !candidate.name.startsWith("mcp__")) return null;
  return {
    name: candidate.name,
    description: typeof candidate.description === "string" ? candidate.description : "",
    inputSchema: isPlainObject(candidate.inputSchema) ? candidate.inputSchema : { type: "object" },
  };
}

async function openToolset(deps: McpDescriptorDeps): Promise<McpToolset | null> {
  if (!deps.env) return null;
  const servers = await loadEnabledServers(deps.driver, deps.projectId);
  if (servers.length === 0) return null;
  try {
    const build = deps.buildTools ?? buildMcpTools;
    return await build({
      servers,
      projectId: deps.projectId,
      env: deps.env,
      allowlist: deps.allowlist,
      discoveryTimeoutMs: MCP_DISCOVERY_TIMEOUT_MS,
    });
  } catch {
    return null;
  }
}

/**
 * The project's read-only MCP tool descriptors (cached ~60s). Fail-open: no
 * env, no enabled servers, or a discovery error yields `[]`.
 */
export async function discoverMcpDescriptors(deps: McpDescriptorDeps): Promise<McpToolDescriptor[]> {
  const now = deps.now?.() ?? Date.now();
  const cached = descriptorCache.get(deps.projectId);
  if (cached && cached.expiresAt > now) return cached.tools;
  const toolset = await openToolset(deps);
  if (!toolset) {
    descriptorCache.set(deps.projectId, { tools: [], expiresAt: now + MCP_DESCRIPTOR_CACHE_TTL_MS });
    return [];
  }
  try {
    const tools = toolset.tools.map(descriptorOf).filter((tool): tool is McpToolDescriptor => tool !== null);
    descriptorCache.set(deps.projectId, { tools, expiresAt: now + MCP_DESCRIPTOR_CACHE_TTL_MS });
    return tools;
  } finally {
    await toolset.close().catch(() => {});
  }
}

/**
 * Execute one prefixed `mcp__<server>__<tool>` call Worker-side. Rebuilds the
 * project's read-only toolset and dispatches by name — a write-capable tool is
 * never present, so it resolves to "unknown" (default-deny). Returns the read
 * result envelope the read-tool route speaks.
 */
export async function executeMcpTool(
  deps: McpDescriptorDeps,
  name: string,
  args: Record<string, unknown>
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  const toolset = await openToolset(deps);
  if (!toolset) return { ok: false, error: `Unknown MCP tool ${name}` };
  try {
    const tool = toolset.tools.find((candidate) => (candidate as { name?: unknown }).name === name) as
      | { execute?: (input: unknown) => Promise<unknown> }
      | undefined;
    if (!tool || typeof tool.execute !== "function") return { ok: false, error: `Unknown MCP tool ${name}` };
    const result = await tool.execute(args);
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "MCP tool call failed" };
  } finally {
    await toolset.close().catch(() => {});
  }
}
