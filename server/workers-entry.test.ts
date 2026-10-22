// Handler-level and unit tests for the Cloudflare Workers entry (merged from
// workers-entry.integration.test.ts). One shared `effect` dispose counter keeps
// the ManagedRuntime.make teardown assertions in scope for every case.
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { Database } from "bun:sqlite";
import workersEntry from "./workers-entry";
import { createBunSqliteDriver } from "./db/drivers/bun-sqlite";
import { batch } from "./db/db";
import { runMigrations } from "./db/migrate";
import { getEnvFromWorkers } from "./env";
import { LexaChatSupervisor } from "./assistant/chat-supervisor";
import { fetchSharedTreeServer } from "../app/lib/share.server";
import { extractSnippet, shareHeadMeta, type SharedTree } from "../app/lib/share";
import {
  getRuntimeAuth,
  injectEntryScript,
  requestLayers,
  resetAuthCache,
  resetRequestLayersCache,
  runScheduledCore,
  type WorkersEnv,
} from "./workers-entry";

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
  it("prunes stale rows and R2 backups past retention, and skips R2 when disabled", async () => {
    const driver = memDriver();
    await Effect.runPromise(
      batch(driver, [
        { sql: "CREATE TABLE webhook_events (delivery_id TEXT PRIMARY KEY, received_at TEXT)", params: [] },
        { sql: "CREATE TABLE device_login_requests (id TEXT PRIMARY KEY, expires_at TEXT)", params: [] },
        { sql: "CREATE TABLE runtime_events (id TEXT PRIMARY KEY, status TEXT, finished_at TEXT)", params: [] },
        { sql: "INSERT INTO webhook_events (delivery_id, received_at) VALUES ('old', datetime('now', '-8 days'))", params: [] },
        { sql: "INSERT INTO webhook_events (delivery_id, received_at) VALUES ('new', datetime('now'))", params: [] },
        { sql: "INSERT INTO device_login_requests (id, expires_at) VALUES ('expired', datetime('now', '-1 minute'))", params: [] },
        { sql: "INSERT INTO device_login_requests (id, expires_at) VALUES ('live', datetime('now', '+10 minutes'))", params: [] },
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
    const remaining = await Effect.runPromise(
      Effect.gen(function* () {
        const { queryAll } = yield* Effect.promise(() => import("./db/db"));
        const w = yield* queryAll<{ delivery_id: string }>(driver, "SELECT delivery_id FROM webhook_events");
        const d = yield* queryAll<{ id: string }>(driver, "SELECT id FROM device_login_requests");
        return { webhooks: w.map((x) => x.delivery_id).sort(), devices: d.map((x) => x.id).sort() };
      })
    );
    expect(remaining).toEqual({ webhooks: ["new"], devices: ["live"] });
    expect(r2.deleted.sort()).toEqual(["backups/lexa-2026-09-01-00-00-00.db.gz"]);

    const disabled = fakeR2(["backups/lexa-old.db.gz"]);
    await runScheduledCore(driver, {}, disabled.binding as never);
    expect(disabled.deleted).toEqual([]);
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
function sqliteD1Binding(db: Database): Record<string, unknown> {
  return {
    prepare(sql: string) {
      let params: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) {
          params = values;
          return statement;
        },
        async all<T>() {
          return { results: db.prepare(sql).all(...params) as T[] };
        },
        async first<T>() {
          return (db.prepare(sql).get(...params) as T | undefined) ?? null;
        },
        async run() {
          const result = db.prepare(sql).run(...params);
          return { success: true, meta: { changes: result.changes } };
        },
      };
      return statement;
    },
  };
}

function workerEnv(db: Record<string, unknown>): WorkersEnv {
  return {
    DB: db as never,
    LXK_ENV: "dev",
    LXK_PUBLIC_URL: "http://localhost:5173",
    LXK_SECRETS_MASTER_KEY: Buffer.from("workers-entry-test-master-key-0000").toString("base64"),
  };
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

  it("caches request layers + runtime auth per fingerprint and rebuilds on reset or fingerprint change", () => {
    resetRequestLayersCache();
    const first = requestLayers(env());
    expect(requestLayers(env())).toBe(first);
    expect(requestLayers(env()).driver).toBe(first.driver);
    resetRequestLayersCache();
    expect(requestLayers(env())).not.toBe(first);

    resetRequestLayersCache();
    const base = requestLayers(env());
    expect(requestLayers({ ...env(), LXK_ENV: "prod" })).not.toBe(base);
    resetRequestLayersCache();
    const devBase = requestLayers(env());
    expect(requestLayers({ ...env(), LXK_PUBLIC_URL: "https://lexa.test" })).not.toBe(devBase);

    resetAuthCache();
    const runtimeEnv = getEnvFromWorkers(env() as unknown as Record<string, unknown>);
    const runtimeAuth = getRuntimeAuth(runtimeEnv);
    expect(getRuntimeAuth(runtimeEnv)).toBe(runtimeAuth);
    expect(getRuntimeAuth({ ...runtimeEnv, LXK_ENV: "prod" })).not.toBe(runtimeAuth);
  });
});

describe("pre-boot health", () => {
  it("serves /health and the /api/health deep check without running the boot sync chain, 503 on failure", async () => {
    resetRequestLayersCache();
    const queries: string[] = [];
    const health = await workersEntry.fetch!(
      new Request("http://localhost/health") as never,
      workerEnv(d1Stub({ first: (sql) => (sql.includes("SELECT 1") ? { one: 1 } : null), queries })) as never,
      execCtx().ctx
    );
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({ ok: true, flavor: "workers" });
    // ensureBoot's first step is a D1 query, so any boot sync would appear here.
    expect(queries).toEqual([]);

    resetRequestLayersCache();
    const deepQueries: string[] = [];
    const deep = await workersEntry.fetch!(
      new Request("http://localhost/api/health") as never,
      workerEnv(d1Stub({ first: (sql) => (sql.includes("SELECT 1") ? { one: 1 } : null), queries: deepQueries })) as never,
      execCtx().ctx
    );
    expect(deep.status).toBe(200);
    await expect(deep.json()).resolves.toEqual({ ok: true });
    expect(deepQueries).toEqual(["SELECT 1 AS one"]);

    resetRequestLayersCache();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const down = await workersEntry.fetch!(
        new Request("http://localhost/api/health") as never,
        workerEnv(d1Stub({ first: () => { throw new Error("d1 down"); } })) as never,
        execCtx().ctx
      );
      expect(down.status).toBe(503);
      await expect(down.json()).resolves.toEqual({ ok: false });
    } finally {
      error.mockRestore();
    }
  });
});

// The webhook secret resolves from the legacy plaintext settings row; the same
// row also seeds the module-scope GitHub config holder during ensureBoot.
const SECRET = "workers-entry-test-secret";
const settingsAll = (sql: string, params: unknown[]): Array<Record<string, unknown>> =>
  sql.includes("FROM settings") && params[0] === "github_webhook_secret" ? [{ value: SECRET }] : [];
const configDb = (queries?: string[], documentFormat = "markdown-v1"): Record<string, unknown> =>
  d1Stub({
    all: settingsAll,
    first: (sql, params) => sql.includes("FROM settings") && params[0] === "documents.format" ? { value: documentFormat } : null,
    ...(queries ? { queries } : {}),
  });

function webhookRequest(headers: Record<string, string>, body: string): never {
  return new Request("http://localhost/api/webhooks/github", { method: "POST", headers, body }) as never;
}

const issuePayload = (nodeId: string): string => JSON.stringify({ action: "closed", issue: { node_id: nodeId } });
const sign = (body: string): string => `sha256=${createHmac("sha256", SECRET).update(Buffer.from(body)).digest("hex")}`;

describe("webhook handler", () => {
  it("rejects an invalid HMAC signature and a body/signature byte mismatch with 401, scheduling nothing", async () => {
    resetRequestLayersCache();
    runtimeSpies.disposed = 0;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { tasks, ctx } = execCtx();
      const invalid = await workersEntry.fetch!(
        webhookRequest({ "x-hub-signature-256": "sha256=deadbeef", "x-github-delivery": "d-invalid", "x-github-event": "issues" }, issuePayload("n-invalid")),
        workerEnv(configDb(undefined, "migrating")) as never,
        ctx
      );
      expect(invalid.status).toBe(401);
      await expect(invalid.json()).resolves.toEqual({ error: { code: "GITHUB_WEBHOOK_ERROR", message: "Invalid signature" } });
      expect(tasks).toHaveLength(0);
      expect(runtimeSpies.disposed).toBe(1);

      const { tasks: tamperTasks, ctx: tamperCtx } = execCtx();
      const signedBody = issuePayload("n-signed");
      const tamperedBody = issuePayload("n-tampered");
      expect(tamperedBody).not.toBe(signedBody);
      const tampered = await workersEntry.fetch!(
        webhookRequest({ "x-hub-signature-256": sign(signedBody), "x-github-delivery": "d-tampered", "x-github-event": "issues" }, tamperedBody),
        workerEnv(configDb()) as never,
        tamperCtx
      );
      expect(tampered.status).toBe(401);
      expect(tamperTasks).toHaveLength(0);
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });
  it("does not acknowledge or schedule a valid delivery while document format is migrating", async () => {
    resetRequestLayersCache();
    const { tasks, ctx } = execCtx();
    const queries: string[] = [];
    const body = issuePayload("n-maintenance");
    const res = await workersEntry.fetch!(
      webhookRequest({ "x-hub-signature-256": sign(body), "x-github-delivery": "d-maintenance", "x-github-event": "issues" }, body),
      workerEnv(configDb(queries, "migrating")) as never,
      ctx
    );
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: { code: "INTERNAL", message: "Internal error" } });
    expect(tasks).toHaveLength(0);
    expect(queries.some((sql) => sql.includes("INSERT OR IGNORE INTO webhook_events"))).toBe(false);
  });

  it("acks a valid HMAC delivery 200, processes it in waitUntil, and records the delivery only after success", async () => {
    resetRequestLayersCache();
    runtimeSpies.disposed = 0;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { tasks, ctx } = execCtx();
    const queries: string[] = [];
    const body = issuePayload("n-valid");
    try {
      const res = await workersEntry.fetch!(
        webhookRequest({ "x-hub-signature-256": sign(body), "x-github-delivery": "d-valid", "x-github-event": "issues" }, body),
        workerEnv(configDb(queries)) as never,
        ctx
      );
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ ok: true });
      expect(tasks).toHaveLength(1);
      await Promise.all(tasks);
      const insertIdx = queries.findIndex((sql) => sql.includes("INSERT OR IGNORE INTO webhook_events"));
      expect(insertIdx).toBeGreaterThan(-1);
      // The seen-pre-check precedes the record write (delivery never recorded
      // before processing begins).
      const precheckIdx = queries.findIndex((sql) => sql.includes("FROM webhook_events") && sql.includes("delivery_id"));
      expect(precheckIdx).toBeGreaterThan(-1);
      expect(precheckIdx).toBeLessThan(insertIdx);
      expect(runtimeSpies.disposed).toBe(1);
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it("does not record the delivery when processing fails (INSERT only after success)", async () => {
    resetRequestLayersCache();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { tasks, ctx } = execCtx();
    const queries: string[] = [];
    const body = issuePayload("n-fail");
    const db = d1Stub({
      all: settingsAll,
      queries,
      first: (sql, params) => {
        if (sql.includes("FROM settings") && params[0] === "documents.format") return { value: "markdown-v1" };
        if (sql.includes("FROM tasks")) throw new Error("task lookup boom");
        return null;
      },
    });
    try {
      const res = await workersEntry.fetch!(
        webhookRequest({ "x-hub-signature-256": sign(body), "x-github-delivery": "d-fail", "x-github-event": "issues" }, body),
        workerEnv(db) as never,
        ctx
      );
      // Ack still 200: processing is background, and a mid-processing failure
      // must leave the delivery unrecorded so GitHub retries.
      expect(res.status).toBe(200);
      expect(tasks).toHaveLength(1);
      await Promise.all(tasks);
      expect(queries.some((sql) => sql.includes("INSERT OR IGNORE INTO webhook_events"))).toBe(false);
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });
});
describe("chat supervisor readiness", () => {
  it("blocks during migration, then handles malformed payload normally after readiness", async () => {
    const db = new Database(":memory:");
    try {
      db.exec(`
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE assistant_threads (document_id TEXT PRIMARY KEY);
        CREATE TABLE tasks (id TEXT PRIMARY KEY, description TEXT NOT NULL);
      `);
      db.prepare("INSERT INTO settings (key, value) VALUES ('documents.format', 'migrating-markdown-v1')").run();
      const supervisor = new LexaChatSupervisor(
        { waitUntil: () => {} },
        { DB: sqliteD1Binding(db) as never }
      );
      const request = () => supervisor.fetch(new Request("https://chat-supervisor/run", {
        method: "POST",
        body: "not-json",
      }));

      const blocked = await request();
      expect(blocked.status).toBe(500);
      await expect(blocked.json()).resolves.toEqual({ error: { code: "INTERNAL", message: "Internal error" } });

      db.prepare("UPDATE settings SET value = 'markdown-v1' WHERE key = 'documents.format'").run();
      const ready = await request();
      expect(ready.status).toBe(400);
      await expect(ready.json()).resolves.toMatchObject({ error: { code: "INVALID_ARGS" } });
      expect(db.prepare("SELECT COUNT(*) AS count FROM assistant_threads").get()).toEqual({ count: 0 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM tasks").get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });
});

// Carried from the absorbed server/share-ssr.test.ts.
// A full handler-level render test (calling the TanStack Start handler) cannot
// run under vitest: @tanstack/react-start/server pulls Vite-virtual modules
// (#tanstack-router-entry etc.) that only exist inside the vite build — see
// server/workers-shims/start-server.ts. This file is the layered equivalent:
// the D1/SQLite share lookup, the server-rendered head meta, and the Workers
// per-response HTML patch. The Bun serving gate (non-share → shell, /share/*
// → SSR) is covered by the W3 smoke against a built server, since
// server/entry.ts boots a Bun.serve at import time and is not importable here.
const ROOT_DOC = "hello share";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "lexa-share-ssr-"));
  const dbPath = join(dir, "lexa.db");
  runMigrations(dbPath);
  const db = new Database(dbPath);
  db.exec("PRAGMA foreign_keys = OFF");
  db.prepare("INSERT INTO users (id, email, name) VALUES ('u1','u1@test.dev','User One')").run();
  db.prepare("INSERT INTO projects (id, name, slug) VALUES ('p1','P','p1')").run();
  db.prepare(
    `INSERT INTO wiki_pages (id, project_id, title, slug, content, content_text, parent_id, position) VALUES
       ('w-root','p1','Root Page','home',?,'hello share',NULL,0),
       ('w-child','p1','Child Page','child',?,'','w-root',0)`
  ).run(ROOT_DOC, "");
  db.prepare("INSERT INTO wiki_share_links (id, page_id, token, expires_at, created_by) VALUES ('l1','w-root','tok-live',NULL,'u1')").run();
  db.prepare("INSERT INTO wiki_share_links (id, page_id, token, expires_at, created_by) VALUES ('l2','w-root','tok-expired','2000-01-01T00:00:00.000Z','u1')").run();
  db.close();
  // fetchSharedTreeServer builds its runtime lazily on first call, from this env.
  process.env.DATABASE_PATH = dbPath;
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("share SSR data (fetchSharedTreeServer)", () => {
  it("resolves a live token to the shared subtree and returns null for expired/unknown tokens", async () => {
    const tree = await fetchSharedTreeServer("tok-live");
    expect(tree?.root.title).toBe("Root Page");
    expect(tree?.root.slug).toBe("home");
    expect(tree?.root.children.map((c) => c.title)).toEqual(["Child Page"]);
    expect(await fetchSharedTreeServer("tok-expired")).toBeNull();
    expect(await fetchSharedTreeServer("nope")).toBeNull();
  });
});

describe("share head meta (server-rendered OG)", () => {
  it("emits title + description + og tags + robots, falls back for null, and truncates snippets at 160", () => {
    const tree: SharedTree = {
      root: {
        id: "w1",
        title: "API Reference",
        slug: "home",
        content: ROOT_DOC,
        updatedAt: "2026-08-21T10:00:00.000Z",
        children: [],
      },
    };
    const meta = shareHeadMeta(tree);
    expect(meta).toContainEqual({ title: "API Reference" });
    expect(meta).toContainEqual({ name: "description", content: "hello share" });
    expect(meta).toContainEqual({ property: "og:title", content: "API Reference" });
    expect(meta).toContainEqual({ property: "og:description", content: "hello share" });
    expect(meta).toContainEqual({ name: "robots", content: "noindex" });

    const fallback = shareHeadMeta(null);
    expect(fallback).toContainEqual({ title: "Lexa shared page" });
    expect(fallback).toContainEqual({ property: "og:description", content: "Shared via Lexa" });

    const long = "x".repeat(200);
    const longTree: SharedTree = {
      root: {
        id: "w1", title: "T", slug: "t",
        content: long,
        updatedAt: "2026-08-21T10:00:00.000Z", children: [],
      },
    };
    expect(extractSnippet(longTree)).toBe(`${long.slice(0, 157)}...`);
    const emptyTree: SharedTree = {
      root: { id: "w2", title: "E", slug: "e", content: "", updatedAt: "2026-08-21T10:00:00.000Z", children: [] },
    };
    expect(extractSnippet(emptyTree)).toBeNull();
    expect(extractSnippet(null)).toBeNull();
  });
});

describe("workers per-response SSR patch", () => {
  it("patches each HTML document independently and leaves an already-module document unchanged", () => {
    const a = '<html><body><script>self.__TSR={src:"/assets/index-AAA.js"}</script></body></html>';
    const b = '<html><body><script>self.__TSR={src:"/assets/index-BBB.js"}</script></body></html>';
    const pa = injectEntryScript(a);
    const pb = injectEntryScript(b);
    expect(pa).toContain('src="/assets/index-AAA.js"');
    expect(pb).toContain('src="/assets/index-BBB.js"');
    expect(pa).not.toEqual(pb);
    // Re-patching A after B still yields A's document — nothing cached globally.
    expect(injectEntryScript(a)).toEqual(pa);
    const withModule = '<html><head><script type="module" src="/assets/index-AAA.js"></script></head></html>';
    expect(injectEntryScript(withModule)).toBe(withModule);
  });
});
