import { describe, expect, it } from "vitest";
import {
  listModels,
  normalizeBaseUrl,
  translateRunError,
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
    expect((err as { message: string }).message.length).toBeLessThanOrEqual(300);
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
    expect((err as { message: string }).message.length).toBeLessThanOrEqual(300);
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
