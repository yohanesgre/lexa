import { describe, it, expect, vi, beforeEach } from "vitest";
import { Effect, Layer } from "effect";
import { Database } from "bun:sqlite";
import { Sqlite } from "../db/database";
import { HeraldGateway } from "./gateway.service";
import { HeraldProvidersRepo } from "../repos/herald-providers.repo";
import { HeraldModelsRepo } from "../repos/herald-models.repo";
import { HeraldCallLogsRepo } from "../repos/herald-call-logs.repo";
import { HeraldSettingsRepo } from "../repos/herald-settings.repo";
import * as provider from "./provider";
import { ProviderAuthFailed, ProviderUnreachable } from "../api/errors";

function memDbLayer() {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  return Layer.succeed(Sqlite, db);
}

function stubCallLog() {
  return Layer.succeed(HeraldCallLogsRepo, { insert: () => Effect.void, log: () => Effect.void } as unknown as never);
}
function stubProviders() {
  return Layer.succeed(HeraldProvidersRepo, {
    list: () => Effect.succeed([]),
    listAll: () => Effect.succeed([]),
    getById: () => Effect.fail(new (class E { _tag = "RowNotFound" as const; table = "herald_providers" })()),
  } as unknown as never);
}
function stubModels() {
  return Layer.succeed(HeraldModelsRepo, {
    listAll: () => Effect.succeed([]),
    listByProvider: () => Effect.succeed([]),
  } as unknown as never);
}
function stubSettings() {
  return Layer.succeed(HeraldSettingsRepo, {
    getByProject: () => Effect.fail(new (class E { _tag = "RowNotFound" as const; table = "herald_settings" })()),
    maskedView: () => Effect.fail(new (class E { _tag = "RowNotFound" as const; table = "herald_settings" })()),
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

describe("HeraldGateway", () => {
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

    const gatewayLayer = HeraldGateway.Default.pipe(
      Layer.provide(stubProviders()),
      Layer.provide(stubModels()),
      Layer.provide(stubCallLog()),
      Layer.provide(stubSettings()),
      Layer.provide(memDbLayer())
    );

    const program = Effect.gen(function* () {
      const gw = yield* HeraldGateway;
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

  it("normalize per kind: same baseUrl gives different normalized url per model kind", () => {
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

    const gatewayLayer = HeraldGateway.Default.pipe(
      Layer.provide(stubProviders()),
      Layer.provide(stubModels()),
      Layer.provide(stubCallLog()),
      Layer.provide(stubSettings()),
      Layer.provide(memDbLayer())
    );

    const program = Effect.gen(function* () {
      const gw = yield* HeraldGateway;
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

    const gatewayLayer = HeraldGateway.Default.pipe(
      Layer.provide(stubProviders()),
      Layer.provide(stubModels()),
      Layer.provide(stubCallLog()),
      Layer.provide(stubSettings()),
      Layer.provide(memDbLayer())
    );

    const program = Effect.gen(function* () {
      const gw = yield* HeraldGateway;
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

  it("continues on ProviderUnreachable/HeraldGenerationFailed, surfaces aggregated error", async () => {
    const spy = vi.spyOn(provider, "streamChat");
    spy.mockImplementation((() =>
      (async function* () {
        throw new ProviderUnreachable({ message: "unreachable", status: 503 } as never);
      })()) as never);

    const gatewayLayer = HeraldGateway.Default.pipe(
      Layer.provide(stubProviders()),
      Layer.provide(stubModels()),
      Layer.provide(stubCallLog()),
      Layer.provide(stubSettings()),
      Layer.provide(memDbLayer())
    );

    const program = Effect.gen(function* () {
      const gw = yield* HeraldGateway;
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
    expect(tag).toBe("HeraldGenerationFailed");
  });

  it("configForModel builds per-model ProviderConfig with fresh adapter per attempt", () => {
    const cfg = provider.configForModel({ base_url: "https://api.example.com", api_key: "sk-123" }, { kind: "anthropic_compatible", model_id: "claude-x" });
    expect(cfg).toEqual({ kind: "anthropic_compatible", baseUrl: "https://api.example.com", apiKey: "sk-123", model: "claude-x" });
    const adapter = provider.buildAdapterForModel({ base_url: "https://api.example.com", api_key: "sk-123" }, { kind: "openai_compatible", model_id: "gpt-4o" });
    expect(adapter).toBeDefined();
  });
});
