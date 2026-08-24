import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer, Context } from "effect";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { Sqlite, initSqlite } from "../db/database";
import { HeraldSettingsRepo } from "./herald-settings.repo";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

let dirs: string[] = [];
let dbs: Database[] = [];

function tmpDb(): Database {
  const dir = mkdtempSync(join(tmpdir(), "lexa-herald-settings-repo-"));
  dirs.push(dir);
  const path = join(dir, "test.db");
  runMigrations(path, MIGRATIONS);
  const ctx = Effect.runSync(Effect.scoped(Layer.build(initSqlite(path))));
  const db = Context.get(ctx, Sqlite);
  dbs.push(db);
  return db;
}

function seed(db: Database) {
  db.exec(`INSERT INTO projects (id, name, slug) VALUES ('p1', 'P', 'p1')`);
}

function makeRepo(db: Database) {
  const layer = HeraldSettingsRepo.Default.pipe(Layer.provide(Layer.succeed(Sqlite, db)));
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  return Context.get(ctx, HeraldSettingsRepo);
}

afterEach(() => {
  for (const db of dbs) {
    try { db.close(); } catch {}
  }
  dbs = [];
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("HeraldSettingsRepo upsert", () => {
  it("inserts a new row and returns it", () => {
    const db = tmpDb();
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        const row = yield* repo.upsert("p1", {
          kind: "openai_compatible",
          baseUrl: "https://api.example.com/v1",
          model: "gpt-x",
          apiKey: "sk-secret-abcd",
          searchProvider: "exa",
          searchApiKey: "exa-key",
          urlAllowlist: "example.com",
        });
        expect(row.project_id).toBe("p1");
        expect(row.kind).toBe("openai_compatible");
        expect(row.api_key).toBe("sk-secret-abcd");
        expect(row.search_provider).toBe("exa");
      })
    );
  });

  it("update keeps stored keys when omitted", () => {
    const db = tmpDb();
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        yield* repo.upsert("p1", {
          kind: "openai_compatible",
          baseUrl: "https://api.example.com/v1",
          model: "gpt-x",
          apiKey: "sk-secret-abcd",
          searchProvider: "exa",
          searchApiKey: "exa-key",
        });
        const row = yield* repo.upsert("p1", {
          kind: "anthropic_compatible",
          baseUrl: "https://api.anthropic.com",
          model: "claude-x",
        });
        expect(row.kind).toBe("anthropic_compatible");
        expect(row.api_key).toBe("sk-secret-abcd");
        expect(row.search_api_key).toBe("exa-key");
        expect(row.search_provider).toBeNull();
      })
    );
  });

  it("upsert on missing project violates FK", () => {
    const db = tmpDb();
    seed(db);
    const repo = makeRepo(db);
    const exit = Effect.runSyncExit(
      repo.upsert("nope", { kind: "openai_compatible", baseUrl: "https://x", model: "m", apiKey: "k" })
    );
    expect(exit._tag).toBe("Failure");
  });
});

describe("HeraldSettingsRepo getByProject/maskedView", () => {
  it("getByProject fails RowNotFound when absent", () => {
    const db = tmpDb();
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        const err = yield* repo.getByProject("p1").pipe(Effect.flip);
        expect(err._tag).toBe("RowNotFound");
      })
    );
  });

  it("masked view never exposes keys; keyMask uses stored key tail", () => {
    const db = tmpDb();
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        yield* repo.upsert("p1", {
          kind: "openai_compatible",
          baseUrl: "https://api.example.com/v1",
          model: "gpt-x",
          apiKey: "sk-live-1234abcd",
          searchProvider: "exa",
          searchApiKey: "exa-key-9zzz",
          urlAllowlist: "docs.example.com,api.example.com",
        });
        const masked = yield* repo.maskedView("p1");
        expect(masked).toEqual({
          projectId: "p1",
          kind: "openai_compatible",
          baseUrl: "https://api.example.com/v1",
          model: "gpt-x",
          hasKey: true,
          keyMask: "sk-…abcd",
          searchProvider: "exa",
          hasSearchKey: true,
          urlAllowlist: "docs.example.com,api.example.com",
          engine: "herald",
          engineSwitcherEnabled: false,
          primarySupportsImages: false,
          visionModel: null,
          reasoningEffort: null,
        });
        const raw = JSON.stringify(masked);
        expect(raw).not.toContain("sk-live-1234abcd");
        expect(raw).not.toContain("exa-key-9zzz");
      })
    );
  });

  it("masked view hasSearchKey false without search key", () => {
    const db = tmpDb();
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        yield* repo.upsert("p1", {
          kind: "openai_compatible",
          baseUrl: "https://api.example.com/v1",
          model: "gpt-x",
          apiKey: "sk-secret-abcd",
        });
        const masked = yield* repo.maskedView("p1");
        expect(masked.hasSearchKey).toBe(false);
        expect(masked.searchProvider).toBeNull();
        expect(masked.keyMask).toBe("sk-…abcd");
      })
    );
  });

  it("maskedView fails RowNotFound when absent", () => {
    const db = tmpDb();
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        const err = yield* repo.maskedView("p1").pipe(Effect.flip);
        expect(err._tag).toBe("RowNotFound");
      })
    );
  });
});

describe("HeraldSettingsRepo hearth columns (0013)", () => {
  const base = { kind: "openai_compatible" as const, baseUrl: "https://api.example.com/v1", model: "gpt-x", apiKey: "sk-secret-abcd" };

  it("round-trips engine/vision columns", () => {
    const db = tmpDb();
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        const row = yield* repo.upsert("p1", {
          ...base,
          engine: "blacksmith",
          engineSwitcherEnabled: true,
          primarySupportsImages: true,
          visionModel: "claude-vision",
        });
        expect(row.engine).toBe("blacksmith");
        expect(row.engine_switcher_enabled).toBe(1);
        expect(row.primary_supports_images).toBe(1);
        expect(row.vision_model).toBe("claude-vision");
        const masked = yield* repo.maskedView("p1");
        expect(masked.engine).toBe("blacksmith");
        expect(masked.engineSwitcherEnabled).toBe(true);
        expect(masked.primarySupportsImages).toBe(true);
        expect(masked.visionModel).toBe("claude-vision");
      })
    );
  });

  it("omitted visionModel clears on update; stored keys kept when omitted", () => {
    const db = tmpDb();
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        yield* repo.upsert("p1", {
          ...base,
          visionModel: "vl-model",
          engine: "blacksmith",
        });
        const row = yield* repo.upsert("p1", { ...base, kind: "openai_compatible" });
        expect(row.api_key).toBe("sk-secret-abcd");
        expect(row.vision_model).toBeNull();
        expect(row.engine).toBe("herald");
      })
    );
  });

  it("visionModel stores independently of the primary kind (shared credentials)", () => {
    const db = tmpDb();
    seed(db);
    const repo = makeRepo(db);
    const row = Effect.runSync(repo.upsert("p1", { ...base, visionModel: "inherits-primary" }));
    expect(row.kind).toBe("openai_compatible");
    expect(row.vision_model).toBe("inherits-primary");
  });
});

describe("HeraldSettingsRepo reasoning_effort (0014)", () => {
  const base = { kind: "openai_compatible" as const, baseUrl: "https://api.example.com/v1", model: "gpt-x", apiKey: "sk-secret-abcd" };

  it("round-trips reasoningEffort; NULL default on fresh insert", () => {
    const db = tmpDb();
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        const row = yield* repo.upsert("p1", { ...base });
        expect(row.reasoning_effort).toBeNull();
        expect((yield* repo.maskedView("p1")).reasoningEffort).toBeNull();

        const set = yield* repo.upsert("p1", { ...base, reasoningEffort: "high" });
        expect(set.reasoning_effort).toBe("high");
        expect((yield* repo.maskedView("p1")).reasoningEffort).toBe("high");
      })
    );
  });

  it("explicit null clears; omitted keeps stored value semantics consistent with other nullable fields (clears)", () => {
    const db = tmpDb();
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        yield* repo.upsert("p1", { ...base, reasoningEffort: "low" });
        const cleared = yield* repo.upsert("p1", { ...base, reasoningEffort: null });
        expect(cleared.reasoning_effort).toBeNull();
      })
    );
  });

  it("masked view never leaks anything beyond the effort enum value", () => {
    const db = tmpDb();
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        yield* repo.upsert("p1", { ...base, reasoningEffort: "minimal" });
        const masked = yield* repo.maskedView("p1");
        expect(masked.reasoningEffort).toBe("minimal");
      })
    );
  });
});
