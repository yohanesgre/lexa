import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { Database } from "bun:sqlite";
import { createBunSqliteDriver } from "./db/drivers/bun-sqlite";
import { batch } from "./db/db";
import { pruneR2Backups, runScheduledCore } from "./workers-entry";

function memDriver(): ReturnType<typeof createBunSqliteDriver> {
  const db = new Database(":memory:");
  return createBunSqliteDriver(db);
}

function fakeR2(initial: string[]) {
  const keys = new Set(initial);
  const deleted: string[] = [];
  return {
    deleted,
    binding: {
      list: async ({ prefix, cursor }: { prefix?: string; cursor?: string }) => {
        const all = Array.from(keys).filter((k) => !prefix || k.startsWith(prefix)).sort();
        const start = cursor ? Number(cursor) : 0;
        const page = all.slice(start, start + 2);
        return {
          objects: page.map((key) => ({ key, size: 1, etag: "e" })),
          truncated: start + 2 < all.length,
          cursor: String(start + 2),
        };
      },
      delete: async (key: string) => {
        keys.delete(key);
        deleted.push(key);
      },
    },
  };
}

describe("runScheduledCore", () => {
  it("prunes old webhook/runtime events and keeps fresh ones", async () => {
    const driver = memDriver();
    await Effect.runPromise(
      batch(driver, [
        { sql: "CREATE TABLE webhook_events (delivery_id TEXT PRIMARY KEY, received_at TEXT)", params: [] },
        { sql: "CREATE TABLE runtime_events (id TEXT PRIMARY KEY, status TEXT, finished_at TEXT)", params: [] },
        { sql: "INSERT INTO webhook_events (delivery_id, received_at) VALUES ('old', datetime('now', '-8 days'))", params: [] },
        { sql: "INSERT INTO webhook_events (delivery_id, received_at) VALUES ('new', datetime('now'))", params: [] },
        { sql: "INSERT INTO runtime_events (id, status, finished_at) VALUES ('done-old', 'completed', datetime('now', '-9 days'))", params: [] },
        { sql: "INSERT INTO runtime_events (id, status, finished_at) VALUES ('run-new', 'completed', datetime('now'))", params: [] },
        { sql: "INSERT INTO runtime_events (id, status, finished_at) VALUES ('pending', 'claimed', datetime('now', '-9 days'))", params: [] },
      ])
    );
    await runScheduledCore(driver, {}, undefined);
    const remaining = await Effect.runPromise(
      Effect.gen(function* () {
        const { queryAll } = yield* Effect.promise(() => import("./db/db"));
        const w = yield* queryAll<{ delivery_id: string }>(driver, "SELECT delivery_id FROM webhook_events");
        const r = yield* queryAll<{ id: string }>(driver, "SELECT id FROM runtime_events");
        return { w: w.map((x) => x.delivery_id).sort(), r: r.map((x) => x.id).sort() };
      })
    );
    expect(remaining.w).toEqual(["new"]);
    expect(remaining.r).toEqual(["pending", "run-new"]);
  });

  it("prunes R2 backups beyond retention (newest kept) when enabled", async () => {
    const driver = memDriver();
    await Effect.runPromise(
      batch(driver, [
        { sql: "CREATE TABLE webhook_events (delivery_id TEXT PRIMARY KEY, received_at TEXT)", params: [] },
        { sql: "CREATE TABLE runtime_events (id TEXT PRIMARY KEY, status TEXT, finished_at TEXT)", params: [] },
      ])
    );
    const r2 = fakeR2([
      "backups/lexa-2026-09-03-00-00-00.db.gz",
      "backups/lexa-2026-09-02-00-00-00.db.gz",
      "backups/lexa-2026-09-02-00-00-00-blobs/a.bin",
      "backups/lexa-2026-09-01-00-00-00.db.gz",
      "unrelated.txt",
    ]);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await runScheduledCore(driver, { LXK_BACKUP_ENABLED: "1", LXK_BACKUP_RETENTION: "2" }, r2.binding as never);
    } finally {
      log.mockRestore();
    }
    expect(r2.deleted.sort()).toEqual([
      "backups/lexa-2026-09-01-00-00-00.db.gz",
    ]);
  });

  it("skips R2 pruning when backups are not enabled", async () => {
    const driver = memDriver();
    await Effect.runPromise(
      batch(driver, [
        { sql: "CREATE TABLE webhook_events (delivery_id TEXT PRIMARY KEY, received_at TEXT)", params: [] },
        { sql: "CREATE TABLE runtime_events (id TEXT PRIMARY KEY, status TEXT, finished_at TEXT)", params: [] },
      ])
    );
    const r2 = fakeR2(["backups/lexa-old.db.gz"]);
    await runScheduledCore(driver, {}, r2.binding as never);
    expect(r2.deleted).toEqual([]);
  });
});

describe("pruneR2Backups", () => {
  it("keeps the newest N stamps with their blob companions", async () => {
    const r2 = fakeR2(["backups/lexa-b.db.gz", "backups/lexa-a.db.gz", "backups/lexa-a-blobs/f"]);
    const deleted = await pruneR2Backups(r2.binding as never, 1);
    expect(deleted.sort()).toEqual(["backups/lexa-a-blobs/f", "backups/lexa-a.db.gz"]);
  });
});
