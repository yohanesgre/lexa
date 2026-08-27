// @ts-nocheck
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { Effect, Layer } from "effect";
import { Sqlite } from "../db/database";
import { HeraldHealthRepo } from "../repos/herald-health.repo";
import { HeraldHealthService } from "./herald-health.service";

function tempDbPath() {
  const dir = mkdtempSync(join(tmpdir(), "lexa-health-svc-test-"));
  return { dir, dbPath: join(dir, "app.db") };
}

describe("herald-health.service", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("default closed when missing", async () => {
    const { dbPath, dir } = tempDbPath();
    try {
      runMigrations(dbPath);
      const db = new Database(dbPath);
      db.prepare("INSERT INTO herald_providers (id, label, base_url, api_key) VALUES ('pr1','P','https://x','sk')").run();
      const layer = Layer.mergeAll(HeraldHealthRepo.Default, HeraldHealthService.Default).pipe(Layer.provide(Layer.succeed(Sqlite, db)));
      const prog = Effect.gen(function* () {
        const svc = yield* HeraldHealthService;
        const allowed = yield* svc.isAllowed("pr1");
        expect(allowed).toBe(true);
        const h = yield* svc.getHealth("pr1");
        expect(h.circuitState).toBe("closed");
        expect(h.failureCount).toBe(0);
      });
      await Effect.runPromise(prog.pipe(Effect.provide(layer)));
      db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("3 consecutive fails → open, isAllowed false within 5m", async () => {
    const { dbPath, dir } = tempDbPath();
    try {
      runMigrations(dbPath);
      const db = new Database(dbPath);
      db.prepare("INSERT INTO herald_providers (id, label, base_url, api_key) VALUES ('pr1','P','https://x','sk')").run();
      const layer = Layer.mergeAll(HeraldHealthRepo.Default, HeraldHealthService.Default).pipe(Layer.provide(Layer.succeed(Sqlite, db)));
      const prog = Effect.gen(function* () {
        const svc = yield* HeraldHealthService;
        yield* svc.recordFailure("pr1");
        yield* svc.recordFailure("pr1");
        yield* svc.recordFailure("pr1");
        const h = yield* svc.getHealth("pr1");
        expect(h.circuitState).toBe("open");
        expect(h.consecutiveFailures).toBe(3);
        const allowed = yield* svc.isAllowed("pr1");
        expect(allowed).toBe(false);
      });
      await Effect.runPromise(prog.pipe(Effect.provide(layer)));
      db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("after 5m open → half-open allows probe, success closes", async () => {
    const { dbPath, dir } = tempDbPath();
    try {
      runMigrations(dbPath);
      const db = new Database(dbPath);
      db.prepare("INSERT INTO herald_providers (id, label, base_url, api_key) VALUES ('pr1','P','https://x','sk')").run();
      const layer = Layer.mergeAll(HeraldHealthRepo.Default, HeraldHealthService.Default).pipe(Layer.provide(Layer.succeed(Sqlite, db)));
      const prog = Effect.gen(function* () {
        const svc = yield* HeraldHealthService;
        const past = new Date(Date.now() - 6 * 60 * 1000).toISOString();
        const repo = yield* HeraldHealthRepo;
        yield* repo.upsert({ providerId: "pr1", failureCount: 3, circuitState: "open", openedAt: past, consecutiveFailures: 3 });
        const allowed = yield* svc.isAllowed("pr1");
        expect(allowed).toBe(true);
        const h = yield* svc.getHealth("pr1");
        expect(h.circuitState).toBe("half-open");
        yield* svc.recordSuccess("pr1");
        const h2 = yield* svc.getHealth("pr1");
        expect(h2.circuitState).toBe("closed");
        expect(h2.consecutiveFailures).toBe(0);
        const allowed2 = yield* svc.isAllowed("pr1");
        expect(allowed2).toBe(true);
      });
      await Effect.runPromise(prog.pipe(Effect.provide(layer)));
      db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("half-open fail → re-open", async () => {
    const { dbPath, dir } = tempDbPath();
    try {
      runMigrations(dbPath);
      const db = new Database(dbPath);
      db.prepare("INSERT INTO herald_providers (id, label, base_url, api_key) VALUES ('pr1','P','https://x','sk')").run();
      const layer = Layer.mergeAll(HeraldHealthRepo.Default, HeraldHealthService.Default).pipe(Layer.provide(Layer.succeed(Sqlite, db)));
      const prog = Effect.gen(function* () {
        const svc = yield* HeraldHealthService;
        const repo = yield* HeraldHealthRepo;
        const past = new Date(Date.now() - 6 * 60 * 1000).toISOString();
        yield* repo.upsert({ providerId: "pr1", failureCount: 3, circuitState: "open", openedAt: past, consecutiveFailures: 3 });
        yield* svc.isAllowed("pr1");
        yield* svc.recordFailure("pr1");
        const h = yield* svc.getHealth("pr1");
        expect(h.circuitState).toBe("open");
        const allowed = yield* svc.isAllowed("pr1");
        expect(allowed).toBe(false);
      });
      await Effect.runPromise(prog.pipe(Effect.provide(layer)));
      db.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
