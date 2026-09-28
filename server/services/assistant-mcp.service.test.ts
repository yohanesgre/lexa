import { describe, expect, it, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer, Context } from "effect";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { DbBunLive } from "../db/db";
import { McpConnectFailed } from "../api/errors";
import { RUNTIME_ENV_STRING_KEYS, type RuntimeEnv } from "../env";
import { RuntimeEnvLive } from "../runtime-env";
import { LiveMcpConnector } from "../assistant/mcp";
import {
  AssistantMcpService,
  denylistedSecretRefReason,
  envSecretRefReason,
  McpConnector,
  PROCESS_FIELDS_REJECTED,
  SECRET_BOTH_SOURCES_REJECTED,
  SECRET_CLEAR_CONFLICT_REJECTED,
  SECRET_REQUIRES_MASTER_KEY,
  slugifyMcpId,
  validateTransportConfig,
  type McpConnectorShape,
  type McpTransportConfig,
} from "./assistant-mcp.service";
import {
  MCP_MASTER_KEY_INVALID,
  MCP_SECRET_DECRYPT_FAILED,
  MCP_SECRET_KEY_ID_ACTIVE,
  MCP_SECRET_REF_DENYLIST,
} from "../assistant/mcp-secret";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

const STDIO_REASON = "transportType 'stdio' is not supported — MCP clients connect to remote http/sse servers";
const SECRET_NOT_SINGLE_LINE = "resolved MCP secret cannot be sent in an HTTP header; use a single-line token";
// The connect-time denylist refusal is a private const in server/assistant/mcp.ts
// (same convention as SECRET_NOT_SINGLE_LINE above): pinned here so a drift in
// the copy is a failing test, not a silently different message in a 502 body.
const SECRET_REF_DENIED_REASON = "MCP secret reference names a master key and is refused as a client credential";

// The live connector is the only caller of `createMCPClient` on this path, so
// stubbing it observes exactly what a real connect would receive — no dial, no
// spawn — and proves the refused secret never reached the SDK.
// `ok` is flipped only by the rotation test, where a DECRYPTED token must reach
// the SDK. Every refusal path leaves it false, so "the secret reached the SDK"
// stays a visible failure rather than a silent pass.
const sdkMock = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>>, ok: false }));
vi.mock("@tanstack/ai-mcp", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/ai-mcp")>();
  return {
    ...actual,
    createMCPClient: (async (options: Record<string, unknown>) => {
      sdkMock.calls.push(options);
      if (!sdkMock.ok) throw new Error("unreachable: a refused secret must not reach the SDK");
      return { tools: async () => [], close: async () => {} };
    }) as unknown as typeof actual.createMCPClient,
  };
});

// The real ssrf guard does a fail-closed DNS lookup; tests must never touch the
// network, so the module is swapped for a controllable stub that keeps the
// UrlBlocked shape. Real SSRF parity lives in server/assistant/ssrf tests.
const ssrfMock = vi.hoisted(() => ({ block: false }));
vi.mock("../assistant/ssrf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../assistant/ssrf")>();
  return {
    ...actual,
    validateUrl: async (raw: string, _allowlist: string | null) => {
      if (ssrfMock.block) throw new actual.UrlBlocked({ reason: "private or reserved addresses are blocked" });
      return new URL(raw);
    },
  };
});

// stdio used to be a Workers-only failure (MCP_STDIO_UNAVAILABLE) and a success
// on the Bun host, so the runtime is a test input: both values must reject.
const runtimeMock = vi.hoisted(() => ({ workers: false }));
vi.mock("../env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../env")>();
  return { ...actual, isWorkers: () => runtimeMock.workers };
});

let dir: string;
let dbPath: string;
let db: Database;
let service: AssistantMcpService;

const okConnector: McpConnectorShape = {
  connect: () => Effect.succeed({ toolCount: 3, readOnlyToolCount: 2 }),
};
const failConnector: McpConnectorShape = {
  connect: () => Effect.fail(new McpConnectFailed({ message: "no route to host" })),
};

afterEach(() => {
  try { db?.close(); } catch {}
  if (dir) rmSync(dir, { recursive: true, force: true });
  ssrfMock.block = false;
  runtimeMock.workers = false;
  sdkMock.calls = [];
  sdkMock.ok = false;
});

function setup(connector: McpConnectorShape = okConnector) {
  dir = mkdtempSync(join(tmpdir(), "lexa-assistant-mcp-svc-"));
  const path = join(dir, "test.db");
  runMigrations(path, MIGRATIONS);
  db = new Database(path);
  db.exec("PRAGMA foreign_keys = ON");
  const layer = AssistantMcpService.Default.pipe(
    Layer.provide(Layer.mergeAll(DbBunLive(db), Layer.succeed(McpConnector, connector)))
  );
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  service = Context.get(ctx, AssistantMcpService);
}

// The live connector, so a connect goes through the REAL crypto path
// (remoteTransportFor -> decrypt) instead of a stub. dbPath is recorded so a
// test can grep the raw database file for a plaintext marker.
function setupLive() {
  dir = mkdtempSync(join(tmpdir(), "lexa-assistant-mcp-live-svc-"));
  dbPath = join(dir, "test.db");
  runMigrations(dbPath, MIGRATIONS);
  db = new Database(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  const layer = AssistantMcpService.Default.pipe(
    Layer.provide(Layer.mergeAll(DbBunLive(db), LiveMcpConnector))
  );
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  service = Context.get(ctx, AssistantMcpService);
}

// The raw database file, not a SELECT: a plaintext leak would live in a page
// image, so reading through SQLite could not see it. WAL and SHM are included
// because an uncheckpointed write lives there, not in the main file.
function rawDatabaseBytes(): string {
  const parts = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].filter(existsSync);
  return Buffer.concat(parts.map((file) => readFileSync(file))).toString("latin1");
}

const run = <A, E>(eff: Effect.Effect<A, E>) => Effect.runPromise(eff);
const runEither = <A, E>(eff: Effect.Effect<A, E>) => Effect.runPromise(Effect.either(eff));

// The master key lives in the RuntimeEnv snapshot, so a managed save is driven
// by the per-request env exactly as the HTTP handler supplies it. Three
// distinct 32-byte keys stand for "before rotation", "after rotation", and the
// PREV slot.
function keyOf(seed: string): string {
  let text = "";
  while (Buffer.byteLength(text) < 32) text += seed;
  return Buffer.from(text.slice(0, 32)).toString("base64");
}
const KEY_A = keyOf("a");
const KEY_B = keyOf("b");
const PREV_KEY = keyOf("p");
const MARKER = "planted-managed-token-9f3a7c-do-not-leak";
const CONTROL = "planted-plaintext-control-4b1e8d-must-appear";

const envWith = (over: Partial<RuntimeEnv> = {}): RuntimeEnv => ({ ...over } as unknown as RuntimeEnv);

const withKey = <A, E>(env: RuntimeEnv, eff: Effect.Effect<A, E>) =>
  Effect.runPromise(eff.pipe(Effect.provide(RuntimeEnvLive(env))));

const withKeyEither = <A, E>(env: RuntimeEnv, eff: Effect.Effect<A, E>) =>
  Effect.runPromise(Effect.either(eff.pipe(Effect.provide(RuntimeEnvLive(env)))));

// `null`, not `undefined`, when the row is absent: the test-only bun:sqlite
// shim normalizes a miss to null exactly like bun:sqlite does, and a helper
// that lied about it would turn "no secret row" into a passing falsy check.
const secretRow = (id: string) =>
  db.prepare("SELECT server_id, ciphertext, iv, key_id FROM assistant_mcp_secrets WHERE server_id = ?").get(id) as
    | { server_id: string; ciphertext: string; iv: string; key_id: string }
    | null;

const secretCount = () =>
  (db.prepare("SELECT COUNT(*) AS n FROM assistant_mcp_secrets").get() as { n: number }).n;

const refOf = (id: string) =>
  (db.prepare("SELECT secret_ref FROM assistant_mcp_servers WHERE id = ?").get(id) as { secret_ref: string | null }).secret_ref;

const http = (over: Partial<McpTransportConfig> = {}): McpTransportConfig => ({
  transportType: "http",
  url: "https://mcp.test/x",
  command: null,
  args: [],
  secretRef: null,
  ...over,
});

// 0010 deleted every stored stdio row, so a legacy one can only be reproduced
// with a raw INSERT (the historical CHECK still admits it) — that is the row the
// test endpoint must refuse to spawn.
function insertLegacyStdioRow(id = "legacy") {
  db.exec(
    `INSERT INTO assistant_mcp_servers (id, label, transport_type, command, args, enabled)
     VALUES ('${id}', 'Legacy', 'stdio', 'legacy-mcp', '[]', 0)`
  );
}

// A row stored before the `env:NAME` allowlist existed (or written by a build
// that allowed the name): the stored reference is now unresolvable, so the
// connect path fails closed — but an unrelated patch must not be frozen by it.
function insertLegacyBadRefRow(id = "legacy-bad-ref") {
  db.exec(
    `INSERT INTO assistant_mcp_servers (id, label, transport_type, url, command, args, secret_ref, enabled)
     VALUES ('${id}', 'Legacy Ref', 'http', 'https://mcp.test/legacy', NULL, '[]', 'env:LINEAR_TOKEN', 0)`
  );
}

describe("validateTransportConfig", () => {
  it("accepts remote http and sse and hands back the narrowed transport", () => {
    expect(validateTransportConfig(http({ url: "https://mcp.test/x" })))
      .toEqual({ ok: true, transportType: "http", url: "https://mcp.test/x" });
    expect(validateTransportConfig(http({ transportType: "sse", url: "https://mcp.test/sse" })))
      .toEqual({ ok: true, transportType: "sse", url: "https://mcp.test/sse" });
  });

  it("rejects stdio on every runtime — no local process spawn", () => {
    const stdio: McpTransportConfig = { transportType: "stdio", url: null, command: "jev-mcp", args: [], secretRef: null };
    expect(validateTransportConfig(stdio)).toEqual({ ok: false, reason: STDIO_REASON });
    // The transport itself is refused, whatever else the payload carries.
    expect(validateTransportConfig({ ...stdio, url: "https://mcp.test/x" })).toEqual({ ok: false, reason: STDIO_REASON });
    expect(validateTransportConfig({ ...stdio, command: null })).toEqual({ ok: false, reason: STDIO_REASON });
  });

  it("requires a url for http/sse and rejects bad urls and userinfo", () => {
    expect(validateTransportConfig(http({ url: null })))
      .toEqual({ ok: false, reason: "url is required for http/sse transport" });
    expect(validateTransportConfig(http({ url: "   " })))
      .toEqual({ ok: false, reason: "url is required for http/sse transport" });
    expect(validateTransportConfig(http({ url: "not-a-url" })))
      .toEqual({ ok: false, reason: "url must be a valid absolute URL" });
    expect(validateTransportConfig(http({ url: "ftp://x.test" })))
      .toEqual({ ok: false, reason: "url scheme must be http or https" });
    expect(validateTransportConfig(http({ url: "https://user:pw@x.test" })))
      .toEqual({ ok: false, reason: "url must not contain userinfo credentials" });
  });

  // A remote client has no process to configure: `command`/`args` exist only as
  // the historical 0009 columns and are refused, never stored, never ignored.
  // A blank command is the wire-compat exception — absent, not refused.
  it("refuses any command or non-empty args with one reason", () => {
    expect(validateTransportConfig(http({ command: "nope" })))
      .toEqual({ ok: false, reason: PROCESS_FIELDS_REJECTED });
    expect(validateTransportConfig(http({ args: ["--verbose"] })))
      .toEqual({ ok: false, reason: PROCESS_FIELDS_REJECTED });
    expect(validateTransportConfig(http({ args: ["ok", 1] as unknown as string[] })))
      .toEqual({ ok: false, reason: PROCESS_FIELDS_REJECTED });
    expect(validateTransportConfig(http({ command: "nope", args: ["--x"] })))
      .toEqual({ ok: false, reason: PROCESS_FIELDS_REJECTED });
    expect(validateTransportConfig(http())).toEqual({ ok: true, transportType: "http", url: "https://mcp.test/x" });
  });

  it("accepts a blank command as absent (pre-remote wire compat)", () => {
    expect(validateTransportConfig(http({ command: "" })))
      .toEqual({ ok: true, transportType: "http", url: "https://mcp.test/x" });
    expect(validateTransportConfig(http({ command: "   " })))
      .toEqual({ ok: true, transportType: "http", url: "https://mcp.test/x" });
  });

  it("accepts only env:NAME or file:/ refs", () => {
    expect(validateTransportConfig(http({ secretRef: "env:GITHUB_WEBHOOK_SECRET" }))?.ok).toBe(true);
    expect(validateTransportConfig(http({ secretRef: "file:/run/secrets/token" }))?.ok).toBe(true);
    expect(validateTransportConfig(http({ secretRef: "env:lower" })))
      .toEqual({ ok: false, reason: "secretRef must be 'env:NAME' or 'file:/absolute/path'" });
    expect(validateTransportConfig(http({ secretRef: "plaintext-secret" })))
      .toEqual({ ok: false, reason: "secretRef must be 'env:NAME' or 'file:/absolute/path'" });
    expect(validateTransportConfig(http({ secretRef: "file:relative" })))
      .toEqual({ ok: false, reason: "secretRef must be 'env:NAME' or 'file:/absolute/path'" });
  });

  // Maintainer decision 2026-09-28: `env:NAME` resolves only a fixed RuntimeEnv
  // slot (the snapshot getEnv()/getEnvFromWorkers() build). A name outside it
  // could never resolve, so it is refused at save time rather than stored as a
  // reference that silently fails at connect.
  it("rejects an env: name outside the fixed RuntimeEnv snapshot", () => {
    expect(validateTransportConfig(http({ secretRef: "env:LINEAR_TOKEN" })))
      .toEqual({ ok: false, reason: envSecretRefReason("LINEAR_TOKEN") });
    // A process/Workers binding outside the snapshot is not a runtime key.
    expect(validateTransportConfig(http({ secretRef: "env:MCP_REMOTE_TOKEN" })))
      .toEqual({ ok: false, reason: envSecretRefReason("MCP_REMOTE_TOKEN") });
    // A non-string binding name is not a runtime key either.
    expect(validateTransportConfig(http({ secretRef: "env:DB" })))
      .toEqual({ ok: false, reason: envSecretRefReason("DB") });
  });

  it("accepts every fixed RuntimeEnv key and still requires the transport shape", () => {
    for (const key of RUNTIME_ENV_STRING_KEYS) {
      // The two master keys are RuntimeEnv slots but are never a client
      // credential — the denylist is the one deliberate exclusion, so the
      // allowlist loop states it instead of skipping it silently.
      if ((MCP_SECRET_REF_DENYLIST as readonly string[]).includes(key)) {
        expect(validateTransportConfig(http({ secretRef: `env:${key}` })), key).toEqual({
          ok: false,
          reason: denylistedSecretRefReason(key),
        });
        continue;
      }
      expect(validateTransportConfig(http({ secretRef: `env:${key}` })), key).toEqual({
        ok: true,
        transportType: "http",
        url: "https://mcp.test/x",
      });
    }
    // The allowlist is a ref check, not a bypass of the other refusals.
    expect(validateTransportConfig(http({ secretRef: "env:GITHUB_WEBHOOK_SECRET", command: "npx" })))
      .toEqual({ ok: false, reason: PROCESS_FIELDS_REJECTED });
    expect(validateTransportConfig(http({ secretRef: "env:GITHUB_WEBHOOK_SECRET", url: null })))
      .toEqual({ ok: false, reason: "url is required for http/sse transport" });
  });
});

describe("AssistantMcpService", () => {
  it("create derives a slug id, seeds nothing, and never exposes the secret ref", async () => {
    setup();
    const created = await run(service.create({ label: "My Client", transportType: "http", url: "https://mcp.test/x", secretRef: "env:GITHUB_WEBHOOK_SECRET" }));
    expect(created.id).toBe("my-client");
    expect(created.transportType).toBe("http");
    expect(created.url).toBe("https://mcp.test/x");
    expect(created.command).toBeNull();
    expect(created.args).toEqual([]);
    expect(created.hasSecret).toBe(true);
    expect(JSON.stringify(created)).not.toContain("GITHUB_WEBHOOK_SECRET");

    // 0010 removed the seeded `jev` row: the registry starts empty.
    expect((await run(service.list())).map((s) => s.id)).toEqual(["my-client"]);
  });

  it("create refuses a command or args instead of silently dropping them", async () => {
    setup();
    const withCommand = await runEither(service.create({ label: "Remote", transportType: "http", url: "https://mcp.test/x", command: "npx" }));
    expect(withCommand).toMatchObject({ _tag: "Left", left: { _tag: "McpInvalidTransportConfig", reason: PROCESS_FIELDS_REJECTED } });
    const withArgs = await runEither(service.create({ label: "Remote", transportType: "sse", url: "https://mcp.test/x", args: ["--x"] }));
    expect(withArgs).toMatchObject({ _tag: "Left", left: { _tag: "McpInvalidTransportConfig", reason: PROCESS_FIELDS_REJECTED } });
    expect(await run(service.list())).toEqual([]);
  });

  it("create accepts a blank command and stores null (wire compat)", async () => {
    setup();
    const created = await run(service.create({ label: "Blank Command", transportType: "http", url: "https://mcp.test/x", command: "" }));
    expect(created.command).toBeNull();
    expect((await run(service.list()))[0]).toMatchObject({ id: "blank-command", command: null, args: [] });

    const patched = await run(service.update("blank-command", { command: "  " }));
    expect(patched.command).toBeNull();
  });

  it("rejects stdio with MCP_INVALID_TRANSPORT_CONFIG on Bun and on Workers", async () => {
    setup();
    for (const workers of [false, true]) {
      runtimeMock.workers = workers;
      const res = await runEither(service.create({ label: "Local", transportType: "stdio", command: "local-mcp", args: ["--stdio"] }));
      expect(res).toMatchObject({
        _tag: "Left",
        left: { _tag: "McpInvalidTransportConfig", reason: STDIO_REASON },
      });
    }
    // Nothing was persisted on either runtime.
    expect(await run(service.list())).toEqual([]);
  });

  it("create rejects an env: secret name outside the RuntimeEnv snapshot and stores nothing", async () => {
    setup();
    const unknown = await runEither(service.create({ label: "Linear", transportType: "http", url: "https://mcp.test/x", secretRef: "env:LINEAR_TOKEN" }));
    expect(unknown).toMatchObject({ _tag: "Left", left: { _tag: "McpInvalidTransportConfig", reason: envSecretRefReason("LINEAR_TOKEN") } });
    expect(await run(service.list())).toEqual([]);

    // A fixed runtime key is accepted, and the resolved value is never echoed.
    const known = await run(service.create({ label: "Linear", transportType: "sse", url: "https://mcp.test/s", secretRef: "env:CRON_SECRET" }));
    expect(known).toMatchObject({ id: "linear", transportType: "sse", hasSecret: true });
    expect(JSON.stringify(known)).not.toContain("CRON_SECRET");

    const unknownAgain = await runEither(service.create({ label: "Linear", transportType: "sse", url: "https://mcp.test/s", secretRef: "env:MCP_REMOTE_TOKEN" }));
    expect(unknownAgain).toMatchObject({ _tag: "Left", left: { _tag: "McpInvalidTransportConfig", reason: envSecretRefReason("MCP_REMOTE_TOKEN") } });
  });

  it("update rejects an env: secret name outside the RuntimeEnv snapshot and keeps the stored ref", async () => {
    setup();
    await run(service.create({ label: "Remote", transportType: "http", url: "https://mcp.test/x", secretRef: "env:GITHUB_WEBHOOK_SECRET" }));

    const refused = await runEither(service.update("remote", { secretRef: "env:LINEAR_TOKEN" }));
    expect(refused).toMatchObject({ _tag: "Left", left: { _tag: "McpInvalidTransportConfig", reason: envSecretRefReason("LINEAR_TOKEN") } });
    expect((await run(service.list()))[0]).toMatchObject({ id: "remote", hasSecret: true });

    // Removal is the explicit `clearSecret` affordance now. `secretRef: null`
    // is an EMPTY field, which means "keep" — a UI that always posts its form
    // must not be able to wipe a credential by saving a blank input.
    const keptOnBlank = await run(service.update("remote", { secretRef: null }));
    expect(keptOnBlank.hasSecret).toBe(true);
    const cleared = await run(service.update("remote", { clearSecret: true }));
    expect(cleared.hasSecret).toBe(false);
    expect(cleared.secretSource).toBe("none");

    const accepted = await run(service.update("remote", { secretRef: "env:LXK_S3_SECRET_ACCESS_KEY" }));
    expect(accepted.hasSecret).toBe(true);
  });

  // A process env var is not a runtime key: the allowlist is the snapshot, not
  // the host environment, so the same name stays refused on the Bun host.
  it("refuses an env: name that exists only in process.env", async () => {
    setup();
    process.env.LINEAR_TOKEN = "process-secret";
    try {
      const res = await runEither(service.create({ label: "Linear", transportType: "http", url: "https://mcp.test/x", secretRef: "env:LINEAR_TOKEN" }));
      expect(res).toMatchObject({ _tag: "Left", left: { _tag: "McpInvalidTransportConfig", reason: envSecretRefReason("LINEAR_TOKEN") } });
      expect(await run(service.list())).toEqual([]);
    } finally {
      delete process.env.LINEAR_TOKEN;
    }
  });

  // A pre-existing stored ref that is no longer an allowlisted name must not
  // freeze the row: only a SUPPLIED secretRef is allowlist-validated, exactly
  // like the legacy process fields. The stored value is passed through, so the
  // row stays editable until a valid ref (or null) replaces it.
  it("update patches other fields on a legacy row whose stored ref is not allowlisted", async () => {
    setup();
    insertLegacyBadRefRow();

    const renamed = await run(service.update("legacy-bad-ref", { label: "Legacy Renamed" }));
    expect(renamed).toMatchObject({ id: "legacy-bad-ref", label: "Legacy Renamed", transportType: "http", hasSecret: true });

    const moved = await run(service.update("legacy-bad-ref", { url: "https://mcp.test/moved" }));
    expect(moved.url).toBe("https://mcp.test/moved");

    const enabled = await run(service.update("legacy-bad-ref", { enabled: true }));
    expect(enabled).toMatchObject({ enabled: true, hasSecret: true });

    const stored = db.prepare("SELECT secret_ref FROM assistant_mcp_servers WHERE id = 'legacy-bad-ref'").get() as { secret_ref: string | null };
    expect(stored.secret_ref).toBe("env:LINEAR_TOKEN");

    // Supplying the same now-unknown name is still refused.
    const refused = await runEither(service.update("legacy-bad-ref", { secretRef: "env:LINEAR_TOKEN" }));
    expect(refused).toMatchObject({ _tag: "Left", left: { _tag: "McpInvalidTransportConfig", reason: envSecretRefReason("LINEAR_TOKEN") } });
    expect((await run(service.list()))[0]).toMatchObject({ id: "legacy-bad-ref", label: "Legacy Renamed" });
  });

  it("slug `jev` is an ordinary user-owned client", async () => {
    setup();
    const created = await run(service.create({ label: "Jev", transportType: "http", url: "https://mcp.test/jev" }));
    expect(created).toMatchObject({ id: "jev", label: "Jev", transportType: "http", enabled: false });
    expect((await run(service.list())).map((s) => s.id)).toEqual(["jev"]);

    await run(service.remove("jev"));
    expect(await run(service.list())).toEqual([]);
  });

  it("rejects invalid transport shapes and secret refs", async () => {
    setup();
    const noUrl = await runEither(service.create({ label: "Remote", transportType: "http", url: null }));
    expect(noUrl).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "McpInvalidTransportConfig", reason: "url is required for http/sse transport" }) });

    const badSecret = await runEither(service.create({ label: "Remote", transportType: "http", url: "https://mcp.test/x", secretRef: "plaintext" }));
    expect(badSecret).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "McpInvalidTransportConfig" }) });
    expect(await run(service.list())).toEqual([]);
  });

  it("runs the SSRF guard on http/sse saves", async () => {
    setup();
    ssrfMock.block = true;
    const blocked = await runEither(service.create({ label: "Remote", transportType: "sse", url: "https://mcp.test/x" }));
    expect(blocked).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "McpInvalidTransportConfig" }) });
    expect(await run(service.list())).toEqual([]);

    ssrfMock.block = false;
    const ok = await run(service.create({ label: "Remote", transportType: "http", url: "https://mcp.test/x" }));
    expect(ok.id).toBe("remote");
    expect(ok.url).toBe("https://mcp.test/x");
    expect(ok.command).toBeNull();
  });

  it("update patches fields and re-validates the merged transport shape", async () => {
    setup();
    await run(service.create({ label: "Remote", transportType: "http", url: "https://mcp.test/x" }));

    const renamed = await run(service.update("remote", { label: "Remote 2", args: [] }));
    expect(renamed).toMatchObject({ label: "Remote 2", transportType: "http", args: [] });

    // Switching transport without a usable url is invalid on the merged row.
    const clearedUrl = await runEither(service.update("remote", { url: null }));
    expect(clearedUrl).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "McpInvalidTransportConfig" }) });

    const switched = await run(service.update("remote", { transportType: "sse" }));
    expect(switched.transportType).toBe("sse");
    expect(switched.url).toBe("https://mcp.test/x");
    expect(switched.command).toBeNull();
  });

  it("update refuses a command or non-empty args and never persists them", async () => {
    setup();
    await run(service.create({ label: "Remote", transportType: "http", url: "https://mcp.test/x" }));

    const withCommand = await runEither(service.update("remote", { command: "npx" }));
    expect(withCommand).toMatchObject({ _tag: "Left", left: { _tag: "McpInvalidTransportConfig", reason: PROCESS_FIELDS_REJECTED } });
    const withArgs = await runEither(service.update("remote", { args: ["--verbose"] }));
    expect(withArgs).toMatchObject({ _tag: "Left", left: { _tag: "McpInvalidTransportConfig", reason: PROCESS_FIELDS_REJECTED } });
    expect(await run(service.list())).toMatchObject([{ id: "remote", command: null, args: [] }]);
  });

  it("update normalises legacy stored process fields away", async () => {
    setup();
    // A row written by an older build can still hold `args` (the 0009 CHECK only
    // pins `command`); the next write clears it instead of blocking the patch.
    db.exec(
      `INSERT INTO assistant_mcp_servers (id, label, transport_type, url, command, args, enabled)
       VALUES ('legacy-http', 'Legacy Http', 'http', 'https://mcp.test/legacy', NULL, '["--old"]', 0)`
    );
    const renamed = await run(service.update("legacy-http", { label: "Legacy 2" }));
    expect(renamed).toMatchObject({ label: "Legacy 2", transportType: "http", command: null, args: [] });
  });

  it("update refuses to switch a stored client to stdio", async () => {
    setup();
    await run(service.create({ label: "Remote", transportType: "http", url: "https://mcp.test/x" }));
    for (const workers of [false, true]) {
      runtimeMock.workers = workers;
      const res = await runEither(service.update("remote", { transportType: "stdio", command: "local-mcp" }));
      expect(res).toMatchObject({
        _tag: "Left",
        left: { _tag: "McpInvalidTransportConfig", reason: STDIO_REASON },
      });
    }
    expect((await run(service.list())).map((s) => s.transportType)).toEqual(["http"]);
  });

  it("remove deletes a registered client and 404s unknown ids", async () => {
    setup();
    const missing = await runEither(service.remove("nope"));
    expect(missing).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "McpServerNotFound" }) });

    await run(service.create({ label: "Temp", transportType: "http", url: "https://mcp.test/t" }));
    await run(service.remove("temp"));
    expect(await run(service.list())).toEqual([]);
  });

  it("project availability is a replace-set and validates server ids", async () => {
    setup();
    db.exec(`INSERT INTO projects (id, name, slug) VALUES ('p1', 'P', 'p1')`);
    await run(service.create({ label: "A", transportType: "http", url: "https://mcp.test/a" }));
    await run(service.create({ label: "B", transportType: "sse", url: "https://mcp.test/b" }));

    await run(service.setProjectServers("p1", [{ serverId: "a", enabled: false }, { serverId: "b", enabled: true }]));
    expect((await run(service.listForProject("p1"))).map((r) => [r.serverId, r.enabled])).toEqual([["a", false], ["b", true]]);

    await run(service.setProjectServers("p1", [{ serverId: "a", enabled: false }]));
    expect((await run(service.listForProject("p1"))).map((r) => r.serverId)).toEqual(["a"]);

    const bad = await runEither(service.setProjectServers("p1", [{ serverId: "ghost", enabled: true }]));
    expect(bad).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "McpServerNotFound" }) });
  });

  it("test endpoint reports the connector result and never throws for a live row", async () => {
    setup(okConnector);
    await run(service.create({ label: "Remote", transportType: "http", url: "https://mcp.test/x" }));
    const report = await run(service.testConnection("remote"));
    expect(report).toEqual({ ok: true, toolCount: 3, readOnlyToolCount: 2, latencyMs: expect.any(Number), error: null });

    const missing = await runEither(service.testConnection("nope"));
    expect(missing).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "McpServerNotFound" }) });
  });

  it("test endpoint folds a failed connect into an error report (still resolvable)", async () => {
    setup(failConnector);
    await run(service.create({ label: "Remote", transportType: "sse", url: "https://mcp.test/s" }));
    const report = await run(service.testConnection("remote"));
    expect(report.ok).toBe(false);
    expect(report.toolCount).toBe(0);
    expect(report.error).toEqual({ code: "MCP_CONNECT_FAILED", message: "no route to host" });
  });

  // End-to-end pin through the real LiveMcpConnector + the real report shape:
  // a planted multiline secret must reach neither the 200 body nor stderr. The
  // unit tests prove each guard in isolation; this proves the wiring has no
  // unguarded seam between them.
  it("live connector + planted multiline secret: report body and stderr carry no secret", async () => {
    const secret = "-----BEGIN PRIVATE KEY-----\nplanted-live-secret-body\n-----END PRIVATE KEY-----";
    const env = { GITHUB_WEBHOOK_SECRET: secret } as unknown as RuntimeEnv;
    dir = mkdtempSync(join(tmpdir(), "lexa-assistant-mcp-live-"));
    const path = join(dir, "test.db");
    runMigrations(path, MIGRATIONS);
    db = new Database(path);
    db.exec("PRAGMA foreign_keys = ON");
    const layer = AssistantMcpService.Default.pipe(
      Layer.provide(Layer.mergeAll(DbBunLive(db), LiveMcpConnector))
    );
    const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
    const liveService = Context.get(ctx, AssistantMcpService);
    // The planted env is provided per call, exactly as the request handler does
    // in server/api/http.ts (RuntimeEnvLive in the per-request base layer).
    const live = <A, E>(eff: Effect.Effect<A, E>) =>
      Effect.runPromise(eff.pipe(Effect.provide(RuntimeEnvLive(env))));

    await live(liveService.create({
      label: "Live",
      transportType: "http",
      url: "https://mcp.test/live",
      secretRef: "env:GITHUB_WEBHOOK_SECRET",
    }));

    const logged: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      logged.push(String(chunk));
      return true;
    });
    let report: unknown;
    try {
      report = await live(liveService.testConnection("live"));
    } finally {
      spy.mockRestore();
    }

    expect(report).toEqual({
      ok: false,
      toolCount: 0,
      readOnlyToolCount: 0,
      latencyMs: expect.any(Number),
      error: { code: "MCP_CONNECT_FAILED", message: SECRET_NOT_SINGLE_LINE },
    });
    const body = JSON.stringify(report);
    expect(body).not.toContain("planted-live-secret-body");
    expect(body).not.toContain("BEGIN PRIVATE KEY");
    const stderr = logged.join("\n");
    expect(stderr).not.toContain("planted-live-secret-body");
    expect(stderr).not.toContain("BEGIN PRIVATE KEY");
    expect(sdkMock.calls).toEqual([]);
  });

  it("test endpoint refuses a legacy stdio row with MCP_INVALID_TRANSPORT_CONFIG (no process spawn)", async () => {
    setup(okConnector);
    insertLegacyStdioRow();
    for (const workers of [false, true]) {
      runtimeMock.workers = workers;
      const report = await run(service.testConnection("legacy"));
      expect(report).toEqual({
        ok: false,
        toolCount: 0,
        readOnlyToolCount: 0,
        latencyMs: 0,
        error: { code: "MCP_INVALID_TRANSPORT_CONFIG", message: STDIO_REASON },
      });
    }
  });
});

// Managed secrets (envelope encryption). Each test drives the REAL service and,
// where a connect is involved, the REAL LiveMcpConnector — the crypto path
// (remoteTransportFor -> decryptMcpSecret) is the thing under test, so a stub
// would prove nothing. `sdkMock` is the only seam: it records exactly what the
// SDK was handed, and `ok` stays false on every refusal path, so a secret that
// reached the SDK is a visible failure rather than a silent pass.
describe("managed MCP client secrets", () => {
  const managedEnv = (over: Partial<RuntimeEnv> = {}): RuntimeEnv =>
    envWith({ LXK_MCP_MASTER_KEY: KEY_A, ...over });
  // The rotation env: a NEW active key with the one that wrote the rows demoted
  // to PREV. Exactly what an operator sets to rotate without an outage. `null`
  // prev is the "PREV retired" state — a rotation completed, PREV emptied.
  const rotatedEnv = (prev: string | null = KEY_A, active: string = KEY_B): RuntimeEnv =>
    envWith({ LXK_MCP_MASTER_KEY: active, ...(prev === null ? {} : { LXK_MCP_MASTER_KEY_PREV: prev }) });
  const noKeyEnv = (): RuntimeEnv => envWith({});

  const createInput = (over: Partial<Parameters<typeof service.create>[0]> = {}) => ({
    label: "Managed",
    transportType: "http" as const,
    url: "https://mcp.test/managed",
    ...over,
  });

  it("1. stores exactly one source on create and update — the other is removed, both is refused", async () => {
    setup();

    // Managed only: ciphertext row written, registry ref stays null, the public
    // shape says `managed` and never carries the value.
    const managed = await withKey(managedEnv(), service.create(createInput({ secret: MARKER })));
    expect(managed).toMatchObject({ id: "managed", hasSecret: true, secretSource: "managed" });
    expect(refOf("managed")).toBeNull();
    const stored = secretRow("managed");
    expect(stored).toBeDefined();
    expect(stored!.key_id).toBe(MCP_SECRET_KEY_ID_ACTIVE);
    expect(stored!.ciphertext).not.toContain(MARKER);
    expect(stored!.iv).not.toContain(MARKER);

    // Reference only: no ciphertext row at all.
    const referenced = await withKey(managedEnv(), service.create(createInput({
      label: "Referenced",
      secretRef: "env:CRON_SECRET",
    })));
    expect(referenced).toMatchObject({ id: "referenced", hasSecret: true, secretSource: "reference" });
    expect(secretRow("referenced")).toBeNull();
    expect(refOf("referenced")).toBe("env:CRON_SECRET");

    // Neither: a secret-less client stays legal.
    const bare = await withKey(managedEnv(), service.create(createInput({ label: "Bare" })));
    expect(bare).toMatchObject({ id: "bare", hasSecret: false, secretSource: "none" });
    expect(secretRow("bare")).toBeNull();
    expect(refOf("bare")).toBeNull();

    // Both on create: refused, and nothing at all is written for that label.
    const both = await withKeyEither(managedEnv(), service.create(createInput({
      label: "Both",
      secret: MARKER,
      secretRef: "env:CRON_SECRET",
    })));
    expect(both).toMatchObject({
      _tag: "Left",
      left: { _tag: "McpInvalidTransportConfig", reason: SECRET_BOTH_SOURCES_REJECTED },
    });
    expect((await run(service.list())).map((s) => s.id)).toEqual(["bare", "managed", "referenced"]);
    expect(secretRow("both")).toBeNull();
    expect(secretCount()).toBe(1);

    // Choosing a reference on update DELETES the ciphertext row.
    const toRef = await withKey(managedEnv(), service.update("managed", { secretRef: "env:CRON_SECRET" }));
    expect(toRef).toMatchObject({ hasSecret: true, secretSource: "reference" });
    expect(secretRow("managed")).toBeNull();
    expect(refOf("managed")).toBe("env:CRON_SECRET");

    // Choosing a managed token on update NULLS the stored ref.
    const toManaged = await withKey(managedEnv(), service.update("referenced", { secret: MARKER }));
    expect(toManaged).toMatchObject({ hasSecret: true, secretSource: "managed" });
    expect(refOf("referenced")).toBeNull();
    expect(secretRow("referenced")).toBeDefined();

    // Both on update: refused, and the stored source survives untouched.
    const before = secretRow("referenced")!;
    const bothUpdate = await withKeyEither(managedEnv(), service.update("referenced", {
      secret: MARKER,
      secretRef: "env:CRON_SECRET",
    }));
    expect(bothUpdate).toMatchObject({
      _tag: "Left",
      left: { _tag: "McpInvalidTransportConfig", reason: SECRET_BOTH_SOURCES_REJECTED },
    });
    expect(secretRow("referenced")).toEqual(before);

    // clearSecret + a value is refused rather than silently resolved, so a UI
    // bug can never erase one source and store the other in one request.
    const clearConflict = await withKeyEither(managedEnv(), service.update("referenced", {
      clearSecret: true,
      secret: MARKER,
    }));
    expect(clearConflict).toMatchObject({
      _tag: "Left",
      left: { _tag: "McpInvalidTransportConfig", reason: SECRET_CLEAR_CONFLICT_REJECTED },
    });
    expect(secretRow("referenced")).toEqual(before);
  });

  it("2. refuses a managed write with no master key, and a malformed key, without half-applying anything", async () => {
    setup();

    // The documented disable switch: no key, no managed secret, and the registry
    // row is not created either — a disabled deployment accumulates no orphans.
    const noKey = await withKeyEither(noKeyEnv(), service.create(createInput({ secret: MARKER })));
    expect(noKey).toMatchObject({
      _tag: "Left",
      left: { _tag: "McpInvalidTransportConfig", reason: SECRET_REQUIRES_MASTER_KEY },
    });
    expect(await run(service.list())).toEqual([]);
    expect(secretCount()).toBe(0);

    // A configured-but-wrong key is told, not silently treated as disabled.
    const malformed = await withKeyEither(
      envWith({ LXK_MCP_MASTER_KEY: "too-short" }),
      service.create(createInput({ secret: MARKER }))
    );
    expect(malformed).toMatchObject({
      _tag: "Left",
      left: { _tag: "McpInvalidTransportConfig", reason: MCP_MASTER_KEY_INVALID },
    });
    expect(await run(service.list())).toEqual([]);
    expect(secretCount()).toBe(0);

    // `env:`/`file:` references are untouched by the switch: they keep saving
    // and keep reporting `reference` with no key configured at all.
    const ref = await withKey(noKeyEnv(), service.create(createInput({
      label: "Ref Only",
      secretRef: "env:CRON_SECRET",
    })));
    expect(ref).toMatchObject({ id: "ref-only", hasSecret: true, secretSource: "reference" });
    expect(secretCount()).toBe(0);

    // An update that would store a token is refused the same way, and the
    // stored row keeps whatever it had.
    const refusedUpdate = await withKeyEither(noKeyEnv(), service.update("ref-only", { secret: MARKER }));
    expect(refusedUpdate).toMatchObject({
      _tag: "Left",
      left: { _tag: "McpInvalidTransportConfig", reason: SECRET_REQUIRES_MASTER_KEY },
    });
    expect(refOf("ref-only")).toBe("env:CRON_SECRET");
    expect(secretCount()).toBe(0);
  });

  it("3. refuses a denylisted ref at save and again at connect, including a legacy stored one", async () => {
    setupLive();
    // A legal stored ref, so each refused update below has something to protect.
    await withKey(managedEnv(), service.create(createInput({ label: "Ref Only", secretRef: "env:CRON_SECRET" })));
    for (const name of MCP_SECRET_REF_DENYLIST) {
      const refused = await withKeyEither(managedEnv(), service.create(createInput({
        label: `Denied ${name}`,
        secretRef: `env:${name}`,
      })));
      expect(refused, name).toMatchObject({
        _tag: "Left",
        left: { _tag: "McpInvalidTransportConfig", reason: denylistedSecretRefReason(name) },
      });
      const refusedUpdate = await withKeyEither(managedEnv(), service.update("ref-only", { secretRef: `env:${name}` }));
      expect(refusedUpdate, name).toMatchObject({
        _tag: "Left",
        left: { _tag: "McpInvalidTransportConfig", reason: denylistedSecretRefReason(name) },
      });
    }
    // Nothing was created or overwritten by the refused writes.
    expect(refOf("ref-only")).toBe("env:CRON_SECRET");
    expect(await run(service.list())).toHaveLength(1);
    expect(secretCount()).toBe(0);

    // A row written before the denylist existed: the stored ref names the master
    // key, and the env really carries it, so without the connect-time guard the
    // envelope key itself would be forwarded as a Bearer token.
    db.exec(
      `INSERT INTO assistant_mcp_servers (id, label, transport_type, url, command, args, secret_ref, enabled)
       VALUES ('legacy-key-ref', 'Legacy Key Ref', 'http', 'https://mcp.test/legacy', NULL, '[]', 'env:LXK_MCP_MASTER_KEY', 0)`
    );
    const report = await withKey(managedEnv({ LXK_MCP_MASTER_KEY: KEY_A }), service.testConnection("legacy-key-ref"));
    expect(report).toMatchObject({
      ok: false,
      toolCount: 0,
      error: { code: "MCP_CONNECT_FAILED", message: SECRET_REF_DENIED_REASON },
    });
    // The key never reached the SDK, and never reached the report body either.
    expect(sdkMock.calls).toEqual([]);
    expect(JSON.stringify(report)).not.toContain(KEY_A);
  });

  it("4. an undecryptable blob is a hard error that leaks neither secret nor ciphertext", async () => {
    setupLive();
    // The URL plants a KNOWN plaintext string in the database so the byte scan
    // below is a positive control: it can see plaintext that really is stored,
    // so "not present" for the token means absent, not invisible. The label
    // stays "Managed" so the slug id matches the other assertions.
    await withKey(managedEnv(), service.create(createInput({ url: `https://mcp.test/${CONTROL}`, secret: MARKER })));
    const stored = secretRow("managed")!;
    expect(stored.ciphertext).not.toBe("");

    // Wrong key: neither slot opens it, so the connect fails hard instead of
    // silently authenticating as anonymous.
    const wrongKey = await withKey(
      rotatedEnv(PREV_KEY, KEY_B),
      service.testConnection("managed")
    );
    expect(wrongKey).toMatchObject({
      ok: false,
      toolCount: 0,
      readOnlyToolCount: 0,
      error: { code: "MCP_CONNECT_FAILED", message: MCP_SECRET_DECRYPT_FAILED },
    });
    const wrongBody = JSON.stringify(wrongKey);
    expect(wrongBody).not.toContain(MARKER);
    expect(wrongBody).not.toContain(stored.ciphertext);
    expect(sdkMock.calls).toEqual([]);

    // Tampered row: flip one stored ciphertext byte and the same fixed failure
    // comes back — the tampered value is not echoed either.
    const bytes = Buffer.from(stored.ciphertext, "base64");
    bytes[0] = (bytes[0]! ^ 0xff) & 0xff;
    const tampered = bytes.toString("base64");
    db.prepare("UPDATE assistant_mcp_secrets SET ciphertext = ? WHERE server_id = ?").run(tampered, "managed");
    const logged: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      logged.push(String(chunk));
      return true;
    });
    let tamperedReport: unknown;
    try {
      tamperedReport = await withKey(managedEnv(), service.testConnection("managed"));
    } finally {
      spy.mockRestore();
    }
    expect(tamperedReport).toMatchObject({
      ok: false,
      error: { code: "MCP_CONNECT_FAILED", message: MCP_SECRET_DECRYPT_FAILED },
    });
    const tamperedBody = JSON.stringify(tamperedReport);
    expect(tamperedBody).not.toContain(MARKER);
    expect(tamperedBody).not.toContain(tampered);
    const stderr = logged.join("\n");
    expect(stderr).not.toContain(MARKER);
    expect(stderr).not.toContain(tampered);
    expect(stderr).not.toContain(MCP_SECRET_DECRYPT_FAILED.split(" ")[0]!);
    expect(sdkMock.calls).toEqual([]);

    // The raw database file, not a SELECT: a plaintext leak would live in a
    // page image or an uncheckpointed WAL frame, which no query could see.
    // CONTROL (the planted URL) and the tampered blob are both expected to be
    // readable as raw bytes — that is the positive control proving this scan can
    // see what is really stored; the token must be nowhere in it.
    const raw = rawDatabaseBytes();
    expect(raw).toContain(CONTROL);
    expect(raw).toContain(tampered);
    expect(raw).not.toContain(MARKER);
  });

  it("5. a row written under the active key survives that key moving to PREV, and dies when it is dropped", async () => {
    setupLive();
    // Written while KEY_A is active; the row records the slot, not the key.
    await withKey(managedEnv(), service.create(createInput({ secret: MARKER })));
    const stored = secretRow("managed")!;
    expect(stored.key_id).toBe(MCP_SECRET_KEY_ID_ACTIVE);

    // Rotation: KEY_B becomes active, KEY_A is demoted to PREV. The row still
    // says `active`, so only a fallback can open it — and the decrypted token
    // must actually reach the SDK as the Bearer credential.
    sdkMock.ok = true;
    const rotated = await withKey(rotatedEnv(), service.testConnection("managed"));
    expect(rotated).toMatchObject({ ok: true, toolCount: 0, error: null });
    expect(sdkMock.calls).toHaveLength(1);
    expect((sdkMock.calls[0]!.transport as { headers: Record<string, string> }).headers).toEqual({
      Authorization: `Bearer ${MARKER}`,
    });
    // The rotation is a read-path event only: no rewrap, no re-encryption.
    expect(secretRow("managed")).toEqual(stored);

    // Retiring PREV (the documented unfinished-rotation state) is the one thing
    // that does kill the row: a hard error, never a silent anonymous connect.
    sdkMock.calls = [];
    const retired = await withKey(rotatedEnv(null, KEY_B), service.testConnection("managed"));
    expect(retired).toMatchObject({
      ok: false,
      toolCount: 0,
      error: { code: "MCP_CONNECT_FAILED", message: MCP_SECRET_DECRYPT_FAILED },
    });
    expect(JSON.stringify(retired)).not.toContain(MARKER);
    expect(sdkMock.calls).toEqual([]);
  });

  it("6. clearSecret revokes a stored token with no master key configured", async () => {
    setup();
    await withKey(managedEnv(), service.create(createInput({ secret: MARKER })));
    expect(secretCount()).toBe(1);

    // A pure row delete: revocation must not depend on a key being present, or
    // a rotated-away key would leave a credential no one can remove.
    const cleared = await withKey(noKeyEnv(), service.update("managed", { clearSecret: true }));
    expect(cleared).toMatchObject({ id: "managed", hasSecret: false, secretSource: "none" });
    expect(secretCount()).toBe(0);
    expect(refOf("managed")).toBeNull();

    // Same for a stored reference, and for a client that never had a secret.
    await withKey(noKeyEnv(), service.create(createInput({ label: "Ref Only", secretRef: "env:CRON_SECRET" })));
    const refCleared = await withKey(noKeyEnv(), service.update("ref-only", { clearSecret: true }));
    expect(refCleared).toMatchObject({ hasSecret: false, secretSource: "none" });
    expect(refOf("ref-only")).toBeNull();
    const bareCleared = await withKey(noKeyEnv(), service.update("managed", { clearSecret: true, label: "Managed" }));
    expect(bareCleared).toMatchObject({ label: "Managed", hasSecret: false, secretSource: "none" });

    // remove() takes the child row with it (FK-OFF runner included).
    await withKey(managedEnv(), service.create(createInput({ label: "Doomed", secret: MARKER })));
    expect(secretCount()).toBe(1);
    await withKey(managedEnv(), service.remove("doomed"));
    expect(secretCount()).toBe(0);
  });

  it("7. never returns the token, the ciphertext, or the key in a public shape", async () => {
    setup();
    const created = await withKey(managedEnv(), service.create(createInput({ secret: MARKER })));
    const stored = secretRow("managed")!;
    const publicKeys = [
      "args",
      "command",
      "createdAt",
      "enabled",
      "hasSecret",
      "id",
      "label",
      "secretSource",
      "transportType",
      "updatedAt",
      "url",
    ];
    // The service return value IS the HTTP response body (http.ts responds with
    // it verbatim), so pinning the key set pins the API contract.
    expect(Object.keys(created).sort()).toEqual(publicKeys);
    for (const shape of [created, (await run(service.list()))[0]!, (await run(service.update("managed", { label: "Managed" })))]) {
      const body = JSON.stringify(shape);
      expect(body).not.toContain(MARKER);
      expect(body).not.toContain(stored.ciphertext);
      expect(body).not.toContain(stored.iv);
      expect(body).not.toContain(KEY_A);
      expect(body).not.toContain("secretRef");
      expect(body).not.toContain("secret_ref");
    }
    // The report body is the other surface a secret could reach.
    const report = await withKey(managedEnv(), service.testConnection("managed"));
    expect(JSON.stringify(report)).not.toContain(MARKER);
    expect(JSON.stringify(report)).not.toContain(stored.ciphertext);
  });

  it("8. an unrelated patch passes the stored ref and ciphertext through untouched, with or without a key", async () => {
    setup();
    await withKey(managedEnv(), service.create(createInput({ secret: MARKER })));
    await withKey(managedEnv(), service.create(createInput({ label: "Ref Only", secretRef: "env:CRON_SECRET" })));
    const managedBefore = secretRow("managed")!;

    // Renaming a managed client must not re-encrypt (a fresh IV per write would
    // change the blob), must not need a key, and must not drop the row.
    const renamed = await withKey(noKeyEnv(), service.update("managed", { label: "Managed Renamed" }));
    expect(renamed).toMatchObject({ label: "Managed Renamed", hasSecret: true, secretSource: "managed" });
    expect(secretRow("managed")).toEqual(managedBefore);

    // Same under a DIFFERENT key: a patch has no business touching the blob.
    const underOther = await withKey(rotatedEnv(), service.update("managed", { enabled: true }));
    expect(underOther).toMatchObject({ enabled: true, hasSecret: true, secretSource: "managed" });
    expect(secretRow("managed")).toEqual(managedBefore);

    // An empty secret field means "keep" — a UI that always posts its form can
    // never blank a stored credential by saving a blank input.
    const blank = await withKey(managedEnv(), service.update("managed", { secret: "", secretRef: null }));
    expect(blank).toMatchObject({ hasSecret: true, secretSource: "managed" });
    expect(secretRow("managed")).toEqual(managedBefore);

    // The legacy-freeze lesson for a stored reference: an unrelated patch keeps
    // it, with no key configured and no secret fields supplied.
    const refKept = await withKey(noKeyEnv(), service.update("ref-only", { label: "Ref Renamed" }));
    expect(refKept).toMatchObject({ label: "Ref Renamed", hasSecret: true, secretSource: "reference" });
    expect(refOf("ref-only")).toBe("env:CRON_SECRET");
  });

  // The write ORDER is the safety property: the ciphertext is stored BEFORE the
  // registry write that clears `secret_ref`. A fault in between must leave the
  // client with the credential it already had, never with none — an
  // unauthenticated connect is indistinguishable from a working one.
  it("9. a fault between the ciphertext upsert and the ref clear keeps the stored ref", async () => {
    setup();
    // Both clients with a live credential to protect are created BEFORE the
    // fault is armed: the trigger refuses every ciphertext INSERT, so a managed
    // client created under it would fail for a reason this test is not about.
    await withKey(managedEnv(), service.create(createInput({ label: "Ref Only", secretRef: "env:CRON_SECRET" })));
    expect(refOf("ref-only")).toBe("env:CRON_SECRET");
    expect(secretRow("ref-only")).toBeNull();
    await withKey(managedEnv(), service.create(createInput({ label: "Managed", secret: MARKER })));

    // Fault injection at the storage boundary: a trigger that makes the
    // ciphertext upsert fail exactly as a disk/constraint fault would. RAISE
    // (not ABORT) keeps the surrounding statement recoverable.
    db.exec(`CREATE TRIGGER fail_secret_upsert BEFORE INSERT ON assistant_mcp_secrets
             BEGIN SELECT RAISE(FAIL, 'injected upsert fault'); END;`);

    const faulted = await withKeyEither(managedEnv(), service.update("ref-only", { secret: MARKER }));
    expect(faulted).toMatchObject({ _tag: "Left", left: { _tag: "DbError" } });
    // The registry write that nulls the ref never ran: the client still
    // authenticates with its old reference instead of connecting anonymously.
    expect(refOf("ref-only")).toBe("env:CRON_SECRET");
    expect(secretRow("ref-only")).toBeNull();
    expect(await run(service.list())).toMatchObject([
      { id: "managed", hasSecret: true, secretSource: "managed" },
      { id: "ref-only", hasSecret: true, secretSource: "reference" },
    ]);

    // The same fault on a managed re-save leaves the PREVIOUS ciphertext in
    // place (the upsert is atomic), so a client is never left credential-less.
    const before = secretRow("managed")!;
    const refaulted = await withKeyEither(managedEnv(), service.update("managed", { secret: `${MARKER}-2` }));
    expect(refaulted).toMatchObject({ _tag: "Left", left: { _tag: "DbError" } });
    expect(secretRow("managed")).toEqual(before);

    // With the fault removed, the success path stores exactly ONE source: the
    // new ciphertext, and no stale reference beside it.
    db.exec("DROP TRIGGER fail_secret_upsert");
    const retried = await withKey(managedEnv(), service.update("ref-only", { secret: MARKER }));
    expect(retried).toMatchObject({ id: "ref-only", hasSecret: true, secretSource: "managed" });
    expect(refOf("ref-only")).toBeNull();
    expect(secretRow("ref-only")).toBeDefined();
    expect(secretCount()).toBe(2);

    // A managed CREATE has no prior credential to protect, but the same
    // ordering means an encryption fault leaves NO registration at all: the
    // token is sealed before the registry row is written.
    const sealFault = vi.spyOn(crypto.subtle, "encrypt").mockRejectedValueOnce(new Error("injected encrypt fault"));
    try {
      const cryptoFault = await withKeyEither(managedEnv(), service.create(createInput({ label: "Never", secret: MARKER })));
      expect(cryptoFault).toMatchObject({
        _tag: "Left",
        left: { _tag: "McpInvalidTransportConfig", reason: "managed MCP secret could not be encrypted" },
      });
    } finally {
      sealFault.mockRestore();
    }
    expect(await run(service.list())).toMatchObject([{ id: "managed" }, { id: "ref-only" }]);
    // No registration and no ciphertext row for the failed label: the whole row
    // is absent, not a row with an empty credential.
    expect(db.prepare("SELECT id FROM assistant_mcp_servers WHERE id = ?").get("never")).toBeNull();
    expect(secretRow("never")).toBeNull();
  });

  // The 400 body is built from `reason` verbatim, so a third-party WebCrypto or
  // driver message must never reach it: such text can quote the key material
  // the import choked on. Every import failure reduces to the fixed shape
  // message, and no other text (canary included) survives.
  it("10. a failing key import reports the fixed shape message, never the third-party error", async () => {
    setup();
    const canary = "CANARY-THIRD-PARTY-KEY-MATERIAL";
    const importKey = crypto.subtle.importKey.bind(crypto.subtle);
    const spy = vi.spyOn(crypto.subtle, "importKey").mockRejectedValueOnce(new Error(`${canary}: unsupported key length`));
    try {
      const refused = await withKeyEither(managedEnv(), service.create(createInput({ secret: MARKER })));
      expect(refused).toMatchObject({
        _tag: "Left",
        left: { _tag: "McpInvalidTransportConfig", reason: MCP_MASTER_KEY_INVALID },
      });
      const body = JSON.stringify(refused);
      expect(body).not.toContain(canary);
      expect(body).not.toContain("unsupported key length");
      expect(body).not.toContain(MARKER);
    } finally {
      spy.mockRestore();
    }
    // Nothing was written, and the key still imports normally afterwards.
    expect(await run(service.list())).toEqual([]);
    expect(secretCount()).toBe(0);
    const ok = await withKey(managedEnv(), service.create(createInput({ secret: MARKER })));
    expect(ok).toMatchObject({ id: "managed", hasSecret: true, secretSource: "managed" });
    expect(importKey).toBeTypeOf("function");
  });
});

describe("slugifyMcpId", () => {
  it("slugifies labels and falls back when empty", () => {
    expect(slugifyMcpId("My Cool Server")).toBe("my-cool-server");
    expect(slugifyMcpId("   ")).toBe("mcp-server");
  });
});
