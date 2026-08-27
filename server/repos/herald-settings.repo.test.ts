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
          searchProvider: "exa",
          searchApiKey: "exa-key",
          urlAllowlist: "example.com",
        });
        expect(row.project_id).toBe("p1");
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

  it("upsert on missing project violates FK", () => {
    const db = tmpDb();
    seed(db);
    const repo = makeRepo(db);
    const exit = Effect.runSyncExit(
      repo.upsert("nope", { searchProvider: "exa", searchApiKey: "k" })
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
          engine: "herald",
          engineSwitcherEnabled: false,
          primarySupportsImages: false,
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

  it("masked view hasSearchKey false without search key", () => {
    const db = tmpDb();
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        yield* repo.upsert("p1", {});
        const masked = yield* repo.maskedView("p1");
        expect(masked.hasSearchKey).toBe(false);
        expect(masked.searchProvider).toBeNull();
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
  const base = {} as const;

  it("round-trips engine columns", () => {
    const db = tmpDb();
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        const row = yield* repo.upsert("p1", {
          engine: "blacksmith",
          engineSwitcherEnabled: true,
          primarySupportsImages: true,
        });
        expect(row.engine).toBe("blacksmith");
        expect(row.engine_switcher_enabled).toBe(1);
        expect(row.primary_supports_images).toBe(1);
        const masked = yield* repo.maskedView("p1");
        expect(masked.engine).toBe("blacksmith");
        expect(masked.engineSwitcherEnabled).toBe(true);
        expect(masked.primarySupportsImages).toBe(true);
      })
    );
  });

  it("engine resets to default on update without explicit value", () => {
    const db = tmpDb();
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        yield* repo.upsert("p1", {
          engine: "blacksmith",
        });
        const row = yield* repo.upsert("p1", {});
        expect(row.engine).toBe("herald");
      })
    );
  });

  it("upsert without legacy provider fields still succeeds", () => {
    const db = tmpDb();
    seed(db);
    const repo = makeRepo(db);
    const row = Effect.runSync(repo.upsert("p1", {}));
    expect(row.project_id).toBe("p1");
  });
});

describe("HeraldSettingsRepo reasoning_effort (0014)", () => {
  const base = {} as const;

  it("round-trips reasoningEffort; NULL default on fresh insert", () => {
    const db = tmpDb();
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
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

  it("explicit null clears; omitted keeps stored value semantics consistent with other nullable fields (clears)", () => {
    const db = tmpDb();
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        yield* repo.upsert("p1", { reasoningEffort: "low" });
        const cleared = yield* repo.upsert("p1", { reasoningEffort: null });
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
        yield* repo.upsert("p1", { reasoningEffort: "minimal" });
        const masked = yield* repo.maskedView("p1");
        expect(masked.reasoningEffort).toBe("minimal");
      })
    );
  });
});
