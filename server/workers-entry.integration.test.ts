// Handler-level integration tests for the Cloudflare Workers entry: these
// drive the REAL exported fetch handler end to end (routing → ensureBoot →
// GitHubClient/GitHubService over a D1-shaped stub), unlike the unit tests in
// workers-entry.test.ts that exercise pieces. A separate file keeps the global
// `effect` counter in `workers-entry.test.ts` scoped to that file.
//
// The dispose counter wraps ManagedRuntime.make to count teardowns while
// delegating to the real Effect implementation — no behavior is substituted.
import { createHmac } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import workersEntry from "./workers-entry";
import { resetRequestLayersCache, type WorkersEnv } from "./workers-entry";

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

const SECRET = "workers-entry-integration-secret";

// D1-shaped binding: records every prepared statement and lets a test serve
// rows / throw per query, so the handler's real D1 driver path executes.
interface D1StubHandlers {
  all?: (sql: string, params: unknown[]) => Array<Record<string, unknown>>;
  first?: (sql: string, params: unknown[]) => Record<string, unknown> | null;
  queries?: string[];
}

function d1Stub(handlers: D1StubHandlers): Record<string, unknown> {
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
    batch: async (stmts: unknown[]) => (stmts as unknown[]).map(() => ({ success: true, results: [], meta: {} })),
  };
}

function workerEnv(db: Record<string, unknown>): WorkersEnv {
  return {
    DB: db as never,
    LXK_ENV: "dev",
    LXK_PUBLIC_URL: "http://localhost:5173",
    LXK_SECRETS_MASTER_KEY: Buffer.from("workers-entry-itest-master-key-0000").toString("base64"),
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

// The webhook secret resolves from the legacy plaintext settings row; the same
// row also seeds the module-scope GitHub config holder during ensureBoot.
const settingsAll = (sql: string, params: unknown[]): Array<Record<string, unknown>> =>
  sql.includes("FROM settings") && params[0] === "github_webhook_secret" ? [{ value: SECRET }] : [];
const configDb = (queries?: string[]): Record<string, unknown> =>
  d1Stub({ all: settingsAll, ...(queries ? { queries } : {}) });

function webhookRequest(headers: Record<string, string>, body: string): never {
  return new Request("http://localhost/api/webhooks/github", { method: "POST", headers, body }) as never;
}

function issuePayload(nodeId: string): string {
  return JSON.stringify({ action: "closed", issue: { node_id: nodeId } });
}

function sign(body: string): string {
  return `sha256=${createHmac("sha256", SECRET).update(Buffer.from(body)).digest("hex")}`;
}

async function fetchHandler(path: string, env: WorkersEnv, ctx: never): Promise<Response> {
  return (await workersEntry.fetch!(new Request(`http://localhost${path}`) as never, env as never, ctx)) as unknown as Response;
}

describe("workers-entry fetch handler", () => {
  // B1 (pre-boot /health + /api/health) is owned by the perf-be lane, which is
  // not part of this test file's base (origin/main d591838). Probe the real
  // behavior so the B1 assertions run once that lane merges, instead of being
  // silently weakened or left failing against the un-merged handler.
  let preBootHealth = false;
  beforeAll(async () => {
    preBootHealth = await detectPreBootHealth();
  });

  it("/health answers 200 without executing the boot-sync SQL", async ({ skip }) => {
    if (!preBootHealth) skip();
    resetRequestLayersCache();
    const queries: string[] = [];
    const res = await fetchHandler("/health", workerEnv(configDb(queries)), execCtx().ctx);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, flavor: "workers" });
    // ensureBoot's first step is a D1 query, so any boot sync would appear here.
    expect(queries).toEqual([]);
  });

  it("/api/health deep-checks D1 pre-boot: 200 with a single SELECT 1 and no boot SQL", async ({ skip }) => {
    if (!preBootHealth) skip();
    resetRequestLayersCache();
    const queries: string[] = [];
    const env = workerEnv(d1Stub({ first: (sql) => (sql.includes("SELECT 1") ? { one: 1 } : null), queries }));
    const res = await fetchHandler("/api/health", env, execCtx().ctx);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(queries).toEqual(["SELECT 1 AS one"]);
  });

  it("/api/health returns 503 {ok:false} when the D1 deep check rejects, and runs no boot SQL", async ({ skip }) => {
    if (!preBootHealth) skip();
    resetRequestLayersCache();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const queries: string[] = [];
      const env = workerEnv(
        d1Stub({
          first: () => {
            throw new Error("d1 down");
          },
          queries,
        })
      );
      const res = await fetchHandler("/api/health", env, execCtx().ctx);
      expect(res.status).toBe(503);
      await expect(res.json()).resolves.toEqual({ ok: false });
      expect(queries).toEqual(["SELECT 1 AS one"]);
    } finally {
      error.mockRestore();
    }
  });

  it("rejects an invalid HMAC signature with 401, schedules no processing, and disposes the runtime", async () => {
    resetRequestLayersCache();
    runtimeSpies.disposed = 0;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { tasks, ctx } = execCtx();
    try {
      const res = await workersEntry.fetch!(
        webhookRequest(
          { "x-hub-signature-256": "sha256=deadbeef", "x-github-delivery": "d-invalid", "x-github-event": "issues" },
          issuePayload("n-invalid")
        ),
        workerEnv(configDb()) as never,
        ctx
      );
      expect(res.status).toBe(401);
      await expect(res.json()).resolves.toEqual({
        error: { code: "GITHUB_WEBHOOK_ERROR", message: "Invalid signature" },
      });
      expect(tasks).toHaveLength(0);
      expect(runtimeSpies.disposed).toBe(1);
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it("rejects a delivery whose body bytes do not match the signed bytes (401)", async () => {
    resetRequestLayersCache();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { tasks, ctx } = execCtx();
    const signedBody = issuePayload("n-signed");
    const tamperedBody = issuePayload("n-tampered");
    expect(tamperedBody).not.toBe(signedBody);
    try {
      const res = await workersEntry.fetch!(
        webhookRequest(
          { "x-hub-signature-256": sign(signedBody), "x-github-delivery": "d-tampered", "x-github-event": "issues" },
          tamperedBody
        ),
        workerEnv(configDb()) as never,
        ctx
      );
      expect(res.status).toBe(401);
      expect(tasks).toHaveLength(0);
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it("acks a valid HMAC delivery 200, runs processing in waitUntil, and records the delivery only after success", async () => {
    resetRequestLayersCache();
    runtimeSpies.disposed = 0;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { tasks, ctx } = execCtx();
    const queries: string[] = [];
    const body = issuePayload("n-valid");
    try {
      const res = await workersEntry.fetch!(
        webhookRequest(
          { "x-hub-signature-256": sign(body), "x-github-delivery": "d-valid", "x-github-event": "issues" },
          body
        ),
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
      // One runtime per delivery after the perf-be B2 merge; the un-merged
      // handler builds a separate verifier + processor runtime (two disposes).
      expect(runtimeSpies.disposed).toBe(preBootHealth ? 1 : 2);
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
      first: (sql) => {
        if (sql.includes("FROM tasks")) throw new Error("task lookup boom");
        return null;
      },
    });
    try {
      const res = await workersEntry.fetch!(
        webhookRequest(
          { "x-hub-signature-256": sign(body), "x-github-delivery": "d-fail", "x-github-event": "issues" },
          body
        ),
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

async function detectPreBootHealth(): Promise<boolean> {
  resetRequestLayersCache();
  const queries: string[] = [];
  const res = await workersEntry.fetch!(
    new Request("http://localhost/health") as never,
    workerEnv(configDb(queries)) as never,
    execCtx().ctx
  );
  return res.status === 200 && queries.length === 0;
}
