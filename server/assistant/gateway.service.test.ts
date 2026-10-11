import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Effect, Layer } from "effect";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../db/migrate";
import { RuntimeEnvLive } from "../runtime-env";
import { seedProviderSecret } from "./test-secrets";
import { PROVIDER_KEY_UNDECRYPTABLE } from "../services/assistant-providers.service";
import type { RuntimeEnv } from "../env";
import { Sqlite } from "../db/database";
import { DbBunLive } from "../db/db";
import type { DbError } from "../db/db";
import { AssistantGateway } from "./gateway.service";
import { AssistantProvidersRepo } from "../repos/assistant-providers.repo";
import { AssistantModelsRepo } from "../repos/assistant-models.repo";
import { AssistantCallLogsRepo } from "../repos/assistant-call-logs.repo";
import { AssistantSettingsRepo } from "../repos/assistant-settings.repo";
import { AssistantHealthService } from "../services/assistant-health.service";
import { AssistantModelPricesRepo } from "../repos/assistant-model-prices.repo";
import * as provider from "./provider";
import { ProviderAuthFailed, ProviderNotConfigured, ProviderUnreachable } from "../api/errors";

function memDbLayer() {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  return Layer.mergeAll(Layer.succeed(Sqlite, db), DbBunLive(db));
}

function stubCallLog() {
  return Layer.succeed(AssistantCallLogsRepo, { insert: () => Effect.void, log: () => Effect.void } as unknown as never);
}
function stubProviders() {
  return Layer.succeed(AssistantProvidersRepo, {
    list: () => Effect.succeed([]),
    listAll: () => Effect.succeed([]),
    getById: () => Effect.fail(new (class E { _tag = "RowNotFound" as const; table = "assistant_providers" })()),
  } as unknown as never);
}
function stubModels() {
  return Layer.succeed(AssistantModelsRepo, {
    listAll: () => Effect.succeed([]),
    listByProvider: () => Effect.succeed([]),
  } as unknown as never);
}
function stubSettings() {
  return Layer.succeed(AssistantSettingsRepo, {
    getByProject: () => Effect.fail(new (class E { _tag = "RowNotFound" as const; table = "assistant_settings" })()),
    maskedView: () => Effect.fail(new (class E { _tag = "RowNotFound" as const; table = "assistant_settings" })()),
    upsert: () => Effect.succeed(null as never),
  } as unknown as never);
}

function collect(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  return (async () => {
    const out: unknown[] = [];
    for await (const c of stream) out.push(c);
    return out;
  })();
}

describe("AssistantGateway", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("cross-kind fallback: fail A succeed B yields B chunks", async () => {
    const spy = vi.spyOn(provider, "streamChat");
    spy.mockImplementation(((input: { config: { model: string } }) => {
      if (input.config.model === "model-a") {
        return (async function* () {
          throw new ProviderUnreachable({ message: "rate limited", status: 429 } as never);
        })();
      }
      return (async function* () {
        yield { type: "TEXT_MESSAGE_CONTENT", delta: "hello" } as unknown as never;
        yield { type: "RUN_FINISHED", usage: { input: 1, output: 2 } } as unknown as never;
      })();
    }) as never);

    const gatewayLayer = AssistantGateway.Default.pipe(
      Layer.provide(stubProviders()),
      Layer.provide(stubModels()),
      Layer.provide(stubCallLog()),
      Layer.provide(stubSettings()),
      Layer.provide(memDbLayer())
    );

    const program = Effect.gen(function* () {
      const gw = yield* AssistantGateway;
      const stream = gw.streamChat({
        projectId: "proj-1",
        systemPrompts: [],
        messages: [{ role: "user", content: "hi" } as never],
        fallbackConfigs: [
          { kind: "openai_compatible", baseUrl: "https://api.example.com", apiKey: "sk-a", model: "model-a" },
          { kind: "anthropic_compatible", baseUrl: "https://api.example.com", apiKey: "sk-a", model: "model-b" },
        ],
      });
      const chunks = yield* Effect.promise(() => collect(stream));
      return chunks;
    });

    const chunks = await Effect.runPromise(program.pipe(Effect.provide(gatewayLayer))) as unknown[];
    expect(chunks.some((c) => (c as { type?: string }).type === "TEXT_MESSAGE_CONTENT")).toBe(true);
    expect(chunks.some((c) => (c as { type?: string }).type === "RUN_FINISHED")).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("loop max 3: only first 3 configs tried", async () => {
    const spy = vi.spyOn(provider, "streamChat");
    spy.mockImplementation((() =>
      (async function* () {
        throw new ProviderUnreachable({});
      })()) as never);

    const gatewayLayer = AssistantGateway.Default.pipe(
      Layer.provide(stubProviders()),
      Layer.provide(stubModels()),
      Layer.provide(stubCallLog()),
      Layer.provide(stubSettings()),
      Layer.provide(memDbLayer())
    );

    const program = Effect.gen(function* () {
      const gw = yield* AssistantGateway;
      const stream = gw.streamChat({
        projectId: "proj-1",
        systemPrompts: [],
        messages: [{ role: "user", content: "hi" } as never],
        fallbackConfigs: [
          { kind: "openai_compatible", baseUrl: "https://a.com", apiKey: "sk", model: "m1" },
          { kind: "openai_compatible", baseUrl: "https://a.com", apiKey: "sk", model: "m2" },
          { kind: "openai_compatible", baseUrl: "https://a.com", apiKey: "sk", model: "m3" },
          { kind: "openai_compatible", baseUrl: "https://a.com", apiKey: "sk", model: "m4" },
        ],
      });
      yield* Effect.promise(() => collect(stream).catch(() => []));
      return spy.mock.calls.length;
    });

    const calls = await Effect.runPromise(program.pipe(Effect.provide(gatewayLayer))) as unknown as number;
    expect(calls).toBe(3);
  });

  it("continues on ProviderUnreachable/AssistantGenerationFailed, surfaces aggregated error", async () => {
    const spy = vi.spyOn(provider, "streamChat");
    spy.mockImplementation((() =>
      (async function* () {
        throw new ProviderUnreachable({ message: "unreachable", status: 503 } as never);
      })()) as never);

    const gatewayLayer = AssistantGateway.Default.pipe(
      Layer.provide(stubProviders()),
      Layer.provide(stubModels()),
      Layer.provide(stubCallLog()),
      Layer.provide(stubSettings()),
      Layer.provide(memDbLayer())
    );

    const program = Effect.gen(function* () {
      const gw = yield* AssistantGateway;
      const stream = gw.streamChat({
        projectId: "proj-1",
        systemPrompts: [],
        messages: [{ role: "user", content: "hi" } as never],
        fallbackConfigs: [
          { kind: "openai_compatible", baseUrl: "https://a.com", apiKey: "sk", model: "m1" },
          { kind: "openai_compatible", baseUrl: "https://a.com", apiKey: "sk", model: "m2" },
        ],
      });
      const result = yield* Effect.tryPromise({
        try: () => collect(stream),
        catch: (e) => e as unknown as Error,
      }).pipe(
        Effect.map(() => "no-throw" as string),
        Effect.catchAll((e) => Effect.succeed((e as unknown as { _tag: string })._tag ?? "unknown"))
      );
      return result;
    });

    const tag = await Effect.runPromise(program.pipe(Effect.provide(gatewayLayer))) as unknown as string;
    expect(tag).toBe("AssistantGenerationFailed");
  });

});

// Decrypt-before-adapter: the gateway registry rows carry no key, so the only
// way a provider config can hold a credential is through
// AssistantProvidersService.resolveApiKeyForRow. Real temp DB + migrations here
// so the repo/service/crypto path is exercised end to end.
describe("AssistantGateway provider secret resolution", () => {
  const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));
  const MASTER_KEY = Buffer.from("g".repeat(32)).toString("base64");
  const OTHER_KEY = Buffer.from("o".repeat(32)).toString("base64");
  let dir: string;
  let db: Database;

  afterEach(() => {
    try { db?.close(); } catch {}
    rmSync(dir, { recursive: true, force: true });
  });

  function setup() {
    dir = mkdtempSync(join(tmpdir(), "lexa-gateway-secret-"));
    const dbPath = join(dir, "test.db");
    runMigrations(dbPath, MIGRATIONS);
    db = new Database(dbPath);
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(`
      INSERT INTO projects (id, name, slug) VALUES ('p1', 'P', 'p1');
      INSERT INTO assistant_providers (id, label, base_url, api_key) VALUES
        ('pr1', 'P1', 'https://api-one.test', ''),
        ('pr2', 'P2', 'https://api-two.test', '');
      INSERT INTO assistant_models (id, provider_id, model_id, kind, priority, enabled) VALUES
        ('m1', 'pr1', 'gpt-x', 'openai_compatible', 0, 1),
        ('m2', 'pr2', 'gpt-y', 'openai_compatible', 1, 1);
    `);
  }

  function run<T>(program: Effect.Effect<T, ProviderAuthFailed | ProviderNotConfigured | DbError, AssistantGateway>, env: RuntimeEnv): Promise<T> {
    const layer = AssistantGateway.Default.pipe(Layer.provide(DbBunLive(db)));
    return Effect.runPromise(program.pipe(Effect.provide(layer), Effect.provide(RuntimeEnvLive(env))));
  }

  it("drops only the unopenable provider: a healthy provider still resolves", async () => {
    const env = { LXK_SECRETS_MASTER_KEY: MASTER_KEY } as RuntimeEnv;
    setup();
    // pr1 sealed under a key the running env does not have; pr2 openable.
    await seedProviderSecret(db, "pr1", "sk-lost-1111", OTHER_KEY);
    await seedProviderSecret(db, "pr2", "sk-live-2222", MASTER_KEY);

    const configs = await run(
      Effect.gen(function* () {
        const gw = yield* AssistantGateway;
        return yield* gw.resolveFallback("p1");
      }),
      env
    );
    expect(configs.map((c) => c.providerId)).toEqual(["pr2"]);
    expect(configs[0]).toMatchObject({ apiKey: "sk-live-2222" });
    // REAL (unstubbed) adapter construction proves the decrypted key is a
    // usable credential at the adapter boundary.
    expect(() => provider.buildAdapter(configs[0]!)).not.toThrow();
  });

  it("an all-unopenable chain — wrong key material or no keyring at all — fails with PROVIDER_KEY_UNDECRYPTABLE", async () => {
    setup();
    // Both rows sealed under a key the running env does not have.
    await seedProviderSecret(db, "pr1", "sk-lost-3333", OTHER_KEY);
    await seedProviderSecret(db, "pr2", "sk-lost-4444", OTHER_KEY);

    const withMasterKey = await run(
      Effect.gen(function* () {
        const gw = yield* AssistantGateway;
        return yield* Effect.either(gw.resolveFallback("p1"));
      }),
      { LXK_SECRETS_MASTER_KEY: MASTER_KEY } as RuntimeEnv
    );
    expect(withMasterKey).toMatchObject({
      _tag: "Left",
      left: expect.objectContaining({ _tag: "ProviderAuthFailed", message: PROVIDER_KEY_UNDECRYPTABLE }),
    });

    // No keyring configured: the same rows are unopenable and the chain fails
    // with the identical fixed message.
    const withNoKeyring = await run(
      Effect.gen(function* () {
        const gw = yield* AssistantGateway;
        return yield* Effect.either(gw.resolveFallback("p1"));
      }),
      {} as RuntimeEnv
    );
    expect(withNoKeyring).toMatchObject({
      _tag: "Left",
      left: expect.objectContaining({ _tag: "ProviderAuthFailed", message: PROVIDER_KEY_UNDECRYPTABLE }),
    });
  });

  it("resolves a real workers_ai model row and preserves its kind (keyless binding)", async () => {
    const env = {} as RuntimeEnv;
    setup();
    // A manually registered Cloudflare Workers AI model: no secret, empty base
    // URL — the gateway must surface kind `workers_ai` through normalization.
    db.exec(`
      INSERT INTO assistant_providers (id, label, base_url, api_key) VALUES ('pr-cf', 'CF', '', '');
      INSERT INTO assistant_models (id, provider_id, model_id, kind, priority, enabled) VALUES
        ('m-cf', 'pr-cf', '@cf/meta/llama-3.2-1b-instruct', 'workers_ai', 0, 1);
    `);

    const configs = await run(
      Effect.gen(function* () {
        const gw = yield* AssistantGateway;
        return yield* gw.resolveFallback("p1");
      }),
      env
    );
    expect(configs.find((c) => c.providerId === "pr-cf")).toMatchObject({
      kind: "workers_ai",
      baseUrl: "",
      apiKey: "",
      model: "@cf/meta/llama-3.2-1b-instruct",
    });
  });
});

// Carried from the absorbed `gateway-health.test.ts` (merge-absorb row →
// gateway.service.test.ts): the gateway wiring of the health gate, the
// usage-0 estimation path and cache-write pricing. The health state machine
// itself is covered by assistant-health.service.test.ts.
describe("AssistantGateway health + usage pricing wiring", () => {
  type Chunk = { type?: string; delta?: string };
  type CallLogRow = {
    estimated: number;
    usage_in: number;
    usage_out: number;
    cached_in: number;
    cached_write_in: number;
    cost_cents: number;
  };

  function memDb() {
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("CREATE TABLE assistant_providers (id TEXT PRIMARY KEY, label TEXT, base_url TEXT, api_key TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')))");
    db.exec("CREATE TABLE assistant_models (id TEXT PRIMARY KEY, provider_id TEXT, model_id TEXT, kind TEXT, priority INTEGER DEFAULT 0, enabled INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')))");
    db.exec("CREATE TABLE assistant_provider_health (provider_id TEXT PRIMARY KEY, failure_count INTEGER NOT NULL DEFAULT 0, circuit_state TEXT NOT NULL CHECK (circuit_state IN ('open','closed','half-open')) DEFAULT 'closed', opened_at TEXT, last_probe_at TEXT, consecutive_failures INTEGER NOT NULL DEFAULT 0)");
    db.exec("CREATE TABLE assistant_call_logs (id TEXT PRIMARY KEY, project_id TEXT, provider_id TEXT, thread_key TEXT, run_id TEXT, model TEXT, kind TEXT, status TEXT, purpose TEXT NOT NULL DEFAULT 'turn', error_code TEXT, usage_in INTEGER DEFAULT 0, usage_out INTEGER DEFAULT 0, cached_in INTEGER DEFAULT 0, cached_write_in INTEGER DEFAULT 0, latency_ms INTEGER, cost_cents INTEGER DEFAULT 0, estimated INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')))");
    db.exec("CREATE TABLE assistant_model_prices (model TEXT PRIMARY KEY, prompt_price REAL DEFAULT 0, completion_price REAL DEFAULT 0, cached_read_price REAL DEFAULT 0, cached_write_price REAL DEFAULT 0, updated_at TEXT DEFAULT (datetime('now')))");
    db.exec("CREATE TABLE assistant_settings (project_id TEXT PRIMARY KEY, search_provider TEXT, search_api_key TEXT, url_allowlist TEXT, primary_supports_images INTEGER DEFAULT 0, reasoning_effort TEXT, write_tools TEXT DEFAULT '', fallback_model_ids TEXT DEFAULT '[]', created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')))");
    return db;
  }

  type HealthRow = {
    provider_id: string;
    failure_count: number;
    circuit_state: "open" | "closed" | "half-open";
    opened_at: string | null;
    last_probe_at: string | null;
    consecutive_failures: number;
  };

  function mockHealth(db: Database) {
    const get = (id: string) =>
      db.prepare("SELECT * FROM assistant_provider_health WHERE provider_id = ?").get(id) as HealthRow | null;
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
            db.prepare("UPDATE assistant_provider_health SET circuit_state='half-open', last_probe_at=? WHERE provider_id=?").run(new Date().toISOString(), providerId);
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
          db.prepare("INSERT INTO assistant_provider_health (provider_id, failure_count, circuit_state, last_probe_at, consecutive_failures) VALUES (?,?,?,?,?)").run(providerId, 1, "closed", iso, 1);
          return;
        }
        let consecutive = row.consecutive_failures;
        const since = row.last_probe_at ? Date.now() - Date.parse(row.last_probe_at) : Infinity;
        if (since > 5 * 60 * 1000) consecutive = 0;
        consecutive += 1;
        const failureCount = row.failure_count + 1;
        if (row.circuit_state === "half-open" || consecutive >= THRESHOLD) {
          db.prepare("UPDATE assistant_provider_health SET failure_count=?, circuit_state='open', opened_at=?, last_probe_at=?, consecutive_failures=? WHERE provider_id=?").run(failureCount, iso, iso, consecutive, providerId);
          return;
        }
        db.prepare("UPDATE assistant_provider_health SET failure_count=?, last_probe_at=?, consecutive_failures=? WHERE provider_id=?").run(failureCount, iso, consecutive, providerId);
      }),
      recordSuccess: (providerId: string) => Effect.sync(() => {
        const iso = new Date().toISOString();
        const row = get(providerId);
        if (!row) {
          db.prepare("INSERT INTO assistant_provider_health (provider_id, failure_count, circuit_state, opened_at, last_probe_at, consecutive_failures) VALUES (?,?,?,?,?,?)").run(providerId, 0, "closed", null, iso, 0);
          return;
        }
        db.prepare("UPDATE assistant_provider_health SET failure_count=0, circuit_state='closed', opened_at=NULL, last_probe_at=?, consecutive_failures=0 WHERE provider_id=?").run(iso, providerId);
      }),
      getHealth: (providerId: string) => Effect.sync(() => {
        const row = get(providerId);
        if (!row) return { providerId, circuitState: "closed", failureCount: 0, openedAt: null, lastProbeAt: null, consecutiveFailures: 0 };
        if (row.circuit_state === "open" && row.opened_at && Date.now() - Date.parse(row.opened_at) >= OPEN_MS) {
          const iso = new Date().toISOString();
          db.prepare("UPDATE assistant_provider_health SET circuit_state='half-open', last_probe_at=? WHERE provider_id=?").run(iso, providerId);
          return { providerId, circuitState: "half-open", failureCount: row.failure_count, openedAt: row.opened_at, lastProbeAt: iso, consecutiveFailures: row.consecutive_failures };
        }
        return { providerId, circuitState: row.circuit_state, failureCount: row.failure_count, openedAt: row.opened_at, lastProbeAt: row.last_probe_at, consecutiveFailures: row.consecutive_failures };
      }),
    };
  }

  function buildGatewayLayer(db: Database, callLogs: Layer.Layer<AssistantCallLogsRepo>) {
    return AssistantGateway.Default.pipe(
      Layer.provide(Layer.succeed(AssistantProvidersRepo, { list: () => Effect.succeed([]) } as unknown as never)),
      Layer.provide(Layer.succeed(AssistantModelsRepo, { listAll: () => Effect.succeed([]) } as unknown as never)),
      Layer.provide(callLogs),
      Layer.provide(Layer.succeed(AssistantSettingsRepo, { getByProject: () => Effect.fail(new (class E { _tag = "RowNotFound" as const; table = "assistant_settings" })()) } as unknown as never)),
      Layer.provide(Layer.succeed(AssistantHealthService, mockHealth(db) as unknown as never)),
      Layer.provide(AssistantModelPricesRepo.Default.pipe(Layer.provide(Layer.mergeAll(Layer.succeed(Sqlite, db), DbBunLive(db))))),
      Layer.provide(Layer.mergeAll(Layer.succeed(Sqlite, db), DbBunLive(db)))
    );
  }

  it("wires the health gate, the usage-0 estimation path and cache-write pricing", async () => {
    // 1. Skips a provider whose health is open and falls through to the next.
    {
    const db = memDb();
    const spy = vi.spyOn(provider, "streamChat");
    spy.mockImplementation((() => (async function* () { yield { type: "TEXT_MESSAGE_CONTENT", delta: "from-b" } as unknown as never; yield { type: "RUN_FINISHED", usage: { input: 1, output: 1 } } as unknown as never; })()) as never);

    const gatewayLayer = buildGatewayLayer(db, Layer.succeed(AssistantCallLogsRepo, { insert: () => Effect.void } as unknown as never));

    db.prepare("INSERT INTO assistant_provider_health (provider_id, failure_count, circuit_state, opened_at, last_probe_at, consecutive_failures) VALUES (?,?,?,?,?,?)").run("prov-a", 3, "open", new Date().toISOString(), new Date().toISOString(), 3);
    const prog = Effect.gen(function* () {
      const gw = yield* AssistantGateway;
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
      return { chunks: chunks as Chunk[], spyCalls: spy.mock.calls.length };
    });
    const result = await Effect.runPromise(prog.pipe(Effect.provide(gatewayLayer)));
    expect(result.spyCalls).toBe(1);
    expect(result.chunks.some((c) => c.delta === "from-b")).toBe(true);
    }

    // 2. Estimates tokens when usage is 0, setting the estimated flag and a cost.
    {
    const db = memDb();
    db.prepare("INSERT INTO assistant_model_prices (model, prompt_price, completion_price, cached_read_price, cached_write_price) VALUES ('m-est', 3000, 6000, 300, 900)").run();
    const spy = vi.spyOn(provider, "streamChat");
    spy.mockImplementation((() => (async function* () { yield { type: "TEXT_MESSAGE_CONTENT", delta: "hello" } as unknown as never; yield { type: "RUN_FINISHED", usage: { input: 0, output: 0 } } as unknown as never; })()) as never);

    const gatewayLayer = buildGatewayLayer(db, AssistantCallLogsRepo.Default.pipe(Layer.provide(Layer.mergeAll(Layer.succeed(Sqlite, db), DbBunLive(db)))));

    const prog = Effect.gen(function* () {
      const gw = yield* AssistantGateway;
      const stream = gw.streamChat({
        projectId: "p1",
        systemPrompts: [{ content: "system hello world" } as never],
        messages: [{ role: "user", content: "hi there" } as never],
        fallbackConfigs: [{ kind: "openai_compatible", baseUrl: "https://a.com", apiKey: "sk", model: "m-est", providerId: "prov-x" }],
      });
      const chunks = yield* Effect.promise(() => collect(stream));
      expect(chunks.length).toBe(2);
    });
    await Effect.runPromise(prog.pipe(Effect.provide(gatewayLayer)));
    const row = db.prepare("SELECT estimated, usage_in, cost_cents FROM assistant_call_logs WHERE model='m-est'").get() as CallLogRow | null;
    expect(row).toBeTruthy();
    expect(row!.estimated).toBe(1);
    expect(row!.usage_in > 0).toBe(true);
    expect(row!.cost_cents > 0).toBe(true);
    }

    // 3. Prices cache-write tokens at cached_write_price in the gateway cost path.
    {
    const db = memDb();
    db.prepare("INSERT INTO assistant_model_prices (model, prompt_price, completion_price, cached_read_price, cached_write_price) VALUES ('m-cw', 3000, 6000, 300, 1500)").run();
    const spy = vi.spyOn(provider, "streamChat");
    spy.mockImplementation((() => (async function* () { yield { type: "TEXT_MESSAGE_CONTENT", delta: "hello" } as unknown as never; yield { type: "RUN_FINISHED", usage: { input: 1000, output: 500, cachedTokens: 200, cacheWriteTokens: 100 } } as unknown as never; })()) as never);

    const gatewayLayer = buildGatewayLayer(db, AssistantCallLogsRepo.Default.pipe(Layer.provide(Layer.mergeAll(Layer.succeed(Sqlite, db), DbBunLive(db)))));

    const prog = Effect.gen(function* () {
      const gw = yield* AssistantGateway;
      const stream = gw.streamChat({
        projectId: "p1",
        systemPrompts: [],
        messages: [{ role: "user", content: "hi" } as never],
        fallbackConfigs: [{ kind: "openai_compatible", baseUrl: "https://a.com", apiKey: "sk", model: "m-cw", providerId: "prov-cw" }],
      });
      yield* Effect.promise(() => collect(stream));
    });
    await Effect.runPromise(prog.pipe(Effect.provide(gatewayLayer)));
    const row = db.prepare("SELECT usage_in, usage_out, cached_in, cached_write_in, cost_cents, estimated FROM assistant_call_logs WHERE model='m-cw'").get() as CallLogRow | null;
    // freshIn = 1000-200-100 = 700: (700*3000 + 200*300 + 100*1500 + 500*6000)/1e6*100 = 531 cents.
    expect(row).toMatchObject({ usage_in: 1000, usage_out: 500, cached_in: 200, cached_write_in: 100, cost_cents: 531, estimated: 0 });
    }
  });
});
