import { describe, expect, it, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  envSecretRefReason,
  McpConnector,
  PROCESS_FIELDS_REJECTED,
  slugifyMcpId,
  validateTransportConfig,
  type McpConnectorShape,
  type McpTransportConfig,
} from "./assistant-mcp.service";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

const STDIO_REASON = "transportType 'stdio' is not supported — MCP clients connect to remote http/sse servers";
const SECRET_NOT_SINGLE_LINE = "resolved MCP secret cannot be sent in an HTTP header; use a single-line token";

// The live connector is the only caller of `createMCPClient` on this path, so
// stubbing it observes exactly what a real connect would receive — no dial, no
// spawn — and proves the refused secret never reached the SDK.
const sdkMock = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }));
vi.mock("@tanstack/ai-mcp", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/ai-mcp")>();
  return {
    ...actual,
    createMCPClient: (async (options: Record<string, unknown>) => {
      sdkMock.calls.push(options);
      throw new Error("unreachable: a refused secret must not reach the SDK");
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

const run = <A, E>(eff: Effect.Effect<A, E>) => Effect.runPromise(eff);
const runEither = <A, E>(eff: Effect.Effect<A, E>) => Effect.runPromise(Effect.either(eff));

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

    const cleared = await run(service.update("remote", { secretRef: null }));
    expect(cleared.hasSecret).toBe(false);

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

describe("slugifyMcpId", () => {
  it("slugifies labels and falls back when empty", () => {
    expect(slugifyMcpId("My Cool Server")).toBe("my-cool-server");
    expect(slugifyMcpId("   ")).toBe("mcp-server");
  });
});
