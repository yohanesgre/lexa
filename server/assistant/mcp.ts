// MCP tool bridge: discover read-only tools from registered MCP servers, prefix
// their names, cap/dispose their lifecycle, and hand them to the assistant tool
// loop. Every failure is fail-open — a down MCP server must never kill a stream.
import { Effect, Layer } from "effect";
import {
  createMCPClient,
  type HttpTransportConfig,
  type MCPClient,
  type MCPClientOptions,
  type SseTransportConfig,
  type ToolAnnotations,
} from "@tanstack/ai-mcp";
import { McpConnectFailed, McpToolCallFailed } from "../api/errors";
import { isWorkers, resolveSecretRef, type RuntimeEnv } from "../env";
import {
  MCP_CLIENT_TRANSPORTS,
  type McpClientTransportType,
  type McpServerRow,
  type McpTransportType,
} from "../repos/assistant-mcp.repo";
import { McpConnector, type McpConnectorShape } from "../services/assistant-mcp.service";
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

// Same rule as THIRD_PARTY_CONNECT_FAILURE, for the tool path. A thrown Error
// from the SDK, fetch, or a remote JSON-RPC error lands in the model-visible
// tool result and in the stream's error frame; remote text routinely quotes the
// Authorization header. Only a refusal Lexa built itself (timeout, missing
// execute) keeps its own text — that text names the tool and the budget, which
// is the actionable part.
const THIRD_PARTY_TOOL_CALL_FAILURE = "MCP tool call failed — remote error details are not forwarded";

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
        throw e instanceof McpToolCallFailed ? e : new McpToolCallFailed({ message: THIRD_PARTY_TOOL_CALL_FAILURE });
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

  // Only remote http/sse rows are ever handed to a factory: 0010 removed the
  // stored stdio registrations, and a leftover row must not reach a transport
  // builder (let alone a process spawn) on any runtime.
  const connectable: McpServerRow[] = [];
  for (const row of opts.servers) {
    if (isRemoteMcpTransport(row.transport_type)) connectable.push(row);
    else logMcpSkip(opts.projectId, row.id, `transport '${row.transport_type}' — ${UNSUPPORTED_TRANSPORT_REASON}`, null);
  }

  const settled = await Promise.allSettled(
    connectable.map(async (row) => {
      const client = await withTimeout(factory.create(row, { env: opts.env, allowlist: opts.allowlist }), discoveryTimeoutMs);
      handles.push(client);
      const discovered = await withTimeout(client.tools(), discoveryTimeoutMs);
      return { row, discovered };
    })
  );

  const tools: unknown[] = [];
  const usedNames = new Set<string>();
  // `allSettled` preserves input order, so the index still identifies the row:
  // the skip log's server id is the only attribution left once the error text
  // is redacted to THIRD_PARTY_CONNECT_FAILURE.
  for (const [index, outcome] of settled.entries()) {
    if (outcome.status === "rejected") {
      logMcpSkip(opts.projectId, connectable[index]!.id, "discovery", outcome.reason);
      continue;
    }
    const { row, discovered } = outcome.value;
    for (const tool of discovered) {
      if (!isReadOnlyMcpTool(tool)) continue;
      const name = prefixedMcpToolName(row.id, tool.name);
      if (usedNames.has(name)) {
        logMcpSkip(opts.projectId, row.id, `duplicate tool name '${name}'`, null);
        continue;
      }
      usedNames.add(name);
      tools.push(wrapMcpTool(tool, row, name, tool.metadata?.mcp?.serverToolName ?? tool.name, sink, toolCallTimeoutMs));
    }
  }
  return { tools, close };
}

// The skip log is the other place a connect failure surfaces, so only a refusal
// Lexa constructed itself keeps its text; a third-party Error (SDK, fetch, remote
// JSON-RPC) is logged as the same fixed generic reason it becomes in the report.
function logMcpSkip(projectId: string, serverId: string, reason: string, error: unknown): void {
  const detail = error instanceof McpConnectFailed
    ? error.message
    : error === null || error === undefined
      ? null
      : THIRD_PARTY_CONNECT_FAILURE;
  try {
    process.stderr.write(
      `${JSON.stringify({
        level: "WARN",
        service: "assistant-mcp",
        message: `MCP server skipped: ${reason}`,
        meta: { projectId, serverId, reason, error: detail },
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

// Stored column domain is wider than the transports Lexa can connect: migration
// 0010 deletes every stdio row, and the 0009 CHECK still admits one. A row that
// names anything but http/sse is refused here, before a client exists — Lexa is
// a client of remote MCP servers and never spawns a local process.
export function isRemoteMcpTransport(transportType: McpTransportType): transportType is McpClientTransportType {
  return (MCP_CLIENT_TRANSPORTS as readonly string[]).includes(transportType);
}

export const UNSUPPORTED_TRANSPORT_REASON = "MCP clients connect to remote http/sse servers only — local process transport is not supported";

// A resolved credential is opaque bytes, but an HTTP header is not: a value with
// CR/LF/NUL (a multiline PEM from an allowlisted key, or a `file:` read) is
// rejected by fetch with a TypeError whose message quotes the value verbatim —
// which would then reach stderr and the test-report body. Refuse the value here,
// before the factory or the SDK ever sees it, with a message naming no secret.
const SECRET_NOT_SINGLE_LINE = "resolved MCP secret cannot be sent in an HTTP header; use a single-line token";

// `secret_ref` names a credential, never one. The resolved value goes out as the
// single `Authorization: Bearer` header and is never returned or logged; an
// absent or unresolvable reference connects with no headers at all.
async function remoteTransportFor(
  row: McpServerRow,
  opts: { env: RuntimeEnv; allowlist: string | null }
): Promise<HttpTransportConfig | SseTransportConfig> {
  if (!isRemoteMcpTransport(row.transport_type)) {
    throw new McpConnectFailed({ message: `MCP server '${row.id}': ${UNSUPPORTED_TRANSPORT_REASON}` });
  }
  await validateMcpTransportUrl(row, opts.allowlist);
  const secret = resolveSecretRef(row.secret_ref, opts.env);
  if (secret !== null && /[\r\n\0]/.test(secret)) throw new McpConnectFailed({ message: SECRET_NOT_SINGLE_LINE });
  const base = {
    url: row.url!,
    ...(secret !== null ? { headers: { Authorization: `Bearer ${secret}` } } : {}),
  };
  return row.transport_type === "sse" ? { type: "sse", ...base } : { type: "http", ...base };
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
      transport: await remoteTransportFor(row, opts),
      name: "lexa-assistant",
      version: "1.0.0",
      ...(clientOptions !== undefined ? { clientOptions } : {}),
    });
    return toClientHandle(client);
  },
};

// Only a refusal Lexa constructed itself keeps its own text. Anything from the
// SDK, fetch, or a remote JSON-RPC error is replaced by a fixed message: that
// text reaches stderr (skip log) and the 200 test-report body, and third-party
// messages routinely quote the Authorization header or the response body.
const THIRD_PARTY_CONNECT_FAILURE = "MCP connect failed — remote error details are not forwarded";

function toConnectError(error: unknown): McpConnectFailed {
  if (error instanceof McpConnectFailed) return error;
  return new McpConnectFailed({ message: THIRD_PARTY_CONNECT_FAILURE });
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
