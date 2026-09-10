import { describe, expect, it, afterEach, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer, Context } from "effect";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { Sqlite, initSqlite } from "../db/database";
import { DbBunLive } from "../db/db";
import { HearthService } from "./hearth.service";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

let dir: string;
let db: Database;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "lexa-hearth-register-team-"));
  const path = join(dir, "test.db");
  runMigrations(path, MIGRATIONS);
  const ctx = Effect.runSync(Effect.scoped(Layer.build(initSqlite(path))));
  db = Context.get(ctx, Sqlite);
});

afterAll(() => {
  try { db.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

function cleanDb(db: Database) {
  db.exec("PRAGMA foreign_keys = OFF");
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '_migrations' AND name NOT LIKE '%fts%'").all() as { name: string }[];
  for (const { name } of tables) {
    try { db.exec(`DELETE FROM "${name}"`); } catch {}
  }
  try { db.exec("DELETE FROM sqlite_sequence"); } catch {}
  db.exec("PRAGMA foreign_keys = ON");
}

beforeEach(() => {
  cleanDb(db);
  db.prepare("INSERT INTO machines (id, hostname) VALUES ('m1','host')").run();
  db.prepare("INSERT INTO organization (id, name, slug, createdAt) VALUES ('t1','Team One','team-one','2026-01-01T00:00:00.000Z')").run();
});

afterEach(() => {
  // no-op placeholder to mirror the service test conventions
});

function makeService(db: Database) {
  const layer = HearthService.Default.pipe(Layer.provide(Layer.mergeAll(Layer.succeed(Sqlite, db), DbBunLive(db))));
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  return Context.get(ctx, HearthService);
}

const base = { name: "host-opencode", provider: "opencode" as const, machineId: "m1", agent: "build", model: "", hostname: "host" };

describe("HearthService.registerRuntime team binding", () => {
  it("applies the machine's latest setup-event team to the registered runtime", async () => {
    db.prepare(`INSERT INTO runtime_events (id, machine_id, action, agent_cli, team_id, status, created_at)
                VALUES ('e1','m1','install','opencode','t1','completed','2026-01-01 10:00:00')`).run();
    const svc = makeService(db);
    const runtime = await Effect.runPromise(svc.registerRuntime(base));
    expect(runtime.teamId).toBe("t1");
  });

  it("treats an explicit Global event as a global runtime", async () => {
    db.prepare(`INSERT INTO runtime_events (id, machine_id, action, agent_cli, team_id, status, created_at)
                VALUES ('e1','m1','install','opencode',NULL,'completed','2026-01-01 10:00:00')`).run();
    const svc = makeService(db);
    const runtime = await Effect.runPromise(svc.registerRuntime(base));
    expect(runtime.teamId).toBeNull();
  });

  it("prefers an explicit teamId over the setup event", async () => {
    db.prepare(`INSERT INTO runtime_events (id, machine_id, action, agent_cli, team_id, status, created_at)
                VALUES ('e1','m1','install','opencode','t1','completed','2026-01-01 10:00:00')`).run();
    db.prepare("INSERT INTO organization (id, name, slug, createdAt) VALUES ('t2','Team Two','team-two','2026-01-01T00:00:00.000Z')").run();
    const svc = makeService(db);
    const runtime = await Effect.runPromise(svc.registerRuntime({ ...base, teamId: "t2" }));
    expect(runtime.teamId).toBe("t2");
  });

  it("keeps the existing runtime's team on re-registration when no event exists", async () => {
    const svc = makeService(db);
    const first = await Effect.runPromise(svc.registerRuntime({ ...base, teamId: "t1" }));
    expect(first.teamId).toBe("t1");
    const again = await Effect.runPromise(svc.registerRuntime({ ...base, id: first.id }));
    expect(again.teamId).toBe("t1");
  });

  it("defaults to global when no event and no existing runtime row", async () => {
    const svc = makeService(db);
    const runtime = await Effect.runPromise(svc.registerRuntime(base));
    expect(runtime.teamId).toBeNull();
  });
});
