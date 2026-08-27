/**
 * Herald provider logging
 * Levels: DEBUG (verbose config/flow, enabled via LOG_LEVEL=debug|trace or TANSTACK_AI_DEBUG=1),
 *         INFO (normal operational), WARN (retriable/transient), ERROR (failure after retries or single-shot),
 *         FATAL (terminal non-retriable or all-retries exhausted).
 * Enable DEBUG: LOG_LEVEL=debug or trace, or TANSTACK_AI_DEBUG=1 / true. Structured TanStack logs: TANSTACK_AI_JSON=1 (service tanstack-ai).
 */
import { chat, type AnyTextAdapter, type DebugOption, type ModelMessage, type StreamChunk } from "@tanstack/ai";
import { createOpenaiChat, createOpenaiChatCompletions } from "@tanstack/ai-openai";
import { createAnthropicChat } from "@tanstack/ai-anthropic";
import type { ProviderKind } from "../../shared/herald";
import { ProviderAuthFailed, ProviderUnreachable, HeraldGenerationFailed } from "../api/errors";
import type { CacheablePrompt } from "./prompt";
import { getEnv } from "../env";

export type HeraldLogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR" | "FATAL";

function isDebugEnabled(): boolean {
  const env = getEnv();
  const raw = env.TANSTACK_AI_DEBUG;
  if (raw !== undefined) {
    const v = raw.trim();
    if (v === "1" || v.toLowerCase() === "true") return true;
    if (v === "0" || v.toLowerCase() === "false") {
    } else {
      try {
        const parsed = JSON.parse(v);
        if (parsed) return true;
      } catch {
        return true;
      }
    }
  }
  const lvl = (env.LOG_LEVEL ?? "").toLowerCase();
  return lvl === "debug" || lvl === "trace";
}

export function heraldLog(level: HeraldLogLevel, message: string, meta?: Record<string, unknown>): void {
  if (level === "DEBUG" && !isDebugEnabled()) return;
  try {
    const line = JSON.stringify({
      level,
      service: "herald-provider",
      message,
      ...(meta !== undefined ? { meta } : {}),
      timestamp: new Date().toISOString(),
    });
    if (level === "ERROR" || level === "FATAL") process.stderr.write(line + "\n");
    else process.stdout.write(line + "\n");
  } catch {}
}

function tanstackDebug(): DebugOption | undefined {
  const env = getEnv();
  const raw = env.TANSTACK_AI_DEBUG;
  if (raw !== undefined) {
    const v = raw.trim();
    if (v === "1" || v.toLowerCase() === "true") return true;
    if (v === "0" || v.toLowerCase() === "false") return false;
    try {
      return JSON.parse(v) as DebugOption;
    } catch {
      return true;
    }
  }
  const lvl = (env.LOG_LEVEL ?? "").toLowerCase();
  if (lvl === "debug" || lvl === "trace") return true;
  return undefined;
}

function structuredTanstackLogger(): import("@tanstack/ai").Logger | undefined {
  const env = getEnv();
  if ((env.TANSTACK_AI_JSON ?? "").trim() !== "1") return undefined;
  const write = (level: string, msg: string, meta?: Record<string, unknown>) => {
    let normalizedMeta = meta;
    if (meta && typeof meta === "object") {
      const m = meta as Record<string, unknown>;
      const hasKind = "kind" in m || "providerKind" in m || "modelKind" in m;
      const hasBase = "baseUrl" in m || "base_url" in m || "baseURL" in m;
      if (hasKind || hasBase) {
        normalizedMeta = { ...m };
        for (const k of ["kind", "providerKind", "modelKind"] as const) {
          if (typeof normalizedMeta[k] === "string") normalizedMeta[k] = normalizeProviderKind(normalizedMeta[k]);
        }
        for (const k of ["baseUrl", "base_url", "baseURL"] as const) {
          if (typeof normalizedMeta[k] === "string") {
            try {
              const kindForBase = (normalizedMeta.kind ?? normalizedMeta.providerKind ?? "openai_compatible") as string;
              normalizedMeta[k] = normalizeBaseUrl(String(normalizedMeta[k]), kindForBase);
            } catch {}
          }
        }
      }
    }
    const line = JSON.stringify({
      level,
      service: "tanstack-ai",
      message: msg,
      ...(normalizedMeta !== undefined ? { meta: normalizedMeta } : {}),
      timestamp: new Date().toISOString(),
    });
    if (level === "ERROR" || level === "FATAL") process.stderr.write(line + "\n");
    else process.stdout.write(line + "\n");
  };
  return {
    debug: (m: string, meta?: Record<string, unknown>) => write("DEBUG", m, meta),
    info: (m: string, meta?: Record<string, unknown>) => write("INFO", m, meta),
    warn: (m: string, meta?: Record<string, unknown>) => write("WARN", m, meta),
    error: (m: string, meta?: Record<string, unknown>) => write("ERROR", m, meta),
    fatal: (m: string, meta?: Record<string, unknown>) => write("FATAL", m, meta),
  } as unknown as import("@tanstack/ai").Logger;
}

function debugOption(): DebugOption | undefined {
  const base = tanstackDebug();
  if (base === undefined) return undefined;
  const logger = structuredTanstackLogger();
  if (logger === undefined) return base;
  if (typeof base === "boolean") return { logger } as DebugOption;
  return { ...(base as Record<string, unknown>), logger } as DebugOption;
}

export function normalizeProviderKind(raw: unknown): ProviderKind {
  if (raw === "openai_compatible" || raw === "anthropic_compatible" || raw === "openai_responses") return raw;
  if (raw === "responses" || raw === "responses_compatible" || raw === "openai_compatible_responses" || raw === "openai-responses") return "openai_responses";
  if (raw === "openai-chat" || raw === "openai") return "openai_compatible";
  if (raw === "anthropic" || raw === "anthropic-chat" || raw === "anthropic_compatible") return "anthropic_compatible";
  return "openai_compatible";
}

// OpenCode Go's /v1/models (https://opencode.ai/docs/go) returns {object:"list",data:[{id,...}]}
// with no kind field. Provider wire (chat/completions vs messages vs responses) must be
// inferred per-model id from the registry table at https://opencode.ai/docs/go.
export function inferModelKind(modelId: string): ProviderKind {
  const lower = modelId.toLowerCase();
  if (lower.startsWith("minimax-") || lower.startsWith("qwen")) return "anthropic_compatible";
  if (lower.startsWith("muse-") || lower.startsWith("grok-") || lower.startsWith("gpt-") || lower.startsWith("claude")) return "openai_responses";
  return "openai_compatible";
}

export interface ProviderConfig {
  kind: ProviderKind;
  baseUrl: string;
  apiKey: string;
  model: string;
  providerId?: string;
}

export function configForModel(
  provider: { base_url: string; api_key: string },
  model: { kind: ProviderKind; model_id: string }
): ProviderConfig {
  return { kind: model.kind, baseUrl: provider.base_url, apiKey: provider.api_key, model: model.model_id };
}

export function buildAdapterForModel(
  provider: { base_url: string; api_key: string },
  model: { kind: ProviderKind; model_id: string }
): AnyTextAdapter {
  return buildAdapter(configForModel(provider, model));
}

type OpenAiChatCompletionsModel = Parameters<typeof createOpenaiChatCompletions>[0];
type OpenAiResponsesModel = Parameters<typeof createOpenaiChat>[0];
type AnthropicChatModel = Parameters<typeof createAnthropicChat>[0];

// openai_compatible / openai_responses: the OpenAI SDK expects baseURL to
// INCLUDE /v1 (default https://api.openai.com/v1). Responses endpoint is
// {base}/responses where base already /v1, so same normalization as
// chat/completions.
// anthropic_compatible: the Anthropic SDK appends /v1/messages itself, so a
// trailing /v1 must be stripped from base to avoid doubling (/v1/v1/messages).
export function normalizeBaseUrl(raw: string, kind: ProviderKind | string): string {
  const coerced = normalizeProviderKind(kind);
  const trimmed = raw.trim();
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const url = new URL(withScheme);
  const stripped = url.pathname.replace(/\/+$/, "");
  if (coerced === "openai_compatible" || coerced === "openai_responses") {
    url.pathname = /\/v1$/.test(stripped) ? stripped : `${stripped}/v1`;
  } else {
    url.pathname = stripped.replace(/\/v1$/, "");
  }
  const normalized = url.toString();
  heraldLog("DEBUG", "herald-provider normalizeBaseUrl", { raw, kind: coerced, normalized });
  return normalized;
}

// DEVIATION (declared): settings.model is free text — custom compat endpoints
// name models the adapter unions have never heard of. The factories only
// accept their known model literal unions, so the arbitrary string is cast.
// No compile-time protection for custom endpoints; upstream 400s surface as
// HERALD_GENERATION_FAILED via translateRunError.
export function buildAdapter(config: ProviderConfig): AnyTextAdapter {
  const kind = normalizeProviderKind(config.kind);
  heraldLog("DEBUG", "herald-provider buildAdapter", {
    kind,
    model: config.model,
    providerId: config.providerId ?? null,
    baseUrl: (() => { try { return normalizeBaseUrl(config.baseUrl, kind); } catch { return config.baseUrl; } })(),
    apiKeyMask: maskApiKey(config.apiKey),
  });
  if (kind === "openai_compatible") {
    return createOpenaiChatCompletions(config.model as OpenAiChatCompletionsModel, config.apiKey, {
      baseURL: normalizeBaseUrl(config.baseUrl, kind),
    });
  }
  if (kind === "openai_responses") {
    return createOpenaiChat(config.model as OpenAiResponsesModel, config.apiKey, {
      baseURL: normalizeBaseUrl(config.baseUrl, kind),
    });
  }
  return createAnthropicChat(config.model as AnthropicChatModel, config.apiKey, {
    baseURL: normalizeBaseUrl(config.baseUrl, kind),
  });
}

function toSystemPrompts(kind: ProviderKind | string, prompts: CacheablePrompt[]) {
  if (normalizeProviderKind(kind) === "anthropic_compatible") {
    return prompts.map((p) =>
      p.cache_control ? { content: p.content, metadata: { cache_control: p.cache_control } } : p.content
    );
  }
  // OpenAI-compatible + Responses providers reject per-prompt metadata — strip it.
  return prompts.map((p) => p.content);
}

export interface StreamChatInput {
  config: ProviderConfig;
  systemPrompts: CacheablePrompt[];
  messages: ModelMessage[];
  tools?: ReadonlyArray<unknown> | undefined;
  abortController?: AbortController | undefined;
  // Merged verbatim into the provider request body by the adapter's
  // mapOptionsToRequest (e.g. { reasoning_effort: "high" }).
  modelOptions?: Record<string, unknown> | undefined;
}

// The ONLY file that imports chat() (S12). Everything provider-shaped goes
// through here so an SDK upgrade touches this file alone.
export function streamChat(input: StreamChatInput): AsyncIterable<StreamChunk> {
  const debug = debugOption();
  let filteredMessages = input.messages.filter(
    (m) => !(m.role === "user" && typeof (m as { content?: unknown }).content === "string" && String((m as { content: string }).content).trim() === "")
  );
  if (filteredMessages.length === 0) {
    filteredMessages = [{ role: "user", content: "Generate based on document context." } as ModelMessage];
  }
  return chat({
    adapter: buildAdapter(input.config),
    systemPrompts: toSystemPrompts(input.config.kind, input.systemPrompts) as never,
    messages: filteredMessages,
    tools: input.tools as never,
    abortController: input.abortController,
    ...(input.modelOptions !== undefined ? { modelOptions: input.modelOptions } : {}),
    ...(debug !== undefined ? { debug } : {}),
  }) as AsyncIterable<StreamChunk>;
}

// Non-streaming one-shot completion (rolling summary, connection test).
export async function completeText(
  config: ProviderConfig,
  input: { systemPrompts?: CacheablePrompt[]; messages: ModelMessage[] },
  opts?: { signal?: AbortSignal; abortController?: AbortController }
): Promise<string> {
  const debug = debugOption();
  let abortController = opts?.abortController;
  if (!abortController && opts?.signal) {
    abortController = new AbortController();
    const sig = opts.signal;
    if (sig.aborted) abortController.abort((sig as AbortSignal & { reason?: unknown }).reason);
    else sig.addEventListener("abort", () => abortController!.abort((sig as AbortSignal & { reason?: unknown }).reason), { once: true });
  }
  return (await chat({
    adapter: buildAdapter(config),
    systemPrompts: toSystemPrompts(config.kind, input.systemPrompts ?? []) as never,
    messages: input.messages,
    stream: false,
    ...(abortController !== undefined ? { abortController } : {}),
    ...(debug !== undefined ? { debug } : {}),
  })) as string;
}

export interface FetchLike {
  (input: string, init?: RequestInit): Promise<Response>;
}

const ANTHROPIC_VERSION = "2023-06-01";

// OpenAI wire (openai_compatible + openai_responses): GET {base}/models with
// Bearer where base already includes /v1. Anthropic wire: GET {base}/v1/models
// with x-api-key + anthropic-version where base has /v1 stripped (SDK appends
// /v1/messages, so listModels must re-add /v1). normalizeBaseUrl already
// normalized per kind.
export async function listModels(
  config: ProviderConfig,
  fetchImpl: FetchLike = fetch
): Promise<{ models: { id: string }[] }> {
  const kind = normalizeProviderKind(config.kind);
  const base = normalizeBaseUrl(config.baseUrl, kind).replace(/\/+$/, "");
  const isOpenAiWire = kind === "openai_compatible" || kind === "openai_responses";
  const path = isOpenAiWire ? "/models" : "/v1/models";
  const headers: Record<string, string> = isOpenAiWire
    ? { authorization: `Bearer ${config.apiKey}` }
    : { "x-api-key": config.apiKey, "anthropic-version": ANTHROPIC_VERSION };
  heraldLog("DEBUG", "herald-provider listModels request", { kind, base, path, model: config.model, providerId: config.providerId ?? null, apiKeyMask: maskApiKey(config.apiKey) });
  let res: Response;
  try {
    res = await fetchImpl(`${base}${path}`, { headers, signal: AbortSignal.timeout(15_000) });
  } catch (e) {
    heraldLog("WARN", "herald-provider listModels fetch failed", { kind, base, path, error: String(e).slice(0, 500) });
    throw new ProviderUnreachable({});
  }
  heraldLog("DEBUG", "herald-provider listModels response", { kind, base, path, status: res.status });
  if (res.status === 401 || res.status === 403) throw new ProviderAuthFailed({});
  if (!res.ok) throw new ProviderUnreachable({ message: `models endpoint returned ${res.status}` });
  const body = (await res.json()) as { data?: Array<{ id?: string }>; models?: Array<{ id?: string }> };
  const items = body.data ?? body.models ?? [];
  const models = items.filter((m) => typeof m.id === "string").map((m) => ({ id: m.id as string }));
  heraldLog("DEBUG", "herald-provider listModels parsed", { kind, count: models.length });
  return { models };
}

function maskApiKey(key: string): string {
  if (!key) return "(empty)";
  const len = key.length;
  if (len <= 8) return `*** (len=${len})`;
  return `${key.slice(0, 3)}***${key.slice(-4)} (len=${len})`;
}

function extractStack(e: unknown): string | null {
  if (e instanceof Error && typeof e.stack === "string" && e.stack.trim()) return e.stack.slice(0, 2000);
  if (typeof e === "object" && e !== null && "stack" in e && typeof (e as Record<string, unknown>).stack === "string") {
    const s = String((e as Record<string, unknown>).stack);
    if (s.trim()) return s.slice(0, 2000);
  }
  return null;
}

function extractCauseChain(e: unknown, depth = 0, seen = new Set<unknown>()): string | null {
  if (e === null || e === undefined || depth > 5) return null;
  if (typeof e === "object" && seen.has(e)) return null;
  if (typeof e === "object" && e !== null) seen.add(e);
  const parts: string[] = [];
  let cur: unknown = e;
  for (let i = 0; i < 6; i++) {
    if (cur === null || cur === undefined) break;
    if (typeof cur === "object" && seen.has(cur) && i > 0) break;
    if (cur instanceof Error) {
      if (cur.cause !== undefined && cur.cause !== null) {
        const c = cur.cause as unknown;
        parts.push(`${cur.name}: ${cur.message} -> cause: ${typeof c === "string" ? c : c instanceof Error ? `${(c as Error).name}: ${(c as Error).message}` : (() => { try { return JSON.stringify(c).slice(0, 400); } catch { return String(c).slice(0, 400); } })()}`);
        cur = c;
        if (typeof cur === "object" && cur !== null) seen.add(cur);
        continue;
      }
      break;
    }
    const obj = cur as Record<string, unknown>;
    if (obj.cause !== undefined && obj.cause !== null && obj.cause !== cur) {
      const c = obj.cause;
      const preview = typeof c === "string" ? c.slice(0, 400) : c instanceof Error ? `${(c as Error).name}: ${(c as Error).message}` : (() => { try { return JSON.stringify(c).slice(0, 400); } catch { return String(c).slice(0, 400); } })();
      parts.push(`cause: ${preview}`);
      cur = c;
      continue;
    }
    break;
  }
  return parts.length > 0 ? parts.join(" | ").slice(0, 800) : null;
}

function extractRawEventJson(e: unknown): string | null {
  if (typeof e !== "object" || e === null) return null;
  const obj = e as Record<string, unknown>;
  const candidate = obj.rawEvent ?? obj.error ?? obj.metadata ?? null;
  if (candidate === null || candidate === undefined) return null;
  try {
    const s = typeof candidate === "string" ? candidate : JSON.stringify(candidate);
    if (!s.trim()) return null;
    return s.slice(0, 800);
  } catch {
    try { return String(candidate).slice(0, 800); } catch { return null; }
  }
}

function collectErrorText(e: unknown, out: string[], depth = 0): void {
  if (e === null || e === undefined || depth > 4) return;
  if (e instanceof Error) {
    if (e.name) out.push(e.name);
    out.push(e.message);
    collectErrorText((e as { cause?: unknown }).cause, out, depth + 1);
    return;
  }
  if (typeof e === "object") {
    const obj = e as Record<string, unknown>;
    if (typeof obj.message === "string" && obj.message) out.push(obj.message);
    if (typeof obj.code === "string" && obj.code) out.push(String(obj.code));
    if (typeof obj.status === "number") out.push(String(obj.status));
    if (obj.cause !== undefined) collectErrorText(obj.cause, out, depth + 1);
    if (obj.error !== undefined && obj.error !== e) collectErrorText(obj.error, out, depth + 1);
    if (obj.rawEvent !== undefined && obj.rawEvent !== e) collectErrorText(obj.rawEvent, out, depth + 1);
    return;
  }
  out.push(String(e));
}

function extractStatusCode(e: unknown, depth = 0, seen = new Set<unknown>()): number | undefined {
  if (e === null || e === undefined || depth > 4 || (typeof e === "object" && seen.has(e))) return undefined;
  if (typeof e === "object") seen.add(e);
  const obj = e as Record<string, unknown>;
  const numericCode = (v: unknown): number | undefined => {
    if (typeof v === "number" && Number.isFinite(v) && v >= 100 && v < 600) return v;
    if (typeof v === "string" && /^\d{3}$/.test(v.trim())) {
      const n = Number(v.trim());
      if (n >= 100 && n < 600) return n;
    }
    return undefined;
  };
  if (typeof e === "object" && e !== null) {
    const direct = numericCode(obj.status) ?? numericCode(obj.code);
    if (direct !== undefined) return direct;
    for (const key of ["error", "rawEvent", "metadata", "cause"] as const) {
      const v = obj[key];
      if (v !== undefined && v !== null && typeof v === "object") {
        const found = extractStatusCode(v, depth + 1, seen);
        if (found !== undefined) return found;
      }
    }
    if (typeof obj.status === "string") {
      const m = obj.status.match(/\b(\d{3})\b/);
      if (m) {
        const n = Number(m[1]!);
        if (n >= 100 && n < 600) return n;
      }
    }
  }
  return undefined;
}

function extractProviderMessage(e: unknown, depth = 0, seen = new Set<unknown>()): string | undefined {
  if (e === null || e === undefined || depth > 5 || (typeof e === "object" && seen.has(e))) return undefined;
  if (typeof e === "object") seen.add(e);
  const obj = e as Record<string, unknown>;
  const tryMessage = (v: unknown): string | undefined => {
    if (typeof v === "string" && v.trim()) return v.trim();
    if (v !== null && typeof v === "object") {
      const r = v as Record<string, unknown>;
      if (typeof r.message === "string" && r.message.trim()) return r.message.trim();
      if (r.error !== undefined) {
        const inner = tryMessage(r.error);
        if (inner) return inner;
      }
    }
    return undefined;
  };
  for (const key of ["rawEvent", "error", "metadata", "cause"] as const) {
    const v = obj[key];
    if (v !== undefined && v !== null) {
      const m = tryMessage(v);
      if (m) return m;
      if (typeof v === "object") {
        const deep = extractProviderMessage(v, depth + 1, seen);
        if (deep) return deep;
      }
    }
  }
  if (typeof obj.message === "string" && obj.message.trim()) {
    const nested = extractProviderMessage(obj.error, depth + 1, seen) ?? extractProviderMessage(obj.rawEvent, depth + 1, seen);
    if (nested) return nested;
  }
  return undefined;
}

export function extractRetryAfter(e: unknown, depth = 0, seen = new Set<unknown>()): number | null {
  if (e === null || e === undefined || depth > 6 || (typeof e === "object" && seen.has(e))) return null;
  if (typeof e === "object") seen.add(e as object);
  const obj = e as Record<string, unknown>;
  const parseRetryValue = (v: unknown): number | null => {
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v > 0 && v < 1000 ? v * 1000 : v;
    if (typeof v === "string" && v.trim()) {
      const s = v.trim();
      if (/^\d+(\.\d+)?$/.test(s)) {
        const n = Number(s);
        if (Number.isFinite(n) && n >= 0) return n < 1000 ? n * 1000 : n;
      }
      const d = Date.parse(s);
      if (!Number.isNaN(d)) {
        const diff = d - Date.now();
        if (diff > 0 && diff < 3_600_000) return diff;
      }
    }
    return null;
  };
  for (const key of ["retryAfter", "retry-after", "retry_after", "Retry-After", "RetryAfter"] as const) {
    const v = obj[key];
    if (v !== undefined && v !== null) {
      const parsed = parseRetryValue(v);
      if (parsed !== null) return parsed;
    }
  }
  const headerSources: unknown[] = [obj.headers, obj.responseHeaders, obj.rawHeaders, (obj.response as Record<string, unknown> | undefined)?.headers];
  for (const hs of headerSources) {
    if (hs === undefined || hs === null) continue;
    if (hs instanceof Headers) {
      const v = hs.get("retry-after") ?? hs.get("Retry-After");
      if (v) {
        const parsed = parseRetryValue(v);
        if (parsed !== null) return parsed;
      }
      continue;
    }
    if (typeof hs === "object") {
      const h = hs as Record<string, unknown>;
      for (const k of Object.keys(h)) {
        if (k.toLowerCase() === "retry-after") {
          const parsed = parseRetryValue(h[k]);
          if (parsed !== null) return parsed;
        }
      }
      if (typeof (h as Record<string, unknown>).get === "function") {
        try {
          const v = (h as { get: (k: string) => unknown }).get("retry-after") ?? (h as { get: (k: string) => unknown }).get("Retry-After");
          if (v !== undefined && v !== null) {
            const parsed = parseRetryValue(v);
            if (parsed !== null) return parsed;
          }
        } catch {}
      }
    }
  }
  for (const key of ["error", "rawEvent", "metadata", "cause", "response", "body"] as const) {
    const v = obj[key];
    if (v !== undefined && v !== null && typeof v === "object") {
      const found = extractRetryAfter(v, depth + 1, seen);
      if (found !== null) return found;
    }
  }
  return null;
}

function extractUpstreamBody(e: unknown, depth = 0, seen = new Set<unknown>()): string | null {
  if (e === null || e === undefined || depth > 5 || (typeof e === "object" && seen.has(e))) return null;
  if (typeof e === "object") seen.add(e as object);
  const obj = e as Record<string, unknown>;
  for (const key of ["upstreamBody", "responseBody", "body", "responseText", "text"] as const) {
    const v = obj[key];
    if (typeof v === "string" && v.trim()) return v.slice(0, 800);
    if (v !== null && typeof v === "object") {
      try { const s = JSON.stringify(v); if (s.trim()) return s.slice(0, 800); } catch {}
    }
  }
  for (const key of ["error", "rawEvent", "metadata", "cause", "response"] as const) {
    const v = obj[key];
    if (v !== undefined && v !== null && typeof v === "object") {
      const found = extractUpstreamBody(v, depth + 1, seen);
      if (found) return found;
    }
  }
  return null;
}

export function isTransientUpstream(e: unknown): boolean {
  const status = extractStatusCode(e);
  if (status === 429 || status === 502 || status === 503 || status === 504 || status === 529) return true;
  if (status !== undefined && status >= 500 && status < 600 && status !== 501) return true;
  const parts: string[] = [];
  collectErrorText(e, parts);
  const msg = parts.join(" | ").toLowerCase();
  return (
    msg.includes("fetch failed") ||
    msg.includes("fetch_error") ||
    msg.includes("unable to connect") ||
    msg.includes("connection error") ||
    msg.includes("connection refused") ||
    msg.includes("network") ||
    msg.includes("econnrefused") ||
    msg.includes("econnreset") ||
    msg.includes("econnaborted") ||
    msg.includes("ehostunreach") ||
    msg.includes("enetunreach") ||
    msg.includes("enotfound") ||
    msg.includes("etimedout") ||
    msg.includes("timeout") ||
    msg.includes("getaddrinfo") ||
    msg.includes("aborted") ||
    msg.includes("aborterror") ||
    msg.includes("timeouterror") ||
    msg.includes("econn") ||
    msg.includes("eai_again")
  );
}

export function translateRunError(e: unknown, config?: ProviderConfig): ProviderAuthFailed | ProviderUnreachable | HeraldGenerationFailed {
  const parts: string[] = [];
  collectErrorText(e, parts);
  const raw = parts.join(" | ").slice(0, 800);
  const msg = raw.toLowerCase();
  const statusCode = extractStatusCode(e);
  const providerMessagePreview = extractProviderMessage(e);
  const retryAfterMs = extractRetryAfter(e);
  const upstreamBody = extractUpstreamBody(e);
  const isMappingError =
    msg.includes("unexpected token") ||
    msg.includes("json parse") ||
    msg.includes("failed to parse") ||
    msg.includes("syntaxerror") ||
    msg.includes("tool_call") ||
    msg.includes("<tool_call") ||
    msg.includes("xml leak") ||
    msg.includes("upstream response mapping");
  if (isMappingError) {
    const detailRaw = extractProviderMessage(e) ?? raw;
    const detail = `upstream response mapping failed: ${detailRaw.slice(0, 400)}`;
    const final = detail.slice(0, 500);
    heraldLog("FATAL", `[HeraldGenerationFailed] ${final}`, {
      errorTag: "HeraldGenerationFailed",
      status: statusCode ?? null,
      providerMessage: extractProviderMessage(e) ?? null,
      raw: raw.slice(0, 800),
      rawEvent: extractRawEventJson(e),
      upstreamBody: upstreamBody ?? extractRawEventJson(e),
      retryAfter: retryAfterMs,
      stack: extractStack(e),
      causeChain: extractCauseChain(e),
      request: config
        ? {
            providerId: config.providerId ?? null,
            baseUrl: (() => { try { return normalizeBaseUrl(config.baseUrl, config.kind); } catch { return config.baseUrl; } })(),
            kind: normalizeProviderKind(config.kind),
            model: config.model,
            apiKeyMask: maskApiKey(config.apiKey),
            apiKeyLen: config.apiKey.length,
          }
        : null,
    });
    return new HeraldGenerationFailed({
      message: final,
      status: statusCode ?? null,
      providerMessage: extractProviderMessage(e) ?? null,
      raw: raw.slice(0, 800),
      rawEvent: extractRawEventJson(e),
      upstreamBody: upstreamBody ?? extractRawEventJson(e),
      retryAfter: retryAfterMs,
    } as never);
  }
  if (
    statusCode === 401 ||
    statusCode === 403 ||
    /\b(401|403)\b/.test(msg) ||
    msg.includes("unauthorized") ||
    msg.includes("invalid api key") ||
    msg.includes("incorrect api key") ||
    msg.includes("forbidden")
  ) {
    heraldLog("FATAL", `[ProviderAuthFailed] ${raw.slice(0, 500)}`, {
      errorTag: "ProviderAuthFailed",
      status: statusCode ?? null,
      providerMessage: providerMessagePreview ?? null,
      raw: raw.slice(0, 800),
      retryAfter: retryAfterMs,
      stack: extractStack(e),
      causeChain: extractCauseChain(e),
      request: config ? { providerId: config.providerId ?? null, baseUrl: (() => { try { return normalizeBaseUrl(config.baseUrl, config.kind); } catch { return config.baseUrl; } })(), kind: normalizeProviderKind(config.kind), model: config.model, apiKeyMask: maskApiKey(config.apiKey) } : null,
    });
    return new ProviderAuthFailed({
      message: raw.slice(0, 500) || undefined,
      status: statusCode ?? null,
      providerMessage: providerMessagePreview ?? null,
      raw: raw.slice(0, 800),
      retryAfter: retryAfterMs,
    } as never);
  }
  if (
    statusCode === 429 ||
    /\b429\b/.test(msg) ||
    msg.includes("rate limit") ||
    msg.includes("rate_limit") ||
    msg.includes("too many requests")
  ) {
    heraldLog("WARN", `[ProviderUnreachable] ${raw.slice(0, 500) || "rate limited"}`, {
      errorTag: "ProviderUnreachable",
      status: statusCode ?? 429,
      providerMessage: providerMessagePreview ?? null,
      raw: raw.slice(0, 800),
      retryAfter: retryAfterMs,
      upstreamBody: upstreamBody ?? extractRawEventJson(e),
      stack: extractStack(e),
      causeChain: extractCauseChain(e),
      request: config ? { providerId: config.providerId ?? null, baseUrl: (() => { try { return normalizeBaseUrl(config.baseUrl, config.kind); } catch { return config.baseUrl; } })(), kind: normalizeProviderKind(config.kind), model: config.model, apiKeyMask: maskApiKey(config.apiKey) } : null,
    });
    return new ProviderUnreachable({
      message: raw.slice(0, 500) || "rate limited",
      status: statusCode ?? 429,
      providerMessage: providerMessagePreview ?? null,
      raw: raw.slice(0, 800),
      retryAfter: retryAfterMs,
      upstreamBody: upstreamBody ?? extractRawEventJson(e),
    } as never);
  }
  if (
    msg.includes("fetch failed") ||
    msg.includes("fetch_error") ||
    msg.includes("unable to connect") ||
    msg.includes("connection error") ||
    msg.includes("connection refused") ||
    msg.includes("network") ||
    msg.includes("econnrefused") ||
    msg.includes("econnreset") ||
    msg.includes("econnaborted") ||
    msg.includes("ehostunreach") ||
    msg.includes("enetunreach") ||
    msg.includes("enotfound") ||
    msg.includes("etimedout") ||
    msg.includes("timeout") ||
    msg.includes("getaddrinfo") ||
    msg.includes("aborted") ||
    msg.includes("aborterror") ||
    msg.includes("timeouterror")
  ) {
    heraldLog("WARN", `[ProviderUnreachable] ${raw.slice(0, 500)}`, {
      errorTag: "ProviderUnreachable",
      status: statusCode ?? null,
      providerMessage: providerMessagePreview ?? null,
      raw: raw.slice(0, 800),
      retryAfter: retryAfterMs,
      upstreamBody: upstreamBody ?? extractRawEventJson(e),
      stack: extractStack(e),
      causeChain: extractCauseChain(e),
      request: config ? { providerId: config.providerId ?? null, baseUrl: (() => { try { return normalizeBaseUrl(config.baseUrl, config.kind); } catch { return config.baseUrl; } })(), kind: normalizeProviderKind(config.kind), model: config.model, apiKeyMask: maskApiKey(config.apiKey) } : null,
    });
    return new ProviderUnreachable({
      message: raw.slice(0, 500) || undefined,
      status: statusCode ?? null,
      providerMessage: providerMessagePreview ?? null,
      raw: raw.slice(0, 800),
      retryAfter: retryAfterMs,
      upstreamBody: upstreamBody ?? extractRawEventJson(e),
    } as never);
  }
  const providerMessage = extractProviderMessage(e) ?? providerMessagePreview;
  let detail: string;
  if (providerMessage) {
    if (statusCode !== undefined && !providerMessage.trimStart().startsWith(String(statusCode))) {
      detail = `${statusCode} ${providerMessage}`;
    } else if (statusCode !== undefined) {
      detail = providerMessage;
    } else {
      detail = providerMessage;
    }
    if (statusCode !== undefined && raw.toLowerCase().includes(String(statusCode)) && detail.length < raw.length) {
      const suffix = raw.slice(0, 500 - detail.length - 3);
      if (suffix.trim() && !detail.includes(suffix.trim().slice(0, 20))) {
        // keep raw context only if it adds signal beyond the provider message
      }
    }
  } else {
    detail = raw;
    if (statusCode !== undefined && !detail.includes(String(statusCode))) {
      detail = `${statusCode} ${detail}`;
    }
  }
  const finalMessage = detail.slice(0, 500);
  const rawEventJson = extractRawEventJson(e);
  {
    const stack = extractStack(e);
    const causeChain = extractCauseChain(e);
    const rawSlice = raw.slice(0, 800);
    const requestMeta = config
      ? {
          providerId: config.providerId ?? null,
          baseUrl: (() => { try { return normalizeBaseUrl(config.baseUrl, config.kind); } catch { return config.baseUrl; } })(),
          kind: normalizeProviderKind(config.kind),
          model: config.model,
          apiKeyMask: maskApiKey(config.apiKey),
          apiKeyLen: config.apiKey.length,
        }
      : null;
    const causePreview = (() => {
      const c = (e as Record<string, unknown>)?.cause;
      if (c === undefined || c === null) return null;
      if (c instanceof Error) return `${c.name}: ${c.message}`.slice(0, 500);
      try { const s = typeof c === "string" ? c : JSON.stringify(c); return s.slice(0, 500); } catch { return String(c).slice(0, 500); }
    })();
    const isNonRetriableStatus = statusCode !== undefined && [400, 404, 422, 501].includes(statusCode);
    const isTransient = isTransientUpstream(e) || (statusCode !== undefined && ((statusCode === 429) || (statusCode >= 500 && statusCode < 600 && statusCode !== 501)));
    let level: HeraldLogLevel = "ERROR";
    if (isNonRetriableStatus) level = "FATAL";
    else if (isTransient) level = "WARN";
    heraldLog(level, `[HeraldGenerationFailed] ${finalMessage}`, {
      errorTag: "HeraldGenerationFailed",
      status: statusCode ?? null,
      providerMessage: providerMessage ?? null,
      raw: rawSlice,
      rawEvent: rawEventJson,
      upstreamBody: upstreamBody ?? rawEventJson,
      retryAfter: retryAfterMs,
      stack,
      cause: causePreview,
      causeChain,
      request: requestMeta,
    });
  }
  return new HeraldGenerationFailed({
    message: finalMessage,
    status: statusCode ?? null,
    providerMessage: providerMessage ?? null,
    raw: raw.slice(0, 800),
    rawEvent: rawEventJson,
    upstreamBody: upstreamBody ?? rawEventJson,
    retryAfter: retryAfterMs,
  } as never);
}

// Minimal completion ping against submitted (unsaved) values. Never persists.
export async function testConnection(
  config: ProviderConfig,
  opts?: { signal?: AbortSignal }
): Promise<{ ok: true; latencyMs: number }> {
  const startedAt = Date.now();
  const signal = opts?.signal ?? AbortSignal.timeout(30_000);
  try {
    await completeText(config, { messages: [{ role: "user", content: "Reply with the single word: ok" }] }, { signal });
    return { ok: true, latencyMs: Date.now() - startedAt };
  } catch (e) {
    throw translateRunError(e, config);
  }
}

export function getProviderDiagnostics(e: unknown): { status: number | null; providerMessage: string | null; stack: string | null; causeChain: string | null; rawEventJson: string | null; raw: string; retryAfter: number | null; upstreamBody: string | null } {
  const parts: string[] = [];
  collectErrorText(e, parts);
  const raw = parts.join(" | ").slice(0, 800);
  return {
    status: extractStatusCode(e) ?? null,
    providerMessage: extractProviderMessage(e) ?? null,
    stack: extractStack(e),
    causeChain: extractCauseChain(e),
    rawEventJson: extractRawEventJson(e),
    raw,
    retryAfter: extractRetryAfter(e),
    upstreamBody: extractUpstreamBody(e),
  };
}

export { extractStatusCode, extractProviderMessage, extractUpstreamBody };
