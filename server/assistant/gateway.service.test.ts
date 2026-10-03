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

  it("normalize per kind: same baseUrl gives different normalized url per model kind", async () => {
    const { normalizeBaseUrl } = provider;
    const openai = normalizeBaseUrl("https://api.example.com", "openai_compatible");
    const anthropic = normalizeBaseUrl("https://api.example.com", "anthropic_compatible");
    expect(openai).toBe("https://api.example.com/v1");
    expect(anthropic).toBe("https://api.example.com/");
    expect(openai).not.toBe(anthropic);
  });

  it("same baseUrl different kind uses per-model kind for adapter baseUrl", async () => {
    const spy = vi.spyOn(provider, "streamChat");
    const seen: string[] = [];
    spy.mockImplementation(((input: { config: { kind: string; baseUrl: string } }) => {
      seen.push(provider.normalizeBaseUrl(input.config.baseUrl, input.config.kind as never));
      return (async function* () {
        throw new ProviderUnreachable({});
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
          { kind: "openai_compatible", baseUrl: "https://api.example.com", apiKey: "sk", model: "m1" },
          { kind: "anthropic_compatible", baseUrl: "https://api.example.com", apiKey: "sk", model: "m2" },
        ],
      });
      yield* Effect.promise(() => collect(stream).catch(() => []));
      return seen;
    });

    const seenVals = await Effect.runPromise(program.pipe(Effect.provide(gatewayLayer))) as unknown as string[];
    expect(seenVals).toEqual(["https://api.example.com/v1", "https://api.example.com/"]);
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

  it("configForModel builds per-model ProviderConfig with fresh adapter per attempt", async () => {
    const cfg = provider.configForModel({ base_url: "https://api.example.com", api_key: "sk-123" }, { kind: "anthropic_compatible", model_id: "claude-x" });
    expect(cfg).toEqual({ kind: "anthropic_compatible", baseUrl: "https://api.example.com", apiKey: "sk-123", model: "claude-x" });
    const adapter = provider.buildAdapterForModel({ base_url: "https://api.example.com", api_key: "sk-123" }, { kind: "openai_compatible", model_id: "gpt-4o" });
    expect(adapter).toBeDefined();
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

  it("resolves seeded provider keys and the decrypted key reaches real adapter construction", async () => {
    const env = { LXK_SECRETS_MASTER_KEY: MASTER_KEY } as RuntimeEnv;
    setup();
    await seedProviderSecret(db, "pr1", "sk-live-4242", MASTER_KEY);
    await seedProviderSecret(db, "pr2", "sk-live-7777", MASTER_KEY);

    const configs = await run(
      Effect.gen(function* () {
        const gw = yield* AssistantGateway;
        return yield* gw.resolveFallback("p1");
      }),
      env
    );
    const byProvider = new Map(configs.map((c) => [c.providerId, c]));
    expect(byProvider.get("pr1")).toMatchObject({ apiKey: "sk-live-4242", model: "gpt-x" });
    expect(byProvider.get("pr2")).toMatchObject({ apiKey: "sk-live-7777", model: "gpt-y" });
    // REAL (unstubbed) adapter construction proves the decrypted key is a
    // usable credential at the adapter boundary.
    expect(() => provider.buildAdapter(byProvider.get("pr1")!)).not.toThrow();
    expect(() => provider.buildAdapter(byProvider.get("pr2")!)).not.toThrow();
  });

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
  });

  it("an all-unopenable chain fails with PROVIDER_KEY_UNDECRYPTABLE", async () => {
    const env = { LXK_SECRETS_MASTER_KEY: MASTER_KEY } as RuntimeEnv;
    setup();
    await seedProviderSecret(db, "pr1", "sk-lost-3333", OTHER_KEY);
    await seedProviderSecret(db, "pr2", "sk-lost-4444", OTHER_KEY);

    const outcome = await run(
      Effect.gen(function* () {
        const gw = yield* AssistantGateway;
        return yield* Effect.either(gw.resolveFallback("p1"));
      }),
      env
    );
    expect(outcome).toMatchObject({
      _tag: "Left",
      left: expect.objectContaining({ _tag: "ProviderAuthFailed", message: PROVIDER_KEY_UNDECRYPTABLE }),
    });
  });

  it("no keyring: stored keys are unopenable and the chain fails with the fixed message", async () => {
    const env = {} as RuntimeEnv;
    setup();
    await seedProviderSecret(db, "pr1", "sk-lost-9999", MASTER_KEY);
    await seedProviderSecret(db, "pr2", "sk-lost-8888", MASTER_KEY);

    const outcome = await run(
      Effect.gen(function* () {
        const gw = yield* AssistantGateway;
        return yield* Effect.either(gw.resolveFallback("p1"));
      }),
      env
    );
    expect(outcome).toMatchObject({
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
