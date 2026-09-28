import { Context, Effect, Either } from "effect";
import { DbError, ConstraintViolation, RowNotFound } from "../db/db";
import {
  AssistantMcpRepo,
  projectToPublic,
  toPublic,
  type McpClientTransportType,
  type McpSecretStorage,
  type McpServerPublic,
  type McpServerRowWithSecret,
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
import {
  encryptMcpSecret,
  mcpKeyringFromEnv,
  mcpManagedSecretsEnabled,
  MCP_MASTER_KEY_INVALID,
  MCP_SECRET_REF_DENYLIST,
  type McpKeyring,
} from "../assistant/mcp-secret";

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
  /**
   * A managed Bearer token, stored as AES-256-GCM ciphertext. Write-only: it
   * is never returned, logged, or echoed. A non-empty value is a second source
   * of truth, so it is legal only when `secretRef` is absent.
   */
  secret?: string | null;
  enabled?: boolean;
}

export interface McpUpdateInput {
  label?: string;
  transportType?: McpRequestedTransportType;
  url?: string | null;
  command?: string | null;
  args?: string[];
  secretRef?: string | null;
  /** A managed Bearer token replacing whatever source is stored. Write-only. */
  secret?: string | null;
  /**
   * The only removal route: `true` nulls the stored reference AND deletes the
   * ciphertext row. An omitted or empty `secret`/`secretRef` means "keep" — an
   * empty string is not a way to clear, so a UI cannot wipe a secret by saving
   * a blank field. Needs no master key (a row delete, no crypto).
   */
  clearSecret?: boolean;
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

// A managed token is a real credential; a blank field is not one. Same "absent,
// not a value" rule as `command`, so a UI that always posts its (empty) input
// cannot silently blank a stored secret.
export const blankSecret = (secret: string | null | undefined): string | null =>
  secret === null || secret === undefined || secret.trim() === "" ? null : secret;

// A `secret_ref` may never name a master key: `env:LXK_MCP_MASTER_KEY` would
// forward the envelope key itself as a Bearer token to a remote server. The
// master keys ARE fixed RuntimeEnv slots, so the allowlist above would otherwise
// accept them. Checked at save AND again at connect (server/assistant/mcp.ts),
// because a row written before this rule existed must not forward a key either.
export const denylistedSecretRefReason = (name: string): string =>
  `secretRef 'env:${name}' names an MCP master key and is never a client credential`;

// Exactly-one-source normalize. A managed token and a `secretRef` are two ways
// to say the same thing, and letting both persist means the connect path has to
// guess which one authenticates. Neither is also legal: secret-less clients
// exist today and must keep saving. Refusing only the BOTH case keeps the rule
// small enough to enforce at every write.
export type McpSecretIntent =
  | { kind: "none" }
  | { kind: "clear" }
  | { kind: "managed"; secret: string }
  | { kind: "reference"; secretRef: string };

export type McpSecretIntentResult = { ok: true; intent: McpSecretIntent } | { ok: false; reason: string };

export const SECRET_BOTH_SOURCES_REJECTED =
  "a managed token and a secretRef are mutually exclusive — store exactly one source (or neither)";

export const SECRET_CLEAR_CONFLICT_REJECTED =
  "clearSecret: true cannot be combined with a secret or a secretRef in the same request";

export const SECRET_REQUIRES_MASTER_KEY =
  "a managed MCP token needs LXK_MCP_MASTER_KEY to be set — managed secrets are disabled without it";

/**
 * Resolve what a write intends to do with the secret. Read from the REQUEST
 * only: a stored value is never an input, so an untouched row is never cleared
 * as a side effect of an unrelated patch (the legacy-freeze lesson).
 *
 * `clearSecret: true` is the only removal route, and a confirm dialog sends it
 * alone — carrying it together with a new value is refused rather than silently
 * resolved, so a UI bug can never erase one and store the other in one breath.
 */
export function normalizeSecretIntent(input: { secret?: string | null; secretRef?: string | null; clearSecret?: boolean | undefined }): McpSecretIntentResult {
  const secret = blankSecret(input.secret);
  const secretRef = blankReference(input.secretRef);
  if (input.clearSecret === true) {
    if (secret !== null || secretRef !== null) return { ok: false, reason: SECRET_CLEAR_CONFLICT_REJECTED };
    return { ok: true, intent: { kind: "clear" } };
  }
  if (secret !== null && secretRef !== null) return { ok: false, reason: SECRET_BOTH_SOURCES_REJECTED };
  if (secret !== null) return { ok: true, intent: { kind: "managed", secret } };
  if (secretRef !== null) return { ok: true, intent: { kind: "reference", secretRef } };
  return { ok: true, intent: { kind: "none" } };
}

// `secretRef: ""` means "no reference" (an empty field), not a reference to the
// empty name; the same absent-not-value rule as the token.
export const blankReference = (ref: string | null | undefined): string | null =>
  ref === null || ref === undefined || ref.trim() === "" ? null : ref;

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
    if (config.secretRef.startsWith("env:")) {
      const name = config.secretRef.slice(4);
      if (!isRuntimeEnvStringKey(name)) return { ok: false, reason: envSecretRefReason(name) };
      // The master keys are fixed RuntimeEnv slots, so the allowlist accepts
      // them; without this they would be forwardable as Bearer credentials.
      if ((MCP_SECRET_REF_DENYLIST as readonly string[]).includes(name)) {
        return { ok: false, reason: denylistedSecretRefReason(name) };
      }
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
    row: McpServerRowWithSecret,
    opts: { env: RuntimeEnv; allowlist: string | null }
  ): Effect.Effect<{ toolCount: number; readOnlyToolCount: number }, McpConnectFailed>;
}

export class McpConnector extends Context.Tag("Lexa/McpConnector")<McpConnector, McpConnectorShape>() {}

export class AssistantMcpService extends Effect.Service<AssistantMcpService>()("Lexa/AssistantMcpService", {
  dependencies: [AssistantMcpRepo.Default],
  effect: Effect.gen(function* () {
    const repo = yield* AssistantMcpRepo;
    const connector = yield* McpConnector;

    const requireRow = (id: string): Effect.Effect<McpServerRowWithSecret, McpServerNotFound | DbError> =>
      repo.getById(id).pipe(Effect.catchTag("RowNotFound", () => Effect.fail(new McpServerNotFound({ id }))));

    // The same read on a just-WRITTEN id. A managed save needs a second read
    // (after the ciphertext upsert) so the returned public shape reflects the
    // stored source, and on that path a missing row is a database fault, not a
    // not-found — same distinction repo.create already makes.
    const requireWrittenRow = (id: string): Effect.Effect<McpServerRowWithSecret, DbError> =>
      repo.getById(id).pipe(
        Effect.catchTag("RowNotFound", () => Effect.fail(new DbError({ message: `assistant_mcp_servers row '${id}' missing after write` })))
      );

    // A managed save needs the keyring. Unset key -> the documented disable
    // switch (refuse the write, keep `env:`/`file:` refs working); a
    // configured-but-malformed key -> a refusal naming the required shape, so an
    // operator who set the key wrong is told instead of silently getting a
    // feature that never works. Both are McpInvalidTransportConfig: no new
    // error code (the catalog is frozen).
    // The catch never forwards the thrown message: a WebCrypto/driver error can
    // quote the key material it choked on, and `reason` is copied verbatim into
    // the 400 body. The fixed shape message names the requirement and nothing
    // else, so every import failure class reduces to it.
    const keyringForSave = (): Effect.Effect<McpKeyring, McpInvalidTransportConfig> =>
      Effect.gen(function* () {
        const env = yield* currentEnv;
        const keyring = yield* Effect.tryPromise({
          try: () => mcpKeyringFromEnv(env),
          catch: () => new McpInvalidTransportConfig({ reason: MCP_MASTER_KEY_INVALID }),
        });
        if (keyring === null) return yield* Effect.fail(new McpInvalidTransportConfig({ reason: SECRET_REQUIRES_MASTER_KEY }));
        return keyring;
      });

    // The single ENCRYPTION point for a managed token: a fresh IV per write,
    // AAD bound to the client id, and the plaintext exists only as a local here
    // and in the caller's effect frame. The upsert is deliberately NOT part of
    // it — callers apply the sealed blob in their own write order, because the
    // registry `secret_ref` must never be cleared before the ciphertext that
    // replaces it is stored (see create/update).
    const sealSecret = (
      id: string,
      plaintext: string,
      keyring: McpKeyring
    ): Effect.Effect<McpSecretStorage, McpInvalidTransportConfig> =>
      Effect.tryPromise({
        try: () => encryptMcpSecret(plaintext, id, keyring.active, keyring),
        catch: () => new McpInvalidTransportConfig({ reason: "managed MCP secret could not be encrypted" }),
      }).pipe(
        Effect.map((sealed) => ({ ciphertext: sealed.ciphertextB64, iv: sealed.ivB64, keyId: sealed.keyId }))
      );

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

    // The registry read carries the managed-secrets capability so no client has
    // to hardcode it. Same env snapshot, same helper as keyringForSave, and it
    // cannot fail — an error channel here would take the whole list down.
    const managedSecretsEnabled = (): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        const env = yield* currentEnv;
        return yield* Effect.tryPromise({
          try: () => mcpManagedSecretsEnabled(env),
          catch: (cause) => cause,
        }).pipe(Effect.orElseSucceed(() => false));
      });

    // Exactly-one source, applied BEFORE any write: a refused payload leaves
    // the registry untouched, so the two-source case can never half-apply.
    const resolveIntent = (input: { secret?: string | null; secretRef?: string | null; clearSecret?: boolean | undefined }) =>
      Effect.gen(function* () {
        const result = normalizeSecretIntent(input);
        if (!result.ok) return yield* Effect.fail(new McpInvalidTransportConfig({ reason: result.reason }));
        return result.intent;
      });

    const create = (input: McpCreateInput): Effect.Effect<
      McpServerPublic,
      McpInvalidTransportConfig | DbError | ConstraintViolation
    > =>
      Effect.gen(function* () {
        const id = slugifyMcpId(input.label);
        const intent = yield* resolveIntent(input);
        // The payload's own command/args go into the validated shape: a
        // non-blank command or non-empty args fails with
        // MCP_INVALID_TRANSPORT_CONFIG instead of being dropped on the floor.
        // A blank command normalizes to null here, so the row stores null.
        // secretRef is whatever the intent says — a managed create stores null
        // there, because the credential lives in the ciphertext row.
        const config: McpTransportConfig = {
          transportType: input.transportType,
          url: input.transportType === "http" || input.transportType === "sse" ? input.url ?? null : null,
          command: blankCommand(input.command),
          args: input.args ?? [],
          secretRef: intent.kind === "reference" ? intent.secretRef : null,
        };
        const transportType = yield* validateAndGuard(config);
        // A managed create with no master key is refused BEFORE the registry row
        // exists, so a disabled deployment never accumulates orphan rows.
        const keyring = intent.kind === "managed" ? yield* keyringForSave() : null;
        // Encrypt BEFORE the registry write: a crypto fault then leaves nothing
        // behind at all, instead of a credential-less registration. The upsert
        // itself has to follow the row (the secret table's FK names it), but by
        // then the only thing that can fail is the write of an already-sealed
        // blob — and this row never had a credential to lose.
        const sealed = intent.kind === "managed" && keyring !== null
          ? yield* sealSecret(id, intent.secret, keyring)
          : null;
        yield* repo.create({
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
        if (sealed !== null) yield* repo.putSecret(id, sealed);
        return toPublic(yield* requireWrittenRow(id));
      });

    const update = (id: string, patch: McpUpdateInput): Effect.Effect<
      McpServerPublic,
      McpServerNotFound | McpInvalidTransportConfig | DbError | ConstraintViolation
    > =>
      Effect.gen(function* () {
        const existing = yield* requireRow(id);
        const intent = yield* resolveIntent(patch);
        // Only the request decides the process fields and the secret source: a
        // value supplied here is validated (and refused when illegal), while any
        // legacy value already stored is passed through by the write rather than
        // blocking an unrelated patch. The stored ref is unresolvable either way
        // (an `env:` name outside the snapshot) and the connect path fails closed
        // with no header, so re-validating it would only freeze the row.
        const merged: McpTransportConfig = {
          transportType: patch.transportType ?? existing.transport_type,
          url: patch.url !== undefined ? patch.url : existing.url,
          command: blankCommand(patch.command),
          args: patch.args ?? [],
          secretRef: intent.kind === "reference" ? intent.secretRef : null,
        };
        const transportType = yield* validateAndGuard(merged);
        // The stored reference passes through untouched unless this request
        // REPLACES it with the other source or clears it — an unrelated patch
        // must never silently drop a credential (the legacy-freeze lesson, now
        // for managed secrets too). Choosing a managed token is exactly such a
        // replacement: the ciphertext row is about to be written, so keeping the
        // ref would leave a row carrying BOTH sources and a stale credential
        // behind in a column nothing reads any more.
        const nextSecretRef =
          intent.kind === "reference"
            ? intent.secretRef
            : intent.kind === "clear" || intent.kind === "managed"
              ? null
              : existing.secret_ref;
        const keyring = intent.kind === "managed" ? yield* keyringForSave() : null;
        // A managed update seals the token FIRST and writes the ciphertext row
        // BEFORE the registry write that nulls `secret_ref`. A fault between the
        // two leaves the stored reference intact — a client that still
        // authenticates with its old credential — where the reverse order would
        // leave a row with NO credential at all: a silent anonymous connect, the
        // exact failure this feature exists to prevent. The transient
        // both-sources state is safe by construction: the read path treats
        // present ciphertext as authoritative, so the client authenticates with
        // the token just entered, never with the stale ref.
        const sealed = intent.kind === "managed" && keyring !== null
          ? yield* sealSecret(id, intent.secret, keyring)
          : null;
        if (sealed !== null) yield* repo.putSecret(id, sealed);
        yield* repo.update(id, {
          label: patch.label ?? existing.label,
          transportType,
          url: merged.url,
          command: null,
          args: merged.args,
          secretRef: nextSecretRef,
          enabled: patch.enabled !== undefined ? patch.enabled : existing.enabled === 1,
        }).pipe(Effect.catchTag("RowNotFound", () => Effect.fail(new McpServerNotFound({ id }))));
        // Exactly-one source: choosing one deletes the other. The clear path is
        // a pure row delete and needs no master key, so a superadmin can always
        // revoke a credential even on a deployment whose key is gone.
        if (intent.kind === "reference" || intent.kind === "clear") yield* repo.deleteSecret(id);
        return toPublic(yield* requireWrittenRow(id));
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

    return { list, managedSecretsEnabled, create, update, remove, listForProject, setProjectServers, testConnection } as const;
  }),
}) {}
