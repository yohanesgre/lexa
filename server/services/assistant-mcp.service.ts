import { Context, Effect, Either } from "effect";
import { DbError, ConstraintViolation, RowNotFound } from "../db/db";
import {
  AssistantMcpRepo,
  projectToPublic,
  toPublic,
  type McpClientTransportType,
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
} from "../api/errors";
import { isRuntimeEnvStringKey, type RuntimeEnv } from "../env";
import { currentEnv } from "../runtime-env";
import { UrlBlocked, validateUrl } from "../assistant/ssrf";

export interface McpTransportConfig {
  transportType: McpTransportType;
  url: string | null;
  command: string | null;
  args: string[];
  secretRef: string | null;
}

export type McpValidationResult =
  | { ok: true; transportType: McpClientTransportType; url: string }
  | { ok: false; reason: string };

export interface McpTestReport {
  ok: boolean;
  toolCount: number;
  readOnlyToolCount: number;
  latencyMs: number;
  error: { code: string; message: string } | null;
}

// Unvalidated transport value from the API payload. Deliberately the legacy
// `http|sse|stdio` literal: the wire schema keeps `stdio` so a legacy payload
// reaches validation and fails with the exact domain error
// (MCP_INVALID_TRANSPORT_CONFIG) instead of a generic schema-decode 400.
export type McpRequestedTransportType = McpTransportType;

export interface McpCreateInput {
  label: string;
  transportType: McpRequestedTransportType;
  url?: string | null;
  command?: string | null;
  args?: string[];
  secretRef?: string | null;
  enabled?: boolean;
}

export interface McpUpdateInput {
  label?: string;
  transportType?: McpRequestedTransportType;
  url?: string | null;
  command?: string | null;
  args?: string[];
  secretRef?: string | null;
  enabled?: boolean;
}

// Lexa is a client of REMOTE MCP servers: no local process is ever spawned, so
// stdio is refused on every runtime (Bun host included) and never reaches
// storage. The exact reason is shared with the test endpoint, which reports the
// same domain error instead of attempting a connect.
export const STDIO_TRANSPORT_REJECTED = "transportType 'stdio' is not supported — MCP clients connect to remote http/sse servers";

// A remote client has no local process: `command`/`args` survive only as the
// historical 0009 columns. Any real value in a request is refused (one reason
// for both) so a payload can never look accepted while the fields are dropped.
// A blank `command` is the one exception: it is absent, not a process request.
export const PROCESS_FIELDS_REJECTED = "command/args are not supported for http/sse transports — MCP clients connect to remote servers only";

// Save-time allowlist for `env:NAME` (maintainer decision 2026-09-28: the fixed
// RuntimeEnv snapshot, no dedicated MCP secret namespace). A name outside the
// snapshot can never resolve, so it is refused here instead of being stored and
// silently failing at connect. `file:` refs are unaffected (Bun-only, unchanged).
export const envSecretRefReason = (name: string): string =>
  `secretRef 'env:${name}' is not a RuntimeEnv key — env references resolve only fixed runtime environment keys`;

// Wire compat: `command: ""` (or whitespace) meant "no command" before the
// remote-only rule and was stored as null, so a blank value is absent, not a
// process request. Non-blank commands are still refused.
export const blankCommand = (command: string | null | undefined): string | null =>
  command === null || command === undefined || command.trim() === "" ? null : command;

// Pure shape checks — unit-testable without DNS or a network. The accepted
// branch returns the narrowed transport so every write carries
// McpClientTransportType.
export function validateTransportConfig(config: McpTransportConfig): McpValidationResult {
  if (config.transportType !== "http" && config.transportType !== "sse") {
    return { ok: false, reason: STDIO_TRANSPORT_REJECTED };
  }
  if (!config.url || config.url.trim() === "") return { ok: false, reason: "url is required for http/sse transport" };
  let parsed: URL;
  try {
    parsed = new URL(config.url);
  } catch {
    return { ok: false, reason: "url must be a valid absolute URL" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: "url scheme must be http or https" };
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return { ok: false, reason: "url must not contain userinfo credentials" };
  }
  if (blankCommand(config.command) !== null || config.args.length > 0)
    return { ok: false, reason: PROCESS_FIELDS_REJECTED };
  if (config.secretRef !== null) {
    if (!/^env:[A-Z0-9_]+$/.test(config.secretRef) && !/^file:\//.test(config.secretRef)) {
      return { ok: false, reason: "secretRef must be 'env:NAME' or 'file:/absolute/path'" };
    }
    if (config.secretRef.startsWith("env:") && !isRuntimeEnvStringKey(config.secretRef.slice(4))) {
      return { ok: false, reason: envSecretRefReason(config.secretRef.slice(4)) };
    }
  }
  return { ok: true, transportType: config.transportType, url: config.url };
}

export function slugifyMcpId(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "mcp-server";
}

// Injectable seam for the test endpoint. The live implementation (HTTP+SSE
// JSON-RPC `tools/list`) lands in server/assistant/mcp.ts; tests inject a fake
// so no network is touched. Errors are the provider-shaped tags so the service
// can render the report without the connector knowing about HTTP codes.
// McpConnectFailed is the only failure in this union: a stdio row is refused as
// McpConnectFailed (McpStdioUnavailable stays reserved in the catalog but is never
// constructed) and a tool call is not part of connect — McpToolCallFailed is
// raised in the tool wrapper, so the test report can never carry
// MCP_TOOL_CALL_FAILED.
export interface McpConnectorShape {
  connect(
    row: McpServerRow,
    opts: { env: RuntimeEnv; allowlist: string | null }
  ): Effect.Effect<{ toolCount: number; readOnlyToolCount: number }, McpConnectFailed>;
}

export class McpConnector extends Context.Tag("Lexa/McpConnector")<McpConnector, McpConnectorShape>() {}

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

    // Resolves to the accepted transport, so the repo write is remote-only by
    // construction: 'stdio' fails here with MCP_INVALID_TRANSPORT_CONFIG.
    const validateAndGuard = (config: McpTransportConfig): Effect.Effect<McpClientTransportType, McpInvalidTransportConfig> =>
      Effect.gen(function* () {
        const result = validateTransportConfig(config);
        if (!result.ok) return yield* Effect.fail(new McpInvalidTransportConfig({ reason: result.reason }));
        yield* ssrfCheck(result.url);
        return result.transportType;
      });

    const list = (): Effect.Effect<McpServerPublic[], DbError> =>
      repo.list().pipe(Effect.map((rows) => rows.map(toPublic)));

    const create = (input: McpCreateInput): Effect.Effect<
      McpServerPublic,
      McpInvalidTransportConfig | DbError | ConstraintViolation
    > =>
      Effect.gen(function* () {
        const id = slugifyMcpId(input.label);
        // The payload's own command/args go into the validated shape: a
        // non-blank command or non-empty args fails with
        // MCP_INVALID_TRANSPORT_CONFIG instead of being dropped on the floor.
        // A blank command normalizes to null here, so the row stores null.
        const config: McpTransportConfig = {
          transportType: input.transportType,
          url: input.transportType === "http" || input.transportType === "sse" ? input.url ?? null : null,
          command: blankCommand(input.command),
          args: input.args ?? [],
          secretRef: input.secretRef ?? null,
        };
        const transportType = yield* validateAndGuard(config);
        const row = yield* repo.create({
          id,
          label: input.label,
          transportType,
          url: config.url,
          // Proven empty by the validator; the 0009 CHECK requires it anyway.
          command: null,
          args: config.args,
          secretRef: config.secretRef,
          enabled: input.enabled === true,
        });
        return toPublic(row);
      });

    const update = (id: string, patch: McpUpdateInput): Effect.Effect<
      McpServerPublic,
      McpServerNotFound | McpInvalidTransportConfig | DbError | ConstraintViolation
    > =>
      Effect.gen(function* () {
        const existing = yield* requireRow(id);
        // Only the request decides the process fields and the secret ref: a value
        // supplied here is validated (and refused when illegal), while any legacy
        // value already stored is passed through by the write rather than
        // blocking an unrelated patch. The stored ref is unresolvable either way
        // (an `env:` name outside the snapshot) and the connect path fails closed
        // with no header, so re-validating it would only freeze the row.
        const merged: McpTransportConfig = {
          transportType: patch.transportType ?? existing.transport_type,
          url: patch.url !== undefined ? patch.url : existing.url,
          command: blankCommand(patch.command),
          args: patch.args ?? [],
          secretRef: patch.secretRef !== undefined ? patch.secretRef : null,
        };
        const transportType = yield* validateAndGuard(merged);
        const row = yield* repo.update(id, {
          label: patch.label ?? existing.label,
          transportType,
          url: merged.url,
          command: null,
          args: merged.args,
          secretRef: patch.secretRef !== undefined ? patch.secretRef : existing.secret_ref,
          enabled: patch.enabled !== undefined ? patch.enabled : existing.enabled === 1,
        }).pipe(Effect.catchTag("RowNotFound", () => Effect.fail(new McpServerNotFound({ id }))));
        return toPublic(row);
      });

    const remove = (id: string): Effect.Effect<void, McpServerNotFound | DbError | ConstraintViolation> =>
      repo.remove(id).pipe(Effect.catchTag("RowNotFound", () => Effect.fail(new McpServerNotFound({ id }))));

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
        // 0010 deletes every stored stdio registration; a row that still has one
        // is refused rather than spawned, on any runtime.
        if (row.transport_type !== "http" && row.transport_type !== "sse") {
          const rejected = new McpInvalidTransportConfig({ reason: STDIO_TRANSPORT_REJECTED });
          return {
            ok: false,
            toolCount: 0,
            readOnlyToolCount: 0,
            latencyMs: 0,
            error: {
              code: errorCodeMap[rejected._tag] ?? "MCP_INVALID_TRANSPORT_CONFIG",
              message: errorMessage(rejected as unknown as { _tag: string } & Record<string, unknown>),
            },
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
