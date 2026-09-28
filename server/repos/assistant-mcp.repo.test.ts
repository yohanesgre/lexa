import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer, Context } from "effect";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { DbBunLive } from "../db/db";
import { AssistantMcpRepo, toPublic, MCP_CLIENT_TRANSPORTS, type CreateMcpServerInput, type McpServerRow, type McpClientTransportType, type McpTransportType } from "./assistant-mcp.repo";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

let dir: string;
let db: Database;
let repo: AssistantMcpRepo;

afterEach(() => { try { db?.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });

function setup() {
  dir = mkdtempSync(join(tmpdir(), "lexa-assistant-mcp-repo-"));
  const path = join(dir, "test.db");
  runMigrations(path, MIGRATIONS);
  db = new Database(path);
  db.exec("PRAGMA foreign_keys = ON");
  const layer = AssistantMcpRepo.Default.pipe(Layer.provide(DbBunLive(db)));
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  repo = Context.get(ctx, AssistantMcpRepo);
}

const HTTP = {
  id: "web",
  label: "Web",
  transportType: "http" as const,
  url: "https://mcp.example.com",
  command: null,
  args: ["--header"],
  secretRef: null,
  enabled: true,
};

const SSE = { ...HTTP, id: "stream", label: "Stream", transportType: "sse" as const, url: "https://mcp.example.com/sse" };

describe("AssistantMcpRepo", () => {
  it("migration 0010 leaves no stdio registration behind", async () => {
    setup();
    const all = await Effect.runPromise(repo.list());
    expect(all.map((r) => r.id)).toEqual([]);
    expect(all.filter((r) => (r.transport_type as string) === "stdio")).toEqual([]);
    const jev = await Effect.runPromise(Effect.either(repo.getById("jev")));
    expect(jev).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "RowNotFound" }) });
  });

  it("create / getById / list / update happy path", async () => {
    setup();
    const created = await Effect.runPromise(repo.create(HTTP));
    expect(created.id).toBe("web");
    expect(created.args).toBe('["--header"]');
    expect(created.enabled).toBe(1);

    const found = await Effect.runPromise(repo.getById("web"));
    expect(found.transport_type).toBe("http");
    expect(found.url).toBe("https://mcp.example.com");

    await Effect.runPromise(repo.create(SSE));
    const all = await Effect.runPromise(repo.list());
    expect(all.map((r) => r.id)).toEqual(["stream", "web"]);

    db.exec(`UPDATE assistant_mcp_servers SET created_at = '2000-01-01 00:00:00' WHERE id = 'web'`);
    const updated = await Effect.runPromise(repo.update("web", {
      label: "Web v2",
      transportType: "sse",
      url: "https://mcp.example.com/v2",
      command: null,
      args: [],
      secretRef: "env:LOCAL_TOKEN",
      enabled: false,
    }));
    expect(updated.label).toBe("Web v2");
    expect(updated.transport_type).toBe("sse");
    expect(updated.url).toBe("https://mcp.example.com/v2");
    expect(updated.command).toBeNull();
    expect(updated.args).toBe("[]");
    expect(updated.secret_ref).toBe("env:LOCAL_TOKEN");
    expect(updated.enabled).toBe(0);
    expect(updated.updated_at).not.toBe("2000-01-01 00:00:00");
  });

  it("update with no fields returns the current row", async () => {
    setup();
    await Effect.runPromise(repo.create(HTTP));
    const unchanged = await Effect.runPromise(repo.update("web", {}));
    expect(unchanged.label).toBe("Web");
    expect(unchanged.url).toBe("https://mcp.example.com");
  });

  it("keeps the historical transport CHECK while the application type is http/sse only", async () => {
    setup();
    const httpNoUrl = await Effect.runPromise(Effect.either(repo.create({ ...HTTP, id: "h1", url: null })));
    expect(httpNoUrl).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "ConstraintViolation" }) });

    const httpWithCommand = await Effect.runPromise(Effect.either(repo.create({ ...HTTP, id: "h2", command: "nope" })));
    expect(httpWithCommand).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "ConstraintViolation" }) });

    // The SQL CHECK still names stdio, so a raw stdio row with a command is
    // accepted by SQLite — the application type is what keeps callers off it.
    db.exec(`INSERT INTO assistant_mcp_servers (id, label, transport_type, command) VALUES ('raw', 'Raw', 'stdio', 'raw-mcp')`);
    expect(db.prepare("SELECT transport_type FROM assistant_mcp_servers WHERE id = 'raw'").get()).toEqual({ transport_type: "stdio" });
    // Application support is remote-only: stdio is not assignable.
    expect(MCP_CLIENT_TRANSPORTS).toEqual(["http", "sse"]);
    // @ts-expect-error stdio is not an application transport
    const rejected: McpClientTransportType = "stdio";
    expect(rejected).toBe("stdio");
    // @ts-expect-error the write input is remote-only too, so no caller can persist stdio
    const rejectedWrite: CreateMcpServerInput = { ...HTTP, id: "w", transportType: "stdio" };
    expect(rejectedWrite.transportType).toBe("stdio");
    // The row type still mirrors the physical column domain, which keeps
    // stdio readable as a stored value even though 0010 deletes every one.
    const stored: McpTransportType = "stdio";
    expect(stored).toBe("stdio");
  });

  it("duplicate id → ConstraintViolation; unknown getById/remove → RowNotFound", async () => {
    setup();
    await Effect.runPromise(repo.create(HTTP));
    const dup = await Effect.runPromise(Effect.either(repo.create(HTTP)));
    expect(dup).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "ConstraintViolation" }) });

    const missing = await Effect.runPromise(Effect.either(repo.getById("nope")));
    expect(missing).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "RowNotFound" }) });

    const removeMissing = await Effect.runPromise(Effect.either(repo.remove("nope")));
    expect(removeMissing).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "RowNotFound" }) });
  });

  it("setProjectServers replaces the set atomically", async () => {
    setup();
    db.exec(`INSERT INTO projects (id, name, slug) VALUES ('p1', 'P', 'p1')`);
    await Effect.runPromise(repo.create(HTTP));
    await Effect.runPromise(repo.create(SSE));

    await Effect.runPromise(repo.setProjectServers("p1", [
      { serverId: "stream", enabled: false },
      { serverId: "web", enabled: true },
    ]));
    let rows = await Effect.runPromise(repo.listForProject("p1"));
    expect(rows.map((r) => [r.server_id, r.enabled])).toEqual([["stream", 0], ["web", 1]]);

    // Second call is a replace, not an append.
    await Effect.runPromise(repo.setProjectServers("p1", [{ serverId: "web", enabled: true }]));
    rows = await Effect.runPromise(repo.listForProject("p1"));
    expect(rows.map((r) => [r.server_id, r.enabled])).toEqual([["web", 1]]);

    // Unknown server id surfaces as a constraint violation (FK enforced).
    const bad = await Effect.runPromise(Effect.either(repo.setProjectServers("p1", [
      { serverId: "web", enabled: true },
      { serverId: "ghost", enabled: true },
    ])));
    expect(bad).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "ConstraintViolation" }) });
    // Transaction rolled back — the previous set is intact.
    rows = await Effect.runPromise(repo.listForProject("p1"));
    expect(rows.map((r) => r.server_id)).toEqual(["web"]);
  });

  it("project and server deletes cascade the junction rows", async () => {
    setup();
    db.exec(`INSERT INTO projects (id, name, slug) VALUES ('p1', 'P', 'p1')`);
    await Effect.runPromise(repo.create(HTTP));
    await Effect.runPromise(repo.setProjectServers("p1", [{ serverId: "web", enabled: true }]));

    db.exec(`DELETE FROM assistant_mcp_servers WHERE id = 'web'`);
    expect(db.prepare("SELECT COUNT(*) AS n FROM assistant_mcp_project_servers").get()).toEqual({ n: 0 });

    await Effect.runPromise(repo.create(HTTP));
    await Effect.runPromise(repo.setProjectServers("p1", [{ serverId: "web", enabled: true }]));
    db.exec(`DELETE FROM projects WHERE id = 'p1'`);
    expect(db.prepare("SELECT COUNT(*) AS n FROM assistant_mcp_project_servers").get()).toEqual({ n: 0 });
  });

  it("toPublic never returns secret_ref — only hasSecret", async () => {
    setup();
    await Effect.runPromise(repo.create({ ...HTTP, secretRef: "env:MY_SECRET_TOKEN" }));
    const raw = await Effect.runPromise(repo.getById("web"));
    expect(raw.secret_ref).toBe("env:MY_SECRET_TOKEN");

    const pub = toPublic(raw as McpServerRow);
    expect(pub.hasSecret).toBe(true);
    expect(JSON.stringify(pub)).not.toContain("MY_SECRET_TOKEN");
    expect("secret_ref" in pub).toBe(false);

    const noSecret = toPublic({ ...raw, secret_ref: null } as McpServerRow);
    expect(noSecret.hasSecret).toBe(false);
  });
});
