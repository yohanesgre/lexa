// @ts-nocheck
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { Effect, Layer } from "effect";
import { Sqlite } from "../db/database";
import { HeraldHealthRepo } from "./herald-health.repo";

function tempDbPath() {
  const dir = mkdtempSync(join(tmpdir(), "lexa-health-repo-test-"));
  return { dir, dbPath: join(dir, "app.db") };
}

describe("herald-health.repo", () => {
  it("migration creates herald_provider_health with correct schema and FK cascade", () => {
    const { dbPath, dir } = tempDbPath();
    try {
      runMigrations(dbPath);
      const db = new Database(dbPath);
      const row = db.prepare("SELECT sql FROM sqlite_master WHERE name='herald_provider_health'").get() as { sql: string };
      expect(row.sql).toContain("provider_id TEXT PRIMARY KEY");
      expect(row.sql).toContain("REFERENCES herald_providers(id) ON DELETE CASCADE");
      expect(row.sql).toContain("CHECK (circuit_state IN ('open','closed','half-open'))");
      expect(row.sql).toContain("failure_count INTEGER NOT NULL DEFAULT 0");
      expect(row.sql).toContain("consecutive_failures INTEGER NOT NULL DEFAULT 0");
      db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("upsert + get + delete round-trip", async () => {
    const { dbPath, dir } = tempDbPath();
    try {
      runMigrations(dbPath);
      const db = new Database(dbPath);
      db.prepare("INSERT INTO herald_providers (id, label, base_url, api_key) VALUES ('pr1','P','https://x','sk')").run();
      const layer = HeraldHealthRepo.Default.pipe(Layer.provide(Layer.succeed(Sqlite, db as any)));
      const prog = Effect.gen(function* () {
        const repo = yield* HeraldHealthRepo;
        const inserted = yield* repo.upsert({ providerId: "pr1", failureCount: 1, circuitState: "closed", consecutiveFailures: 1 });
        expect(inserted.provider_id).toBe("pr1");
        expect(inserted.failure_count).toBe(1);
        const got = yield* repo.get("pr1");
        expect(got.circuit_state).toBe("closed");
        yield* repo.upsert({ providerId: "pr1", circuitState: "open", openedAt: new Date().toISOString() });
        const got2 = yield* repo.get("pr1");
        expect(got2.circuit_state).toBe("open");
        yield* repo.delete("pr1");
        const missing = yield* repo.getOrNull("pr1");
        expect(missing).toBeNull();
      });
      await Effect.runPromise(prog.pipe(Effect.provide(layer)));
      db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("cascade delete removes health row when provider deleted", async () => {
    const { dbPath, dir } = tempDbPath();
    try {
      runMigrations(dbPath);
      const db = new Database(dbPath);
      db.prepare("INSERT INTO herald_providers (id, label, base_url, api_key) VALUES ('pr1','P','https://x','sk')").run();
      const layer = HeraldHealthRepo.Default.pipe(Layer.provide(Layer.succeed(Sqlite, db as any)));
      const prog = Effect.gen(function* () {
        const repo = yield* HeraldHealthRepo;
        yield* repo.upsert({ providerId: "pr1", failureCount: 2 });
        db.prepare("DELETE FROM herald_providers WHERE id='pr1'").run();
        const row = yield* repo.getOrNull("pr1");
        expect(row).toBeNull();
      });
      await Effect.runPromise(prog.pipe(Effect.provide(layer)));
      db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
