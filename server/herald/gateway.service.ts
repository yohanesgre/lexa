import { Effect, Option } from "effect";
import type { ModelMessage, StreamChunk } from "@tanstack/ai";
import { buildAdapter, normalizeBaseUrl, streamChat as providerStreamChat, translateRunError, type ProviderConfig } from "./provider";
import type { CacheablePrompt } from "./prompt";
import { HeraldProvidersRepo } from "../repos/herald-providers.repo";
import { HeraldModelsRepo } from "../repos/herald-models.repo";
import { HeraldCallLogsRepo } from "../repos/herald-call-logs.repo";
import { HeraldModelPricesRepo } from "../repos/herald-model-prices.repo";
import { HeraldSettingsRepo } from "../repos/herald-settings.repo";
import { HeraldHealthService } from "../services/herald-health.service";
import { estimateTokens } from "./tiktoken";
import { ProviderNotConfigured, HeraldGenerationFailed } from "../api/errors";

export interface GatewayStreamInput {
  projectId: string;
  systemPrompts: CacheablePrompt[];
  messages: ModelMessage[];
  tools?: ReadonlyArray<unknown> | undefined;
  abortController?: AbortController | undefined;
  modelOptions?: Record<string, unknown> | undefined;
  fallbackConfigs?: ProviderConfig[] | undefined;
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
    const healthOption = yield* Effect.serviceOption(HeraldHealthService);
    const health = Option.isSome(healthOption) ? healthOption.value : ({
      isAllowed: () => Effect.succeed(true),
      recordFailure: () => Effect.void,
      recordSuccess: () => Effect.void,
      getHealth: (id: string) => Effect.succeed({ providerId: id, circuitState: "closed" as const, failureCount: 0, openedAt: null, lastProbeAt: null, consecutiveFailures: 0 }),
    } as never as InstanceType<typeof HeraldHealthService>);
    yield* HeraldSettingsRepo;

    const resolveFallback = (projectId: string): Effect.Effect<ProviderConfig[], ProviderNotConfigured> =>
      (Effect.gen(function* () {
        const models = (yield* modelRepo.listAll().pipe(Effect.catchAll((e: unknown) => (e as { _tag?: string })?._tag === "RowNotFound" ? Effect.succeed([] as Array<never>) : Effect.fail(e as never)))) as Array<{ provider_id?: string; providerId?: string; kind: ProviderConfig["kind"]; model_id?: string; modelId?: string; enabled?: boolean }>;
        const providers = (yield* providerRepo.list().pipe(Effect.catchAll((e: unknown) => (e as { _tag?: string })?._tag === "RowNotFound" ? Effect.succeed([] as Array<{ id: string }>) : Effect.fail(e as never)))) as Array<{ id: string; base_url?: string; baseUrl?: string; api_key?: string; apiKey?: string }>;
        const byId = new Map((providers as Array<{ id: string }>).map((p: { id: string }) => [p.id, p] as const));
        const enabledModels = (models as Array<{ enabled?: boolean }>).filter((m) => (m as { enabled?: boolean }).enabled !== false);
        const configs: ProviderConfig[] = [];
        for (const m of enabledModels as Array<{ kind: ProviderConfig["kind"]; model_id?: string; modelId?: string; provider_id?: string; providerId?: string }>) {
          if (configs.length >= 3) break;
          const pid = (m as { provider_id?: string; providerId?: string }).provider_id ?? (m as { providerId?: string }).providerId;
          if (!pid) continue;
          const p = byId.get(pid) as { base_url?: string; baseUrl?: string; api_key?: string; apiKey?: string } | undefined;
          if (!p) continue;
          const baseUrl = p.base_url ?? p.baseUrl ?? "";
          const apiKey = p.api_key ?? p.apiKey ?? "";
          const modelId = (m as { model_id?: string; modelId?: string }).model_id ?? (m as { modelId?: string }).modelId ?? "";
          configs.push({ kind: m.kind as ProviderConfig["kind"], baseUrl, apiKey, model: modelId, providerId: pid });
        }
        if (configs.length > 0) return configs.slice(0, 3);
        return yield* Effect.fail(new ProviderNotConfigured({ projectId }));
      }) as Effect.Effect<ProviderConfig[], ProviderNotConfigured>);

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
            const cfg = limited[i]!; // limited bound guarantees presence
            if (cfg.providerId) {
              try {
                const allowed = await Effect.runPromise(health.isAllowed(cfg.providerId).pipe(Effect.catchAll(() => Effect.succeed(true))));
                if (!allowed) {
                  continue;
                }
              } catch {}
            }
            const start = Date.now();
            try {
              normalizeBaseUrl(cfg.baseUrl, cfg.kind);
            } catch (e) {
              const err = translateRunError(e);
              lastError = err;
              if (cfg.providerId) {
                try { await Effect.runPromise(health.recordFailure(cfg.providerId).pipe(Effect.catchAll(() => Effect.void))); } catch {}
              }
              try { const l3 = (callLogRepo as never as Record<string, unknown>); const fn3 = (l3.log ?? l3.insert) as ((i: unknown) => Effect.Effect<void, unknown>) | undefined; if (fn3) await Effect.runPromise(fn3.call(callLogRepo, { id: crypto.randomUUID(), projectId: input.projectId, providerId: cfg.providerId ?? null, model: cfg.model, kind: cfg.kind, status: "error", errorCode: (err as { _tag: string })._tag, latencyMs: Date.now() - start } as never).pipe(Effect.catchAll(() => Effect.void)));
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
              let generatedText = "";
              for await (const chunk of iterable) {
                if ((chunk as { type?: string }).type === "RUN_ERROR") {
                  const c = chunk as Record<string, unknown>;
                  const e = Object.assign(new Error(String(c.message ?? "run error")), {
                    code: c.code,
                    status: c.code,
                    rawEvent: c.rawEvent,
                    error: c.rawEvent,
                    cause: c.rawEvent,
                  });
                  throw translateRunError(e);
                }
                if ((chunk as { type?: string }).type === "TEXT_MESSAGE_CONTENT") {
                  const d = (chunk as { delta?: string }).delta ?? "";
                  generatedText += d;
                }
                if ((chunk as { type?: string }).type === "RUN_FINISHED") {
                  const u = (chunk as { usage?: { input?: number; output?: number; promptTokens?: number; completionTokens?: number } }).usage;
                  usageIn = Number(u?.input ?? u?.promptTokens ?? 0);
                  usageOut = Number(u?.output ?? u?.completionTokens ?? 0);
                }
                yield chunk;
              }
              {
                let costCents = 0;
                let estimated = false;
                if (usageIn === 0 && usageOut === 0) {
                  const inputText = [
                    ...(input.systemPrompts?.map((p) => typeof (p as { content?: unknown }).content === "string" ? String((p as { content: string }).content) : JSON.stringify((p as { content: unknown }).content ?? "")) ?? []),
                    ...input.messages.map((m) => typeof (m as { content?: unknown }).content === "string" ? String((m as { content: string }).content) : Array.isArray((m as { content?: unknown }).content) ? JSON.stringify((m as { content: unknown }).content) : JSON.stringify((m as { content?: unknown }).content ?? "")),
                    generatedText,
                  ].join("\n");
                  const est = estimateTokens(inputText);
                  if (est > 0) {
                    usageIn = est;
                    estimated = true;
                  } else if (inputText.length > 0) {
                    usageIn = Math.ceil(inputText.length / 4);
                    estimated = true;
                  }
                }
                try {
                  const price = await Effect.runPromise(priceRepo.getByModel(cfg.model).pipe(Effect.catchAll(() => Effect.succeed(null as never as { promptPrice: number; completionPrice: number }))));
                  if (price) {
                    costCents = Math.round((usageIn * price.promptPrice + usageOut * price.completionPrice) * 100);
                  } else {
                    costCents = 0;
                    if (!estimated) estimated = usageIn === 0 && usageOut === 0;
                    if (usageIn !== 0 || usageOut !== 0) estimated = estimated;
                    else estimated = true;
                  }
                } catch {
                  costCents = 0;
                  estimated = true;
                }
                try { const l2 = (callLogRepo as never as Record<string, unknown>); const fn2 = (l2.log ?? l2.insert) as ((i: unknown) => Effect.Effect<void, unknown>) | undefined; if (fn2) await Effect.runPromise(fn2.call(callLogRepo, { id: crypto.randomUUID(), projectId: input.projectId, providerId: cfg.providerId ?? null, model: cfg.model, kind: cfg.kind, status: "done", latencyMs: Date.now() - start, usageIn, usageOut, costCents, estimated } as never).pipe(Effect.catchAll(() => Effect.void)));
                } catch {}
              }
              if (cfg.providerId) {
                try { await Effect.runPromise(health.recordSuccess(cfg.providerId).pipe(Effect.catchAll(() => Effect.void))); } catch {}
              }
              return;
            } catch (e) {
              const tagged = (e as { _tag?: string })?._tag;
              const err = tagged === "ProviderAuthFailed" || tagged === "ProviderUnreachable" || tagged === "HeraldGenerationFailed" ? (e as ReturnType<typeof translateRunError>) : translateRunError(e);
              lastError = err;
              if (cfg.providerId) {
                try { await Effect.runPromise(health.recordFailure(cfg.providerId).pipe(Effect.catchAll(() => Effect.void))); } catch {}
              }
              try { const l3 = (callLogRepo as never as Record<string, unknown>); const fn3 = (l3.log ?? l3.insert) as ((i: unknown) => Effect.Effect<void, unknown>) | undefined; if (fn3) await Effect.runPromise(fn3.call(callLogRepo, { id: crypto.randomUUID(), projectId: input.projectId, providerId: cfg.providerId ?? null, model: cfg.model, kind: cfg.kind, status: "error", errorCode: (err as { _tag: string })._tag, latencyMs: Date.now() - start } as never).pipe(Effect.catchAll(() => Effect.void)));
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
