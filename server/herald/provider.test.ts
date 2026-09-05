import { describe, expect, it } from "vitest";
import {
  buildAdapter,
  listModels,
  normalizeBaseUrl,
  normalizeProviderKind,
  inferModelKind,
  opencodeSessionIdFor,
  resolveOpencodeSessionId,
  OPENCODE_SESSION_HEADER,
  translateRunError,
  extractRetryAfter,
  extractUpstreamBody,
  isTransientUpstream,
  type FetchLike,
  type ProviderConfig,
} from "./provider";

const openaiConfig = (baseUrl = "https://api.example.com"): ProviderConfig => ({
  kind: "openai_compatible",
  baseUrl,
  apiKey: "sk-test",
  model: "gpt-4o",
});

const anthropicConfig = (baseUrl = "https://api.example.com"): ProviderConfig => ({
  kind: "anthropic_compatible",
  baseUrl,
  apiKey: "ak-test",
  model: "claude-sonnet-4-5",
});

const responsesConfig = (baseUrl = "https://api.example.com"): ProviderConfig => ({
  kind: "openai_responses",
  baseUrl,
  apiKey: "sk-resp",
  model: "muse-spark-1.2-contributor",
});

describe("normalizeBaseUrl", () => {
  it("openai_compatible appends /v1 when missing", () => {
    expect(normalizeBaseUrl("https://api.x.com", "openai_compatible")).toBe("https://api.x.com/v1");
  });

  it("openai_compatible keeps existing /v1", () => {
    expect(normalizeBaseUrl("https://api.x.com/v1", "openai_compatible")).toBe("https://api.x.com/v1");
  });

  it("openai_compatible keeps non-v1 path and appends /v1", () => {
    expect(normalizeBaseUrl("https://api.x.com/api", "openai_compatible")).toBe("https://api.x.com/api/v1");
  });

  it("anthropic_compatible strips trailing /v1", () => {
    expect(normalizeBaseUrl("https://api.x.com/v1", "anthropic_compatible")).toBe("https://api.x.com/");
  });

  it("anthropic_compatible leaves base without /v1 untouched", () => {
    expect(normalizeBaseUrl("https://api.x.com", "anthropic_compatible")).toBe("https://api.x.com/");
  });

  it("trims whitespace and adds https scheme when missing", () => {
    expect(normalizeBaseUrl("  api.x.com  ", "openai_compatible")).toBe("https://api.x.com/v1");
    expect(normalizeBaseUrl("http://host.local:8080", "anthropic_compatible")).toBe("http://host.local:8080/");
  });

  it("strips trailing slashes before suffix logic", () => {
    expect(normalizeBaseUrl("https://api.x.com///", "openai_compatible")).toBe("https://api.x.com/v1");
    expect(normalizeBaseUrl("https://api.x.com/v1/", "anthropic_compatible")).toBe("https://api.x.com/");
  });

  it("openai_responses appends /v1 when missing", () => {
    expect(normalizeBaseUrl("https://api.x.com", "openai_responses")).toBe("https://api.x.com/v1");
  });

  it("openai_responses keeps existing /v1", () => {
    expect(normalizeBaseUrl("https://api.x.com/v1", "openai_responses")).toBe("https://api.x.com/v1");
  });

  it("openai_responses keeps non-v1 path and appends /v1", () => {
    expect(normalizeBaseUrl("https://api.x.com/api", "openai_responses")).toBe("https://api.x.com/api/v1");
  });
});

describe("normalizeProviderKind", () => {
  it("maps responses aliases to openai_responses", () => {
    expect(normalizeProviderKind("openai_responses")).toBe("openai_responses");
    expect(normalizeProviderKind("responses")).toBe("openai_responses");
    expect(normalizeProviderKind("responses_compatible")).toBe("openai_responses");
    expect(normalizeProviderKind("openai_compatible_responses")).toBe("openai_responses");
    expect(normalizeProviderKind("openai-responses")).toBe("openai_responses");
  });

  it("keeps openai_compatible and anthropic_compatible verbatim", () => {
    expect(normalizeProviderKind("openai_compatible")).toBe("openai_compatible");
    expect(normalizeProviderKind("anthropic_compatible")).toBe("anthropic_compatible");
  });

  it("defaults unknown to openai_compatible", () => {
    expect(normalizeProviderKind("unknown_kind")).toBe("openai_compatible");
  });
});

describe("inferModelKind", () => {
  it("minimax-* -> anthropic_compatible (case-insensitive)", () => {
    expect(inferModelKind("minimax-m3")).toBe("anthropic_compatible");
    expect(inferModelKind("minimax-m2.7")).toBe("anthropic_compatible");
    expect(inferModelKind("minimax-m2.5")).toBe("anthropic_compatible");
    expect(inferModelKind("MINIMAX-M3")).toBe("anthropic_compatible");
  });

  it("qwen* -> anthropic_compatible", () => {
    expect(inferModelKind("qwen3.7-max")).toBe("anthropic_compatible");
    expect(inferModelKind("qwen3.8-max")).toBe("anthropic_compatible");
    expect(inferModelKind("qwen3.7-plus")).toBe("anthropic_compatible");
    expect(inferModelKind("qwen3.6-plus")).toBe("anthropic_compatible");
    expect(inferModelKind("qwen3.5-plus")).toBe("anthropic_compatible");
    expect(inferModelKind("QWEN3.7-max")).toBe("anthropic_compatible");
  });

  it("mimo-*, kimi-*, glm-*, deepseek-*, longcat-*, hy3* -> openai_compatible", () => {
    expect(inferModelKind("mimo-v2-pro")).toBe("openai_compatible");
    expect(inferModelKind("mimo-v2-omni")).toBe("openai_compatible");
    expect(inferModelKind("mimo-v2.5-pro")).toBe("openai_compatible");
    expect(inferModelKind("mimo-v2.5")).toBe("openai_compatible");
    expect(inferModelKind("kimi-k3")).toBe("openai_compatible");
    expect(inferModelKind("kimi-k2.7-code")).toBe("openai_compatible");
    expect(inferModelKind("kimi-k2.6")).toBe("openai_compatible");
    expect(inferModelKind("kimi-k2.5")).toBe("openai_compatible");
    expect(inferModelKind("glm-5.2")).toBe("openai_compatible");
    expect(inferModelKind("glm-5.3-flash")).toBe("openai_compatible");
    expect(inferModelKind("glm-5.3")).toBe("openai_compatible");
    expect(inferModelKind("glm-5.1")).toBe("openai_compatible");
    expect(inferModelKind("glm-5")).toBe("openai_compatible");
    expect(inferModelKind("deepseek-v4-pro")).toBe("openai_compatible");
    expect(inferModelKind("deepseek-v4-flash")).toBe("openai_compatible");
    expect(inferModelKind("deepseek-v4-flash-vision-exp")).toBe("openai_compatible");
    expect(inferModelKind("longcat-2.0")).toBe("openai_compatible");
    expect(inferModelKind("hy3")).toBe("openai_compatible");
    expect(inferModelKind("hy3-preview")).toBe("openai_compatible");
  });

  it("muse-*, grok-*, gpt-* -> openai_responses", () => {
    expect(inferModelKind("muse-spark-1.2-contributor")).toBe("openai_responses");
    expect(inferModelKind("muse-v2-pro")).toBe("openai_responses");
    expect(inferModelKind("grok-4.5")).toBe("openai_responses");
    expect(inferModelKind("grok-4.6")).toBe("openai_responses");
    expect(inferModelKind("gpt-5.6-luna")).toBe("openai_responses");
    expect(inferModelKind("GPT-5.6-LUNA")).toBe("openai_responses");
    expect(inferModelKind("claude-sonnet-4-5")).toBe("openai_responses");
  });

  it("unknown defaults to openai_compatible", () => {
    expect(inferModelKind("unknown-model")).toBe("openai_compatible");
    expect(inferModelKind("k2-foo")).toBe("openai_compatible");
  });

  it("full Go catalog maps correctly per opencode.ai/docs/go", () => {
    const cases: Array<[string, ReturnType<typeof inferModelKind>]> = [
      ["minimax-m3", "anthropic_compatible"],
      ["minimax-m2.7", "anthropic_compatible"],
      ["minimax-m2.5", "anthropic_compatible"],
      ["kimi-k3", "openai_compatible"],
      ["kimi-k2.7-code", "openai_compatible"],
      ["kimi-k2.6", "openai_compatible"],
      ["longcat-2.0", "openai_compatible"],
      ["kimi-k2.5", "openai_compatible"],
      ["glm-5.2", "openai_compatible"],
      ["glm-5.3-flash", "openai_compatible"],
      ["glm-5.3", "openai_compatible"],
      ["glm-5.1", "openai_compatible"],
      ["glm-5", "openai_compatible"],
      ["deepseek-v4-pro", "openai_compatible"],
      ["deepseek-v4-flash", "openai_compatible"],
      ["deepseek-v4-flash-vision-exp", "openai_compatible"],
      ["qwen3.7-max", "anthropic_compatible"],
      ["qwen3.8-max", "anthropic_compatible"],
      ["qwen3.7-plus", "anthropic_compatible"],
      ["qwen3.6-plus", "anthropic_compatible"],
      ["qwen3.5-plus", "anthropic_compatible"],
      ["mimo-v2-pro", "openai_compatible"],
      ["mimo-v2-omni", "openai_compatible"],
      ["mimo-v2.5-pro", "openai_compatible"],
      ["mimo-v2.5", "openai_compatible"],
      ["hy3", "openai_compatible"],
      ["hy3-preview", "openai_compatible"],
      ["gpt-5.6-luna", "openai_responses"],
      ["grok-4.5", "openai_responses"],
      ["grok-4.6", "openai_responses"],
      ["muse-spark-1.2-contributor", "openai_responses"],
    ];
    for (const [id, kind] of cases) expect(inferModelKind(id)).toBe(kind);
  });
});

describe("buildAdapter", () => {
  it("returns adapter for openai_responses without throw", () => {
    const adapter = buildAdapter(responsesConfig());
    expect(adapter).toBeDefined();
    expect(typeof (adapter as { kind?: string }).kind === "string" || typeof adapter === "object").toBe(true);
  });

  it("returns adapter for openai_compatible and anthropic_compatible", () => {
    expect(buildAdapter(openaiConfig())).toBeDefined();
    expect(buildAdapter(anthropicConfig())).toBeDefined();
  });

  it("attaches x-opencode-session defaultHeaders on every adapter", () => {
    for (const cfg of [openaiConfig(), anthropicConfig(), responsesConfig()]) {
      const adapter = buildAdapter({ ...cfg, sessionId: "thread-abc" });
      const client = (adapter as unknown as { client: Record<string, unknown> }).client;
      const options = (client as { _options?: Record<string, unknown> })._options ?? client;
      const headers = (options as { defaultHeaders?: Record<string, string> }).defaultHeaders;
      expect(headers?.[OPENCODE_SESSION_HEADER]).toBe("lexa-herald-thread-abc");
    }
  });

  it("falls back to a stable per-model session id when none is given", () => {
    const adapter = buildAdapter(openaiConfig());
    const client = (adapter as unknown as { client: Record<string, unknown> }).client;
    const options = (client as { _options?: Record<string, unknown> })._options ?? client;
    const headers = (options as { defaultHeaders?: Record<string, string> }).defaultHeaders;
    expect(headers?.[OPENCODE_SESSION_HEADER]).toBe("lexa-herald-gpt-4o");
  });
});

describe("opencode session id", () => {
  it("prefixes bare conversation ids with lexa-herald-", () => {
    expect(opencodeSessionIdFor("thread-abc")).toBe("lexa-herald-thread-abc");
    expect(opencodeSessionIdFor("lexa-herald-thread-abc")).toBe("lexa-herald-thread-abc");
  });

  it("resolveOpencodeSessionId prefers the conversation id, falls back per model", () => {
    expect(resolveOpencodeSessionId("chat-1", { model: "m" })).toBe("lexa-herald-chat-1");
    expect(resolveOpencodeSessionId(undefined, { model: "m" })).toBe("lexa-herald-m");
    expect(resolveOpencodeSessionId(undefined, { providerId: "p1", model: "m" })).toBe("lexa-herald-p1");
    expect(resolveOpencodeSessionId("  ", { model: "m" })).toBe("lexa-herald-m");
  });
});

function fakeFetch(status: number, body: unknown, log: { url?: string; headers?: Record<string, string> } = {}): FetchLike {
  return async (input, init) => {
    log.url = input;
    log.headers = (init?.headers ?? {}) as Record<string, string>;
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
}

describe("listModels", () => {
  it("openai wire: GET {base}/v1/models with Bearer; parses data[]", async () => {
    const log: { url?: string; headers?: Record<string, string> } = {};
    const res = await listModels(openaiConfig(), fakeFetch(200, { data: [{ id: "m1" }, { id: "m2" }] }, log));
    expect(log.url).toBe("https://api.example.com/v1/models");
    expect(log.headers?.authorization).toBe("Bearer sk-test");
    expect(res.models).toEqual([{ id: "m1" }, { id: "m2" }]);
  });

  it("anthropic wire: GET {base}/v1/models with x-api-key + version header; parses models[]", async () => {
    const log: { url?: string; headers?: Record<string, string> } = {};
    const res = await listModels(anthropicConfig(), fakeFetch(200, { models: [{ id: "claude-x" }] }, log));
    expect(log.url).toBe("https://api.example.com/v1/models");
    expect(log.headers?.["x-api-key"]).toBe("ak-test");
    expect(log.headers?.["anthropic-version"]).toBe("2023-06-01");
    expect(res.models).toEqual([{ id: "claude-x" }]);
  });

  it("filters entries without string ids", async () => {
    const res = await listModels(openaiConfig(), fakeFetch(200, { data: [{ id: "ok" }, {}, { nope: 1 }] }));
    expect(res.models).toEqual([{ id: "ok" }]);
  });

  it("401 → PROVIDER_AUTH_FAILED", async () => {
    const err = await listModels(openaiConfig(), fakeFetch(401, {})).catch((e) => e);
    expect(err._tag).toBe("ProviderAuthFailed");
  });

  it("403 → PROVIDER_AUTH_FAILED", async () => {
    const err = await listModels(anthropicConfig(), fakeFetch(403, {})).catch((e) => e);
    expect(err._tag).toBe("ProviderAuthFailed");
  });

  it("500 → PROVIDER_UNREACHABLE with status message", async () => {
    const err = await listModels(openaiConfig(), fakeFetch(500, {})).catch((e) => e);
    expect(err._tag).toBe("ProviderUnreachable");
    expect(err.message).toContain("500");
  });

  it("network failure → PROVIDER_UNREACHABLE", async () => {
    const err = await listModels(openaiConfig(), async () => {
      throw new Error("fetch failed");
    }).catch((e) => e);
    expect(err._tag).toBe("ProviderUnreachable");
  });

  it("openai_responses wire: GET {base}/v1/models with Bearer; parses data[] like openai_compatible", async () => {
    const log: { url?: string; headers?: Record<string, string> } = {};
    const res = await listModels(responsesConfig(), fakeFetch(200, { data: [{ id: "muse-spark-1.2" }] }, log));
    expect(log.url).toBe("https://api.example.com/v1/models");
    expect(log.headers?.authorization).toBe("Bearer sk-resp");
    expect(res.models).toEqual([{ id: "muse-spark-1.2" }]);
  });

  it("openai_responses with base already /v1 does not double", async () => {
    const log: { url?: string } = {};
    await listModels(responsesConfig("https://api.example.com/v1"), fakeFetch(200, { data: [] }, log));
    expect(log.url).toBe("https://api.example.com/v1/models");
  });

  it("sends x-opencode-session on the openai wire (fallback per model)", async () => {
    const log: { url?: string; headers?: Record<string, string> } = {};
    await listModels(openaiConfig(), fakeFetch(200, { data: [] }, log));
    expect(log.headers?.[OPENCODE_SESSION_HEADER]).toBe("lexa-herald-gpt-4o");
  });

  it("sends x-opencode-session on the anthropic wire (explicit session id)", async () => {
    const log: { url?: string; headers?: Record<string, string> } = {};
    await listModels(anthropicConfig(), fakeFetch(200, { models: [] }, log), { sessionId: "chat-1" });
    expect(log.headers?.[OPENCODE_SESSION_HEADER]).toBe("lexa-herald-chat-1");
  });
});

describe("translateRunError", () => {
  it("maps auth-shaped messages to ProviderAuthFailed", () => {
    for (const msg of ["Request failed with status code 401", "Unauthorized", "Invalid API key provided", "403 Forbidden"]) {
      expect(translateRunError(new Error(msg))._tag).toBe("ProviderAuthFailed");
    }
  });

  it("maps network-shaped messages to ProviderUnreachable", () => {
    for (const msg of ["fetch failed", "ECONNREFUSED 127.0.0.1:11434", "getaddrinfo ENOTFOUND api.x.com", "request aborted", "ETIMEDOUT"]) {
      expect(translateRunError(new Error(msg))._tag).toBe("ProviderUnreachable");
    }
  });

  it("maps timeout/abort-shaped messages and DOMException names to ProviderUnreachable", () => {
    for (const msg of ["timeout", "The operation was aborted", "ETIMEDOUT", "aborted"]) {
      expect(translateRunError(new Error(msg))._tag).toBe("ProviderUnreachable");
    }
    const abortErr = Object.assign(new Error("The operation was aborted due to timeout"), { name: "AbortError" });
    expect(translateRunError(abortErr)._tag).toBe("ProviderUnreachable");
    const timeoutErr = Object.assign(new Error("signal timed out"), { name: "TimeoutError" });
    expect(translateRunError(timeoutErr)._tag).toBe("ProviderUnreachable");
    const domTimeout = new DOMException("signal timed out", "TimeoutError");
    expect(translateRunError(domTimeout)._tag).toBe("ProviderUnreachable");
    const domAbort = new DOMException("The operation was aborted", "AbortError");
    expect(translateRunError(domAbort)._tag).toBe("ProviderUnreachable");
  });

  it("maps Bun fetch TypeError (dead endpoint) to ProviderUnreachable", () => {
    expect(translateRunError(new TypeError("Unable to connect"))._tag).toBe("ProviderUnreachable");
    expect(translateRunError(new TypeError("Connection error."))._tag).toBe("ProviderUnreachable");
  });

  it("walks the cause chain — SDK wrapper over ECONNREFUSED → ProviderUnreachable", () => {
    const cause = new Error("connect ECONNREFUSED 127.0.0.1:9");
    const wrapped = new TypeError("fetch failed: Connection refused", { cause });
    expect(translateRunError(wrapped)._tag).toBe("ProviderUnreachable");
  });

  it("walks the cause chain — AbortError name in cause → ProviderUnreachable", () => {
    const cause = Object.assign(new Error("aborted"), { name: "AbortError" });
    const wrapped = new Error("chat failed", { cause } as ErrorOptions);
    expect(translateRunError(wrapped)._tag).toBe("ProviderUnreachable");
  });

  it("falls through to HeraldGenerationFailed with bounded message", () => {
    const err = translateRunError(new Error(`x`.repeat(1000)));
    expect(err._tag).toBe("HeraldGenerationFailed");
    expect((err as { message: string }).message.length).toBeLessThanOrEqual(500);
  });

  it("stringifies non-Error throwables", () => {
    expect(translateRunError("boom")._tag).toBe("HeraldGenerationFailed");
  });

  it("500 with provider rawEvent preserves verbatim upstream message", () => {
    const apiErr = Object.assign(new Error("500 Internal server error"), {
      status: 500,
      code: "500",
      error: { message: "Internal server error" },
      rawEvent: { message: "Internal server error" },
    });
    const err = translateRunError(apiErr);
    expect(err._tag).toBe("HeraldGenerationFailed");
    expect((err as { message: string }).message).toContain("500");
    expect((err as { message: string }).message).toContain("Internal server error");
    expect((err as { message: string }).message.length).toBeLessThanOrEqual(500);
  });

  it("Zen double-nested error body surfaces inner message verbatim", () => {
    const zenBody = { type: "error", error: { message: "Internal server error" } };
    const apiErr = Object.assign(new Error("500 Internal server error"), {
      status: 500,
      error: zenBody.error,
      rawEvent: zenBody.error,
    });
    const err = translateRunError(apiErr);
    expect(err._tag).toBe("HeraldGenerationFailed");
    expect((err as { message: string }).message).toBe("500 Internal server error");
  });

  it("RUN_ERROR chunk with code+rawEvent preserves upstream 500 message", () => {
    const chunk: unknown = { message: "500 Internal server error", code: "500", rawEvent: { message: "Internal server error" } };
    const c = chunk as Record<string, unknown>;
    const e = Object.assign(new Error(String(c.message)), { code: c.code, status: c.code, rawEvent: c.rawEvent, error: c.rawEvent, cause: c.rawEvent });
    const err = translateRunError(e);
    expect(err._tag).toBe("HeraldGenerationFailed");
    expect((err as { message: string }).message).toContain("Internal server error");
  });

  it("429 with rate limit maps to ProviderUnreachable (retriable with backoff)", () => {
    const apiErr = Object.assign(new Error("429 Rate limit exceeded"), {
      status: 429,
      code: "429",
      error: { message: "Rate limit exceeded" },
    });
    const err = translateRunError(apiErr);
    expect(err._tag).toBe("ProviderUnreachable");
    expect((err as { message: string }).message?.toLowerCase() ?? "").toContain("429");
  });

  it("401 via numeric status field maps to ProviderAuthFailed", () => {
    const apiErr = Object.assign(new Error("Unauthorized"), { status: 401, error: { message: "Unauthorized" } });
    expect(translateRunError(apiErr)._tag).toBe("ProviderAuthFailed");
  });
});

describe("testConnection timeout", () => {
  it("AbortSignal.timeout maps to ProviderUnreachable via translateRunError", () => {
    const sig = AbortSignal.timeout(1);
    const err = Object.assign(new Error("signal timed out"), { name: (sig.reason as DOMException)?.name ?? "TimeoutError" });
    expect(translateRunError(err)._tag).toBe("ProviderUnreachable");
  });
});

describe("isTransientUpstream", () => {
  it("429 is transient", () => {
    expect(isTransientUpstream(Object.assign(new Error("429 rate limit"), { status: 429 }))).toBe(true);
    expect(isTransientUpstream({ status: "429", message: "rate limit" })).toBe(true);
  });
  it("502/503/504/529 are transient", () => {
    for (const s of [502, 503, 504, 529]) {
      expect(isTransientUpstream(Object.assign(new Error(`${s} bad gateway`), { status: s }))).toBe(true);
      expect(isTransientUpstream({ status: String(s) })).toBe(true);
    }
  });
  it("500 is transient (5xx except 501)", () => {
    expect(isTransientUpstream(Object.assign(new Error("500"), { status: 500 }))).toBe(true);
    expect(isTransientUpstream(Object.assign(new Error("501"), { status: 501 }))).toBe(false);
  });
  it("network errors are transient", () => {
    for (const m of ["fetch failed", "ECONNREFUSED", "ETIMEDOUT", "getaddrinfo ENOTFOUND", "aborted"]) {
      expect(isTransientUpstream(new Error(m))).toBe(true);
    }
  });
  it("400/401/404/422 are not transient", () => {
    for (const s of [400, 401, 403, 404, 422]) {
      expect(isTransientUpstream(Object.assign(new Error(`${s}`), { status: s }))).toBe(false);
    }
  });
});

describe("extractRetryAfter", () => {
  it("extracts numeric string seconds -> ms", () => {
    expect(extractRetryAfter({ headers: { "retry-after": "120" } })).toBe(120_000);
    expect(extractRetryAfter({ headers: { "Retry-After": "2" } })).toBe(2000);
  });
  it("extracts from nested error/rawEvent/headers", () => {
    expect(extractRetryAfter({ rawEvent: { headers: { "retry-after": "5" } } })).toBe(5000);
    expect(extractRetryAfter({ error: { headers: { "retry-after": "1" } } })).toBe(1000);
  });
  it("handles Headers instance", () => {
    const h = new Headers({ "retry-after": "10" });
    expect(extractRetryAfter({ headers: h })).toBe(10_000);
  });
  it("returns null when absent", () => {
    expect(extractRetryAfter(new Error("no header"))).toBeNull();
    expect(extractRetryAfter({ status: 429 })).toBeNull();
  });
  it("extracts string status like '502' still transient via isTransientUpstream", () => {
    expect(isTransientUpstream({ status: "502" })).toBe(true);
  });
});

describe("translateRunError mapping errors", () => {
  it("JSON parse error -> HeraldGenerationFailed with mapping message and preserves retryAfter", () => {
    const err = Object.assign(new Error("Unexpected token < in JSON at position 0"), {
      status: 200,
      headers: { "retry-after": "3" },
      rawEvent: { message: "Unexpected token" },
    });
    const translated = translateRunError(err);
    expect(translated._tag).toBe("HeraldGenerationFailed");
    expect((translated as { message: string }).message).toContain("upstream response mapping failed");
    expect((translated as { retryAfter: number | null }).retryAfter).toBe(3000);
  });
  it("tool_call XML leak -> HeraldGenerationFailed mapping", () => {
    const err = Object.assign(new Error("<tool_call> leak detected"), { status: 200, rawEvent: { message: "<tool_call>" } });
    const translated = translateRunError(err);
    expect(translated._tag).toBe("HeraldGenerationFailed");
    expect((translated as { message: string }).message).toContain("upstream response mapping failed");
  });
  it("429 with Retry-After preserves retryAfter in error", () => {
    const e = Object.assign(new Error("429"), { status: 429, headers: { "retry-after": "60" } });
    const translated = translateRunError(e);
    expect(translated._tag).toBe("ProviderUnreachable");
    expect((translated as { retryAfter: number | null }).retryAfter).toBe(60_000);
    expect((translated as { status: number | null }).status).toBe(429);
  });
  it("5xx string status '503' -> HeraldGenerationFailed with status", () => {
    const e = Object.assign(new Error("503 Service Unavailable"), { status: "503" });
    const translated = translateRunError(e);
    expect(translated._tag).toBe("HeraldGenerationFailed");
    expect((translated as { message: string }).message).toContain("503");
    expect((translated as { status: number | null }).status).toBe(503);
  });
  it("upstreamBody extraction included in error", () => {
    const e = Object.assign(new Error("500 body"), { status: 500, body: "upstream body snippet", rawEvent: { message: "error" } });
    const translated = translateRunError(e);
    expect(translated._tag).toBe("HeraldGenerationFailed");
    expect((translated as { upstreamBody: string | null }).upstreamBody).toContain("upstream body");
  });
});

describe("heraldLog levels", () => {
  it("FATAL emitted for mapping error with errorTag", async () => {
    const writes: string[] = [];
    const origStderr = process.stderr.write as unknown as typeof process.stderr.write;
    const origStdout = process.stdout.write as unknown as typeof process.stdout.write;
    (process.stderr.write as unknown as (s: string) => boolean) = ((s: string) => { writes.push(String(s)); return true; }) as unknown as typeof process.stderr.write;
    (process.stdout.write as unknown as (s: string) => boolean) = ((s: string) => { writes.push(String(s)); return true; }) as unknown as typeof process.stdout.write;
    try {
      const err = Object.assign(new Error("Unexpected token < in JSON"), { status: 200, rawEvent: { message: "Unexpected token" } });
      const t = translateRunError(err, { kind: "openai_compatible", baseUrl: "https://api.example.com", apiKey: "sk-test", model: "m1" });
      expect(t._tag).toBe("HeraldGenerationFailed");
    } finally {
      process.stderr.write = origStderr;
      process.stdout.write = origStdout;
    }
    const fatal = writes.find((s) => s.includes('"level":"FATAL"') && s.includes("HeraldGenerationFailed"));
    expect(fatal).toBeDefined();
  });

  it("WARN emitted for transient 429", async () => {
    const writes: string[] = [];
    const origStderr = process.stderr.write as unknown as typeof process.stderr.write;
    const origStdout = process.stdout.write as unknown as typeof process.stdout.write;
    (process.stderr.write as unknown as (s: string) => boolean) = ((s: string) => { writes.push(String(s)); return true; }) as unknown as typeof process.stderr.write;
    (process.stdout.write as unknown as (s: string) => boolean) = ((s: string) => { writes.push(String(s)); return true; }) as unknown as typeof process.stdout.write;
    try {
      const err = Object.assign(new Error("429 Rate limit"), { status: 429 });
      const t = translateRunError(err, { kind: "openai_compatible", baseUrl: "https://api.example.com", apiKey: "sk-test", model: "m1" });
      expect(t._tag).toBe("ProviderUnreachable");
    } finally {
      process.stderr.write = origStderr;
      process.stdout.write = origStdout;
    }
    const warn = writes.find((s) => s.includes('"level":"WARN"') && s.includes("ProviderUnreachable"));
    expect(warn).toBeDefined();
  });
});
