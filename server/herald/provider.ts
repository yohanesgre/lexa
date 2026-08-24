import { chat, type AnyTextAdapter, type ModelMessage, type StreamChunk } from "@tanstack/ai";
import { createOpenaiChatCompletions } from "@tanstack/ai-openai";
import { createAnthropicChat } from "@tanstack/ai-anthropic";
import type { ProviderKind } from "../../shared/herald";
import { ProviderAuthFailed, ProviderUnreachable, HeraldGenerationFailed } from "../api/errors";
import type { CacheablePrompt } from "./prompt";

export interface ProviderConfig {
  kind: ProviderKind;
  baseUrl: string;
  apiKey: string;
  model: string;
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
  return chat({
    adapter: buildAdapter(input.config),
    systemPrompts: toSystemPrompts(input.config.kind, input.systemPrompts) as never,
    messages: input.messages,
    tools: input.tools as never,
    abortController: input.abortController,
    ...(input.modelOptions !== undefined ? { modelOptions: input.modelOptions } : {}),
  }) as AsyncIterable<StreamChunk>;
}

// Non-streaming one-shot completion (rolling summary, connection test).
export async function completeText(
  config: ProviderConfig,
  input: { systemPrompts?: CacheablePrompt[]; messages: ModelMessage[] }
): Promise<string> {
  return (await chat({
    adapter: buildAdapter(config),
    systemPrompts: toSystemPrompts(config.kind, input.systemPrompts ?? []) as never,
    messages: input.messages,
    stream: false,
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

// Pure classifier — no I/O. Recognizable failures map to catalog codes,
// everything else falls through to HERALD_GENERATION_FAILED. Upstream bodies
// are never echoed raw beyond a bounded message.
function collectErrorText(e: unknown, out: string[], depth = 0): void {
  if (e === null || e === undefined || depth > 4) return;
  if (e instanceof Error) {
    out.push(e.message);
    collectErrorText(e.cause, out, depth + 1);
    return;
  }
  out.push(String(e));
}

export function translateRunError(e: unknown): ProviderAuthFailed | ProviderUnreachable | HeraldGenerationFailed {
  const parts: string[] = [];
  collectErrorText(e, parts);
  const raw = parts.join(" | ").slice(0, 600);
  const msg = raw.toLowerCase();
  if (
    /\b(401|403)\b/.test(msg) ||
    msg.includes("unauthorized") ||
    msg.includes("invalid api key") ||
    msg.includes("incorrect api key") ||
    msg.includes("forbidden")
  ) {
    return new ProviderAuthFailed({});
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
    msg.includes("aborted")
  ) {
    return new ProviderUnreachable({});
  }
  return new HeraldGenerationFailed({ message: raw.slice(0, 300) });
}

// Minimal completion ping against submitted (unsaved) values. Never persists.
export async function testConnection(config: ProviderConfig): Promise<{ ok: true; latencyMs: number }> {
  const startedAt = Date.now();
  try {
    await completeText(config, { messages: [{ role: "user", content: "Reply with the single word: ok" }] });
    return { ok: true, latencyMs: Date.now() - startedAt };
  } catch (e) {
    throw translateRunError(e);
  }
}
