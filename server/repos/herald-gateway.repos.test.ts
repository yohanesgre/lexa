import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { Effect, Layer } from "effect";
import { Sqlite } from "../db/database";
import { HeraldSettingsRepo } from "./herald-settings.repo";
import { HeraldProvidersRepo } from "./herald-providers.repo";
import { HeraldModelsRepo } from "./herald-models.repo";
import { HeraldCallLogsRepo } from "./herald-call-logs.repo";
import { HeraldModelPricesRepo } from "./herald-model-prices.repo";

function tempDbPath() {
  const dir = mkdtempSync(join(tmpdir(), "lexa-gateway-test-"));
  return { dir, dbPath: join(dir, "app.db") };
}

describe("herald gateway phase 1", () => {
  it("migration 0017 drops legacy cols, keeps gateway cols, creates 4 new tables + indexes", () => {
    const { dbPath, dir } = tempDbPath();
    try {
      runMigrations(dbPath);
      const db = new Database(dbPath);
      const cols = (db.prepare("PRAGMA table_info(herald_settings)").all() as { name: string }[]).map((c) => c.name);
      expect(cols).not.toContain("kind");
      expect(cols).not.toContain("base_url");
      expect(cols).not.toContain("api_key");
      expect(cols).not.toContain("model");
      expect(cols).not.toContain("vision_model");
      expect(cols).toEqual(expect.arrayContaining(["search_provider","search_api_key","url_allowlist","engine","engine_switcher_enabled","primary_supports_images","write_tools","reasoning_effort","created_at","updated_at","project_id"]));
      for (const tbl of ["herald_providers","herald_models","herald_call_logs","herald_model_prices"]) {
        const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(tbl) as any;
        expect(row?.name).toBe(tbl);
      }
      const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[]).map((r) => r.name);
      expect(idx).toEqual(expect.arrayContaining(["idx_call_logs_project_time","idx_call_logs_provider","idx_call_logs_model","idx_herald_models_provider"]));
      const provSql = (db.prepare("SELECT sql FROM sqlite_master WHERE name='herald_models'").get() as { sql: string }).sql;
      expect(provSql).toContain("CHECK (kind IN ('openai_compatible','anthropic_compatible'))");
      const logsSql = (db.prepare("SELECT sql FROM sqlite_master WHERE name='herald_call_logs'").get() as { sql: string }).sql;
      expect(logsSql).toContain("CHECK (status IN ('done','error','suspended','aborted'))");
      expect(logsSql).toContain("CHECK (kind IN ('openai_compatible','anthropic_compatible'))");
      const provCols = (db.prepare("PRAGMA table_info(herald_providers)").all() as { name: string }[]).map((c) => c.name);
      expect(provCols).not.toContain("project_id");
      db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("herald_settings upsert/maskedView without legacy cols", async () => {
    const { dbPath, dir } = tempDbPath();
    try {
      runMigrations(dbPath);
      const seed = new Database(dbPath);
      seed.prepare("INSERT INTO projects (id, name, slug) VALUES ('p1','P','p1')").run();
      seed.close();
      const db = new Database(dbPath);
      const layer = Layer.mergeAll(HeraldSettingsRepo.Default).pipe(Layer.provide(Layer.succeed(Sqlite, db as any)));
      const prog = Effect.gen(function* () {
        const repo = yield* HeraldSettingsRepo;
        const r = yield* repo.upsert("p1", { searchProvider: "exa", searchApiKey: "skey", urlAllowlist: "https://a.com", writeTools: ["task_create"] });
        expect(r.project_id).toBe("p1");
        expect(r.search_provider).toBe("exa");
        const masked = yield* repo.maskedView("p1");
        expect(masked.searchProvider).toBe("exa");
        expect(masked.hasSearchKey).toBe(true);
        expect((masked as any).kind).toBeUndefined();
        expect((masked as any).model).toBeUndefined();
      });
      await Effect.runPromise(prog.pipe(Effect.provide(layer)));
      db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("providers maskedView never exposes raw api_key", async () => {
    const { dbPath, dir } = tempDbPath();
    try {
      runMigrations(dbPath);
      const db = new Database(dbPath);
      const layer = Layer.mergeAll(HeraldProvidersRepo.Default).pipe(Layer.provide(Layer.succeed(Sqlite, db as any)));
      const prog = Effect.gen(function* () {
        const repo = yield* HeraldProvidersRepo;
        const row = yield* repo.create({ id: "pr1", label: "OpenAI", baseUrl: "https://api.openai.com/v1", apiKey: "sk-abc123XYZ" });
        expect(row.api_key).toBe("sk-abc123XYZ");
        const masked = yield* repo.maskedView("pr1");
        expect(masked.hasKey).toBe(true);
        expect(masked.keyMask).toBe("sk-…3XYZ");
        expect((masked as any).api_key).toBeUndefined();
        const list = yield* repo.maskedList();
        expect(list[0].hasKey).toBe(true);
        expect((list[0] as any).api_key).toBeUndefined();
      });
      await Effect.runPromise(prog.pipe(Effect.provide(layer)));
      db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("models + call_logs + prices round-trip and constraints", async () => {
    const { dbPath, dir } = tempDbPath();
    try {
      runMigrations(dbPath);
      const seed = new Database(dbPath);
      seed.prepare("INSERT INTO projects (id, name, slug) VALUES ('p1','P','p1')").run();
      seed.close();
      const db = new Database(dbPath);
      const layer = Layer.mergeAll(HeraldProvidersRepo.Default, HeraldModelsRepo.Default, HeraldCallLogsRepo.Default, HeraldModelPricesRepo.Default).pipe(Layer.provide(Layer.succeed(Sqlite, db as any)));
      const prog = Effect.gen(function* () {
        const provRepo = yield* HeraldProvidersRepo;
        const modelRepo = yield* HeraldModelsRepo;
        const logRepo = yield* HeraldCallLogsRepo;
        const priceRepo = yield* HeraldModelPricesRepo;
        yield* provRepo.create({ id: "pr1", label: "P1", baseUrl: "https://x", apiKey: "sk-1" });
        const m = yield* modelRepo.create({ id: "m1", providerId: "pr1", modelId: "gpt-4o", kind: "openai_compatible", priority: 1, enabled: true });
        expect(m.modelId).toBe("gpt-4o");
        const byProv = yield* modelRepo.listByProvider("pr1");
        expect(byProv.length).toBe(1);
        const log = yield* logRepo.insert({ id: "l1", projectId: "p1", providerId: "pr1", model: "gpt-4o", kind: "openai_compatible", status: "done", usageIn: 10, usageOut: 20, latencyMs: 123, costCents: 5, estimated: false });
        expect(log.status).toBe("done");
        const byProj = yield* logRepo.listByProject("p1");
        expect(byProj.length).toBe(1);
        const byModel = yield* logRepo.listByModel("gpt-4o");
        expect(byModel.length).toBe(1);
        const price = yield* priceRepo.upsert({ model: "gpt-4o", promptPrice: 0.01, completionPrice: 0.02 });
        expect(price.promptPrice).toBe(0.01);
        const fetched = yield* priceRepo.getByModel("gpt-4o");
        expect(fetched.completionPrice).toBe(0.02);
        const price2 = yield* priceRepo.upsert({ model: "gpt-4o", promptPrice: 0.015, completionPrice: 0.025 });
        expect(price2.promptPrice).toBe(0.015);
      });
      await Effect.runPromise(prog.pipe(Effect.provide(layer)));
      db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
