import { describe, expect, it, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer, Context } from "effect";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { DbBunLive } from "../db/db";
import { McpConnectFailed } from "../api/errors";
import {
  AssistantMcpService,
  McpConnector,
  slugifyMcpId,
  validateTransportConfig,
  type McpConnectorShape,
} from "./assistant-mcp.service";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

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

let dir: string;
let db: Database;
let service: AssistantMcpService;

const okConnector: McpConnectorShape = {
  connect: () => Effect.succeed({ toolCount: 3, readOnlyToolCount: 2 }),
};
const failConnector: McpConnectorShape = {
  connect: () => Effect.fail(new McpConnectFailed({ message: "no route to host" })),
};

afterEach(() => { try { db?.close(); } catch {} if (dir) rmSync(dir, { recursive: true, force: true }); ssrfMock.block = false; });

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

describe("validateTransportConfig", () => {
  it("requires url for http/sse and command for stdio", () => {
    expect(validateTransportConfig({ transportType: "http", url: null, command: null, args: [], secretRef: null }, { workers: false }))
      .toEqual({ kind: "invalid", reason: "url is required for http/sse transport" });
    expect(validateTransportConfig({ transportType: "sse", url: "", command: null, args: [], secretRef: null }, { workers: false }))
      .toEqual({ kind: "invalid", reason: "url is required for http/sse transport" });
    expect(validateTransportConfig({ transportType: "stdio", url: null, command: "", args: [], secretRef: null }, { workers: false }))
      .toEqual({ kind: "invalid", reason: "command is required for stdio transport" });
  });

  it("rejects non-http schemes, userinfo, and cross-transport fields", () => {
    expect(validateTransportConfig({ transportType: "http", url: "ftp://x.test", command: null, args: [], secretRef: null }, { workers: false }))
      .toEqual({ kind: "invalid", reason: "url scheme must be http or https" });
    expect(validateTransportConfig({ transportType: "http", url: "https://user:pw@x.test", command: null, args: [], secretRef: null }, { workers: false }))
      .toEqual({ kind: "invalid", reason: "url must not contain userinfo credentials" });
    expect(validateTransportConfig({ transportType: "http", url: "https://x.test", command: "nope", args: [], secretRef: null }, { workers: false }))
      .toEqual({ kind: "invalid", reason: "command is only valid for stdio transport" });
    expect(validateTransportConfig({ transportType: "stdio", url: "https://x.test", command: "c", args: [], secretRef: null }, { workers: false }))
      .toEqual({ kind: "invalid", reason: "url is only valid for http/sse transport" });
  });

  it("accepts only env:NAME or file:/ refs", () => {
    const base = { transportType: "stdio" as const, url: null, command: "c", args: [] as string[] };
    expect(validateTransportConfig({ ...base, secretRef: "env:MY_TOKEN_2" }, { workers: false })).toBeNull();
    expect(validateTransportConfig({ ...base, secretRef: "file:/run/secrets/token" }, { workers: false })).toBeNull();
    expect(validateTransportConfig({ ...base, secretRef: "env:lower" }, { workers: false })).toEqual({ kind: "invalid", reason: "secretRef must be 'env:NAME' or 'file:/absolute/path'" });
    expect(validateTransportConfig({ ...base, secretRef: "plaintext-secret" }, { workers: false })).toEqual({ kind: "invalid", reason: "secretRef must be 'env:NAME' or 'file:/absolute/path'" });
    expect(validateTransportConfig({ ...base, secretRef: "file:relative" }, { workers: false })).toEqual({ kind: "invalid", reason: "secretRef must be 'env:NAME' or 'file:/absolute/path'" });
  });

  it("rejects stdio on Workers (no process spawn) and passes on Bun", () => {
    const stdio = { transportType: "stdio" as const, url: null, command: "jev-mcp", args: [] as string[], secretRef: null };
    expect(validateTransportConfig(stdio, { workers: true })).toEqual({ kind: "stdio-unavailable" });
    expect(validateTransportConfig(stdio, { workers: false })).toBeNull();
  });
});

describe("AssistantMcpService", () => {
  it("create derives a slug id, lists the seeded jev row, and never exposes the secret ref", async () => {
    setup();
    const created = await run(service.create({ label: "My Server", transportType: "stdio", command: "my-mcp", args: ["--x"], secretRef: "env:MY_TOKEN" }));
    expect(created.id).toBe("my-server");
    expect(created.transportType).toBe("stdio");
    expect(created.hasSecret).toBe(true);
    expect(JSON.stringify(created)).not.toContain("MY_TOKEN");

    const all = await run(service.list());
    expect(all.map((s) => s.id)).toEqual(["jev", "my-server"]);
    const jev = all.find((s) => s.id === "jev")!;
    expect(jev.enabled).toBe(false);
    expect(jev.hasSecret).toBe(false);
  });

  it("rejects the reserved jev id", async () => {
    setup();
    const res = await runEither(service.create({ label: "Jev", transportType: "stdio", command: "jev-mcp" }));
    expect(res).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "McpInvalidTransportConfig" }) });
  });

  it("rejects invalid transport shapes and secret refs", async () => {
    setup();
    const noUrl = await runEither(service.create({ label: "Remote", transportType: "http", url: null }));
    expect(noUrl).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "McpInvalidTransportConfig" }) });

    const badSecret = await runEither(service.create({ label: "Remote", transportType: "stdio", command: "c", secretRef: "plaintext" }));
    expect(badSecret).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "McpInvalidTransportConfig" }) });
  });

  it("runs the SSRF guard on http/sse saves", async () => {
    setup();
    ssrfMock.block = true;
    const blocked = await runEither(service.create({ label: "Remote", transportType: "http", url: "https://mcp.test/x" }));
    expect(blocked).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "McpInvalidTransportConfig" }) });

    ssrfMock.block = false;
    const ok = await run(service.create({ label: "Remote", transportType: "http", url: "https://mcp.test/x" }));
    expect(ok.id).toBe("remote");
    expect(ok.url).toBe("https://mcp.test/x");
    expect(ok.command).toBeNull();
  });

  it("update patches fields and re-validates the merged transport shape", async () => {
    setup();
    await run(service.create({ label: "Local", transportType: "stdio", command: "local-mcp" }));

    const renamed = await run(service.update("local", { label: "Local 2", args: ["--verbose"] }));
    expect(renamed.label).toBe("Local 2");
    expect(renamed.args).toEqual(["--verbose"]);

    // Switch to http without a url → invalid; with a url → ok and command cleared.
    const switchNoUrl = await runEither(service.update("local", { transportType: "http" }));
    expect(switchNoUrl).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "McpInvalidTransportConfig" }) });

    const switched = await run(service.update("local", { transportType: "http", url: "https://mcp.test" }));
    expect(switched.transportType).toBe("http");
    expect(switched.command).toBeNull();
  });

  it("remove protects jev and 404s unknown ids", async () => {
    setup();
    const jev = await runEither(service.remove("jev"));
    expect(jev).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "McpInvalidTransportConfig" }) });

    const missing = await runEither(service.remove("nope"));
    expect(missing).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "McpServerNotFound" }) });

    await run(service.create({ label: "Temp", transportType: "stdio", command: "t" }));
    await run(service.remove("temp"));
    expect((await run(service.list())).map((s) => s.id)).toEqual(["jev"]);
  });

  it("project availability is a replace-set and validates server ids", async () => {
    setup();
    db.exec(`INSERT INTO projects (id, name, slug) VALUES ('p1', 'P', 'p1')`);
    await run(service.create({ label: "A", transportType: "stdio", command: "a" }));

    await run(service.setProjectServers("p1", [{ serverId: "jev", enabled: false }, { serverId: "a", enabled: true }]));
    expect((await run(service.listForProject("p1"))).map((r) => [r.serverId, r.enabled])).toEqual([["a", true], ["jev", false]]);

    await run(service.setProjectServers("p1", [{ serverId: "a", enabled: false }]));
    expect((await run(service.listForProject("p1"))).map((r) => r.serverId)).toEqual(["a"]);

    const bad = await runEither(service.setProjectServers("p1", [{ serverId: "ghost", enabled: true }]));
    expect(bad).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "McpServerNotFound" }) });
  });

  it("test endpoint reports the connector result and never throws for a live row", async () => {
    setup(okConnector);
    await run(service.create({ label: "Local", transportType: "stdio", command: "local-mcp" }));
    const report = await run(service.testConnection("local"));
    expect(report).toEqual({ ok: true, toolCount: 3, readOnlyToolCount: 2, latencyMs: expect.any(Number), error: null });

    const missing = await runEither(service.testConnection("nope"));
    expect(missing).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "McpServerNotFound" }) });
  });

  it("test endpoint folds a failed connect into an error report (still resolvable)", async () => {
    setup(failConnector);
    await run(service.create({ label: "Local", transportType: "stdio", command: "local-mcp" }));
    const report = await run(service.testConnection("local"));
    expect(report.ok).toBe(false);
    expect(report.toolCount).toBe(0);
    expect(report.error).toEqual({ code: "MCP_CONNECT_FAILED", message: "no route to host" });
  });
});

describe("slugifyMcpId", () => {
  it("slugifies labels and falls back when empty", () => {
    expect(slugifyMcpId("My Cool Server")).toBe("my-cool-server");
    expect(slugifyMcpId("   ")).toBe("mcp-server");
  });
});
