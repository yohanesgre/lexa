import { Effect } from "effect";
import type { ModelMessage, StreamChunk } from "@tanstack/ai";
import { buildAdapter, normalizeBaseUrl, streamChat as providerStreamChat, translateRunError, type ProviderConfig } from "./provider";
import type { CacheablePrompt } from "./prompt";
import { HeraldProvidersRepo } from "../repos/herald-providers.repo";
import { HeraldModelsRepo } from "../repos/herald-models.repo";
import { HeraldCallLogsRepo } from "../repos/herald-call-logs.repo";
import { HeraldModelPricesRepo } from "../repos/herald-model-prices.repo";
import { HeraldSettingsRepo } from "../repos/herald-settings.repo";
import { ProviderNotConfigured, HeraldGenerationFailed } from "../api/errors";

export interface GatewayStreamInput {
  projectId: string;
  systemPrompts: CacheablePrompt[];
  messages: ModelMessage[];
  tools?: ReadonlyArray<unknown>;
  abortController?: AbortController;
  modelOptions?: Record<string, unknown>;
  fallbackConfigs?: ProviderConfig[];
}

function isRetriable(e: unknown): boolean {
  const tag = (e as { _tag?: string })?._tag;
  return tag === "ProviderAuthFailed" || tag === "ProviderUnreachable" || tag === "HeraldGenerationFailed";
}

export class HeraldGateway extends Effect.Service<HeraldGateway>()("Lexa/HeraldGateway", {
  dependencies: [
    HeraldProvidersRepo.Default,
    HeraldModelsRepo.Default,
    HeraldCallLogsRepo.Default,
    HeraldModelPricesRepo.Default,
    HeraldSettingsRepo.Default,
  ],
  effect: Effect.gen(function* () {
    const providerRepo = yield* HeraldProvidersRepo;
    const modelRepo = yield* HeraldModelsRepo;
    const callLogRepo = yield* HeraldCallLogsRepo;
    const priceRepo = yield* HeraldModelPricesRepo;
    yield* HeraldSettingsRepo;

    const resolveFallback = (projectId: string): Effect.Effect<ProviderConfig[], ProviderNotConfigured> =>
      (Effect.gen(function* () {
        const models = (yield* modelRepo.listAll().pipe(Effect.catchAll((e: unknown) => (e as { _tag?: string })?._tag === "RowNotFound" ? Effect.succeed([] as Array<never>) : Effect.fail(e as never)))) as unknown as Array<{ provider_id?: string; providerId?: string; kind: ProviderConfig["kind"]; model_id?: string; modelId?: string; enabled?: boolean }>;
        const providers = (yield* providerRepo.list().pipe(Effect.catchAll((e: unknown) => (e as { _tag?: string })?._tag === "RowNotFound" ? Effect.succeed([] as Array<{ id: string }>) : Effect.fail(e as never)))) as unknown as Array<{ id: string; base_url?: string; baseUrl?: string; api_key?: string; apiKey?: string }>;
        const byId = new Map((providers as Array<{ id: string }>).map((p: { id: string }) => [p.id, p] as const));
        const enabledModels = (models as unknown as Array<{ enabled?: boolean }>).filter((m) => (m as { enabled?: boolean }).enabled !== false);
        const configs: ProviderConfig[] = [];
        for (const m of enabledModels as unknown as Array<{ kind: ProviderConfig["kind"]; model_id?: string; modelId?: string; provider_id?: string; providerId?: string }>) {
          if (configs.length >= 3) break;
          const pid = (m as { provider_id?: string; providerId?: string }).provider_id ?? (m as { providerId?: string }).providerId;
          if (!pid) continue;
          const p = byId.get(pid) as unknown as { base_url?: string; baseUrl?: string; api_key?: string; apiKey?: string } | undefined;
          if (!p) continue;
          const baseUrl = p.base_url ?? p.baseUrl ?? "";
          const apiKey = p.api_key ?? p.apiKey ?? "";
          const modelId = (m as { model_id?: string; modelId?: string }).model_id ?? (m as { modelId?: string }).modelId ?? "";
          configs.push({ kind: m.kind as ProviderConfig["kind"], baseUrl, apiKey, model: modelId, providerId: pid });
        }
        if (configs.length > 0) return configs.slice(0, 3);
        return yield* Effect.fail(new ProviderNotConfigured({ projectId }));
      }) as unknown as Effect.Effect<ProviderConfig[], ProviderNotConfigured>);

    const streamChat = (input: GatewayStreamInput): AsyncIterable<StreamChunk> => {
      const fallbackPromise: Promise<ProviderConfig[]> =
        input.fallbackConfigs !== undefined
          ? Promise.resolve(input.fallbackConfigs.slice(0, 3))
          : Effect.runPromise(resolveFallback(input.projectId).pipe(Effect.catchAll(() => Effect.succeed([] as ProviderConfig[]))));

      return {
        [Symbol.asyncIterator]: async function* () {
          const configs = await fallbackPromise;
          const limited = configs.slice(0, 3);
          if (limited.length === 0) {
            throw new ProviderNotConfigured({ projectId: input.projectId });
          }
          let lastError: unknown = null;
          for (let i = 0; i < limited.length; i++) {
            const cfg = limited[i];
            const start = Date.now();
            try {
              normalizeBaseUrl(cfg.baseUrl, cfg.kind);
            } catch (e) {
              const err = translateRunError(e);
              lastError = err;
              try { const l3 = (callLogRepo as unknown as Record<string, unknown>); const fn3 = (l3.log ?? l3.insert) as ((i: unknown) => Effect.Effect<void, unknown>) | undefined; if (fn3) await Effect.runPromise(fn3.call(callLogRepo, { id: crypto.randomUUID(), projectId: input.projectId, providerId: cfg.providerId ?? null, model: cfg.model, kind: cfg.kind, status: "error", errorCode: (err as { _tag: string })._tag, latencyMs: Date.now() - start } as unknown as never).pipe(Effect.catchAll(() => Effect.void)));
              } catch {}
              if (!isRetriable(err) || i === limited.length - 1) throw err;
              continue;
            }
            try {
              void buildAdapter(cfg);
              const iterable = providerStreamChat({
                config: cfg,
                systemPrompts: input.systemPrompts,
                messages: input.messages,
                tools: input.tools,
                abortController: input.abortController,
                modelOptions: input.modelOptions,
              });
              let usageIn = 0; let usageOut = 0;
              for await (const chunk of iterable) {
                if ((chunk as { type?: string }).type === "RUN_ERROR") {
                  const c = chunk as unknown as Record<string, unknown>;
                  const e = Object.assign(new Error(String(c.message ?? "run error")), {
                    code: c.code,
                    status: c.code,
                    rawEvent: c.rawEvent,
                    error: c.rawEvent,
                    cause: c.rawEvent,
                  });
                  throw translateRunError(e);
                }
                if ((chunk as { type?: string }).type === "RUN_FINISHED") {
                  const u = (chunk as unknown as { usage?: { input?: number; output?: number; promptTokens?: number; completionTokens?: number } }).usage;
                  usageIn = Number(u?.input ?? u?.promptTokens ?? 0);
                  usageOut = Number(u?.output ?? u?.completionTokens ?? 0);
                }
                yield chunk;
              }
              {
                let costCents = 0;
                let estimated = false;
                try {
                  const price = await Effect.runPromise(priceRepo.getByModel(cfg.model).pipe(Effect.catchAll(() => Effect.succeed(null as unknown as { promptPrice: number; completionPrice: number }))));
                  if (price) {
                    costCents = Math.round((usageIn * price.promptPrice + usageOut * price.completionPrice) * 100);
                    estimated = false;
                  } else {
                    // TODO: price-sync lane: if schema allows costCents null, use null + estimated true for missing prices
                    costCents = 0;
                    estimated = true;
                  }
                } catch {
                  costCents = 0;
                  estimated = true;
                }
                try { const l2 = (callLogRepo as unknown as Record<string, unknown>); const fn2 = (l2.log ?? l2.insert) as ((i: unknown) => Effect.Effect<void, unknown>) | undefined; if (fn2) await Effect.runPromise(fn2.call(callLogRepo, { id: crypto.randomUUID(), projectId: input.projectId, providerId: cfg.providerId ?? null, model: cfg.model, kind: cfg.kind, status: "done", latencyMs: Date.now() - start, usageIn, usageOut, costCents, estimated } as unknown as never).pipe(Effect.catchAll(() => Effect.void)));
                } catch {}
              }
              return;
            } catch (e) {
              const tagged = (e as { _tag?: string })?._tag;
              const err = tagged === "ProviderAuthFailed" || tagged === "ProviderUnreachable" || tagged === "HeraldGenerationFailed" ? (e as ReturnType<typeof translateRunError>) : translateRunError(e);
              lastError = err;
              try { const l3 = (callLogRepo as unknown as Record<string, unknown>); const fn3 = (l3.log ?? l3.insert) as ((i: unknown) => Effect.Effect<void, unknown>) | undefined; if (fn3) await Effect.runPromise(fn3.call(callLogRepo, { id: crypto.randomUUID(), projectId: input.projectId, providerId: cfg.providerId ?? null, model: cfg.model, kind: cfg.kind, status: "error", errorCode: (err as { _tag: string })._tag, latencyMs: Date.now() - start } as unknown as never).pipe(Effect.catchAll(() => Effect.void)));
              } catch {}
              if (!isRetriable(err) || i === limited.length - 1) throw err;
            }
          }
          if (lastError) throw lastError;
          throw new HeraldGenerationFailed({ message: "all models failed" });
        },
      } as AsyncIterable<StreamChunk>;
    };

    return { resolveFallback, streamChat } as const;
  }),
}) {}
