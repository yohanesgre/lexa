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
import { RuntimeEventRepo } from "./runtime-event.repo";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

let dir: string;
let db: Database;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "lexa-runtime-event-repo-"));
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
});

function seed(db: Database) {
  db.prepare("INSERT INTO machines (id, hostname) VALUES ('m1','host')").run();
  db.prepare("INSERT INTO organization (id, name, slug, createdAt) VALUES ('t1','Team One','team-one','2026-01-01T00:00:00.000Z')").run();
}

function makeRepo(db: Database) {
  const layer = RuntimeEventRepo.Default.pipe(Layer.provide(Layer.mergeAll(Layer.succeed(Sqlite, db), DbBunLive(db))));
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  return Context.get(ctx, RuntimeEventRepo);
}

afterEach(() => {
  // no-op placeholder to mirror the repo test conventions
});

describe("RuntimeEventRepo team binding", () => {
  it("stores teamId on create", async () => {
    seed(db);
    const repo = makeRepo(db);
    const event = await Effect.runPromise(repo.create({
      id: "e1", machineId: "m1", action: "install", agentCli: "opencode", teamId: "t1", apiKeyId: null,
    }));
    expect(event.teamId).toBe("t1");
    const row = db.prepare("SELECT team_id FROM runtime_events WHERE id = 'e1'").get() as { team_id: string | null };
    expect(row.team_id).toBe("t1");
  });

  it("stores null for a Global event", async () => {
    seed(db);
    const repo = makeRepo(db);
    const event = await Effect.runPromise(repo.create({
      id: "e1", machineId: "m1", action: "install", agentCli: "opencode", teamId: null, apiKeyId: null,
    }));
    expect(event.teamId).toBeNull();
  });

  it("latestSetupEventTeam returns the newest install/update team, ignoring remove events", async () => {
    seed(db);
    const repo = makeRepo(db);
    db.prepare(`INSERT INTO runtime_events (id, machine_id, action, agent_cli, team_id, status, created_at) VALUES
      ('e1','m1','install','opencode','t1','completed','2026-01-01 10:00:00'),
      ('e2','m1','update','opencode',NULL,'completed','2026-01-02 10:00:00'),
      ('e3','m1','remove','opencode','t1','completed','2026-01-03 10:00:00')`).run();
    const result = await Effect.runPromise(repo.latestSetupEventTeam("m1", "opencode"));
    expect(result.found).toBe(true);
    expect(result.teamId).toBeNull();
  });

  it("scopes the lookup to machine + provider", async () => {
    seed(db);
    const repo = makeRepo(db);
    db.prepare(`INSERT INTO runtime_events (id, machine_id, action, agent_cli, team_id, status, created_at) VALUES
      ('e1','m1','install','opencode','t1','completed','2026-01-01 10:00:00'),
      ('e2','m1','install','hermes','t1','completed','2026-01-02 10:00:00')`).run();
    const opencode = await Effect.runPromise(repo.latestSetupEventTeam("m1", "opencode"));
    expect(opencode.teamId).toBe("t1");
    const missing = await Effect.runPromise(repo.latestSetupEventTeam("m1", "command-code"));
    expect(missing.found).toBe(false);
  });

  it("reports not found when no setup event exists", async () => {
    seed(db);
    const repo = makeRepo(db);
    const result = await Effect.runPromise(repo.latestSetupEventTeam("m1", "opencode"));
    expect(result).toEqual({ found: false, teamId: null });
  });
});
