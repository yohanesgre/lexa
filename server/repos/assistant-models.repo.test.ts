import { describe, expect, it, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer, Context } from "effect";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { DbBunLive } from "../db/db";
import { AssistantModelsRepo } from "./assistant-models.repo";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

let dir: string;
let db: Database;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "lexa-assistant-models-repo-"));
  const path = join(dir, "test.db");
  runMigrations(path, MIGRATIONS);
  db = new Database(path);
  db.exec("PRAGMA foreign_keys = ON");
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
  db.exec("DROP TRIGGER IF EXISTS fail_settings");
  db.exec("PRAGMA foreign_keys = ON");
}

beforeEach(() => {
  cleanDb(db);
});

function makeRepo(db: Database) {
  const layer = AssistantModelsRepo.Default.pipe(Layer.provide(DbBunLive(db)));
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  return Context.get(ctx, AssistantModelsRepo);
}

function seed(db: Database) {
  db.exec(`
    INSERT INTO projects (id, name, slug) VALUES ('p1','P1','p1'), ('p2','P2','p2');
    INSERT INTO assistant_providers (id, label, base_url, api_key) VALUES ('prov1','Prov','https://x','k');
    INSERT INTO assistant_models (id, provider_id, model_id, kind, priority, enabled) VALUES ('m1','prov1','x','openai_compatible',0,1);
    INSERT INTO assistant_models (id, provider_id, model_id, kind, priority, enabled) VALUES ('m2','prov1','y','openai_compatible',1,1);
    INSERT INTO assistant_settings (project_id, fallback_model_ids) VALUES ('p1','["m1","m2"]');
    INSERT INTO assistant_settings (project_id, fallback_model_ids) VALUES ('p2','["m1"]');
  `);
}

function fallback(db: Database, projectId: string): string[] {
  const row = db.query("SELECT fallback_model_ids FROM assistant_settings WHERE project_id = ?").get(projectId) as { fallback_model_ids: string };
  return JSON.parse(row.fallback_model_ids) as string[];
}

describe("AssistantModelsRepo.delete", () => {
  it("removes the model and scrubs it from every project's fallback list", async () => {
    seed(db);
    const repo = makeRepo(db);
    await Effect.runPromise(repo.delete("m1") as Effect.Effect<void, never>);
    const model = db.query("SELECT id FROM assistant_models WHERE id = 'm1'").get();
    expect(model).toBeNull();
    expect(fallback(db, "p1")).toEqual(["m2"]);
    expect(fallback(db, "p2")).toEqual([]);
  });

  it("rolls back the delete when a fallback rewrite fails mid-batch", async () => {
    seed(db);
    db.exec(`CREATE TRIGGER fail_settings BEFORE UPDATE ON assistant_settings WHEN NEW.project_id = 'p2' BEGIN SELECT RAISE(ABORT, 'boom'); END;`);
    const repo = makeRepo(db);
    const result = await Effect.runPromise(Effect.either(repo.delete("m1")));
    expect(result._tag).toBe("Left");
    const model = db.query("SELECT id FROM assistant_models WHERE id = 'm1'").get();
    expect(model).not.toBeNull();
    expect(fallback(db, "p1")).toEqual(["m1", "m2"]);
    db.exec("DROP TRIGGER IF EXISTS fail_settings");
  });
});
