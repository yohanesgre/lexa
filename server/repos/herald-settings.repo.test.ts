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
