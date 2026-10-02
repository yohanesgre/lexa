import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { Database } from "bun:sqlite";
import { createBunSqliteDriver } from "./db/drivers/bun-sqlite";
import { batch } from "./db/db";
import { getEnvFromWorkers } from "./env";
import {
  getRuntimeAuth,
  loadAssistantThread,
  pruneR2Backups,
  requestLayers,
  resetAuthCache,
  resetRequestLayersCache,
  runScheduledCore,
  type WorkersEnv,
} from "./workers-entry";

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
  it("prunes old webhook events and keeps fresh ones", async () => {
    const driver = memDriver();
    await Effect.runPromise(
      batch(driver, [
        { sql: "CREATE TABLE webhook_events (delivery_id TEXT PRIMARY KEY, received_at TEXT)", params: [] },
        { sql: "INSERT INTO webhook_events (delivery_id, received_at) VALUES ('old', datetime('now', '-8 days'))", params: [] },
        { sql: "INSERT INTO webhook_events (delivery_id, received_at) VALUES ('new', datetime('now'))", params: [] },
      ])
    );
    await runScheduledCore(driver, {}, undefined);
    const remaining = await Effect.runPromise(
      Effect.gen(function* () {
        const { queryAll } = yield* Effect.promise(() => import("./db/db"));
        const w = yield* queryAll<{ delivery_id: string }>(driver, "SELECT delivery_id FROM webhook_events");
        return w.map((x) => x.delivery_id).sort();
      })
    );
    expect(remaining).toEqual(["new"]);
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

describe("loadAssistantThread", () => {
  const createThreads = (driver: ReturnType<typeof memDriver>) =>
    Effect.runPromise(
      batch(driver, [
        {
          sql: "CREATE TABLE assistant_threads (document_type TEXT NOT NULL, document_id TEXT NOT NULL, project_id TEXT NOT NULL, owner_user_id TEXT, PRIMARY KEY (document_type, document_id))",
          params: [],
        },
      ])
    );

  it("returns null for a missing row instead of leaking the typed rejection", async () => {
    const driver = memDriver();
    await createThreads(driver);
    await expect(loadAssistantThread(driver, "chat", "missing")).resolves.toBeNull();
  });

  it("maps a present row to the gate shape", async () => {
    const driver = memDriver();
    await createThreads(driver);
    await Effect.runPromise(
      batch(driver, [
        {
          sql: "INSERT INTO assistant_threads (document_type, document_id, project_id, owner_user_id) VALUES ('chat', 'chat-1', 'proj-1', 'user-1')",
          params: [],
        },
      ])
    );
    await expect(loadAssistantThread(driver, "chat", "chat-1")).resolves.toEqual({
      documentType: "chat",
      documentId: "chat-1",
      projectId: "proj-1",
      ownerUserId: "user-1",
    });
  });
});

// Minimal D1 binding surface: enough for d1DatabaseToD1Like/createD1Driver
// construction and better-auth's D1 auto-detection ("batch"/"exec"/"prepare").
// No query is ever run.
function fakeD1(): Record<string, unknown> {
  const stmt = {
    bind: () => stmt,
    all: () => Promise.resolve({ results: [] }),
    first: () => Promise.resolve(null),
    run: () => Promise.resolve({ success: true, meta: { changes: 0 } }),
  };
  return {
    prepare: () => stmt,
    exec: () => Promise.resolve({ count: 0, duration: 0 }),
    batch: () => Promise.resolve([]),
  };
}

describe("per-isolate caches", () => {
  const env = (): WorkersEnv => ({
    DB: fakeD1() as never,
    LXK_ENV: "dev",
    LXK_PUBLIC_URL: "http://localhost:5173",
  });

  it("requestLayers returns the identical value across same-fingerprint calls", () => {
    resetRequestLayersCache();
    const first = requestLayers(env());
    const second = requestLayers(env());
    expect(second).toBe(first);
    expect(second.driver).toBe(first.driver);
  });

  it("requestLayers rebuilds when LXK_ENV or LXK_PUBLIC_URL changes", () => {
    resetRequestLayersCache();
    const base = requestLayers(env());
    expect(requestLayers({ ...env(), LXK_ENV: "prod" })).not.toBe(base);
    // Reset first: the ENV change above already moved the fingerprint, so a
    // PUBLIC_URL-only rebuild must be measured from a fresh dev base.
    resetRequestLayersCache();
    const devBase = requestLayers(env());
    expect(requestLayers({ ...env(), LXK_PUBLIC_URL: "https://lexa.test" })).not.toBe(devBase);
  });

  it("resetRequestLayersCache forces a rebuild", () => {
    resetRequestLayersCache();
    const first = requestLayers(env());
    resetRequestLayersCache();
    expect(requestLayers(env())).not.toBe(first);
  });

  it("getRuntimeAuth returns the identical instance for the same fingerprint", () => {
    resetAuthCache();
    const runtimeEnv = getEnvFromWorkers(env() as unknown as Record<string, unknown>);
    const first = getRuntimeAuth(runtimeEnv);
    expect(getRuntimeAuth(runtimeEnv)).toBe(first);
    expect(getRuntimeAuth({ ...runtimeEnv, LXK_ENV: "prod" })).not.toBe(first);
  });
});
