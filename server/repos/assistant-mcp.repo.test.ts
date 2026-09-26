import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer, Context } from "effect";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { DbBunLive } from "../db/db";
import { AssistantMcpRepo, toPublic, type McpServerRow } from "./assistant-mcp.repo";

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

const STDIO = {
  id: "local",
  label: "Local",
  transportType: "stdio" as const,
  url: null,
  command: "local-mcp",
  args: ["--stdio"],
  secretRef: null,
  enabled: true,
};

describe("AssistantMcpRepo", () => {
  it("migration seeds the disabled jev stdio row", async () => {
    setup();
    const jev = await Effect.runPromise(repo.getById("jev"));
    expect(jev).toEqual(expect.objectContaining({
      id: "jev",
      label: "Jev",
      transport_type: "stdio",
      url: null,
      command: "jev-mcp",
      args: "[]",
      secret_ref: null,
      enabled: 0,
    }));
  });

  it("create / getById / list / update happy path", async () => {
    setup();
    const created = await Effect.runPromise(repo.create(STDIO));
    expect(created.id).toBe("local");
    expect(created.args).toBe('["--stdio"]');
    expect(created.enabled).toBe(1);

    const found = await Effect.runPromise(repo.getById("local"));
    expect(found.command).toBe("local-mcp");

    const all = await Effect.runPromise(repo.list());
    expect(all.map((r) => r.id)).toEqual(["jev", "local"]);

    db.exec(`UPDATE assistant_mcp_servers SET created_at = '2000-01-01 00:00:00' WHERE id = 'local'`);
    const updated = await Effect.runPromise(repo.update("local", {
      label: "Local v2",
      transportType: "http",
      url: "https://mcp.example.com",
      command: null,
      args: [],
      secretRef: "env:LOCAL_TOKEN",
      enabled: false,
    }));
    expect(updated.label).toBe("Local v2");
    expect(updated.transport_type).toBe("http");
    expect(updated.url).toBe("https://mcp.example.com");
    expect(updated.command).toBeNull();
    expect(updated.args).toBe("[]");
    expect(updated.secret_ref).toBe("env:LOCAL_TOKEN");
    expect(updated.enabled).toBe(0);
    expect(updated.updated_at).not.toBe("2000-01-01 00:00:00");
  });

  it("update with no fields returns the current row", async () => {
    setup();
    await Effect.runPromise(repo.create(STDIO));
    const unchanged = await Effect.runPromise(repo.update("local", {}));
    expect(unchanged.label).toBe("Local");
    expect(unchanged.command).toBe("local-mcp");
  });

  it("transport CHECK rejects http without url and stdio without command", async () => {
    setup();
    const httpNoUrl = await Effect.runPromise(Effect.either(repo.create({
      ...STDIO, id: "h1", transportType: "http", url: null, command: null,
    })));
    expect(httpNoUrl).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "ConstraintViolation" }) });

    const httpWithCommand = await Effect.runPromise(Effect.either(repo.create({
      ...STDIO, id: "h2", transportType: "http", url: "https://x.test", command: "nope",
    })));
    expect(httpWithCommand).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "ConstraintViolation" }) });

    const stdioNoCommand = await Effect.runPromise(Effect.either(repo.create({
      ...STDIO, id: "s1", command: null, url: null,
    })));
    expect(stdioNoCommand).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "ConstraintViolation" }) });
  });

  it("duplicate id → ConstraintViolation; unknown getById/remove → RowNotFound", async () => {
    setup();
    await Effect.runPromise(repo.create(STDIO));
    const dup = await Effect.runPromise(Effect.either(repo.create(STDIO)));
    expect(dup).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "ConstraintViolation" }) });

    const missing = await Effect.runPromise(Effect.either(repo.getById("nope")));
    expect(missing).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "RowNotFound" }) });

    const removeMissing = await Effect.runPromise(Effect.either(repo.remove("nope")));
    expect(removeMissing).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "RowNotFound" }) });
  });

  it("setProjectServers replaces the set atomically", async () => {
    setup();
    db.exec(`INSERT INTO projects (id, name, slug) VALUES ('p1', 'P', 'p1')`);
    await Effect.runPromise(repo.create(STDIO));
    await Effect.runPromise(repo.create({ ...STDIO, id: "remote", transportType: "http", url: "https://mcp.test", command: null }));

    await Effect.runPromise(repo.setProjectServers("p1", [
      { serverId: "jev", enabled: false },
      { serverId: "local", enabled: true },
    ]));
    let rows = await Effect.runPromise(repo.listForProject("p1"));
    expect(rows.map((r) => [r.server_id, r.enabled])).toEqual([["jev", 0], ["local", 1]]);

    // Second call is a replace, not an append.
    await Effect.runPromise(repo.setProjectServers("p1", [{ serverId: "remote", enabled: true }]));
    rows = await Effect.runPromise(repo.listForProject("p1"));
    expect(rows.map((r) => [r.server_id, r.enabled])).toEqual([["remote", 1]]);

    // Unknown server id surfaces as a constraint violation (FK enforced).
    const bad = await Effect.runPromise(Effect.either(repo.setProjectServers("p1", [
      { serverId: "remote", enabled: true },
      { serverId: "ghost", enabled: true },
    ])));
    expect(bad).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "ConstraintViolation" }) });
    // Transaction rolled back — the previous set is intact.
    rows = await Effect.runPromise(repo.listForProject("p1"));
    expect(rows.map((r) => r.server_id)).toEqual(["remote"]);
  });

  it("project and server deletes cascade the junction rows", async () => {
    setup();
    db.exec(`INSERT INTO projects (id, name, slug) VALUES ('p1', 'P', 'p1')`);
    await Effect.runPromise(repo.create(STDIO));
    await Effect.runPromise(repo.setProjectServers("p1", [{ serverId: "local", enabled: true }]));

    db.exec(`DELETE FROM assistant_mcp_servers WHERE id = 'local'`);
    expect(db.prepare("SELECT COUNT(*) AS n FROM assistant_mcp_project_servers").get()).toEqual({ n: 0 });

    await Effect.runPromise(repo.create(STDIO));
    await Effect.runPromise(repo.setProjectServers("p1", [{ serverId: "local", enabled: true }]));
    db.exec(`DELETE FROM projects WHERE id = 'p1'`);
    expect(db.prepare("SELECT COUNT(*) AS n FROM assistant_mcp_project_servers").get()).toEqual({ n: 0 });
  });

  it("toPublic never returns secret_ref — only hasSecret", async () => {
    setup();
    await Effect.runPromise(repo.create({ ...STDIO, secretRef: "env:MY_SECRET_TOKEN" }));
    const raw = await Effect.runPromise(repo.getById("local"));
    expect(raw.secret_ref).toBe("env:MY_SECRET_TOKEN");

    const pub = toPublic(raw as McpServerRow);
    expect(pub.hasSecret).toBe(true);
    expect(JSON.stringify(pub)).not.toContain("MY_SECRET_TOKEN");
    expect("secret_ref" in pub).toBe(false);

    const noSecret = toPublic({ ...raw, secret_ref: null } as McpServerRow);
    expect(noSecret.hasSecret).toBe(false);
  });
});
