import { chat, type AnyTextAdapter, type DebugOption, type ModelMessage, type StreamChunk } from "@tanstack/ai";
import { createOpenaiChatCompletions } from "@tanstack/ai-openai";
import { createAnthropicChat } from "@tanstack/ai-anthropic";
import type { ProviderKind } from "../../shared/herald";
import { ProviderAuthFailed, ProviderUnreachable, HeraldGenerationFailed } from "../api/errors";
import type { CacheablePrompt } from "./prompt";
import { getEnv } from "../env";

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
    const line = JSON.stringify({
      level,
      service: "tanstack-ai",
      message: msg,
      ...(meta !== undefined ? { meta } : {}),
      timestamp: new Date().toISOString(),
    });
    if (level === "ERROR") process.stderr.write(line + "\n");
    else process.stdout.write(line + "\n");
  };
  return {
    debug: (m, meta) => write("DEBUG", m, meta),
    info: (m, meta) => write("INFO", m, meta),
    warn: (m, meta) => write("WARN", m, meta),
    error: (m, meta) => write("ERROR", m, meta),
  };
}

function debugOption(): DebugOption | undefined {
  const base = tanstackDebug();
  if (base === undefined) return undefined;
  const logger = structuredTanstackLogger();
  if (logger === undefined) return base;
  if (typeof base === "boolean") return { logger } as DebugOption;
  return { ...(base as Record<string, unknown>), logger } as DebugOption;
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

type OpenAiChatModel = Parameters<typeof createOpenaiChatCompletions>[0];
type AnthropicChatModel = Parameters<typeof createAnthropicChat>[0];

// openai_compatible: the OpenAI SDK expects baseURL to INCLUDE /v1 (its
// default is https://api.openai.com/v1). anthropic_compatible: the Anthropic
// SDK appends /v1/messages itself, so a trailing /v1 must be stripped.
export function normalizeBaseUrl(raw: string, kind: ProviderKind): string {
  const trimmed = raw.trim();
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const url = new URL(withScheme);
  const stripped = url.pathname.replace(/\/+$/, "");
  if (kind === "openai_compatible") {
    url.pathname = /\/v1$/.test(stripped) ? stripped : `${stripped}/v1`;
  } else {
    url.pathname = stripped.replace(/\/v1$/, "");
  }
  return url.toString();
}

// DEVIATION (declared): settings.model is free text — custom compat endpoints
// name models the adapter unions have never heard of. The factories only
// accept their known model literal unions, so the arbitrary string is cast.
// No compile-time protection for custom endpoints; upstream 400s surface as
// HERALD_GENERATION_FAILED via translateRunError.
export function buildAdapter(config: ProviderConfig): AnyTextAdapter {
  if (config.kind === "openai_compatible") {
    return createOpenaiChatCompletions(config.model as OpenAiChatModel, config.apiKey, {
      baseURL: normalizeBaseUrl(config.baseUrl, config.kind),
    });
  }
  return createAnthropicChat(config.model as AnthropicChatModel, config.apiKey, {
    baseURL: normalizeBaseUrl(config.baseUrl, config.kind),
  });
}

function toSystemPrompts(kind: ProviderKind, prompts: CacheablePrompt[]) {
  if (kind === "anthropic_compatible") {
    return prompts.map((p) =>
      p.cache_control ? { content: p.content, metadata: { cache_control: p.cache_control } } : p.content
    );
  }
  // OpenAI-compatible providers reject per-prompt metadata — strip it.
  return prompts.map((p) => p.content);
}

export interface StreamChatInput {
  config: ProviderConfig;
  systemPrompts: CacheablePrompt[];
  messages: ModelMessage[];
  tools?: ReadonlyArray<unknown>;
  abortController?: AbortController;
  // Merged verbatim into the provider request body by the adapter's
  // mapOptionsToRequest (e.g. { reasoning_effort: "high" }).
  modelOptions?: Record<string, unknown>;
}

// The ONLY file that imports chat() (S12). Everything provider-shaped goes
// through here so an SDK upgrade touches this file alone.
export function streamChat(input: StreamChatInput): AsyncIterable<StreamChunk> {
  const debug = debugOption();
  return chat({
    adapter: buildAdapter(input.config),
    systemPrompts: toSystemPrompts(input.config.kind, input.systemPrompts) as never,
    messages: input.messages,
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

// OpenAI wire: GET {base}/models with Bearer. Anthropic wire: GET {base}/v1/models
// with x-api-key + anthropic-version. normalizeBaseUrl already put /v1 where
// each kind needs it.
export async function listModels(
  config: ProviderConfig,
  fetchImpl: FetchLike = fetch
): Promise<{ models: { id: string }[] }> {
  const base = normalizeBaseUrl(config.baseUrl, config.kind).replace(/\/+$/, "");
  const path = config.kind === "openai_compatible" ? "/models" : "/v1/models";
  const headers: Record<string, string> =
    config.kind === "openai_compatible"
      ? { authorization: `Bearer ${config.apiKey}` }
      : { "x-api-key": config.apiKey, "anthropic-version": ANTHROPIC_VERSION };
  let res: Response;
  try {
    res = await fetchImpl(`${base}${path}`, { headers, signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new ProviderUnreachable({});
  }
  if (res.status === 401 || res.status === 403) throw new ProviderAuthFailed({});
  if (!res.ok) throw new ProviderUnreachable({ message: `models endpoint returned ${res.status}` });
  const body = (await res.json()) as { data?: Array<{ id?: string }>; models?: Array<{ id?: string }> };
  const items = body.data ?? body.models ?? [];
  return { models: items.filter((m) => typeof m.id === "string").map((m) => ({ id: m.id as string })) };
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
        const n = Number(m[1]);
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

export function translateRunError(e: unknown): ProviderAuthFailed | ProviderUnreachable | HeraldGenerationFailed {
  const parts: string[] = [];
  collectErrorText(e, parts);
  const raw = parts.join(" | ").slice(0, 600);
  const msg = raw.toLowerCase();
  const statusCode = extractStatusCode(e);
  if (
    statusCode === 401 ||
    statusCode === 403 ||
    /\b(401|403)\b/.test(msg) ||
    msg.includes("unauthorized") ||
    msg.includes("invalid api key") ||
    msg.includes("incorrect api key") ||
    msg.includes("forbidden")
  ) {
    return new ProviderAuthFailed({});
  }
  if (
    statusCode === 429 ||
    /\b429\b/.test(msg) ||
    msg.includes("rate limit") ||
    msg.includes("rate_limit") ||
    msg.includes("too many requests")
  ) {
    return new ProviderUnreachable({ message: raw.slice(0, 300) || "rate limited" });
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
    return new ProviderUnreachable({});
  }
  const providerMessage = extractProviderMessage(e);
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
      const suffix = raw.slice(0, 300 - detail.length - 3);
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
  return new HeraldGenerationFailed({ message: detail.slice(0, 300) });
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
    throw translateRunError(e);
  }
}
