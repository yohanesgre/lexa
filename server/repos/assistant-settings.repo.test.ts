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
import { AssistantSettingsRepo } from "./assistant-settings.repo";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

let dir: string;
let db: Database;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "lexa-assistant-settings-repo-"));
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
  db.exec(`INSERT INTO projects (id, name, slug) VALUES ('p1', 'P', 'p1')`);
}

function makeRepo(db: Database) {
  const layer = AssistantSettingsRepo.Default.pipe(Layer.provide(Layer.mergeAll(Layer.succeed(Sqlite, db), DbBunLive(db))));
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  return Context.get(ctx, AssistantSettingsRepo);
}

describe("AssistantSettingsRepo upsert", () => {
  it("inserts a new row and returns it", async () => {
    seed(db);
    const repo = makeRepo(db);
    await Effect.runPromise(
      Effect.gen(function* () {
        const row = yield* repo.upsert("p1", {
          searchProvider: "exa",
          searchApiKey: "exa-key",
          urlAllowlist: "example.com",
        });
        expect(row.project_id).toBe("p1");
        expect(row.search_provider).toBe("exa");
      })
    );
  });

  it("update keeps stored keys when omitted", async () => {
    seed(db);
    const repo = makeRepo(db);
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* repo.upsert("p1", {
          searchProvider: "exa",
          searchApiKey: "exa-key",
        });
        const row = yield* repo.upsert("p1", {
          searchProvider: null,
        });
        expect(row.search_api_key).toBe("exa-key");
        expect(row.search_provider).toBeNull();
      })
    );
  });

  it("upsert on missing project violates FK", async () => {
    seed(db);
    const repo = makeRepo(db);
    const exit = await Effect.runPromiseExit(
      repo.upsert("nope", { searchProvider: "exa", searchApiKey: "k" })
    );
    expect(exit._tag).toBe("Failure");
  });
});

describe("AssistantSettingsRepo getByProject/maskedView", () => {
  it("getByProject fails RowNotFound when absent", async () => {
    seed(db);
    const repo = makeRepo(db);
    await Effect.runPromise(
      Effect.gen(function* () {
        const err = yield* repo.getByProject("p1").pipe(Effect.flip);
        expect(err._tag).toBe("RowNotFound");
      })
    );
  });

  it("masked view never exposes keys; keyMask uses stored key tail", async () => {
    seed(db);
    const repo = makeRepo(db);
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* repo.upsert("p1", {
          searchProvider: "exa",
          searchApiKey: "exa-key-9zzz",
          urlAllowlist: "docs.example.com,api.example.com",
        });
        const masked = yield* repo.maskedView("p1");
        expect(masked).toEqual({
          projectId: "p1",
          searchProvider: "exa",
          hasSearchKey: true,
          urlAllowlist: "docs.example.com,api.example.com",
          primarySupportsImages: false,
          visionModel: null,
          reasoningEffort: null,
          writeTools: [],
          providerId: null,
          modelId: null,
          fallbackModelIds: [],
        });
        const raw = JSON.stringify(masked);
        expect(raw).not.toContain("exa-key-9zzz");
      })
    );
  });

  it("masked view hasSearchKey false without search key", async () => {
    seed(db);
    const repo = makeRepo(db);
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* repo.upsert("p1", {});
        const masked = yield* repo.maskedView("p1");
        expect(masked.hasSearchKey).toBe(false);
        expect(masked.searchProvider).toBeNull();
      })
    );
  });

  it("maskedView fails RowNotFound when absent", async () => {
    seed(db);
    const repo = makeRepo(db);
    await Effect.runPromise(
      Effect.gen(function* () {
        const err = yield* repo.maskedView("p1").pipe(Effect.flip);
        expect(err._tag).toBe("RowNotFound");
      })
    );
  });
});

describe("AssistantSettingsRepo image columns", () => {
  it("round-trips primarySupportsImages", async () => {
    seed(db);
    const repo = makeRepo(db);
    await Effect.runPromise(
      Effect.gen(function* () {
        const row = yield* repo.upsert("p1", {
          primarySupportsImages: true,
        });
        expect(row.primary_supports_images).toBe(1);
        const masked = yield* repo.maskedView("p1");
        expect(masked.primarySupportsImages).toBe(true);
      })
    );
  });

  it("upsert without legacy provider fields still succeeds", async () => {
    seed(db);
    const repo = makeRepo(db);
    const row = await Effect.runPromise(repo.upsert("p1", {}));
    expect(row.project_id).toBe("p1");
  });

  it("round-trips visionModel (0028); omitted keeps, explicit null clears", async () => {
    seed(db);
    const repo = makeRepo(db);
    await Effect.runPromise(
      Effect.gen(function* () {
        const fresh = yield* repo.upsert("p1", {});
        expect(fresh.vision_model).toBeNull();
        expect((yield* repo.maskedView("p1")).visionModel).toBeNull();

        const set = yield* repo.upsert("p1", { visionModel: "anthropic/claude-sonnet-4" });
        expect(set.vision_model).toBe("anthropic/claude-sonnet-4");
        expect((yield* repo.maskedView("p1")).visionModel).toBe("anthropic/claude-sonnet-4");

        const kept = yield* repo.upsert("p1", { searchProvider: "exa" });
        expect(kept.vision_model).toBe("anthropic/claude-sonnet-4");

        const cleared = yield* repo.upsert("p1", { visionModel: null });
        expect(cleared.vision_model).toBeNull();
      })
    );
  });
});

describe("AssistantSettingsRepo reasoning_effort (0014)", () => {
  const base = {} as const;

  it("round-trips reasoningEffort; NULL default on fresh insert", async () => {
    seed(db);
    const repo = makeRepo(db);
    await Effect.runPromise(
      Effect.gen(function* () {
        const row = yield* repo.upsert("p1", { ...base });
        expect(row.reasoning_effort).toBeNull();
        expect((yield* repo.maskedView("p1")).reasoningEffort).toBeNull();

        const set = yield* repo.upsert("p1", { reasoningEffort: "high" });
        expect(set.reasoning_effort).toBe("high");
        expect((yield* repo.maskedView("p1")).reasoningEffort).toBe("high");
      })
    );
  });

  it("explicit null clears; omitted keeps stored value semantics consistent with other nullable fields (clears)", async () => {
    seed(db);
    const repo = makeRepo(db);
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* repo.upsert("p1", { reasoningEffort: "low" });
        const cleared = yield* repo.upsert("p1", { reasoningEffort: null });
        expect(cleared.reasoning_effort).toBeNull();
      })
    );
  });

  it("masked view never leaks anything beyond the effort enum value", async () => {
    seed(db);
    const repo = makeRepo(db);
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* repo.upsert("p1", { reasoningEffort: "minimal" });
        const masked = yield* repo.maskedView("p1");
        expect(masked.reasoningEffort).toBe("minimal");
      })
    );
  });
});

describe("AssistantSettingsRepo listBindingsOverview", () => {
  function seedBindings(db: Database) {
    db.exec(`
      INSERT INTO projects (id, name, slug) VALUES ('p1','Alpha','alpha'), ('p2','Beta','beta'), ('p3','Gamma','gamma');
      INSERT INTO assistant_providers (id, label, base_url, api_key) VALUES ('pr1','Opencode Go','https://x','sk');
      INSERT INTO assistant_models (id, provider_id, model_id, kind, priority, enabled) VALUES ('mdl1','pr1','gpt-5.1','openai_compatible',0,1);
      INSERT INTO assistant_settings (project_id, provider_id, primary_model_id, fallback_model_ids, write_tools, search_api_key, reasoning_effort)
        VALUES ('p1','pr1','mdl1','["mdl2","mdl3"]','create_task,update_task','exa-key','high');
      INSERT INTO assistant_settings (project_id) VALUES ('p3');
      INSERT INTO project_memory (id, project_id, content, source) VALUES ('m1','p1','a','assistant'), ('m2','p1','b','assistant');
    `);
  }

  it("returns one row per project including unconfigured ones", async () => {
    seedBindings(db);
    const repo = makeRepo(db);
    await Effect.runPromise(
      Effect.gen(function* () {
        const rows = yield* repo.listBindingsOverview();
        expect(rows.map((r) => r.projectId)).toEqual(["p1", "p2", "p3"]);

        const configured = rows[0]!;
        expect(configured.providerLabel).toBe("Opencode Go");
        expect(configured.modelLabel).toBe("gpt-5.1");
        expect(configured.fallbackCount).toBe(2);
        expect(configured.writeToolsCount).toBe(2);
        expect(configured.memoryCount).toBe(2);
        expect(configured.hasSearchKey).toBe(true);
        expect(configured.reasoningEffort).toBe("high");
        expect(configured.updatedAt).not.toBeNull();

        const unconfigured = rows[1]!;
        expect(unconfigured.providerId).toBeNull();
        expect(unconfigured.modelLabel).toBeNull();
        expect(unconfigured.fallbackCount).toBe(0);
        expect(unconfigured.writeToolsCount).toBe(0);
        expect(unconfigured.memoryCount).toBe(0);
        expect(unconfigured.hasSearchKey).toBe(false);
        expect(unconfigured.updatedAt).toBeNull();

        const empty = rows[2]!;
        expect(empty.writeToolsCount).toBe(0);
        expect(empty.hasSearchKey).toBe(false);
        expect(empty.updatedAt).not.toBeNull();
      })
    );
  });

  it("empty workspace returns no rows", async () => {
    const repo = makeRepo(db);
    await Effect.runPromise(
      Effect.gen(function* () {
        const rows = yield* repo.listBindingsOverview();
        expect(rows).toEqual([]);
      })
    );
  });
});
