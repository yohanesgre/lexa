import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { Database } from "bun:sqlite";
import workersEntry from "./workers-entry";
import { createBunSqliteDriver } from "./db/drivers/bun-sqlite";
import { batch } from "./db/db";
import { getEnvFromWorkers } from "./env";
import {
  getRuntimeAuth,
  pruneR2Backups,
  requestLayers,
  resetAuthCache,
  resetRequestLayersCache,
  runScheduledCore,
  type WorkersEnv,
} from "./workers-entry";
import { LexaAssistantRunner as RunnerFromModule } from "./assistant/runner";
import { LexaAssistantRunner as RunnerFromEntry } from "./workers-entry";

// ManagedRuntime.make in the webhook handler returns an object literal whose
// `dispose` is an own property (not on a prototype), so a prototype spy can't
// see it. Wrap `make` to count dispose calls while delegating to the original.
const runtimeSpies = vi.hoisted(() => ({ disposed: 0 }));
vi.mock("effect", async (importOriginal) => {
  const actual = await importOriginal<typeof import("effect")>();
  const make = actual.ManagedRuntime.make;
  const ManagedRuntime = {
    ...actual.ManagedRuntime,
    make: (...args: Parameters<typeof make>) => {
      const runtime = make(...args);
      const dispose = runtime.dispose.bind(runtime);
      return Object.assign(runtime, {
        dispose: () => {
          runtimeSpies.disposed += 1;
          return dispose();
        },
      });
    },
  };
  return { ...actual, ManagedRuntime } as unknown as typeof import("effect");
});

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

  it("reconciles stale registry runs and stale claimed document runs on the tick", async () => {
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
      ])
    );

    await runScheduledCore(driver, {}, undefined);

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

  it("fails open when the document sweep errors", async () => {
    const driver = memDriver();
    // No `assistant_tasks`: the document sweep rejects — the tick must swallow
    // it and finish cleanly.
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
      ])
    );

    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let docSweepErrored = false;
    try {
      await runScheduledCore(driver, {}, undefined);
      docSweepErrored = error.mock.calls.some((args) => String(args[0]).includes("document-run reconciliation"));
    } finally {
      error.mockRestore();
    }

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

// SQL-routing D1 stub for the handler-level tests: records every prepared
// statement and lets a test serve rows per query.
function d1Stub(handlers: {
  all?: (sql: string, params: unknown[]) => Array<Record<string, unknown>>;
  first?: (sql: string, params: unknown[]) => Record<string, unknown> | null;
  queries?: string[];
}): Record<string, unknown> {
  const prepared = (sql: string) => {
    let params: unknown[] = [];
    const stmt = {
      bind: (...p: unknown[]) => {
        params = p;
        return stmt;
      },
      all: async () => ({ results: handlers.all?.(sql, params) ?? [] }),
      first: async () => (handlers.first ? handlers.first(sql, params) : null),
      run: async () => ({ success: true, meta: { changes: 0 } }),
    };
    return stmt;
  };
  return {
    prepare: (sql: string) => {
      handlers.queries?.push(sql);
      return prepared(sql);
    },
    exec: async () => ({ count: 0, duration: 0 }),
    batch: async (stmts: unknown[]) => stmts.map(() => ({ success: true, results: [], meta: {} })),
  };
}

function workerEnv(db: Record<string, unknown>): WorkersEnv {
  return { DB: db as never, LXK_ENV: "dev", LXK_PUBLIC_URL: "http://localhost:5173" };
}

function execCtx(): { tasks: Promise<unknown>[]; ctx: never } {
  const tasks: Promise<unknown>[] = [];
  return {
    tasks,
    ctx: {
      waitUntil: (p: Promise<unknown>) => {
        tasks.push(p);
      },
      passThroughOnException: () => {},
    } as never,
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

describe("/api/health pre-boot", () => {
  it("answers without running the boot sync chain", async () => {
    resetRequestLayersCache();
    const queries: string[] = [];
    const env = workerEnv(d1Stub({ first: (sql) => (sql.includes("SELECT 1") ? { one: 1 } : null), queries }));

    const res = await workersEntry.fetch!(
      new Request("http://localhost/api/health") as never,
      env as never,
      execCtx().ctx
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    // Only the deep check ran: any boot sync (settings mirror / rate-limit /
    // GitHub config / key backfill) would have prepared additional SQL.
    expect(queries).toEqual(["SELECT 1 AS one"]);
  });

  it("returns 503 {ok:false} when the driver query rejects", async () => {
    resetRequestLayersCache();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const res = await workersEntry.fetch!(
        new Request("http://localhost/api/health") as never,
        workerEnv(d1Stub({ first: () => { throw new Error("d1 down"); } })) as never,
        execCtx().ctx
      );

      expect(res.status).toBe(503);
      await expect(res.json()).resolves.toEqual({ ok: false });
    } finally {
      error.mockRestore();
    }
  });
});

describe("webhook runtime lifecycle", () => {
  const SECRET = "webhook-test-secret";
  const configDb = (queries?: string[]): Record<string, unknown> =>
    d1Stub({
      all: (sql, params) =>
        sql.includes("FROM settings") && params[0] === "github_webhook_secret" ? [{ value: SECRET }] : [],
      ...(queries ? { queries } : {}),
    });

  function webhookRequest(headers: Record<string, string>, body: string): never {
    return new Request("http://localhost/api/webhooks/github", { method: "POST", headers, body }) as never;
  }

  it("rejects an invalid signature with 401 and disposes the runtime once", async () => {
    resetRequestLayersCache();
    runtimeSpies.disposed = 0;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { tasks, ctx } = execCtx();
    try {
      const res = await workersEntry.fetch!(
        webhookRequest(
          { "x-hub-signature-256": "sha256=deadbeef", "x-github-delivery": "d-invalid", "x-github-event": "issues" },
          JSON.stringify({ action: "closed", issue: { node_id: "n1" } })
        ),
        workerEnv(configDb()) as never,
        ctx
      );

      expect(res.status).toBe(401);
      expect(tasks).toHaveLength(0);
      expect(runtimeSpies.disposed).toBe(1);
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it("accepts a valid delivery, processes it, and disposes the runtime once", async () => {
    resetRequestLayersCache();
    runtimeSpies.disposed = 0;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { tasks, ctx } = execCtx();
    const queries: string[] = [];
    const body = JSON.stringify({ action: "closed", issue: { node_id: "n1" } });
    const signature = `sha256=${createHmac("sha256", SECRET).update(Buffer.from(body)).digest("hex")}`;
    try {
      const res = await workersEntry.fetch!(
        webhookRequest(
          {
            "content-type": "application/json",
            "x-hub-signature-256": signature,
            "x-github-delivery": "d-valid",
            "x-github-event": "issues",
          },
          body
        ),
        workerEnv(configDb(queries)) as never,
        ctx
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ ok: true });
      await Promise.all(tasks);
      // Delivery recorded only after processing succeeded (invariant #2).
      expect(queries.some((sql) => sql.includes("INSERT OR IGNORE INTO webhook_events"))).toBe(true);
      expect(runtimeSpies.disposed).toBe(1);
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });
});
