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
import { LexaAssistantRunner as RunnerFromModule } from "./assistant/runner";
import { LexaAssistantRunner as RunnerFromEntry } from "./workers-entry";

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
        { sql: "CREATE TABLE device_login_requests (id TEXT PRIMARY KEY, expires_at TEXT)", params: [] },
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

  it("prunes expired device login requests and keeps live ones", async () => {
    const driver = memDriver();
    await Effect.runPromise(
      batch(driver, [
        { sql: "CREATE TABLE webhook_events (delivery_id TEXT PRIMARY KEY, received_at TEXT)", params: [] },
        { sql: "CREATE TABLE device_login_requests (id TEXT PRIMARY KEY, expires_at TEXT)", params: [] },
        { sql: "INSERT INTO webhook_events (delivery_id, received_at) VALUES ('old', datetime('now', '-8 days'))", params: [] },
        { sql: "INSERT INTO webhook_events (delivery_id, received_at) VALUES ('new', datetime('now'))", params: [] },
        { sql: "INSERT INTO device_login_requests (id, expires_at) VALUES ('expired', datetime('now', '-1 minute'))", params: [] },
        { sql: "INSERT INTO device_login_requests (id, expires_at) VALUES ('live', datetime('now', '+10 minutes'))", params: [] },
      ])
    );
    await runScheduledCore(driver, {}, undefined);
    const remaining = await Effect.runPromise(
      Effect.gen(function* () {
        const { queryAll } = yield* Effect.promise(() => import("./db/db"));
        const w = yield* queryAll<{ delivery_id: string }>(driver, "SELECT delivery_id FROM webhook_events");
        const d = yield* queryAll<{ id: string }>(driver, "SELECT id FROM device_login_requests");
        return { webhooks: w.map((x) => x.delivery_id).sort(), devices: d.map((x) => x.id).sort() };
      })
    );
    expect(remaining).toEqual({ webhooks: ["new"], devices: ["live"] });
  });

  it("prunes R2 backups beyond retention (newest kept) when enabled", async () => {
    const driver = memDriver();
    await Effect.runPromise(
      batch(driver, [
        { sql: "CREATE TABLE webhook_events (delivery_id TEXT PRIMARY KEY, received_at TEXT)", params: [] },
        { sql: "CREATE TABLE device_login_requests (id TEXT PRIMARY KEY, expires_at TEXT)", params: [] },
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

  it("reconciles stale runs and fires due schedules through the enqueue callback", async () => {
    const driver = memDriver();
    await Effect.runPromise(
      batch(driver, [
        { sql: "CREATE TABLE webhook_events (delivery_id TEXT PRIMARY KEY, received_at TEXT)", params: [] },
        { sql: "CREATE TABLE device_login_requests (id TEXT PRIMARY KEY, expires_at TEXT)", params: [] },
        {
          sql: `CREATE TABLE assistant_runs (
            id TEXT PRIMARY KEY, project_id TEXT NOT NULL, thread_key TEXT NOT NULL,
            parent_run_id TEXT, kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
            goal TEXT NOT NULL, result TEXT, error TEXT, budget_ms INTEGER,
            steps_used INTEGER NOT NULL DEFAULT 0, created_by TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')), started_at TEXT, finished_at TEXT)`,
          params: [],
        },
        {
          sql: `CREATE TABLE assistant_schedules (
            id TEXT PRIMARY KEY, project_id TEXT NOT NULL, thread_key TEXT, created_by TEXT,
            title TEXT NOT NULL, prompt TEXT NOT NULL, cron TEXT, interval_seconds INTEGER,
            enabled INTEGER NOT NULL DEFAULT 1, next_run_at TEXT NOT NULL, last_run_at TEXT,
            last_run_id TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
          params: [],
        },
        {
          sql: `CREATE TABLE assistant_tasks (
            id TEXT PRIMARY KEY, project_id TEXT NOT NULL, document_type TEXT NOT NULL,
            document_id TEXT NOT NULL, agent_id TEXT NOT NULL, skill_id TEXT,
            extra_prompt TEXT NOT NULL DEFAULT '', selection TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'queued', result TEXT, error TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')), started_at TEXT, finished_at TEXT)`,
          params: [],
        },
        {
          sql: `INSERT INTO assistant_runs (id, project_id, thread_key, kind, status, goal, budget_ms, created_at)
                VALUES ('stale-1', 'p1', 'chat:stale', 'chat_run', 'running', 'old', 1000, datetime('now', '-1 hour'))`,
          params: [],
        },
        {
          sql: `INSERT INTO assistant_tasks (id, project_id, document_type, document_id, agent_id, status, created_at, started_at)
                VALUES ('doc-stale', 'p1', 'task', 't1', 'asst', 'running', datetime('now', '-2 hours'), datetime('now', '-2 hours'))`,
          params: [],
        },
        {
          sql: `INSERT INTO assistant_schedules (id, project_id, thread_key, created_by, title, prompt, interval_seconds, enabled, next_run_at)
                VALUES ('sched-1', 'p1', 'chat:schedule-sched-1', 'u1', 'Nightly', 'do it', 60, 1, datetime('now', '-1 minute'))`,
          params: [],
        },
      ])
    );

    const enqueued: Array<{ id: string; kind: string; projectId: string; threadKey: string; goal: string; createdBy: string | null }> = [];
    await runScheduledCore(driver, {}, undefined, async (run) => {
      enqueued.push(run);
    });

    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({
      kind: "schedule",
      projectId: "p1",
      threadKey: "chat:schedule-sched-1",
      goal: "do it",
      createdBy: "u1",
    });

    const stale = await Effect.runPromise(
      Effect.gen(function* () {
        const { queryFirst } = yield* Effect.promise(() => import("./db/db"));
        return yield* queryFirst<{ status: string; error: string | null }>(
          driver,
          "SELECT status, error FROM assistant_runs WHERE id = 'stale-1'"
        );
      })
    );
    expect(stale.status).toBe("failed");
    expect(stale.error).toBe("run exceeded its wall-clock budget");

    // The same tick sweeps a stale claimed document run (`assistant_tasks`).
    const staleDoc = await Effect.runPromise(
      Effect.gen(function* () {
        const { queryFirst } = yield* Effect.promise(() => import("./db/db"));
        return yield* queryFirst<{ status: string; error: string | null }>(
          driver,
          "SELECT status, error FROM assistant_tasks WHERE id = 'doc-stale'"
        );
      })
    );
    expect(staleDoc.status).toBe("failed");
    expect(staleDoc.error).toBe("run abandoned");
  });

  it("fails open when the document sweep errors, still dispatching due schedules", async () => {
    const driver = memDriver();
    // No `assistant_tasks`: the document sweep rejects — the tick must swallow
    // it and continue to the schedule dispatch below it.
    await Effect.runPromise(
      batch(driver, [
        { sql: "CREATE TABLE webhook_events (delivery_id TEXT PRIMARY KEY, received_at TEXT)", params: [] },
        { sql: "CREATE TABLE device_login_requests (id TEXT PRIMARY KEY, expires_at TEXT)", params: [] },
        {
          sql: `CREATE TABLE assistant_runs (
            id TEXT PRIMARY KEY, project_id TEXT NOT NULL, thread_key TEXT NOT NULL,
            parent_run_id TEXT, kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
            goal TEXT NOT NULL, result TEXT, error TEXT, budget_ms INTEGER,
            steps_used INTEGER NOT NULL DEFAULT 0, created_by TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')), started_at TEXT, finished_at TEXT)`,
          params: [],
        },
        {
          sql: `CREATE TABLE assistant_schedules (
            id TEXT PRIMARY KEY, project_id TEXT NOT NULL, thread_key TEXT, created_by TEXT,
            title TEXT NOT NULL, prompt TEXT NOT NULL, cron TEXT, interval_seconds INTEGER,
            enabled INTEGER NOT NULL DEFAULT 1, next_run_at TEXT NOT NULL, last_run_at TEXT,
            last_run_id TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
          params: [],
        },
        {
          sql: `INSERT INTO assistant_schedules (id, project_id, thread_key, created_by, title, prompt, interval_seconds, enabled, next_run_at)
                VALUES ('sched-1', 'p1', 'chat:schedule-sched-1', 'u1', 'Nightly', 'do it', 60, 1, datetime('now', '-1 minute'))`,
          params: [],
        },
      ])
    );

    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const enqueued: unknown[] = [];
    let docSweepErrored = false;
    try {
      await runScheduledCore(driver, {}, undefined, async (run) => {
        enqueued.push(run);
      });
      docSweepErrored = error.mock.calls.some((args) => String(args[0]).includes("document-run reconciliation"));
    } finally {
      error.mockRestore();
    }

    // The doc-sweep rejection was caught and the tick drove the schedule.
    expect(enqueued).toHaveLength(1);
    expect(docSweepErrored).toBe(true);
  });

  it("skips R2 pruning when backups are not enabled", async () => {
    const driver = memDriver();
    await Effect.runPromise(
      batch(driver, [
        { sql: "CREATE TABLE webhook_events (delivery_id TEXT PRIMARY KEY, received_at TEXT)", params: [] },
        { sql: "CREATE TABLE device_login_requests (id TEXT PRIMARY KEY, expires_at TEXT)", params: [] },
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
    LXK_SECRETS_MASTER_KEY: Buffer.from("workers-entry-test-master-key-0000").toString("base64"),
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

describe("delegation facet export", () => {
  it("re-exports the runner class from the worker entry for ctx.exports resolution", () => {
    expect(RunnerFromEntry).toBe(RunnerFromModule);
    expect(typeof RunnerFromEntry).toBe("function");
    const proto = RunnerFromEntry.prototype as unknown as { onChatMessage?: unknown };
    expect(typeof proto.onChatMessage).toBe("function");
  });
});
