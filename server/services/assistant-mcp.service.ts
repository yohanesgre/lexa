import { Context, Effect, Either, Layer } from "effect";
import { DbError, ConstraintViolation, RowNotFound } from "../db/db";
import {
  AssistantMcpRepo,
  parseArgs,
  projectToPublic,
  toPublic,
  type McpServerPublic,
  type McpServerRow,
  type McpTransportType,
  type ProjectMcpServerPublic,
} from "../repos/assistant-mcp.repo";
import {
  errorCodeMap,
  errorMessage,
  McpConnectFailed,
  McpInvalidTransportConfig,
  McpServerNotFound,
  McpStdioUnavailable,
  McpToolCallFailed,
} from "../api/errors";
import { isWorkers, type RuntimeEnv } from "../env";
import { currentEnv } from "../runtime-env";
import { UrlBlocked, validateUrl } from "../assistant/ssrf";

export interface McpTransportConfig {
  transportType: McpTransportType;
  url: string | null;
  command: string | null;
  args: string[];
  secretRef: string | null;
}

export type McpValidationFailure =
  | { kind: "invalid"; reason: string }
  | { kind: "stdio-unavailable" };

export interface McpTestReport {
  ok: boolean;
  toolCount: number;
  readOnlyToolCount: number;
  latencyMs: number;
  error: { code: string; message: string } | null;
}

export interface McpCreateInput {
  label: string;
  transportType: McpTransportType;
  url?: string | null;
  command?: string | null;
  args?: string[];
  secretRef?: string | null;
  enabled?: boolean;
}

export interface McpUpdateInput {
  label?: string;
  transportType?: McpTransportType;
  url?: string | null;
  command?: string | null;
  args?: string[];
  secretRef?: string | null;
  enabled?: boolean;
}

// Public validation shape checks — pure so the Workers/stdio branch and every
// transport shape is unit-testable without DNS, spawning, or a network.
export function validateTransportConfig(config: McpTransportConfig, opts: { workers: boolean }): McpValidationFailure | null {
  if (opts.workers && config.transportType === "stdio") return { kind: "stdio-unavailable" };
  if (config.transportType === "http" || config.transportType === "sse") {
    if (!config.url || config.url.trim() === "") return { kind: "invalid", reason: "url is required for http/sse transport" };
    let parsed: URL;
    try {
      parsed = new URL(config.url);
    } catch {
      return { kind: "invalid", reason: "url must be a valid absolute URL" };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { kind: "invalid", reason: "url scheme must be http or https" };
    }
    if (parsed.username !== "" || parsed.password !== "") {
      return { kind: "invalid", reason: "url must not contain userinfo credentials" };
    }
    if (config.command) return { kind: "invalid", reason: "command is only valid for stdio transport" };
  } else if (config.transportType === "stdio") {
    if (!config.command || config.command.trim() === "") return { kind: "invalid", reason: "command is required for stdio transport" };
    if (config.url) return { kind: "invalid", reason: "url is only valid for http/sse transport" };
  } else {
    return { kind: "invalid", reason: "transportType must be one of http, sse, stdio" };
  }
  if (!config.args.every((a) => typeof a === "string")) return { kind: "invalid", reason: "args must be an array of strings" };
  if (config.secretRef !== null) {
    if (!/^env:[A-Z0-9_]+$/.test(config.secretRef) && !/^file:\//.test(config.secretRef)) {
      return { kind: "invalid", reason: "secretRef must be 'env:NAME' or 'file:/absolute/path'" };
    }
  }
  return null;
}

export function slugifyMcpId(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "mcp-server";
}

// Injectable seam for the test endpoint. The live implementation (stdio spawn /
// HTTP+SSE JSON-RPC `tools/list`) lands in server/assistant/mcp.ts; tests inject
// a fake so no process is spawned and no network is touched. Errors are the
// provider-shaped tags so the service can render the report without the
// connector knowing about HTTP codes.
export interface McpConnectorShape {
  connect(
    row: McpServerRow,
    opts: { env: RuntimeEnv; allowlist: string | null }
  ): Effect.Effect<{ toolCount: number; readOnlyToolCount: number }, McpStdioUnavailable | McpConnectFailed | McpToolCallFailed>;
}

export class McpConnector extends Context.Tag("Lexa/McpConnector")<McpConnector, McpConnectorShape>() {}

// Phase 1 default: the live connector is not wired until the tool-loop phase.
// The test endpoint still answers 200 with an MCP_CONNECT_FAILED report.
export const McpConnectorUnavailable: Layer.Layer<McpConnector> = Layer.succeed(McpConnector, {
  connect: () => Effect.fail(new McpConnectFailed({ message: "MCP connector is not available in this build" })),
});

function validationToError(failure: McpValidationFailure): McpInvalidTransportConfig | McpStdioUnavailable {
  return failure.kind === "stdio-unavailable" ? new McpStdioUnavailable() : new McpInvalidTransportConfig({ reason: failure.reason });
}

export class AssistantMcpService extends Effect.Service<AssistantMcpService>()("Lexa/AssistantMcpService", {
  dependencies: [AssistantMcpRepo.Default],
  effect: Effect.gen(function* () {
    const repo = yield* AssistantMcpRepo;
    const connector = yield* McpConnector;

    const requireRow = (id: string): Effect.Effect<McpServerRow, McpServerNotFound | DbError> =>
      repo.getById(id).pipe(Effect.catchTag("RowNotFound", () => Effect.fail(new McpServerNotFound({ id }))));

    const ssrfCheck = (url: string): Effect.Effect<void, McpInvalidTransportConfig> =>
      Effect.tryPromise({
        try: () => validateUrl(url, null),
        catch: (e) =>
          new McpInvalidTransportConfig({ reason: e instanceof UrlBlocked ? `url blocked: ${e.reason}` : "url could not be validated" }),
      }).pipe(Effect.asVoid);

    const validateAndGuard = (config: McpTransportConfig): Effect.Effect<void, McpInvalidTransportConfig | McpStdioUnavailable> =>
      Effect.gen(function* () {
        const failure = validateTransportConfig(config, { workers: isWorkers() });
        if (failure) return yield* Effect.fail(validationToError(failure));
        if (config.transportType === "http" || config.transportType === "sse") {
          yield* ssrfCheck(config.url as string);
        }
      });

    const list = (): Effect.Effect<McpServerPublic[], DbError> =>
      repo.list().pipe(Effect.map((rows) => rows.map(toPublic)));

    const create = (input: McpCreateInput): Effect.Effect<
      McpServerPublic,
      McpInvalidTransportConfig | McpStdioUnavailable | DbError | ConstraintViolation
    > =>
      Effect.gen(function* () {
        const id = slugifyMcpId(input.label);
        if (id === "jev") return yield* Effect.fail(new McpInvalidTransportConfig({ reason: "id 'jev' is reserved for the seeded Jev server" }));
        const config: McpTransportConfig = {
          transportType: input.transportType,
          url: input.transportType === "http" || input.transportType === "sse" ? input.url ?? null : null,
          command: input.transportType === "stdio" ? input.command ?? null : null,
          args: input.args ?? [],
          secretRef: input.secretRef ?? null,
        };
        yield* validateAndGuard(config);
        const row = yield* repo.create({ id, label: input.label, enabled: input.enabled === true, ...config });
        return toPublic(row);
      });

    const update = (id: string, patch: McpUpdateInput): Effect.Effect<
      McpServerPublic,
      McpServerNotFound | McpInvalidTransportConfig | McpStdioUnavailable | DbError | ConstraintViolation
    > =>
      Effect.gen(function* () {
        const existing = yield* requireRow(id);
        const transportType = patch.transportType ?? existing.transport_type;
        const merged = {
          transportType,
          url: transportType === "http" || transportType === "sse" ? patch.url !== undefined ? patch.url : existing.url : null,
          command: transportType === "stdio" ? patch.command !== undefined ? patch.command : existing.command : null,
          args: patch.args ?? parseArgs(existing.args),
          secretRef: patch.secretRef !== undefined ? patch.secretRef : existing.secret_ref,
        };
        yield* validateAndGuard(merged);
        const row = yield* repo.update(id, {
          label: patch.label ?? existing.label,
          transportType,
          url: merged.url,
          command: merged.command,
          args: merged.args,
          secretRef: merged.secretRef,
          enabled: patch.enabled !== undefined ? patch.enabled : existing.enabled === 1,
        }).pipe(Effect.catchTag("RowNotFound", () => Effect.fail(new McpServerNotFound({ id }))));
        return toPublic(row);
      });

    const remove = (id: string): Effect.Effect<void, McpServerNotFound | McpInvalidTransportConfig | DbError | ConstraintViolation> =>
      Effect.gen(function* () {
        if (id === "jev") return yield* Effect.fail(new McpInvalidTransportConfig({ reason: "the seeded 'jev' server cannot be deleted" }));
        yield* repo.remove(id).pipe(Effect.catchTag("RowNotFound", () => Effect.fail(new McpServerNotFound({ id }))));
      });

    const listForProject = (projectId: string): Effect.Effect<ProjectMcpServerPublic[], DbError> =>
      repo.listForProject(projectId).pipe(Effect.map((rows) => rows.map(projectToPublic)));

    const setProjectServers = (
      projectId: string,
      entries: Array<{ serverId: string; enabled: boolean }>
    ): Effect.Effect<void, McpServerNotFound | DbError | ConstraintViolation> =>
      Effect.gen(function* () {
        // One list read validates every id — an unknown serverId is a 404 with
        // the offending id, and the FK can only trip on a concurrent delete.
        const known = new Set((yield* repo.list()).map((row) => row.id));
        for (const entry of entries) {
          if (!known.has(entry.serverId)) return yield* Effect.fail(new McpServerNotFound({ id: entry.serverId }));
        }
        yield* repo.setProjectServers(projectId, entries);
      });

    const testConnection = (id: string): Effect.Effect<McpTestReport, McpServerNotFound | DbError> =>
      Effect.gen(function* () {
        const row = yield* requireRow(id);
        if (row.transport_type === "stdio" && isWorkers()) {
          return {
            ok: false,
            toolCount: 0,
            readOnlyToolCount: 0,
            latencyMs: 0,
            error: { code: "MCP_STDIO_UNAVAILABLE", message: errorMessage(new McpStdioUnavailable() as unknown as { _tag: string } & Record<string, unknown>) },
          } satisfies McpTestReport;
        }
        const env = yield* currentEnv;
        const start = Date.now();
        const outcome = yield* connector.connect(row, { env, allowlist: null }).pipe(Effect.either);
        if (Either.isRight(outcome)) {
          return {
            ok: true,
            toolCount: outcome.right.toolCount,
            readOnlyToolCount: outcome.right.readOnlyToolCount,
            latencyMs: Date.now() - start,
            error: null,
          } satisfies McpTestReport;
        }
        const failure = outcome.left;
        return {
          ok: false,
          toolCount: 0,
          readOnlyToolCount: 0,
          latencyMs: Date.now() - start,
          error: {
            code: errorCodeMap[failure._tag] ?? "MCP_CONNECT_FAILED",
            message: errorMessage(failure as unknown as { _tag: string } & Record<string, unknown>),
          },
        } satisfies McpTestReport;
      });

    return { list, create, update, remove, listForProject, setProjectServers, testConnection } as const;
  }),
}) {}
