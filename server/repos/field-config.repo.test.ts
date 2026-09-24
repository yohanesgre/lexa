import { describe, expect, it, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer, Context, Either } from "effect";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { DbBunLive } from "../db/db";
import { FieldConfigRepo } from "./field-config.repo";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

let dir: string;
let db: Database;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "lexa-fieldcfg-repo-"));
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
  db.exec("PRAGMA foreign_keys = ON");
}

beforeEach(() => {
  cleanDb(db);
});

function makeRepo(db: Database) {
  const layer = FieldConfigRepo.Default.pipe(Layer.provide(DbBunLive(db)));
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  return Context.get(ctx, FieldConfigRepo);
}

function seed(db: Database) {
  db.prepare("INSERT INTO projects (id, name, slug) VALUES ('p1','P','p1')").run();
  db.prepare("INSERT INTO priority_options (id, project_id, label, color, position) VALUES ('o1','p1','Urgent','#f00',0)").run();
  db.prepare("INSERT INTO type_options (id, project_id, label, color, position) VALUES ('o2','p1','Bug','#0f0',0)").run();
}

describe("FieldConfigRepo.updateOption", () => {
  it("updates a priority option even though the table has no updated_at column", async () => {
    seed(db);
    const repo = makeRepo(db);
    const result = await Effect.runPromise(Effect.either(repo.updateOption("o1", { label: "Critical", position: 2 }, "priority")));
    expect(Either.isRight(result)).toBe(true);
    const row = db.query("SELECT label, position FROM priority_options WHERE id = 'o1'").get() as { label: string; position: number };
    expect(row).toEqual({ label: "Critical", position: 2 });
  });

  it("updates a type option", async () => {
    seed(db);
    const repo = makeRepo(db);
    const result = await Effect.runPromise(Effect.either(repo.updateOption("o2", { color: "#123456" }, "type")));
    expect(Either.isRight(result)).toBe(true);
    const row = db.query("SELECT color FROM type_options WHERE id = 'o2'").get() as { color: string };
    expect(row.color).toBe("#123456");
  });

  it("returns before touching the DB when no fields are provided", async () => {
    seed(db);
    const repo = makeRepo(db);
    const result = await Effect.runPromise(Effect.either(repo.updateOption("o1", {}, "priority")));
    expect(result).toEqual(Either.right(undefined));
  });
});
