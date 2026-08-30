/**
 * Herald gateway logging
 * Levels: DEBUG (config snapshot, backoff, abort state, fallback start/done — gated by LOG_LEVEL=debug|trace),
 *         INFO (attempt start/success), WARN (retry/backoff), ERROR (attempt failure), FATAL (all-models-failed terminal).
 * Enable DEBUG: LOG_LEVEL=debug or trace. TANSTACK_AI_JSON=1 also enables structured tanstack-ai logs (service tanstack-ai) — complementary, not duplicate.
 */
import { Effect, Option } from "effect";
import type { ModelMessage, StreamChunk } from "@tanstack/ai";
import { buildAdapter, normalizeBaseUrl, normalizeProviderKind, streamChat as providerStreamChat, testConnection as providerTestConnection, translateRunError, getProviderDiagnostics, extractStatusCode, extractProviderMessage, extractRetryAfter, isTransientUpstream, type ProviderConfig } from "./provider";
import type { CacheablePrompt } from "./prompt";
import { HeraldProvidersRepo } from "../repos/herald-providers.repo";
import { HeraldModelsRepo } from "../repos/herald-models.repo";
import { HeraldCallLogsRepo } from "../repos/herald-call-logs.repo";
import { HeraldModelPricesRepo } from "../repos/herald-model-prices.repo";
import { HeraldSettingsRepo } from "../repos/herald-settings.repo";
import { HeraldHealthService } from "../services/herald-health.service";
import { estimateTokens } from "./tiktoken";
import { ProviderNotConfigured, HeraldGenerationFailed } from "../api/errors";
import { getEnv } from "../env";

function maskApiKeyShort(key: string): string {
  if (!key) return "(empty)";
  const len = key.length;
  if (len <= 8) return `*** (len=${len})`;
  return `${key.slice(0, 3)}***${key.slice(-4)} (len=${len})`;
}

export type GatewayLogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR" | "FATAL";

function isGatewayDebugEnabled(): boolean {
  const lvl = (getEnv().LOG_LEVEL ?? "").toLowerCase();
  return lvl === "debug" || lvl === "trace";
}

export function gatewayLog(level: GatewayLogLevel, message: string, meta: Record<string, unknown>): void {
  if (level === "DEBUG" && !isGatewayDebugEnabled()) return;
  try {
    const line = JSON.stringify({ level, service: "herald-gateway", message, meta, timestamp: new Date().toISOString() });
    if (level === "ERROR" || level === "FATAL") process.stderr.write(line + "\n");
    else process.stdout.write(line + "\n");
  } catch {}
}

function safeBaseUrl(raw: string, kind: string): string {
  try { return normalizeBaseUrl(raw, kind); } catch { return raw; }
}

function diagFromError(e: unknown): { status: number | null; providerMessage: string | null; stack: string | null; causeChain: string | null; rawEvent: string | null; raw: string; retryAfter: number | null; upstreamBody: string | null } {
  const d = getProviderDiagnostics(e);
  return { status: d.status, providerMessage: d.providerMessage, stack: d.stack, causeChain: d.causeChain, rawEvent: d.rawEventJson, raw: d.raw, retryAfter: d.retryAfter, upstreamBody: d.upstreamBody };
}

function backoffMsFor(e: unknown, attempt: number): number {
  const status = extractStatusCode(e);
  const retryAfter = extractRetryAfter(e);
  let base: number;
  if (status === 429) {
    if (retryAfter !== null && retryAfter > 0) base = Math.min(retryAfter, 8000);
    else base = 400;
  } else {
    base = 800;
  }
  const jitter = Math.floor(Math.random() * 200);
  return Math.min(8000, base * Math.pow(2, attempt) + jitter);
}

async function sleepBackoff(e: unknown, attempt: number, metaExtra?: Record<string, unknown>): Promise<void> {
  const ms = backoffMsFor(e, attempt);
  const status = extractStatusCode(e);
  const retryAfter = extractRetryAfter(e);
  const errorTag = (e as { _tag?: string })?._tag ?? null;
  gatewayLog("WARN", `herald backoff ${ms}ms before retry`, { attempt: attempt + 1, backoffMs: ms, status, providerMessage: extractProviderMessage(e) ?? null, errorTag, retryAfter, base: status === 429 && retryAfter !== null ? Math.min(retryAfter, 8000) : status === 429 ? 400 : 800, ...(metaExtra ?? {}) });
  gatewayLog("DEBUG", `herald backoff debug`, { attempt: attempt + 1, backoffMs: ms, status, errorTag, retryAfter, abortSignalled: false });
  await new Promise<void>((r) => setTimeout(r, ms));
}

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
  const status = extractStatusCode(e);
  if (status !== undefined && [400, 401, 403, 404, 422].includes(status)) return false;
  const tag = (e as { _tag?: string })?._tag;
  if (tag === "ProviderAuthFailed") return false;
  if (status === 429) return true;
  if (status !== undefined && status >= 500 && status < 600 && status !== 501) return true;
  if (tag === "ProviderUnreachable") return true;
  if (isTransientUpstream(e)) return true;
  if (tag === "HeraldGenerationFailed") {
    const m = String((e as { message?: string }).message ?? "").toLowerCase();
    if (m.includes("upstream response mapping failed")) return false;
    if (status !== undefined && [400, 401, 403, 404, 422].includes(status)) return false;
    if (status === undefined) return true;
    return isTransientUpstream(e);
  }
  return false;
}

function isSingleRetryCandidate(e: unknown): boolean {
  const status = extractStatusCode(e);
  if (status !== undefined && [400, 401, 403, 404, 422].includes(status)) return false;
  const tag = (e as { _tag?: string })?._tag;
  if (tag === "ProviderAuthFailed") return false;
  if (status === 429) return true;
  if (status !== undefined && status >= 500 && status < 600 && status !== 501) return true;
  if (tag === "ProviderUnreachable") return true;
  if (isTransientUpstream(e)) return true;
  if (tag === "HeraldGenerationFailed") {
    const m = String((e as { message?: string }).message ?? "").toLowerCase();
    if (m.includes("upstream response mapping failed")) return false;
    if (status === undefined) return true;
    return isTransientUpstream(e);
  }
  return false;
}

export function stripToolCallXml(text: string): string {
  return text.replace(/<tool_call>[\s\S]*?(?:<\/tool_call>|$)/gi, "").trim();
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
    const settingsRepo = yield* HeraldSettingsRepo;

    const resolveFallback = (projectId: string): Effect.Effect<ProviderConfig[], ProviderNotConfigured> =>
      (Effect.gen(function* () {
        yield* Effect.sync(() => gatewayLog("DEBUG", "herald resolveFallback start", { projectId }));
        const models = (yield* modelRepo.listAll().pipe(Effect.catchAll((e: unknown) => (e as { _tag?: string })?._tag === "RowNotFound" ? Effect.succeed([] as Array<never>) : Effect.fail(e as never)))) as Array<{ provider_id?: string; providerId?: string; kind: ProviderConfig["kind"]; model_id?: string; modelId?: string; enabled?: boolean; priority?: number; id?: string }>;
        const providers = (yield* providerRepo.list().pipe(Effect.catchAll((e: unknown) => (e as { _tag?: string })?._tag === "RowNotFound" ? Effect.succeed([] as Array<{ id: string }>) : Effect.fail(e as never)))) as Array<{ id: string; base_url?: string; baseUrl?: string; api_key?: string; apiKey?: string }>;
        const byId = new Map((providers as Array<{ id: string }>).map((p: { id: string }) => [p.id, p] as const));
        const enabledModels = (models as Array<{ enabled?: boolean }>).filter((m) => (m as { enabled?: boolean }).enabled !== false);
        const byProviderModel = new Map<string, typeof enabledModels[number]>();
        for (const m of enabledModels) {
          const pid = (m as { provider_id?: string; providerId?: string }).provider_id ?? (m as { providerId?: string }).providerId ?? "";
          const mid = (m as { model_id?: string; modelId?: string }).model_id ?? (m as { modelId?: string }).modelId ?? "";
          if (pid && mid) byProviderModel.set(`${pid}:${mid}`, m);
        }
        const byModelId = new Map<string, typeof enabledModels[number]>();
        for (const m of enabledModels) {
          const mid = (m as { model_id?: string; modelId?: string }).model_id ?? (m as { modelId?: string }).modelId ?? "";
          if (mid && !byModelId.has(mid)) byModelId.set(mid, m);
        }
        const toConfig = (m: typeof enabledModels[number]): ProviderConfig | null => {
          const pid = (m as { provider_id?: string; providerId?: string }).provider_id ?? (m as { providerId?: string }).providerId;
          if (!pid) return null;
          const p = byId.get(pid) as { base_url?: string; baseUrl?: string; api_key?: string; apiKey?: string } | undefined;
          if (!p) return null;
          const baseUrl = p.base_url ?? p.baseUrl ?? "";
          const apiKey = p.api_key ?? p.apiKey ?? "";
          const modelId = (m as { model_id?: string; modelId?: string }).model_id ?? (m as { modelId?: string }).modelId ?? "";
          return { kind: normalizeProviderKind((m as { kind: unknown }).kind), baseUrl, apiKey, model: modelId, providerId: pid };
        };

        const settingsRow = (yield* settingsRepo.getByProject(projectId).pipe(
          Effect.map((r) => r as unknown as { provider_id: string | null; primary_model_id: string | null; fallback_model_ids: string }),
          Effect.catchTag("RowNotFound", () => Effect.succeed(null)),
          Effect.catchAll((e: unknown) => (e as { _tag?: string })?._tag === "RowNotFound" ? Effect.succeed(null) : Effect.fail(e as never))
        )) as { provider_id: string | null; primary_model_id: string | null; fallback_model_ids: string } | null;

        const providerFilter = settingsRow?.provider_id ?? null;
        const scopedModels = providerFilter
          ? enabledModels.filter((m) => ((m as { provider_id?: string; providerId?: string }).provider_id ?? (m as { providerId?: string }).providerId) === providerFilter)
          : null;

        if (settingsRow?.provider_id && settingsRow?.primary_model_id) {
          const pid = settingsRow.provider_id;
          const mid = settingsRow.primary_model_id;
          const primaryKey = `${pid}:${mid}`;
          let primaryModel: typeof enabledModels[number] | null = byProviderModel.get(primaryKey) ?? null;
          if (!primaryModel && scopedModels) {
            primaryModel = scopedModels.find((m) => ((m as { model_id?: string; modelId?: string }).model_id ?? (m as { modelId?: string }).modelId) === mid) ?? null;
          } else if (!primaryModel) {
            primaryModel = byModelId.get(mid) ?? null;
            if (primaryModel) {
              const pmPid = (primaryModel as { provider_id?: string; providerId?: string }).provider_id ?? (primaryModel as { providerId?: string }).providerId;
              if (providerFilter && pmPid !== providerFilter) primaryModel = null;
            }
          }
          if (primaryModel) {
            const primaryCfg = toConfig(primaryModel);
            if (primaryCfg) {
              const configs: ProviderConfig[] = [primaryCfg];
              let fallbackIds: string[] = [];
              try {
                const v = JSON.parse(settingsRow.fallback_model_ids ?? "[]");
                if (Array.isArray(v)) fallbackIds = v.filter((x: unknown) => typeof x === "string");
              } catch {}
              for (const fid of fallbackIds) {
                if (configs.length >= 3) break;
                let m: typeof enabledModels[number] | undefined;
                if (fid.includes(":")) {
                  const [fPid, ...rest] = fid.split(":") as [string, ...string[]];
                  if (providerFilter && fPid !== providerFilter) continue;
                  m = byProviderModel.get(fid) ?? undefined;
                  if (!m) {
                    const midPart = rest.join(":");
                    const byMid = byModelId.get(midPart);
                    if (byMid) {
                      const byMidPid = (byMid as { provider_id?: string; providerId?: string }).provider_id ?? (byMid as { providerId?: string }).providerId;
                      if (!providerFilter || byMidPid === providerFilter) {
                        gatewayLog("WARN", `herald fallback ${fid} not found via byProviderModel, using byModelId ${midPart}`, { fid, fallbackModel: midPart, providerId: byMidPid ?? null });
                        m = byMid;
                      } else {
                        gatewayLog("WARN", `herald fallback ${fid} not found`, { fid, reason: "provider mismatch for byModelId fallback" });
                      }
                    } else {
                      const anyForProvider = enabledModels.find((x) => ((x as { provider_id?: string; providerId?: string }).provider_id ?? (x as { providerId?: string }).providerId) === fPid);
                      if (anyForProvider) {
                        const anyMid = (anyForProvider as { model_id?: string; modelId?: string }).model_id ?? (anyForProvider as { modelId?: string }).modelId ?? "";
                        gatewayLog("WARN", `herald fallback ${fid} not found, using any enabled model for provider ${fPid}`, { fid, fallbackModel: anyMid, providerId: fPid });
                        m = anyForProvider;
                      } else {
                        gatewayLog("WARN", `herald fallback ${fid} not found`, { fid, reason: "no enabled model for provider" });
                      }
                    }
                  }
                } else if (scopedModels) {
                  m = scopedModels.find((x) => ((x as { model_id?: string; modelId?: string }).model_id ?? (x as { modelId?: string }).modelId) === fid);
                  if (!m) {
                    const byMid = byModelId.get(fid);
                    if (byMid) {
                      const byMidPid = (byMid as { provider_id?: string; providerId?: string }).provider_id ?? (byMid as { providerId?: string }).providerId;
                      if (!providerFilter || byMidPid === providerFilter) {
                        gatewayLog("WARN", `herald fallback ${fid} not found in scopedModels, using byModelId`, { fid, providerId: byMidPid ?? null });
                        m = byMid;
                      }
                    }
                    if (!m) gatewayLog("WARN", `herald fallback ${fid} not found`, { fid });
                  }
                } else {
                  m = byModelId.get(fid);
                  if (!m) gatewayLog("WARN", `herald fallback ${fid} not found via byModelId`, { fid });
                }
                if (!m) continue;
                const cfg = toConfig(m);
                if (!cfg) continue;
                if (providerFilter && cfg.providerId !== providerFilter) continue;
                if (cfg.providerId === primaryCfg.providerId && cfg.model === primaryCfg.model) continue;
                if (configs.some((c) => c.providerId === cfg.providerId && c.model === cfg.model)) continue;
                configs.push(cfg);
              }
              if (configs.length === 1) {
                for (const m of enabledModels) {
                  if (configs.length >= 3) break;
                  const cfg = toConfig(m);
                  if (!cfg) continue;
                  if (cfg.providerId === primaryCfg.providerId && cfg.model === primaryCfg.model) continue;
                  if (providerFilter && cfg.providerId !== providerFilter) continue;
                  if (configs.some((c) => c.providerId === cfg.providerId && c.model === cfg.model)) continue;
                  gatewayLog("WARN", `herald fallback supplemented to ensure >1 config`, { addedModel: cfg.model, providerId: cfg.providerId });
                  configs.push(cfg);
                }
              }
              if (configs.length > 0) {
                const out = configs.slice(0, 3);
                gatewayLog("DEBUG", "herald resolveFallback done", { projectId, count: out.length, models: out.map((c) => ({ providerId: c.providerId ?? null, model: c.model, kind: c.kind, baseUrl: safeBaseUrl(c.baseUrl, c.kind) })) });
                return out;
              }
            }
          }
        }

        if (providerFilter) {
          const configs: ProviderConfig[] = [];
          for (const m of (scopedModels ?? []) as typeof enabledModels) {
            if (configs.length >= 3) break;
            const cfg = toConfig(m);
            if (!cfg) continue;
            configs.push(cfg);
          }
          if (configs.length > 0) {
            const out = configs.slice(0, 3);
            gatewayLog("DEBUG", "herald resolveFallback done", { projectId, count: out.length, models: out.map((c) => ({ providerId: c.providerId ?? null, model: c.model, kind: c.kind, baseUrl: safeBaseUrl(c.baseUrl, c.kind) })) });
            return out;
          }
          return yield* Effect.fail(new ProviderNotConfigured({ projectId }));
        }

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
          configs.push({ kind: normalizeProviderKind((m as { kind: unknown }).kind), baseUrl, apiKey, model: modelId, providerId: pid });
        }
        if (configs.length > 0) {
          const out = configs.slice(0, 3);
          gatewayLog("DEBUG", "herald resolveFallback done", { projectId, count: out.length, models: out.map((c) => ({ providerId: c.providerId ?? null, model: c.model, kind: c.kind, baseUrl: safeBaseUrl(c.baseUrl, c.kind) })) });
          return out;
        }
        return yield* Effect.fail(new ProviderNotConfigured({ projectId }));
      }) as Effect.Effect<ProviderConfig[], ProviderNotConfigured>);

    const streamChat = (input: GatewayStreamInput): AsyncIterable<StreamChunk> => {
      let filteredMessages = input.messages.filter(
        (m) => !(m.role === "user" && typeof (m as { content?: unknown }).content === "string" && String((m as { content: string }).content).trim() === "")
      );
      if (filteredMessages.length === 0) {
        filteredMessages = [{ role: "user", content: "Generate based on document context." } as ModelMessage];
      }
      const fallbackPromise: Promise<ProviderConfig[]> =
        input.fallbackConfigs !== undefined
          ? Promise.resolve(input.fallbackConfigs.slice(0, 3))
          : Effect.runPromise(resolveFallback(input.projectId).pipe(Effect.catchAll(() => Effect.succeed([] as ProviderConfig[]))));

      return {
        [Symbol.asyncIterator]: async function* () {
          const configs = (await fallbackPromise).map((c) => ({ ...c, kind: normalizeProviderKind((c as { kind: unknown }).kind) as ProviderConfig["kind"] }));
          const limited = configs.slice(0, 3);
          if (limited.length === 0) {
            throw new ProviderNotConfigured({ projectId: input.projectId });
          }
          const isSingleConfig = limited.length === 1;
          const attemptConfigs = limited.slice();
          const isSingleRetry = isSingleConfig;
          let lastError: unknown = null;
          let retriedSingleNetwork = false;
          const attempts: Array<{ model: string; providerId: string | null; status: number | null; providerMessage: string | null; raw: string; errorTag: string | null; retryAfter: number | null }> = [];
          for (let i = 0; i < attemptConfigs.length; i++) {
            gatewayLog("DEBUG", "herald stream attempt abort check", { projectId: input.projectId, attempt: i + 1, total: attemptConfigs.length, aborted: !!input.abortController?.signal.aborted, abortReason: (() => { try { return (input.abortController?.signal as unknown as { reason?: unknown })?.reason ? String((input.abortController?.signal as unknown as { reason: unknown }).reason).slice(0, 200) : null; } catch { return null; } })() });
            if (input.abortController?.signal.aborted) {
              gatewayLog("INFO", `herald stream aborted before attempt ${i + 1}`, { projectId: input.projectId, attempt: i + 1, total: attemptConfigs.length });
              break;
            }
            const cfg = attemptConfigs[i]!;
            gatewayLog("DEBUG", "herald stream attempt config", { projectId: input.projectId, attempt: i + 1, total: attemptConfigs.length, providerId: cfg.providerId ?? null, model: cfg.model, kind: normalizeProviderKind(cfg.kind), baseUrl: safeBaseUrl(cfg.baseUrl, cfg.kind), apiKeyMask: maskApiKeyShort(cfg.apiKey) });
            if (cfg.providerId) {
              try {
                const allowed = await Effect.runPromise(health.isAllowed(cfg.providerId).pipe(Effect.catchAll(() => Effect.succeed(true))));
                if (!allowed) {
                  gatewayLog("DEBUG", "herald stream health blocked", { projectId: input.projectId, providerId: cfg.providerId, attempt: i + 1 });
                  continue;
                }
              } catch {}
            }
            const singleRetryLabel = isSingleRetry && i === 1 ? " (single-config retry)" : "";
            const start = Date.now();
            gatewayLog("INFO", `herald stream attempt ${i + 1}/${attemptConfigs.length}${singleRetryLabel} start`, { projectId: input.projectId, attempt: i + 1, total: attemptConfigs.length, providerId: cfg.providerId ?? null, model: cfg.model, kind: normalizeProviderKind(cfg.kind), baseUrl: safeBaseUrl(cfg.baseUrl, cfg.kind), apiKeyMask: maskApiKeyShort(cfg.apiKey), singleRetry: isSingleRetry && i === 1 });
            try {
              normalizeBaseUrl(cfg.baseUrl, cfg.kind);
            } catch (e) {
              const diag = diagFromError(e);
              const err = translateRunError(e, cfg);
              lastError = err;
              attempts.push({ model: cfg.model, providerId: cfg.providerId ?? null, status: diag.status, providerMessage: diag.providerMessage, raw: diag.raw.slice(0, 500), errorTag: (err as { _tag?: string })._tag ?? null, retryAfter: diag.retryAfter });
              gatewayLog("ERROR", `herald stream attempt ${i + 1}/${attemptConfigs.length} failed (baseUrl) — ${(err as { message?: string }).message ?? String(err)}`, { projectId: input.projectId, attempt: i + 1, total: attemptConfigs.length, providerId: cfg.providerId ?? null, model: cfg.model, kind: normalizeProviderKind(cfg.kind), baseUrl: safeBaseUrl(cfg.baseUrl, cfg.kind), apiKeyMask: maskApiKeyShort(cfg.apiKey), status: diag.status, providerMessage: diag.providerMessage, raw: diag.raw.slice(0, 500), rawEvent: diag.rawEvent, stack: diag.stack, causeChain: diag.causeChain, errorTag: (err as { _tag?: string })._tag ?? null, latencyMs: Date.now() - start, retryAfter: diag.retryAfter, backoffMs: backoffMsFor(err, i), singleRetry: isSingleRetry && i === 1 });
              if (cfg.providerId) {
                try { await Effect.runPromise(health.recordFailure(cfg.providerId).pipe(Effect.catchAll(() => Effect.void))); } catch {}
              }
              try { const l3 = (callLogRepo as never as Record<string, unknown>); const fn3 = (l3.log ?? l3.insert) as ((i: unknown) => Effect.Effect<void, unknown>) | undefined; if (fn3) await Effect.runPromise(fn3.call(callLogRepo, { id: crypto.randomUUID(), projectId: input.projectId, providerId: cfg.providerId ?? null, model: cfg.model, kind: cfg.kind, status: "error", errorCode: (err as { _tag: string })._tag, latencyMs: Date.now() - start } as never).pipe(Effect.catchAll(() => Effect.void)));
              } catch {}
              if (input.abortController?.signal.aborted) throw err;
              if (isSingleConfig && !retriedSingleNetwork && isSingleRetryCandidate(err) && i === 0) {
                retriedSingleNetwork = true;
                attemptConfigs.push(cfg);
                gatewayLog("WARN", `herald stream retrying next model after baseUrl failure`, { projectId: input.projectId, attempt: i + 1, nextModel: attemptConfigs[i + 1]?.model ?? null, singleRetry: true, status: diag.status, errorTag: (err as { _tag?: string })._tag ?? null, retryAfter: diag.retryAfter, backoffMs: backoffMsFor(err, 0) });
                if (!isRetriable(err)) { /* push still honors single retry candidate */ } else { await sleepBackoff(err, 0, { projectId: input.projectId, model: cfg.model, providerId: cfg.providerId ?? null }); }
                continue;
              }
              if (i === attemptConfigs.length - 1) {
                if (attempts.length > 1 || attemptConfigs.length > 1) {
                  gatewayLog("FATAL", `herald stream all ${attemptConfigs.length} models failed (baseUrl)`, { projectId: input.projectId, total: attemptConfigs.length, lastError: (err as { message?: string }).message ?? String(err), attempts, errorTag: (err as { _tag?: string })._tag ?? null, status: diag.status, providerMessage: diag.providerMessage, retryAfter: diag.retryAfter });
                  const detail = attempts.map((a) => `${a.model}: ${a.providerMessage ?? a.raw.slice(0, 80)} (${a.status ?? "?"}/${a.errorTag ?? "?"})`).join("; ");
                  const combined = `all models failed — ${detail}`.slice(0, 500);
                  throw new HeraldGenerationFailed({ message: combined, status: diag.status, providerMessage: diag.providerMessage, raw: diag.raw.slice(0, 500), attempts } as never);
                }
                throw err;
              }
              if (!isRetriable(err)) throw err;
              await sleepBackoff(err, i, { projectId: input.projectId, model: cfg.model, providerId: cfg.providerId ?? null });
              gatewayLog("WARN", `herald stream retrying next model after baseUrl failure`, { projectId: input.projectId, attempt: i + 1, nextModel: attemptConfigs[i + 1]?.model ?? null, singleRetry: isSingleRetry && i === 0, status: diag.status, errorTag: (err as { _tag?: string })._tag ?? null, retryAfter: diag.retryAfter, backoffMs: backoffMsFor(err, i) });
              continue;
            }
            try {
              void buildAdapter(cfg);
              gatewayLog("DEBUG", "herald stream dispatch config snapshot", { projectId: input.projectId, attempt: i + 1, total: attemptConfigs.length, providerId: cfg.providerId ?? null, model: cfg.model, kind: normalizeProviderKind(cfg.kind), baseUrl: safeBaseUrl(cfg.baseUrl, cfg.kind), apiKeyMask: maskApiKeyShort(cfg.apiKey) });
              gatewayLog("INFO", `herald stream dispatch attempt ${i + 1}/${attemptConfigs.length}${singleRetryLabel}`, { attempt: i + 1, total: attemptConfigs.length, providerId: cfg.providerId ?? null, model: cfg.model, kind: normalizeProviderKind(cfg.kind), baseUrl: safeBaseUrl(cfg.baseUrl, cfg.kind), singleRetry: isSingleRetry && i === 1 });
              const iterable = providerStreamChat({
                config: cfg,
                systemPrompts: input.systemPrompts,
                messages: filteredMessages,
                tools: input.tools,
                abortController: input.abortController,
                modelOptions: input.modelOptions,
              });
              let usageIn = 0; let usageOut = 0;
              let generatedText = "";
              let inToolCallLeak = false;
              for await (const chunk of iterable) {
                if ((chunk as { type?: string }).type === "RUN_ERROR") {
                  const c = chunk as Record<string, unknown>;
                  gatewayLog("ERROR", `herald RUN_ERROR chunk received before translate`, { projectId: input.projectId, providerId: cfg.providerId ?? null, model: cfg.model, code: c.code ?? null, message: String(c.message ?? "").slice(0, 500), rawEvent: c.rawEvent ?? null });
                  const e = Object.assign(new Error(String(c.message ?? "run error")), {
                    code: c.code,
                    status: c.code,
                    rawEvent: c.rawEvent,
                    error: c.rawEvent,
                    cause: c.rawEvent,
                  });
                  throw translateRunError(e, cfg);
                }
                if ((chunk as { type?: string }).type === "TEXT_MESSAGE_CONTENT") {
                  let d = (chunk as { delta?: string }).delta ?? "";
                  if (inToolCallLeak) {
                    const end = d.search(/<\/tool_call>/i);
                    if (end !== -1) {
                      d = d.slice(end + "</tool_call>".length);
                      inToolCallLeak = false;
                      d = d.replace(/<tool_call>[\s\S]*?(?:<\/tool_call>|$)/gi, (m) => {
                        if (!m.toLowerCase().includes("</tool_call>")) inToolCallLeak = true;
                        return "";
                      });
                    } else {
                      d = "";
                    }
                  } else if (/<tool_call>/i.test(d)) {
                    d = d.replace(/<tool_call>[\s\S]*?(?:<\/tool_call>|$)/gi, (m) => {
                      if (!m.toLowerCase().includes("</tool_call>")) inToolCallLeak = true;
                      return "";
                    });
                  }
                  generatedText += d;
                  if ((chunk as { delta?: string }).delta !== d) {
                    if (d === "") continue;
                    yield { ...chunk, delta: d } as StreamChunk;
                    continue;
                  }
                }
                if ((chunk as { type?: string }).type === "RUN_FINISHED") {
                  const u = (chunk as { usage?: { input?: number; output?: number; promptTokens?: number; completionTokens?: number } }).usage;
                  usageIn = Number(u?.input ?? u?.promptTokens ?? 0);
                  usageOut = Number(u?.output ?? u?.completionTokens ?? 0);
                }
                yield chunk;
              }
              generatedText = stripToolCallXml(generatedText);
              {
                let costCents = 0;
                let estimated = false;
                if (usageIn === 0 && usageOut === 0) {
                  const inputText = [
                    ...(input.systemPrompts?.map((p) => typeof (p as { content?: unknown }).content === "string" ? String((p as { content: string }).content) : JSON.stringify((p as { content: unknown }).content ?? "")) ?? []),
                    ...filteredMessages.map((m) => typeof (m as { content?: unknown }).content === "string" ? String((m as { content: string }).content) : Array.isArray((m as { content?: unknown }).content) ? JSON.stringify((m as { content: unknown }).content) : JSON.stringify((m as { content?: unknown }).content ?? "")),
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
              gatewayLog("INFO", `herald stream attempt ${i + 1}/${attemptConfigs.length}${singleRetryLabel} succeeded`, { attempt: i + 1, total: attemptConfigs.length, providerId: cfg.providerId ?? null, model: cfg.model, kind: normalizeProviderKind(cfg.kind), baseUrl: safeBaseUrl(cfg.baseUrl, cfg.kind), latencyMs: Date.now() - start, singleRetry: isSingleRetry && i === 1 });
              return;
            } catch (e) {
              const tagged = (e as { _tag?: string })?._tag;
              const diag = diagFromError(e);
              const err = tagged === "ProviderAuthFailed" || tagged === "ProviderUnreachable" || tagged === "HeraldGenerationFailed" ? (e as ReturnType<typeof translateRunError>) : translateRunError(e, cfg);
              lastError = err;
              attempts.push({ model: cfg.model, providerId: cfg.providerId ?? null, status: diag.status, providerMessage: diag.providerMessage, raw: diag.raw.slice(0, 500), errorTag: (err as { _tag?: string })._tag ?? null, retryAfter: diag.retryAfter });
              gatewayLog("ERROR", `herald stream attempt ${i + 1}/${attemptConfigs.length}${singleRetryLabel} failed — ${(err as { message?: string }).message ?? String(err)}`, { projectId: input.projectId, attempt: i + 1, total: attemptConfigs.length, providerId: cfg.providerId ?? null, model: cfg.model, kind: normalizeProviderKind(cfg.kind), baseUrl: safeBaseUrl(cfg.baseUrl, cfg.kind), apiKeyMask: maskApiKeyShort(cfg.apiKey), status: diag.status, providerMessage: diag.providerMessage, raw: diag.raw.slice(0, 800), rawEvent: diag.rawEvent, stack: diag.stack, causeChain: diag.causeChain, errorTag: (err as { _tag?: string })._tag ?? null, latencyMs: Date.now() - start, retryAfter: diag.retryAfter, backoffMs: backoffMsFor(err, i), singleRetry: isSingleRetry && i === 1 });
              if (cfg.providerId && !(isSingleConfig && retriedSingleNetwork && (err as { _tag?: string })._tag === "ProviderAuthFailed")) {
                try { await Effect.runPromise(health.recordFailure(cfg.providerId).pipe(Effect.catchAll(() => Effect.void))); } catch {}
              }
              try { const l3 = (callLogRepo as never as Record<string, unknown>); const fn3 = (l3.log ?? l3.insert) as ((i: unknown) => Effect.Effect<void, unknown>) | undefined; if (fn3) await Effect.runPromise(fn3.call(callLogRepo, { id: crypto.randomUUID(), projectId: input.projectId, providerId: cfg.providerId ?? null, model: cfg.model, kind: cfg.kind, status: "error", errorCode: (err as { _tag: string })._tag, latencyMs: Date.now() - start } as never).pipe(Effect.catchAll(() => Effect.void)));
              } catch {}
              if (input.abortController?.signal.aborted) throw err;
              if (isSingleConfig && !retriedSingleNetwork && isSingleRetryCandidate(err) && i === 0) {
                retriedSingleNetwork = true;
                attemptConfigs.push(cfg);
                gatewayLog("WARN", `herald stream retrying next model (single-config retry same provider)`, { projectId: input.projectId, attempt: i + 1, nextModel: cfg.model, nextProviderId: cfg.providerId ?? null, singleRetry: true, status: diag.status, errorTag: (err as { _tag?: string })._tag ?? null, retryAfter: diag.retryAfter, backoffMs: backoffMsFor(err, 0) });
                await sleepBackoff(err, 0, { projectId: input.projectId, model: cfg.model, providerId: cfg.providerId ?? null });
                continue;
              }
              if (i === attemptConfigs.length - 1) {
                if (attempts.length > 1 || attemptConfigs.length > 1) {
                  gatewayLog("FATAL", `herald stream all ${attemptConfigs.length} models failed`, { projectId: input.projectId, total: attemptConfigs.length, lastError: (err as { message?: string }).message ?? String(err), lastStack: diag.stack, attempts, singleRetry: isSingleRetry, errorTag: (err as { _tag?: string })._tag ?? null, status: diag.status, providerMessage: diag.providerMessage, retryAfter: diag.retryAfter });
                  const detail = attempts.map((a) => `${a.model}: ${a.providerMessage ?? a.raw.slice(0, 80)} (${a.status ?? "?"}/${a.errorTag ?? "?"})`).join("; ");
                  const combined = `all models failed — ${detail}`.slice(0, 500);
                  throw new HeraldGenerationFailed({ message: combined, status: diag.status, providerMessage: diag.providerMessage, raw: diag.raw.slice(0, 500), attempts, errorTag: (err as { _tag?: string })._tag ?? null } as never);
                }
                throw err;
              }
              if (!isRetriable(err)) throw err;
              await sleepBackoff(err, i, { projectId: input.projectId, model: cfg.model, providerId: cfg.providerId ?? null });
              gatewayLog("WARN", `herald stream retrying next model${isSingleRetry && i === 0 ? " (single-config retry same provider)" : ""}`, { projectId: input.projectId, attempt: i + 1, nextModel: attemptConfigs[i + 1]?.model ?? null, nextProviderId: attemptConfigs[i + 1]?.providerId ?? null, singleRetry: isSingleRetry && i === 0, status: diag.status, errorTag: (err as { _tag?: string })._tag ?? null, retryAfter: diag.retryAfter, backoffMs: backoffMsFor(err, i) });
            }
          }
          if (attempts.length > 0) {
            const first = attempts[0]!;
            const detail = attempts.map((a) => `${a.model}: ${a.providerMessage ?? a.raw.slice(0, 80)} (${a.status ?? "?"}/${a.errorTag ?? "?"})`).join("; ");
            const combined = `all models failed — ${detail}`.slice(0, 500);
            const lastDiag = lastError ? diagFromError(lastError) : { status: first.status, providerMessage: first.providerMessage, raw: first.raw };
            throw new HeraldGenerationFailed({ message: combined, status: lastDiag.status, providerMessage: lastDiag.providerMessage, raw: lastDiag.raw.slice(0, 500), attempts, errorTag: (lastError as { _tag?: string })?._tag ?? null } as never);
          }
          if (lastError) throw lastError;
          throw new HeraldGenerationFailed({ message: "all models failed", attempts } as never);
        },
      } as AsyncIterable<StreamChunk>;
    };

    const testConnection = (
      projectId: string,
      override?: { providerId?: string | null; modelId?: string | null; fallbackModelIds?: string[]; kind?: string; baseUrl?: string; model?: string; apiKey?: string },
      opts?: { signal?: AbortSignal }
    ): Effect.Effect<{ ok: true; latencyMs: number }, ProviderNotConfigured | HeraldGenerationFailed | import("../api/errors").ProviderAuthFailed | import("../api/errors").ProviderUnreachable> =>
      Effect.gen(function* () {
        if (override?.kind && override?.baseUrl && override?.model) {
          const cfg: ProviderConfig = {
            kind: normalizeProviderKind(override.kind),
            baseUrl: override.baseUrl,
            model: override.model,
            apiKey: override.apiKey ?? "",
          };
          yield* Effect.sync(() => gatewayLog("DEBUG", "herald test direct config", { projectId, providerId: cfg.providerId ?? null, model: cfg.model, kind: normalizeProviderKind(cfg.kind), baseUrl: safeBaseUrl(cfg.baseUrl, cfg.kind), apiKeyMask: maskApiKeyShort(cfg.apiKey) }));
          yield* Effect.sync(() => gatewayLog("INFO", `herald test direct start`, { projectId, providerId: cfg.providerId ?? null, model: cfg.model, kind: normalizeProviderKind(cfg.kind), baseUrl: safeBaseUrl(cfg.baseUrl, cfg.kind), apiKeyMask: maskApiKeyShort(cfg.apiKey) }));
          const res = yield* Effect.tryPromise({
            try: () => providerTestConnection(cfg, opts),
            catch: (e) => {
              const diag = diagFromError(e);
              gatewayLog("ERROR", `herald test direct failed — ${(e as { message?: string })?.message ?? String(e)}`, { projectId, providerId: cfg.providerId ?? null, model: cfg.model, kind: normalizeProviderKind(cfg.kind), baseUrl: safeBaseUrl(cfg.baseUrl, cfg.kind), apiKeyMask: maskApiKeyShort(cfg.apiKey), status: diag.status, providerMessage: diag.providerMessage, raw: diag.raw.slice(0, 800), rawEvent: diag.rawEvent, stack: diag.stack, causeChain: diag.causeChain, errorTag: (e as { _tag?: string })?._tag ?? null, retryAfter: diag.retryAfter });
              return translateRunError(e, cfg) as never;
            },
          }).pipe(Effect.tap((r) => Effect.sync(() => gatewayLog("INFO", `herald test direct succeeded`, { projectId, model: cfg.model, latencyMs: r.latencyMs }))));
          return res;
        }

        let configs: ProviderConfig[] | null = null;

        if (override?.providerId && override?.modelId) {
          const models = (yield* modelRepo.listAll().pipe(Effect.catchAll((e: unknown) => (e as { _tag?: string })?._tag === "RowNotFound" ? Effect.succeed([] as Array<never>) : Effect.fail(e as never)))) as Array<{ provider_id?: string; providerId?: string; kind: ProviderConfig["kind"]; model_id?: string; modelId?: string; enabled?: boolean; priority?: number; id?: string }>;
          const providers = (yield* providerRepo.list().pipe(Effect.catchAll((e: unknown) => (e as { _tag?: string })?._tag === "RowNotFound" ? Effect.succeed([] as Array<{ id: string }>) : Effect.fail(e as never)))) as Array<{ id: string; base_url?: string; baseUrl?: string; api_key?: string; apiKey?: string }>;
          const byId = new Map((providers as Array<{ id: string }>).map((p: { id: string }) => [p.id, p] as const));
          const byProviderModel = new Map<string, typeof models[number]>();
          for (const m of models) {
            const pid = (m as { provider_id?: string; providerId?: string }).provider_id ?? (m as { providerId?: string }).providerId ?? "";
            const mid = (m as { model_id?: string; modelId?: string }).model_id ?? (m as { modelId?: string }).modelId ?? "";
            if (pid && mid) byProviderModel.set(`${pid}:${mid}`, m);
          }
          const byModelId = new Map<string, typeof models[number]>();
          for (const m of models) {
            const mid = (m as { model_id?: string; modelId?: string }).model_id ?? (m as { modelId?: string }).modelId ?? "";
            if (mid && !byModelId.has(mid)) byModelId.set(mid, m);
          }
          const toConfig = (m: typeof models[number]): ProviderConfig | null => {
            const pid = (m as { provider_id?: string; providerId?: string }).provider_id ?? (m as { providerId?: string }).providerId;
            if (!pid) return null;
            const p = byId.get(pid) as { base_url?: string; baseUrl?: string; api_key?: string; apiKey?: string } | undefined;
            if (!p) return null;
            const baseUrl = p.base_url ?? p.baseUrl ?? "";
            const apiKey = p.api_key ?? p.apiKey ?? "";
            const modelId = (m as { model_id?: string; modelId?: string }).model_id ?? (m as { modelId?: string }).modelId ?? "";
            return { kind: normalizeProviderKind((m as { kind: unknown }).kind), baseUrl, apiKey, model: modelId, providerId: pid };
          };
          const pid = override.providerId!;
          const mid = override.modelId!;
          const key = `${pid}:${mid}`;
          let primaryModel = byProviderModel.get(key) ?? null;
          if (!primaryModel) {
            primaryModel = models.find((m) => ((m as { model_id?: string; modelId?: string }).model_id ?? (m as { modelId?: string }).modelId) === mid && ((m as { provider_id?: string; providerId?: string }).provider_id ?? (m as { providerId?: string }).providerId) === pid) ?? null;
          }
          if (!primaryModel) return yield* Effect.fail(new ProviderNotConfigured({ projectId }));
          const primaryCfg = toConfig(primaryModel);
          if (!primaryCfg || primaryCfg.model !== mid || primaryCfg.providerId !== pid) {
            if (!primaryCfg) return yield* Effect.fail(new ProviderNotConfigured({ projectId }));
          }
          configs = primaryCfg ? [primaryCfg] : [];
          let fallbackIds: string[] = [];
          if (override.fallbackModelIds && override.fallbackModelIds.length > 0) {
            fallbackIds = override.fallbackModelIds.filter((x): x is string => typeof x === "string");
          } else {
            const settingsRow = (yield* settingsRepo.getByProject(projectId).pipe(
              Effect.map((r) => r as unknown as { fallback_model_ids: string }),
              Effect.catchTag("RowNotFound", () => Effect.succeed(null)),
              Effect.catchAll(() => Effect.succeed(null))
            )) as { fallback_model_ids: string } | null;
            if (settingsRow) {
              try {
                const v = JSON.parse(settingsRow.fallback_model_ids ?? "[]");
                if (Array.isArray(v)) fallbackIds = v.filter((x: unknown) => typeof x === "string");
              } catch {}
            }
            if (fallbackIds.length === 0) {
              const enabledForProvider = models.filter((m) => ((m as { provider_id?: string; providerId?: string }).provider_id ?? (m as { providerId?: string }).providerId) === pid && (m as { enabled?: boolean }).enabled !== false).sort((a, b) => ((a as { priority?: number }).priority ?? 0) - ((b as { priority?: number }).priority ?? 0));
              for (const m of enabledForProvider) {
                const mmid = (m as { model_id?: string; modelId?: string }).model_id ?? (m as { modelId?: string }).modelId ?? "";
                if (mmid === mid) continue;
                fallbackIds.push(`${pid}:${mmid}`);
                if (fallbackIds.length >= 2) break;
              }
            }
          }
          for (const fid of fallbackIds) {
            if (configs.length >= 3) break;
            let m: typeof models[number] | undefined;
            if (fid.includes(":")) {
              const [fPid, ...rest] = fid.split(":") as [string, ...string[]];
              if (fPid !== pid) continue;
              m = byProviderModel.get(fid) ?? undefined;
              if (!m) {
                const midPart = rest.join(":");
                const byMid = byModelId.get(midPart);
                if (byMid) {
                  const byMidPid = (byMid as { provider_id?: string; providerId?: string }).provider_id ?? (byMid as { providerId?: string }).providerId;
                  if (byMidPid === pid) {
                    gatewayLog("WARN", `herald fallback ${fid} not found via byProviderModel, using byModelId ${midPart}`, { fid, fallbackModel: midPart, providerId: pid });
                    m = byMid;
                  } else {
                    gatewayLog("WARN", `herald fallback ${fid} not found`, { fid, reason: "provider mismatch for byModelId fallback" });
                  }
                } else {
                  const anyForProvider = models.find((x) => ((x as { provider_id?: string; providerId?: string }).provider_id ?? (x as { providerId?: string }).providerId) === pid && (x as { enabled?: boolean }).enabled !== false && ((x as { model_id?: string; modelId?: string }).model_id ?? (x as { modelId?: string }).modelId) === midPart);
                  if (anyForProvider) { m = anyForProvider; gatewayLog("WARN", `herald fallback ${fid} not found, using enabled model for provider`, { fid, providerId: pid }); }
                  else gatewayLog("WARN", `herald fallback ${fid} not found`, { fid });
                }
              }
            } else {
              m = byModelId.get(fid);
              if (m && ((m as { provider_id?: string; providerId?: string }).provider_id ?? (m as { providerId?: string }).providerId) !== pid) m = undefined;
              if (!m) gatewayLog("WARN", `herald fallback ${fid} not found via byModelId`, { fid });
            }
            if (!m) continue;
            const cfg = toConfig(m);
            if (!cfg) continue;
            if (cfg.providerId !== pid) continue;
            if (configs.some((c) => c.providerId === cfg.providerId && c.model === cfg.model)) continue;
            configs.push(cfg);
          }
          configs = configs.slice(0, 3);
          if (configs.length === 0) return yield* Effect.fail(new ProviderNotConfigured({ projectId }));
        } else {
          configs = yield* resolveFallback(projectId);
        }

        const limited = configs.slice(0, 3);
        if (limited.length === 0) return yield* Effect.fail(new ProviderNotConfigured({ projectId }));
        const isSingleConfig = limited.length === 1;
        const attemptConfigs = limited.slice();
        const isSingleRetry = isSingleConfig;
        let retriedSingleNetwork = false;

        const attempts: Array<{ model: string; providerId: string | null; error: string; status: number | null; providerMessage: string | null; stack: string | null; rawEvent: string | null; raw: string; errorTag: string | null; retryAfter: number | null }> = [];
        let lastError: unknown = null;
        let success: { ok: true; latencyMs: number } | null = null;
        for (let i = 0; i < attemptConfigs.length; i++) {
          yield* Effect.sync(() => gatewayLog("DEBUG", "herald test attempt abort check", { projectId, attempt: i + 1, total: attemptConfigs.length, aborted: !!opts?.signal?.aborted }));
          if (opts?.signal?.aborted) {
            yield* Effect.sync(() => gatewayLog("INFO", `herald test aborted before attempt ${i + 1}`, { projectId, attempt: i + 1, total: attemptConfigs.length }));
            break;
          }
          const cfg = attemptConfigs[i]!;
          yield* Effect.sync(() => gatewayLog("DEBUG", "herald test attempt config", { projectId, attempt: i + 1, total: attemptConfigs.length, providerId: cfg.providerId ?? null, model: cfg.model, kind: normalizeProviderKind(cfg.kind), baseUrl: safeBaseUrl(cfg.baseUrl, cfg.kind), apiKeyMask: maskApiKeyShort(cfg.apiKey) }));
          const singleRetryLabel = isSingleRetry && i === 1 ? " (single-config retry)" : "";
          const attemptStart = Date.now();
          yield* Effect.sync(() => gatewayLog("INFO", `herald test attempt ${i + 1}/${attemptConfigs.length}${singleRetryLabel} start`, { projectId, attempt: i + 1, total: attemptConfigs.length, providerId: cfg.providerId ?? null, model: cfg.model, kind: normalizeProviderKind(cfg.kind), baseUrl: safeBaseUrl(cfg.baseUrl, cfg.kind), apiKeyMask: maskApiKeyShort(cfg.apiKey), singleRetry: isSingleRetry && i === 1 }));
          try {
            const res = yield* Effect.tryPromise({
              try: () => providerTestConnection(cfg, opts),
              catch: (e) => translateRunError(e, cfg) as never,
            });
            yield* Effect.sync(() => gatewayLog("INFO", `herald test attempt ${i + 1}/${attemptConfigs.length}${singleRetryLabel} succeeded`, { attempt: i + 1, total: attemptConfigs.length, providerId: cfg.providerId ?? null, model: cfg.model, latencyMs: res.latencyMs, singleRetry: isSingleRetry && i === 1 }));
            success = res;
            break;
          } catch (e) {
            const diag = diagFromError(e);
            const err = (e as { _tag?: string })?._tag ? e : translateRunError(e, cfg);
            lastError = err;
            const msg = (err as { message?: string }).message ?? String(err);
            const rawSlice = diag.raw.slice(0, 500);
            attempts.push({ model: cfg.model, providerId: cfg.providerId ?? null, error: msg.slice(0, 500), status: diag.status, providerMessage: diag.providerMessage, stack: diag.stack, rawEvent: diag.rawEvent, raw: diag.raw.slice(0, 500), errorTag: (err as { _tag?: string })._tag ?? null, retryAfter: diag.retryAfter });
            yield* Effect.sync(() => gatewayLog("ERROR", `herald test attempt ${i + 1}/${attemptConfigs.length}${singleRetryLabel} failed — ${msg.slice(0, 300)}`, { projectId, attempt: i + 1, total: attemptConfigs.length, providerId: cfg.providerId ?? null, model: cfg.model, kind: normalizeProviderKind(cfg.kind), baseUrl: safeBaseUrl(cfg.baseUrl, cfg.kind), apiKeyMask: maskApiKeyShort(cfg.apiKey), status: diag.status, providerMessage: diag.providerMessage, raw: rawSlice, rawEvent: diag.rawEvent, stack: diag.stack, causeChain: diag.causeChain, errorTag: (err as { _tag?: string })._tag ?? null, latencyMs: Date.now() - attemptStart, retryAfter: diag.retryAfter, backoffMs: backoffMsFor(err, i), singleRetry: isSingleRetry && i === 1 }));
            const tag = (err as { _tag?: string })?._tag;
            if (opts?.signal?.aborted) throw err as never;
            if (isSingleConfig && !retriedSingleNetwork && isSingleRetryCandidate(err) && i === 0) {
              retriedSingleNetwork = true;
              attemptConfigs.push(cfg);
              yield* Effect.sync(() => gatewayLog("WARN", `herald test retrying next model (single-config retry same provider)`, { projectId, attempt: i + 1, nextModel: cfg.model, nextProviderId: cfg.providerId ?? null, failuresSoFar: attempts.length, singleRetry: true, status: diag.status, errorTag: tag ?? null, retryAfter: diag.retryAfter, backoffMs: backoffMsFor(err, 0) }));
              yield* Effect.promise(() => sleepBackoff(err, 0, { projectId, model: cfg.model, providerId: cfg.providerId ?? null }));
              continue;
            }
            if (i === attemptConfigs.length - 1) {
              if (attempts.length > 1 || attemptConfigs.length > 1) {
                const detail = attempts.map((a) => `${a.model}: ${a.error} (${a.status ?? "?"}/${a.errorTag ?? "?"})`).join("; ");
                const combined = `all models failed — ${detail}`.slice(0, 500);
                yield* Effect.sync(() => gatewayLog("FATAL", `herald test all ${attemptConfigs.length} models failed — aggregate`, { projectId, total: attemptConfigs.length, attempts, combined, singleRetry: isSingleRetry, status: diag.status, errorTag: tag ?? null, retryAfter: diag.retryAfter }));
                throw new HeraldGenerationFailed({ message: combined, status: diag.status, providerMessage: diag.providerMessage, raw: diag.raw.slice(0, 500), attempts, errorTag: tag ?? null } as never);
              }
              throw err as never;
            }
            if (isRetriable(err)) yield* Effect.promise(() => sleepBackoff(err, i, { projectId, model: cfg.model, providerId: cfg.providerId ?? null }));
            yield* Effect.sync(() => gatewayLog("WARN", `herald test retrying next model${isSingleRetry && i === 0 ? " (single-config retry same provider)" : ""}`, { projectId, attempt: i + 1, nextModel: attemptConfigs[i + 1]?.model ?? null, nextProviderId: attemptConfigs[i + 1]?.providerId ?? null, failuresSoFar: attempts.length, singleRetry: isSingleRetry && i === 0, status: diag.status, errorTag: tag ?? null, retryAfter: diag.retryAfter, backoffMs: backoffMsFor(err, i) }));
          }
        }
        if (success) return success;
        if (lastError) {
          const lastDiag = diagFromError(lastError);
          if (attempts.length > 0) {
            const detail = attempts.map((a) => `${a.model}: ${a.error} (${a.status ?? "?"}/${a.errorTag ?? "?"})`).join("; ");
            const combined = `all models failed — ${detail}`.slice(0, 500);
            throw new HeraldGenerationFailed({ message: combined, status: lastDiag.status, providerMessage: lastDiag.providerMessage, raw: lastDiag.raw.slice(0, 500), attempts, errorTag: (lastError as { _tag?: string })._tag ?? null } as never);
          }
          throw lastError as never;
        }
        throw new HeraldGenerationFailed({ message: "all models failed", attempts } as never);
      });

    return { resolveFallback, streamChat, testConnection } as const;
  }),
}) {}
