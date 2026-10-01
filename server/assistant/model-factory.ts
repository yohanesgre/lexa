// Registry config → AI SDK provider (ADR-0003 §C, P3).
//
// This module is the DO-side replacement for the TanStack adapter factory in
// `provider.ts`. It is deliberately pure of DB/service imports so the Durable
// Object can import it without pulling the Bun assistant stack (or
// `@tanstack/ai`) into the Worker bundle.
//
// The built-in `x-opencode-session` derivation is preserved 1:1 from
// `provider.ts` (ADR-0003 §C, D1 addendum): every provider call carries the
// per-conversation value `lexa-assistant-<threadId>`, falling back to the
// provider id then the model id. `provider.test.ts` keeps the two derivations
// in lockstep.

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";

export type ModelFactoryKind = "openai_compatible" | "anthropic_compatible" | "openai_responses";

/** Fetch signature shared with the AI SDK provider settings (matches `FetchFunction`). */
export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** One resolved provider binding (decrypted key included; never persisted by the DO). */
export interface RegistryModelConfig {
  kind: ModelFactoryKind;
  baseUrl: string;
  apiKey: string;
  model: string;
  providerId?: string | undefined;
  /** Per-conversation value for `x-opencode-session`; falls back to providerId/model. */
  sessionId?: string | undefined;
  /** Test seam: routes provider HTTP through an injected fetch (never set in production). */
  fetchImpl?: FetchLike | undefined;
}

export const OPENCODE_SESSION_HEADER = "x-opencode-session" as const;

// `@ai-sdk/openai`'s default baseURL already includes /v1 and appends /responses;
// `@ai-sdk/openai-compatible` appends /chat/completions to baseURL; and
// `@ai-sdk/anthropic` appends /messages to baseURL (default
// https://api.anthropic.com/v1). So every kind wants a base URL that ends in
// /v1 for the AI SDK — the inverse of the TanStack normalization in
// provider.ts (which strips /v1 for Anthropic because its SDK re-adds it).
export function baseUrlForProvider(raw: string, kind: ModelFactoryKind | string): string {
  const coerced = normalizeProviderKind(kind);
  const trimmed = raw.trim();
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const url = new URL(withScheme);
  const stripped = url.pathname.replace(/\/+$/, "");
  url.pathname = /\/v1$/.test(stripped) ? stripped : `${stripped}/v1`;
  return url.toString();
}

export function normalizeProviderKind(raw: unknown): ModelFactoryKind {
  if (raw === "openai_compatible" || raw === "anthropic_compatible" || raw === "openai_responses") return raw;
  if (raw === "responses" || raw === "responses_compatible" || raw === "openai_compatible_responses" || raw === "openai-responses") return "openai_responses";
  if (raw === "openai-chat" || raw === "openai") return "openai_compatible";
  if (raw === "anthropic" || raw === "anthropic-chat" || raw === "anthropic_compatible") return "anthropic_compatible";
  return "openai_compatible";
}

export function opencodeSessionIdFor(conversationId: string): string {
  const trimmed = conversationId.trim();
  return trimmed.startsWith("lexa-assistant-") ? trimmed : `lexa-assistant-${trimmed}`;
}

function fallbackSessionId(config: Pick<RegistryModelConfig, "providerId" | "model">): string {
  return `lexa-assistant-${config.providerId ?? config.model}`;
}

export function resolveOpencodeSessionId(
  sessionId: string | undefined,
  fallback: Pick<RegistryModelConfig, "providerId" | "model">,
): string {
  const trimmed = sessionId?.trim();
  if (trimmed) return trimmed.startsWith("lexa-assistant-") ? trimmed : `lexa-assistant-${trimmed}`;
  return fallbackSessionId(fallback);
}

function sessionHeaders(config: RegistryModelConfig): Record<string, string> {
  return { [OPENCODE_SESSION_HEADER]: resolveOpencodeSessionId(config.sessionId, config) };
}

// `exactOptionalPropertyTypes`-safe fetch seam: only attach `fetch` when a test
// injected one, so production providers keep their real transport. The cast is
// required because the AI SDK types the seam as `typeof fetch` (which carries
// `preconnect`), while tests inject the minimal `FetchLike` shape.
function fetchSetting(config: RegistryModelConfig): { fetch?: typeof fetch } {
  return config.fetchImpl ? { fetch: config.fetchImpl as unknown as typeof fetch } : {};
}

/** Build the AI SDK language model for one registry binding. */
export function buildLanguageModel(config: RegistryModelConfig): LanguageModel {
  const kind = normalizeProviderKind(config.kind);
  const baseURL = baseUrlForProvider(config.baseUrl, kind);
  const headers = sessionHeaders(config);
  const fetch = fetchSetting(config);
  if (kind === "openai_compatible") {
    return createOpenAICompatible({ name: "lexa-openai-compatible", baseURL, apiKey: config.apiKey, headers, ...fetch }).chatModel(config.model);
  }
  if (kind === "openai_responses") {
    return createOpenAI({ name: "lexa-openai-responses", baseURL, apiKey: config.apiKey, headers, ...fetch }).responses(config.model);
  }
  return createAnthropic({ name: "lexa-anthropic-compatible", baseURL, apiKey: config.apiKey, headers, ...fetch }).languageModel(config.model);
}

/** Primary first, then ≤2 fallbacks — the AI SDK side of `fallback_model_ids`. */
export function buildModelChain(configs: readonly RegistryModelConfig[]): LanguageModel[] {
  return configs.slice(0, 3).map((config) => buildLanguageModel(config));
}

// ── Error classification for the fallback walk (ADR-0003 §B.6/§C) ──────────

/** HTTP status carried by an AI SDK / fetch error, if any. */
export function statusOfError(e: unknown): number | undefined {
  const direct = extractStatus(e, 0, new Set<unknown>());
  return direct;
}

function extractStatus(e: unknown, depth: number, seen: Set<unknown>): number | undefined {
  if (e === null || e === undefined || depth > 4) return undefined;
  if (typeof e === "object") {
    if (seen.has(e)) return undefined;
    seen.add(e);
  }
  const numeric = (v: unknown): number | undefined => {
    if (typeof v === "number" && Number.isFinite(v) && v >= 100 && v < 600) return v;
    if (typeof v === "string" && /^\d{3}$/.test(v.trim())) {
      const n = Number(v.trim());
      if (n >= 100 && n < 600) return n;
    }
    return undefined;
  };
  if (typeof e !== "object" || e === null) return undefined;
  const obj = e as Record<string, unknown>;
  const direct = numeric(obj.status) ?? numeric(obj.statusCode) ?? numeric(obj.code);
  if (direct !== undefined) return direct;
  for (const key of ["cause", "error", "response", "data", "lastError"] as const) {
    const nested = obj[key];
    if (nested !== undefined && nested !== null && typeof nested === "object") {
      const found = extractStatus(nested, depth + 1, seen);
      if (found !== undefined) return found;
    }
  }
  if (typeof obj.message === "string") {
    const m = obj.message.match(/\b(\d{3})\b/);
    if (m) {
      const n = Number(m[1]);
      if (n >= 100 && n < 600) return n;
    }
  }
  return undefined;
}

/** 429 / rate-limit wording → `PROVIDER_RATE_LIMITED` (ADR-0003 §B.6). */
export function isRateLimitedError(e: unknown): boolean {
  if (statusOfError(e) === 429) return true;
  const text = errorText(e).toLowerCase();
  return text.includes("rate limit") || text.includes("rate_limit") || text.includes("too many requests") || text.includes("429");
}

// Retryable = transient upstream conditions only. Auth/validation (400/401/
// 403/404/422) and 501 are terminal — walking the fallback chain cannot fix
// them (same predicate as `gateway.service.ts` isRetriable).
export function isRetryableModelError(e: unknown): boolean {
  const status = statusOfError(e);
  if (status !== undefined && [400, 401, 403, 404, 422, 501].includes(status)) return false;
  if (status === 429) return true;
  if (status !== undefined && status >= 500 && status < 600) return true;
  const text = errorText(e).toLowerCase();
  return (
    text.includes("fetch failed") ||
    text.includes("network") ||
    text.includes("econnrefused") ||
    text.includes("econnreset") ||
    text.includes("etimedout") ||
    text.includes("timeout") ||
    text.includes("aborted") ||
    text.includes("unable to connect") ||
    text.includes("connection error")
  );
}

function errorText(e: unknown, depth = 0, seen = new Set<unknown>()): string {
  if (e === null || e === undefined || depth > 4) return "";
  if (typeof e === "string") return e;
  if (typeof e === "object") {
    if (seen.has(e)) return "";
    seen.add(e);
  }
  if (e instanceof Error) {
    return `${e.name}: ${e.message} ${errorText((e as { cause?: unknown }).cause, depth + 1, seen)}`;
  }
  if (typeof e === "object") {
    const obj = e as Record<string, unknown>;
    const parts: string[] = [];
    if (typeof obj.message === "string") parts.push(obj.message);
    if (typeof obj.code === "string") parts.push(obj.code);
    for (const key of ["cause", "error"] as const) {
      const nested = errorText(obj[key], depth + 1, seen);
      if (nested) parts.push(nested);
    }
    return parts.join(" ");
  }
  return String(e);
}

export interface FallbackWalkResult<T> {
  value: T;
  /** Index into the config chain that succeeded (0 = primary). */
  configIndex: number;
}

/**
 * Walk the model chain: try `attempt(config, model)` in order, moving on only
 * for retryable failures. The final error is rethrown so the caller can map it
 * (429 → PROVIDER_RATE_LIMITED, auth → PROVIDER_AUTH_FAILED, …).
 */
export async function runWithModelFallback<T>(
  configs: readonly RegistryModelConfig[],
  attempt: (config: RegistryModelConfig, model: LanguageModel) => Promise<T>,
): Promise<FallbackWalkResult<T>> {
  const chain = configs.slice(0, 3);
  let lastError: unknown;
  for (let i = 0; i < chain.length; i++) {
    const config = chain[i]!;
    try {
      const value = await attempt(config, buildLanguageModel(config));
      return { value, configIndex: i };
    } catch (e) {
      lastError = e;
      if (!isRetryableModelError(e) || i === chain.length - 1) throw e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("no provider config available");
}
