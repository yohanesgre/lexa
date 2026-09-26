// MCP tool bridge: discover read-only tools from registered MCP servers, prefix
// their names, cap/dispose their lifecycle, and hand them to the assistant tool
// loop. Every failure is fail-open — a down MCP server must never kill a stream.
import { Effect, Layer } from "effect";
import {
  createMCPClient,
  type MCPClient,
  type MCPClientOptions,
  type ToolAnnotations,
  type TransportConfig,
} from "@tanstack/ai-mcp";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { McpConnectFailed, McpStdioUnavailable, McpToolCallFailed } from "../api/errors";
import { isWorkers, type RuntimeEnv } from "../env";
import { parseArgs, type McpServerRow } from "../repos/assistant-mcp.repo";
import { McpConnector, type McpConnectorShape } from "../services/assistant-mcp.service";
import { buildStdioTransport } from "./mcp-stdio";
import { validateUrl } from "./ssrf";

export const MCP_DISCOVERY_TIMEOUT_MS = 5000;
export const MCP_TOOL_CALL_TIMEOUT_MS = 30_000;
export const MCP_TOOL_RESULT_CAP = 100_000;
export const MCP_TOOL_NAME_MAX = 64;
const MCP_SERVER_ID_MAX = 24;

// Per-project enablement join: the global `enabled` is the master switch and the
// absence of a project row means unavailable there (Q3).
export const ENABLED_MCP_SERVERS_SQL = `SELECT s.* FROM assistant_mcp_servers s
  JOIN assistant_mcp_project_servers p ON p.server_id = s.id
  WHERE s.enabled = 1 AND p.enabled = 1 AND p.project_id = ?
  ORDER BY s.id ASC`;

export function sanitizeMcpServerId(id: string): string {
  const cleaned = id
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, MCP_SERVER_ID_MAX);
  return cleaned === "" ? "server" : cleaned;
}

export function mcpToolPrefix(serverId: string): string {
  return `mcp__${sanitizeMcpServerId(serverId)}__`;
}

// Provider tool-name limits are 64 chars; the server segment is capped and the
// tool segment truncated so joining always stays within the limit.
export function prefixedMcpToolName(serverId: string, toolName: string): string {
  const prefix = mcpToolPrefix(serverId);
  const cleaned = toolName.replace(/[^A-Za-z0-9_-]/g, "_");
  const room = Math.max(1, MCP_TOOL_NAME_MAX - prefix.length);
  const segment = cleaned.length > room ? cleaned.slice(0, room) : cleaned;
  return `${prefix}${segment}`;
}

export function parsePrefixedMcpToolName(name: string): { serverId: string; toolName: string } | null {
  const match = /^mcp__([a-z0-9_]+)__(.+)$/.exec(name);
  return match ? { serverId: match[1]!, toolName: match[2]! } : null;
}

export interface McpDiscoveredTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  metadata?: {
    mcp?: {
      serverToolName?: string;
      title?: string;
      annotations?: ToolAnnotations;
    };
    [key: string]: unknown;
  };
  execute?: (args: unknown, ctx?: unknown) => Promise<unknown>;
}

export interface McpClientHandle {
  tools: () => Promise<McpDiscoveredTool[]>;
  close: () => Promise<void>;
}

export interface McpClientFactory {
  create: (row: McpServerRow, opts: { env: RuntimeEnv; allowlist: string | null }) => Promise<McpClientHandle>;
}

// Default-deny: a tool is exposed only when the server explicitly annotates it
// read-only. An absent annotation is not proof of safety.
export function isReadOnlyMcpTool(tool: McpDiscoveredTool): boolean {
  return tool.metadata?.mcp?.annotations?.readOnlyHint === true;
}

export interface McpToolCallAudit {
  serverId: string;
  toolName: string;
  ok: boolean;
  durationMs: number;
  errorCode?: string;
}

export type McpToolCallSink = (entry: McpToolCallAudit) => void;

// Mirrors the assistant log-line convention (level/service/message/meta/timestamp).
// `assistant_call_logs.kind` is CHECK-pinned to provider kinds, so MCP tool
// calls are audited as structured log lines until a rebuild migration widens it.
function defaultMcpCallSink(entry: McpToolCallAudit, projectId: string): void {
  try {
    process.stdout.write(
      `${JSON.stringify({
        level: entry.ok ? "INFO" : "ERROR",
        service: "assistant-mcp",
        message: `MCP tool call ${entry.serverId}.${entry.toolName} ${entry.ok ? "ok" : "failed"}`,
        meta: {
          projectId,
          serverId: entry.serverId,
          toolName: entry.toolName,
          ok: entry.ok,
          durationMs: entry.durationMs,
          ...(entry.errorCode !== undefined ? { errorCode: entry.errorCode } : {}),
        },
        timestamp: new Date().toISOString(),
      })}\n`
    );
  } catch {
    // logging must never fail a tool call
  }
}

function capMcpResult(result: unknown, cap: number = MCP_TOOL_RESULT_CAP): unknown {
  if (typeof result === "string") return result.length > cap ? result.slice(0, cap) : result;
  if (result === null || result === undefined) return result;
  let json: string | null = null;
  try {
    json = JSON.stringify(result);
  } catch {
    json = null;
  }
  if (json === null) return result;
  return json.length > cap ? json.slice(0, cap) : result;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`MCP operation timed out after ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function wrapMcpTool(
  tool: McpDiscoveredTool,
  row: McpServerRow,
  name: string,
  serverToolName: string,
  sink: McpToolCallSink,
  toolCallTimeoutMs: number
): unknown {
  const { outputSchema: _unvalidated, ...rest } = tool;
  const serverId = row.id;
  return {
    ...rest,
    name,
    metadata: {
      ...(tool.metadata ?? {}),
      mcp: {
        ...(tool.metadata?.mcp ?? {}),
        serverId,
        serverToolName,
      },
    },
    execute: async (args: unknown, ctx?: unknown) => {
      const execute = tool.execute;
      if (typeof execute !== "function") throw new McpToolCallFailed({ message: `MCP tool ${name} has no executable definition` });
      const started = Date.now();
      const controller = new AbortController();
      const parent = (ctx as { abortSignal?: AbortSignal } | undefined)?.abortSignal;
      const onAbort = () => controller.abort();
      parent?.addEventListener("abort", onAbort, { once: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          execute(args ?? {}, {
            ...(typeof ctx === "object" && ctx !== null ? (ctx as Record<string, unknown>) : {}),
            abortSignal: controller.signal,
          }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(new McpToolCallFailed({ message: `MCP tool ${name} exceeded ${toolCallTimeoutMs} ms` }));
            }, toolCallTimeoutMs);
          }),
        ]);
        sink({ serverId, toolName: serverToolName, ok: true, durationMs: Date.now() - started });
        return capMcpResult(result);
      } catch (e) {
        sink({
          serverId,
          toolName: serverToolName,
          ok: false,
          durationMs: Date.now() - started,
          errorCode: e instanceof McpToolCallFailed ? "MCP_TOOL_CALL_FAILED" : "MCP_TOOL_CALL_ERROR",
        });
        throw e instanceof McpToolCallFailed ? e : new McpToolCallFailed({ message: e instanceof Error ? e.message : "MCP tool call failed" });
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        parent?.removeEventListener("abort", onAbort);
      }
    },
  };
}

export interface BuildMcpToolsOptions {
  servers: McpServerRow[];
  projectId: string;
  env: RuntimeEnv;
  allowlist: string | null;
  connector?: McpClientFactory;
  onToolCall?: McpToolCallSink;
  discoveryTimeoutMs?: number;
  toolCallTimeoutMs?: number;
}

export interface McpToolset {
  tools: unknown[];
  close: () => Promise<void>;
}

export async function buildMcpTools(opts: BuildMcpToolsOptions): Promise<McpToolset> {
  const factory = opts.connector ?? liveMcpClientFactory;
  const sink = opts.onToolCall ?? ((entry) => defaultMcpCallSink(entry, opts.projectId));
  const discoveryTimeoutMs = opts.discoveryTimeoutMs ?? MCP_DISCOVERY_TIMEOUT_MS;
  const toolCallTimeoutMs = opts.toolCallTimeoutMs ?? MCP_TOOL_CALL_TIMEOUT_MS;
  const handles: McpClientHandle[] = [];
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await Promise.allSettled(handles.map((handle) => handle.close()));
  };

  const settled = await Promise.allSettled(
    opts.servers.map(async (row) => {
      const client = await withTimeout(factory.create(row, { env: opts.env, allowlist: opts.allowlist }), discoveryTimeoutMs);
      handles.push(client);
      const discovered = await withTimeout(client.tools(), discoveryTimeoutMs);
      return { row, discovered };
    })
  );

  const tools: unknown[] = [];
  const usedNames = new Set<string>();
  for (const outcome of settled) {
    if (outcome.status === "rejected") {
      logMcpSkip(opts.projectId, "discovery", outcome.reason);
      continue;
    }
    const { row, discovered } = outcome.value;
    for (const tool of discovered) {
      if (!isReadOnlyMcpTool(tool)) continue;
      const name = prefixedMcpToolName(row.id, tool.name);
      if (usedNames.has(name)) {
        logMcpSkip(opts.projectId, `duplicate tool name '${name}'`, null);
        continue;
      }
      usedNames.add(name);
      tools.push(wrapMcpTool(tool, row, name, tool.metadata?.mcp?.serverToolName ?? tool.name, sink, toolCallTimeoutMs));
    }
  }
  return { tools, close };
}

function logMcpSkip(projectId: string, reason: string, error: unknown): void {
  try {
    process.stderr.write(
      `${JSON.stringify({
        level: "WARN",
        service: "assistant-mcp",
        message: `MCP server skipped: ${reason}`,
        meta: { projectId, reason, error: error instanceof Error ? error.message : error === null ? null : String(error) },
        timestamp: new Date().toISOString(),
      })}\n`
    );
  } catch {
    // best-effort
  }
}

// SSRF at connect time (authoritative; save time is the fast-feedback pass).
export async function validateMcpTransportUrl(row: McpServerRow, allowlist: string | null): Promise<void> {
  if (row.url === null || row.url === "") throw new McpConnectFailed({ message: `MCP server '${row.id}' has no url` });
  await validateUrl(row.url, allowlist);
}

async function transportFor(row: McpServerRow, opts: { env: RuntimeEnv; allowlist: string | null }): Promise<TransportConfig | Transport> {
  if (row.transport_type === "stdio") {
    if (isWorkers()) throw new McpStdioUnavailable();
    if (row.command === null || row.command === "") throw new McpConnectFailed({ message: `MCP server '${row.id}' has no command` });
    return buildStdioTransport({ command: row.command, args: parseArgs(row.args), env: opts.env, secretRef: row.secret_ref });
  }
  await validateMcpTransportUrl(row, opts.allowlist);
  return { type: row.transport_type, url: row.url! } as TransportConfig;
}

// SDK's default AJV validator compiles schemas with `new Function`, which
// workerd forbids. Output-schema validation is skipped there via a permissive
// validator (the wrapped tools already drop `outputSchema`).
class PermissiveJsonSchemaValidator {
  getValidator<T>(_schema: unknown) {
    return (input: unknown) => ({ valid: true as const, data: input as T, errorMessage: undefined as undefined });
  }
}

function clientOptionsForRuntime(): MCPClientOptions["clientOptions"] {
  if (!isWorkers()) return undefined;
  return { jsonSchemaValidator: new PermissiveJsonSchemaValidator() } as unknown as MCPClientOptions["clientOptions"];
}

function toClientHandle(client: MCPClient): McpClientHandle {
  return {
    tools: () => client.tools() as unknown as Promise<McpDiscoveredTool[]>,
    close: () => client.close(),
  };
}

export const liveMcpClientFactory: McpClientFactory = {
  create: async (row, opts) => {
    const clientOptions = clientOptionsForRuntime();
    const client = await createMCPClient({
      transport: await transportFor(row, opts),
      name: "lexa-assistant",
      version: "1.0.0",
      ...(clientOptions !== undefined ? { clientOptions } : {}),
    });
    return toClientHandle(client);
  },
};

function toConnectError(error: unknown): McpStdioUnavailable | McpConnectFailed {
  if (error instanceof McpStdioUnavailable) return error;
  if (error instanceof McpConnectFailed) return error;
  return new McpConnectFailed({ message: error instanceof Error ? error.message : "MCP connect failed" });
}

// Live connector for the registry test endpoint and the tool bridge. The tag is
// injectable so tests substitute a fake connector without spawning or dialing.
export const LiveMcpConnector: Layer.Layer<McpConnector> = Layer.succeed(McpConnector, {
  connect: (row, opts) =>
    Effect.tryPromise({
      try: async () => {
        const client = await withTimeout(liveMcpClientFactory.create(row, opts), MCP_DISCOVERY_TIMEOUT_MS);
        try {
          const tools = await withTimeout(client.tools(), MCP_DISCOVERY_TIMEOUT_MS);
          return { toolCount: tools.length, readOnlyToolCount: tools.filter(isReadOnlyMcpTool).length };
        } finally {
          await client.close().catch(() => {});
        }
      },
      catch: (error) => toConnectError(error),
    }),
} satisfies McpConnectorShape);
