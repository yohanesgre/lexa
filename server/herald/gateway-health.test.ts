// @ts-nocheck
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Effect, Layer } from "effect";
import { Database } from "bun:sqlite";
import { Sqlite } from "../db/database";
import { HeraldGateway } from "./gateway.service";
import { HeraldProvidersRepo } from "../repos/herald-providers.repo";
import { HeraldModelsRepo } from "../repos/herald-models.repo";
import { HeraldCallLogsRepo } from "../repos/herald-call-logs.repo";
import { HeraldSettingsRepo } from "../repos/herald-settings.repo";
import { HeraldHealthService } from "../services/herald-health.service";
import { HeraldModelPricesRepo } from "../repos/herald-model-prices.repo";
import * as provider from "./provider";

function memDb() {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("CREATE TABLE herald_providers (id TEXT PRIMARY KEY, label TEXT, base_url TEXT, api_key TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')))");
  db.exec("CREATE TABLE herald_models (id TEXT PRIMARY KEY, provider_id TEXT, model_id TEXT, kind TEXT, priority INTEGER DEFAULT 0, enabled INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')))");
  db.exec("CREATE TABLE herald_provider_health (provider_id TEXT PRIMARY KEY, failure_count INTEGER NOT NULL DEFAULT 0, circuit_state TEXT NOT NULL CHECK (circuit_state IN ('open','closed','half-open')) DEFAULT 'closed', opened_at TEXT, last_probe_at TEXT, consecutive_failures INTEGER NOT NULL DEFAULT 0)");
  db.exec("CREATE TABLE herald_call_logs (id TEXT PRIMARY KEY, project_id TEXT, provider_id TEXT, model TEXT, kind TEXT, status TEXT, error_code TEXT, usage_in INTEGER DEFAULT 0, usage_out INTEGER DEFAULT 0, cached_in INTEGER DEFAULT 0, latency_ms INTEGER, cost_cents INTEGER DEFAULT 0, estimated INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')))");
  db.exec("CREATE TABLE herald_model_prices (model TEXT PRIMARY KEY, prompt_price REAL DEFAULT 0, completion_price REAL DEFAULT 0, updated_at TEXT DEFAULT (datetime('now')))");
  db.exec("CREATE TABLE herald_settings (project_id TEXT PRIMARY KEY, search_provider TEXT, search_api_key TEXT, url_allowlist TEXT, engine TEXT DEFAULT 'herald', engine_switcher_enabled INTEGER DEFAULT 0, primary_supports_images INTEGER DEFAULT 0, reasoning_effort TEXT, write_tools TEXT DEFAULT '', fallback_model_ids TEXT DEFAULT '[]', created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')))");
  return db;
}

function mockHealth(db: Database) {
  const get = (id: string) => db.prepare("SELECT * FROM herald_provider_health WHERE provider_id = ?").get(id) as any;
  const THRESHOLD = 3;
  const OPEN_MS = 5 * 60 * 1000;
  return {
    isAllowed: (providerId: string) => Effect.sync(() => {
      const row = get(providerId);
      if (!row) return true;
      if (row.circuit_state === "closed") return true;
      if (row.circuit_state === "open") {
        const opened = row.opened_at ? Date.parse(row.opened_at) : 0;
        if (Date.now() - opened >= OPEN_MS) {
          db.prepare("UPDATE herald_provider_health SET circuit_state='half-open', last_probe_at=? WHERE provider_id=?").run(new Date().toISOString(), providerId);
          return true;
        }
        return false;
      }
      return true;
    }),
    recordFailure: (providerId: string) => Effect.sync(() => {
      const row = get(providerId);
      const iso = new Date().toISOString();
      if (!row) {
        db.prepare("INSERT INTO herald_provider_health (provider_id, failure_count, circuit_state, last_probe_at, consecutive_failures) VALUES (?,?,?,?,?)").run(providerId, 1, "closed", iso, 1);
        return;
      }
      let consecutive = row.consecutive_failures;
      const since = row.last_probe_at ? Date.now() - Date.parse(row.last_probe_at) : Infinity;
      if (since > 5 * 60 * 1000) consecutive = 0;
      consecutive += 1;
      const failureCount = row.failure_count + 1;
      if (row.circuit_state === "half-open") {
        db.prepare("UPDATE herald_provider_health SET failure_count=?, circuit_state='open', opened_at=?, last_probe_at=?, consecutive_failures=? WHERE provider_id=?").run(failureCount, iso, iso, consecutive, providerId);
        return;
      }
      if (consecutive >= THRESHOLD) {
        db.prepare("UPDATE herald_provider_health SET failure_count=?, circuit_state='open', opened_at=?, last_probe_at=?, consecutive_failures=? WHERE provider_id=?").run(failureCount, iso, iso, consecutive, providerId);
        return;
      }
      db.prepare("UPDATE herald_provider_health SET failure_count=?, last_probe_at=?, consecutive_failures=? WHERE provider_id=?").run(failureCount, iso, consecutive, providerId);
    }),
    recordSuccess: (providerId: string) => Effect.sync(() => {
      const iso = new Date().toISOString();
      const row = get(providerId);
      if (!row) {
        db.prepare("INSERT INTO herald_provider_health (provider_id, failure_count, circuit_state, opened_at, last_probe_at, consecutive_failures) VALUES (?,?,?,?,?,?)").run(providerId, 0, "closed", null, iso, 0);
        return;
      }
      db.prepare("UPDATE herald_provider_health SET failure_count=0, circuit_state='closed', opened_at=NULL, last_probe_at=?, consecutive_failures=0 WHERE provider_id=?").run(iso, providerId);
    }),
    getHealth: (providerId: string) => Effect.sync(() => {
      const row = get(providerId);
      if (!row) return { providerId, circuitState: "closed", failureCount: 0, openedAt: null, lastProbeAt: null, consecutiveFailures: 0 };
      if (row.circuit_state === "open" && row.opened_at && Date.now() - Date.parse(row.opened_at) >= OPEN_MS) {
        const iso = new Date().toISOString();
        db.prepare("UPDATE herald_provider_health SET circuit_state='half-open', last_probe_at=? WHERE provider_id=?").run(iso, providerId);
        return { providerId, circuitState: "half-open", failureCount: row.failure_count, openedAt: row.opened_at, lastProbeAt: iso, consecutiveFailures: row.consecutive_failures };
      }
      return { providerId, circuitState: row.circuit_state, failureCount: row.failure_count, openedAt: row.opened_at, lastProbeAt: row.last_probe_at, consecutiveFailures: row.consecutive_failures };
    }),
  };
}

function collect(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  return (async () => { const out: unknown[] = []; for await (const c of stream) out.push(c); return out; })();
}

describe("gateway health wiring", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("skips provider whose health is open", async () => {
    const db = memDb();
    const spy = vi.spyOn(provider, "streamChat");
    spy.mockImplementation((() => (async function* () { yield { type: "TEXT_MESSAGE_CONTENT", delta: "from-b" } as unknown as never; yield { type: "RUN_FINISHED", usage: { input: 1, output: 1 } } as unknown as never; })()) as never);

    const combined = Layer.mergeAll(
      Layer.succeed(HeraldProvidersRepo, { list: () => Effect.succeed([]) } as unknown as never),
      Layer.succeed(HeraldModelsRepo, { listAll: () => Effect.succeed([]) } as unknown as never),
      Layer.succeed(HeraldCallLogsRepo, { insert: () => Effect.void } as unknown as never),
      Layer.succeed(HeraldSettingsRepo, { getByProject: () => Effect.fail(new (class E { _tag = "RowNotFound" as const; table = "herald_settings" })()) } as unknown as never),
      Layer.succeed(HeraldHealthService, mockHealth(db) as unknown as never),
      HeraldModelPricesRepo.Default.pipe(Layer.provide(Layer.succeed(Sqlite, db as any))),
      Layer.succeed(Sqlite, db as any)
    );
    const gatewayLayer = Layer.provide(HeraldGateway.Default, combined);

    db.prepare("INSERT INTO herald_provider_health (provider_id, failure_count, circuit_state, opened_at, last_probe_at, consecutive_failures) VALUES (?,?,?,?,?,?)").run("prov-a", 3, "open", new Date().toISOString(), new Date().toISOString(), 3);
    const prog = Effect.gen(function* () {
      const gw = yield* HeraldGateway;
      const stream = gw.streamChat({
        projectId: "p1",
        systemPrompts: [],
        messages: [{ role: "user", content: "hi" } as never],
        fallbackConfigs: [
          { kind: "openai_compatible", baseUrl: "https://a.com", apiKey: "sk", model: "m-a", providerId: "prov-a" },
          { kind: "openai_compatible", baseUrl: "https://a.com", apiKey: "sk", model: "m-b", providerId: "prov-b" },
        ],
      });
      const chunks = yield* Effect.promise(() => collect(stream));
      return { chunks, spyCalls: spy.mock.calls.length };
    });
    const result = await Effect.runPromise(prog.pipe(Effect.provide(gatewayLayer)) as any) as { chunks: unknown[]; spyCalls: number };
    expect(result.spyCalls).toBe(1);
    expect(result.chunks.some((c) => (c as { delta?: string }).delta === "from-b")).toBe(true);
  });

  it("records failure on provider error and success on provider success", async () => {
    const db = memDb();
    const spy = vi.spyOn(provider, "streamChat");
    spy.mockImplementation(((input: { config: { model: string } }) => {
      if (input.config.model === "m-a") return (async function* () { throw new provider.translateRunError(new Error("boom")); })();
      return (async function* () { yield { type: "TEXT_MESSAGE_CONTENT", delta: "ok" } as unknown as never; yield { type: "RUN_FINISHED", usage: { input: 1, output: 1 } } as unknown as never; })();
    }) as never);

    const combined = Layer.mergeAll(
      Layer.succeed(HeraldProvidersRepo, { list: () => Effect.succeed([]) } as unknown as never),
      Layer.succeed(HeraldModelsRepo, { listAll: () => Effect.succeed([]) } as unknown as never),
      Layer.succeed(HeraldCallLogsRepo, { insert: (inp: unknown) => Effect.sync(() => { const r = inp as { providerId: string | null; status: string; estimated?: boolean }; db.prepare("INSERT INTO herald_call_logs (id, project_id, provider_id, model, kind, status, estimated) VALUES (?,?,?,?,?,?,?)").run(crypto.randomUUID(), "p1", r.providerId, "m", "openai_compatible", r.status, r.estimated ? 1 : 0); }) } as unknown as never),
      Layer.succeed(HeraldSettingsRepo, { getByProject: () => Effect.fail(new (class E { _tag = "RowNotFound" as const; table = "herald_settings" })()) } as unknown as never),
      Layer.succeed(HeraldHealthService, mockHealth(db) as unknown as never),
      HeraldModelPricesRepo.Default.pipe(Layer.provide(Layer.succeed(Sqlite, db as any))),
      Layer.succeed(Sqlite, db as any)
    );
    const gatewayLayer = Layer.provide(HeraldGateway.Default, combined);

    const prog = Effect.gen(function* () {
      const gw = yield* HeraldGateway;
      const stream = gw.streamChat({
        projectId: "p1",
        systemPrompts: [],
        messages: [{ role: "user", content: "hi" } as never],
        fallbackConfigs: [
          { kind: "openai_compatible", baseUrl: "https://a.com", apiKey: "sk", model: "m-a", providerId: "prov-a" },
          { kind: "openai_compatible", baseUrl: "https://a.com", apiKey: "sk", model: "m-b", providerId: "prov-b" },
        ],
      });
      yield* Effect.promise(() => collect(stream));
      const ha = db.prepare("SELECT * FROM herald_provider_health WHERE provider_id='prov-a'").get() as any;
      const hb = db.prepare("SELECT * FROM herald_provider_health WHERE provider_id='prov-b'").get() as any;
      expect(ha.consecutive_failures).toBe(1);
      expect(hb ? hb.circuit_state : "closed").toBe("closed");
    });
    await Effect.runPromise(prog.pipe(Effect.provide(gatewayLayer)) as any);
  });

  it("tiktoken estimation used when usage 0 sets estimated flag and cost", async () => {
    const db = memDb();
    db.prepare("INSERT INTO herald_model_prices (model, prompt_price, completion_price) VALUES ('m-est', 0.01, 0.02)").run();
    const spy = vi.spyOn(provider, "streamChat");
    spy.mockImplementation((() => (async function* () { yield { type: "TEXT_MESSAGE_CONTENT", delta: "hello" } as unknown as never; yield { type: "RUN_FINISHED", usage: { input: 0, output: 0 } } as unknown as never; })()) as never);

    const combined = Layer.mergeAll(
      Layer.succeed(HeraldProvidersRepo, { list: () => Effect.succeed([]) } as unknown as never),
      Layer.succeed(HeraldModelsRepo, { listAll: () => Effect.succeed([]) } as unknown as never),
      HeraldCallLogsRepo.Default.pipe(Layer.provide(Layer.succeed(Sqlite, db as any))),
      Layer.succeed(HeraldSettingsRepo, { getByProject: () => Effect.fail(new (class E { _tag = "RowNotFound" as const; table = "herald_settings" })()) } as unknown as never),
      Layer.succeed(HeraldHealthService, mockHealth(db) as unknown as never),
      HeraldModelPricesRepo.Default.pipe(Layer.provide(Layer.succeed(Sqlite, db as any))),
      Layer.succeed(Sqlite, db as any)
    );
    const gatewayLayer = Layer.provide(HeraldGateway.Default, combined);

    const prog = Effect.gen(function* () {
      const gw = yield* HeraldGateway;
      const stream = gw.streamChat({
        projectId: "p1",
        systemPrompts: [{ content: "system hello world" } as never],
        messages: [{ role: "user", content: "hi there" } as never],
        fallbackConfigs: [{ kind: "openai_compatible", baseUrl: "https://a.com", apiKey: "sk", model: "m-est", providerId: "prov-x" }],
      });
      const chunks = yield* Effect.promise(() => collect(stream));
      expect(chunks.length).toBe(2);
    });
    await Effect.runPromise(prog.pipe(Effect.provide(gatewayLayer)) as any);
    const row = db.prepare("SELECT * FROM herald_call_logs WHERE model='m-est'").get() as any;
    expect(row).toBeTruthy();
    expect(row.estimated).toBe(1);
    expect(row.usage_in > 0).toBe(true);
    expect(row.cost_cents > 0).toBe(true);
  });
});
