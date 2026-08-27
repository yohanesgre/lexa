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
import { HeraldGenerationFailed } from "../api/errors";

function memDbLayer() {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  return Layer.succeed(Sqlite, db);
}
function stubCallLog() {
  return Layer.succeed(HeraldCallLogsRepo, { insert: () => Effect.void, log: () => Effect.void } as unknown as never);
}
function stubProviders() {
  return Layer.succeed(HeraldProvidersRepo, { list: () => Effect.succeed([]), listAll: () => Effect.succeed([]), getById: () => Effect.fail(new (class E { _tag = "RowNotFound" as const; table = "herald_providers" })()) } as unknown as never);
}
function stubModels() {
  return Layer.succeed(HeraldModelsRepo, { listAll: () => Effect.succeed([]), listByProvider: () => Effect.succeed([]) } as unknown as never);
}
function stubSettings() {
  return Layer.succeed(HeraldSettingsRepo, { getByProject: () => Effect.fail(new (class E { _tag = "RowNotFound" as const; table = "herald_settings" })()), maskedView: () => Effect.fail(new (class E { _tag = "RowNotFound" as const; table = "herald_settings" })()), upsert: () => Effect.succeed(null as never) } as unknown as never);
}
function collect(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  return (async () => {
    const out: unknown[] = [];
    for await (const c of stream) out.push(c);
    return out;
  })();
}

describe("HeraldGateway retry/backoff", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("400 non-retriable does not retry fallback", async () => {
    const spy = vi.spyOn(provider, "streamChat");
    spy.mockImplementation((() =>
      (async function* () {
        throw new HeraldGenerationFailed({ message: "400 bad request", status: 400 } as never);
      })()) as never);
    const gatewayLayer = HeraldGateway.Default.pipe(Layer.provide(stubProviders()), Layer.provide(stubModels()), Layer.provide(stubCallLog()), Layer.provide(stubSettings()), Layer.provide(memDbLayer()));
    const program = Effect.gen(function* () {
      const gw = yield* HeraldGateway;
      const stream = gw.streamChat({
        projectId: "p1",
        systemPrompts: [],
        messages: [{ role: "user", content: "hi" } as never],
        fallbackConfigs: [
          { kind: "openai_compatible", baseUrl: "https://a.com", apiKey: "sk", model: "m1" },
          { kind: "openai_compatible", baseUrl: "https://a.com", apiKey: "sk", model: "m2" },
        ],
      });
      yield* Effect.promise(() => collect(stream).catch(() => []));
      return spy.mock.calls.length;
    });
    const calls = (await Effect.runPromise(program.pipe(Effect.provide(gatewayLayer)))) as unknown as number;
    expect(calls).toBe(1);
  });

  it("429 retriable does retry fallback with backoff", async () => {
    const spy = vi.spyOn(provider, "streamChat");
    let callCount = 0;
    spy.mockImplementation((() => {
      callCount++;
      if (callCount === 1) {
        return (async function* () {
          throw Object.assign(new HeraldGenerationFailed({ message: "429 rate limit", status: 429 } as never), { status: 429 });
        })();
      }
      return (async function* () {
        yield { type: "TEXT_MESSAGE_CONTENT", delta: "ok" } as unknown as never;
        yield { type: "RUN_FINISHED", usage: { input: 1, output: 1 } } as unknown as never;
      })();
    }) as never);
    const gatewayLayer = HeraldGateway.Default.pipe(Layer.provide(stubProviders()), Layer.provide(stubModels()), Layer.provide(stubCallLog()), Layer.provide(stubSettings()), Layer.provide(memDbLayer()));
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const program = Effect.gen(function* () {
      const gw = yield* HeraldGateway;
      const stream = gw.streamChat({
        projectId: "p1",
        systemPrompts: [],
        messages: [{ role: "user", content: "hi" } as never],
        fallbackConfigs: [
          { kind: "openai_compatible", baseUrl: "https://a.com", apiKey: "sk", model: "m1" },
          { kind: "openai_compatible", baseUrl: "https://a.com", apiKey: "sk", model: "m2" },
        ],
      });
      const chunks = yield* Effect.promise(() => collect(stream));
      return { chunks, calls: spy.mock.calls.length, slept: setTimeoutSpy.mock.calls.length > 0 };
    });
    const result = (await Effect.runPromise(program.pipe(Effect.provide(gatewayLayer)))) as unknown as { chunks: unknown[]; calls: number; slept: boolean };
    expect(result.calls).toBe(2);
    expect(result.chunks.some((c) => (c as { delta?: string }).delta === "ok")).toBe(true);
    expect(result.slept).toBe(true);
  });

  it("500 retriable does retry", async () => {
    const spy = vi.spyOn(provider, "streamChat");
    spy.mockImplementationOnce((() =>
      (async function* () {
        throw new HeraldGenerationFailed({ message: "500 Internal", status: 500 } as never);
      })()) as never);
    spy.mockImplementationOnce((() =>
      (async function* () {
        yield { type: "TEXT_MESSAGE_CONTENT", delta: "ok2" } as unknown as never;
        yield { type: "RUN_FINISHED", usage: { input: 1, output: 1 } } as unknown as never;
      })()) as never);
    const gatewayLayer = HeraldGateway.Default.pipe(Layer.provide(stubProviders()), Layer.provide(stubModels()), Layer.provide(stubCallLog()), Layer.provide(stubSettings()), Layer.provide(memDbLayer()));
    const program = Effect.gen(function* () {
      const gw = yield* HeraldGateway;
      const stream = gw.streamChat({
        projectId: "p1",
        systemPrompts: [],
        messages: [{ role: "user", content: "hi" } as never],
        fallbackConfigs: [
          { kind: "openai_compatible", baseUrl: "https://a.com", apiKey: "sk", model: "m1" },
          { kind: "openai_compatible", baseUrl: "https://a.com", apiKey: "sk", model: "m2" },
        ],
      });
      const chunks = yield* Effect.promise(() => collect(stream));
      return chunks;
    });
    const chunks = (await Effect.runPromise(program.pipe(Effect.provide(gatewayLayer)))) as unknown[];
    expect(spy).toHaveBeenCalledTimes(2);
    expect(chunks.some((c) => (c as { delta?: string }).delta === "ok2")).toBe(true);
  });

  it("mapping error not retriable, preserves message", async () => {
    const spy = vi.spyOn(provider, "streamChat");
    spy.mockImplementation((() =>
      (async function* () {
        throw new HeraldGenerationFailed({ message: "upstream response mapping failed: Unexpected token" } as never);
      })()) as never);
    const gatewayLayer = HeraldGateway.Default.pipe(Layer.provide(stubProviders()), Layer.provide(stubModels()), Layer.provide(stubCallLog()), Layer.provide(stubSettings()), Layer.provide(memDbLayer()));
    const program = Effect.gen(function* () {
      const gw = yield* HeraldGateway;
      const stream = gw.streamChat({
        projectId: "p1",
        systemPrompts: [],
        messages: [{ role: "user", content: "hi" } as never],
        fallbackConfigs: [
          { kind: "openai_compatible", baseUrl: "https://a.com", apiKey: "sk", model: "m1" },
          { kind: "openai_compatible", baseUrl: "https://a.com", apiKey: "sk", model: "m2" },
        ],
      });
      const thrown = yield* Effect.tryPromise({
        try: () => collect(stream),
        catch: (e) => e as unknown,
      }).pipe(Effect.map(() => null as unknown), Effect.catchAll((e) => Effect.succeed(e as unknown)));
      return thrown;
    });
    const err = (await Effect.runPromise(program.pipe(Effect.provide(gatewayLayer)))) as unknown as { message: string; _tag: string };
    expect(spy).toHaveBeenCalledTimes(1);
    expect(err._tag).toBe("HeraldGenerationFailed");
    expect(err.message).toContain("upstream response mapping failed");
  });

  it("abort signal breaks without retry", async () => {
    const spy = vi.spyOn(provider, "streamChat");
    const ac = new AbortController();
    ac.abort();
    spy.mockImplementation((() =>
      (async function* () {
        throw new HeraldGenerationFailed({ message: "500 Internal", status: 500 } as never);
      })()) as never);
    const gatewayLayer = HeraldGateway.Default.pipe(Layer.provide(stubProviders()), Layer.provide(stubModels()), Layer.provide(stubCallLog()), Layer.provide(stubSettings()), Layer.provide(memDbLayer()));
    const program = Effect.gen(function* () {
      const gw = yield* HeraldGateway;
      const stream = gw.streamChat({
        projectId: "p1",
        systemPrompts: [],
        messages: [{ role: "user", content: "hi" } as never],
        abortController: ac,
        fallbackConfigs: [
          { kind: "openai_compatible", baseUrl: "https://a.com", apiKey: "sk", model: "m1" },
          { kind: "openai_compatible", baseUrl: "https://a.com", apiKey: "sk", model: "m2" },
        ],
      });
      const thrown = yield* Effect.tryPromise({
        try: () => collect(stream),
        catch: (e) => e as unknown,
      }).pipe(Effect.map(() => null as unknown), Effect.catchAll((e) => Effect.succeed(e as unknown)));
      return { calls: spy.mock.calls.length, thrown };
    });
    const res = (await Effect.runPromise(program.pipe(Effect.provide(gatewayLayer)))) as unknown as { calls: number; thrown: unknown };
    expect(res.calls).toBe(0);
  });

  it("single-config 429 retries same model with backoff", async () => {
    const spy = vi.spyOn(provider, "streamChat");
    let count = 0;
    spy.mockImplementation((() => {
      count++;
      if (count === 1) {
        return (async function* () {
          throw new HeraldGenerationFailed({ message: "429 rate limit", status: 429 } as never);
        })();
      }
      return (async function* () {
        yield { type: "TEXT_MESSAGE_CONTENT", delta: "retry-ok" } as unknown as never;
        yield { type: "RUN_FINISHED", usage: { input: 1, output: 1 } } as unknown as never;
      })();
    }) as never);
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const gatewayLayer = HeraldGateway.Default.pipe(Layer.provide(stubProviders()), Layer.provide(stubModels()), Layer.provide(stubCallLog()), Layer.provide(stubSettings()), Layer.provide(memDbLayer()));
    const program = Effect.gen(function* () {
      const gw = yield* HeraldGateway;
      const stream = gw.streamChat({
        projectId: "p1",
        systemPrompts: [],
        messages: [{ role: "user", content: "hi" } as never],
        fallbackConfigs: [{ kind: "openai_compatible", baseUrl: "https://a.com", apiKey: "sk", model: "solo" }],
      });
      const chunks = yield* Effect.promise(() => collect(stream));
      return { chunks, calls: spy.mock.calls.length, slept: setTimeoutSpy.mock.calls.length > 0 };
    });
      const res = (await Effect.runPromise(program.pipe(Effect.provide(gatewayLayer)))) as unknown as { chunks: unknown[]; calls: number; slept: boolean };
    expect(res.calls).toBe(2);
    expect(res.slept).toBe(true);
    expect(res.chunks.some((c) => (c as { delta?: string }).delta === "retry-ok")).toBe(true);
  });

  it("FATAL emitted on all-models-failed terminal", async () => {
    const spy = vi.spyOn(provider, "streamChat");
    spy.mockImplementation((() => (async function* () { throw new HeraldGenerationFailed({ message: "500 Internal", status: 500 } as never); })()) as never);
    const writes: string[] = [];
    const origStderr = process.stderr.write as unknown as typeof process.stderr.write;
    const origStdout = process.stdout.write as unknown as typeof process.stdout.write;
    (process.stderr.write as unknown as (s: string) => boolean) = ((s: string) => { writes.push(String(s)); return true; }) as unknown as typeof process.stderr.write;
    (process.stdout.write as unknown as (s: string) => boolean) = ((s: string) => { writes.push(String(s)); return true; }) as unknown as typeof process.stdout.write;
    const gatewayLayer = HeraldGateway.Default.pipe(Layer.provide(stubProviders()), Layer.provide(stubModels()), Layer.provide(stubCallLog()), Layer.provide(stubSettings()), Layer.provide(memDbLayer()));
    const program = Effect.gen(function* () {
      const gw = yield* HeraldGateway;
      const stream = gw.streamChat({
        projectId: "p1",
        systemPrompts: [],
        messages: [{ role: "user", content: "hi" } as never],
        fallbackConfigs: [
          { kind: "openai_compatible", baseUrl: "https://a.com", apiKey: "sk", model: "m1" },
          { kind: "openai_compatible", baseUrl: "https://a.com", apiKey: "sk", model: "m2" },
        ],
      });
      yield* Effect.tryPromise({ try: () => collect(stream), catch: (e) => e as unknown }).pipe(Effect.catchAll((e) => Effect.succeed(e)));
      return writes;
    });
    try {
      const out = (await Effect.runPromise(program.pipe(Effect.provide(gatewayLayer)))) as unknown as string[];
      const fatal = out.find((s) => s.includes('"level":"FATAL"') && s.includes("all") );
      expect(fatal).toBeDefined();
    } finally {
      process.stderr.write = origStderr;
      process.stdout.write = origStdout;
    }
  });
});
