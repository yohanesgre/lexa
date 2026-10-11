import { describe, expect, it, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer, Context } from "effect";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { Sqlite } from "../db/database";
import { DbBunLive } from "../db/db";
import { ProjectMemoryRepo, MEMORY_SEARCH_K, MEMORY_CHAR_CAP } from "./project-memory.repo";
import { AssistantModelsRepo } from "./assistant-models.repo";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

let dir: string;
let db: Database;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "lexa-repo-misc-"));
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

// --- ProjectMemoryRepo (FTS search) harness ---

function makeMemoryRepo(db: Database) {
  const layer = ProjectMemoryRepo.Default.pipe(Layer.provide(Layer.mergeAll(Layer.succeed(Sqlite, db), DbBunLive(db))));
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  return Context.get(ctx, ProjectMemoryRepo);
}

function seedProjects(db: Database) {
  db.exec(`INSERT INTO projects (id, name, slug) VALUES ('p1', 'P', 'p1'), ('p2', 'Q', 'p2');`);
}

describe("ProjectMemoryRepo FTS searchByProject", () => {
  it("matches terms and ranks better matches first", async () => {
    seedProjects(db);
    const repo = makeMemoryRepo(db);
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* repo.create({ id: "m1", projectId: "p1", content: "deploy uses cloudflared tunnel" });
        yield* repo.create({ id: "m2", projectId: "p1", content: "database is sqlite with WAL mode" });
        yield* repo.create({ id: "m3", projectId: "p1", content: "tunnel credentials live in cloudflare dashboard" });
        const hits = yield* repo.searchByProject("p1", ["tunnel", "cloudflared"]);
        expect(hits.length).toBeGreaterThanOrEqual(1);
        expect(hits[0]!).toContain("cloudflared tunnel");
        expect(hits.some((h) => h.includes("sqlite"))).toBe(false);
      })
    );
  });

  it("scoped to project", async () => {
    seedProjects(db);
    const repo = makeMemoryRepo(db);
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* repo.create({ id: "m1", projectId: "p1", content: "kubernetes cluster notes" });
        yield* repo.create({ id: "m2", projectId: "p2", content: "kubernetes cluster secrets" });
        const hits = yield* repo.searchByProject("p1", ["kubernetes"]);
        expect(hits).toEqual(["kubernetes cluster notes"]);
      })
    );
  });

  it("caps hits at k=5 default", async () => {
    seedProjects(db);
    const repo = makeMemoryRepo(db);
    await Effect.runPromise(
      Effect.gen(function* () {
        for (let i = 0; i < 8; i++) {
          yield* repo.create({ id: `m${i}`, projectId: "p1", content: `widget fact number ${i}` });
        }
        const hits = yield* repo.searchByProject("p1", ["widget"]);
        expect(hits).toHaveLength(MEMORY_SEARCH_K);
      })
    );
  });

  it("enforces cumulative char cap by truncating the crossing hit", async () => {
    seedProjects(db);
    const repo = makeMemoryRepo(db);
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* repo.create({ id: "big", projectId: "p1", content: "alpha ".repeat(500) }); // 3000 chars
        yield* repo.create({ id: "small", projectId: "p1", content: "beta detail" });
        const hits = yield* repo.searchByProject("p1", ["alpha", "beta"], { k: 5, charCap: MEMORY_CHAR_CAP });
        const total = hits.reduce((n, h) => n + h.length, 0);
        expect(total).toBeLessThanOrEqual(MEMORY_CHAR_CAP);
        expect(hits[0]!.length).toBe(MEMORY_CHAR_CAP);
        expect(hits).toHaveLength(1);
      })
    );
  });

  it("FTS index stays in sync after delete", async () => {
    seedProjects(db);
    const repo = makeMemoryRepo(db);
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* repo.create({ id: "m1", projectId: "p1", content: "ephemeral note about zig" });
        yield* repo.remove("m1");
        const hits = yield* repo.searchByProject("p1", ["zig"]);
        expect(hits).toEqual([]);
      })
    );
  });
});

// --- AssistantModelsRepo (delete + fallback scrub) harness ---

function makeModelsRepo(db: Database) {
  const layer = AssistantModelsRepo.Default.pipe(Layer.provide(DbBunLive(db)));
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  return Context.get(ctx, AssistantModelsRepo);
}

function seedModels(db: Database) {
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
    seedModels(db);
    const repo = makeModelsRepo(db);
    await Effect.runPromise(repo.delete("m1") as Effect.Effect<void, never>);
    const model = db.query("SELECT id FROM assistant_models WHERE id = 'm1'").get();
    expect(model).toBeNull();
    expect(fallback(db, "p1")).toEqual(["m2"]);
    expect(fallback(db, "p2")).toEqual([]);
  });

  it("rolls back the delete when a fallback rewrite fails mid-batch", async () => {
    seedModels(db);
    db.exec(`CREATE TRIGGER fail_settings BEFORE UPDATE ON assistant_settings WHEN NEW.project_id = 'p2' BEGIN SELECT RAISE(ABORT, 'boom'); END;`);
    const repo = makeModelsRepo(db);
    const result = await Effect.runPromise(Effect.either(repo.delete("m1")));
    expect(result._tag).toBe("Left");
    const model = db.query("SELECT id FROM assistant_models WHERE id = 'm1'").get();
    expect(model).not.toBeNull();
    expect(fallback(db, "p1")).toEqual(["m1", "m2"]);
    db.exec("DROP TRIGGER IF EXISTS fail_settings");
  });
});
