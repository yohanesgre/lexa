import { describe, expect, it } from "vitest";
import {
  OPENCODE_SESSION_HEADER,
  baseUrlForProvider,
  buildLanguageModel,
  buildModelChain,
  isRateLimitedError,
  isRetryableModelError,
  normalizeProviderKind,
  opencodeSessionIdFor,
  resolveOpencodeSessionId,
  runWithModelFallback,
  statusOfError,
  type RegistryModelConfig,
} from "./model-factory";
// Parity reference — the Bun adapter derivation the DO must preserve 1:1.
import {
  opencodeSessionIdFor as bunOpencodeSessionIdFor,
  resolveOpencodeSessionId as bunResolveOpencodeSessionId,
} from "./provider";

const baseConfig: RegistryModelConfig = {
  kind: "openai_compatible",
  baseUrl: "https://provider.example",
  apiKey: "sk-test",
  model: "deepseek-v4-flash",
  providerId: "prov-1",
  sessionId: "chat-123",
};

function headersOf(model: unknown): Record<string, string> | undefined {
  const headers = (model as { config?: { headers?: unknown } }).config?.headers;
  if (typeof headers === "function") return (headers as () => Record<string, string>)();
  return headers as Record<string, string> | undefined;
}

// `LanguageModel` is a union that includes plain model-id strings, so the
// provider metadata is only reachable after narrowing. These guards keep the
// assertions type-safe without an `any` cast.
function providerOf(model: unknown): string {
  if (typeof model !== "object" || model === null || !("provider" in model)) {
    throw new Error("expected a provider-backed language model");
  }
  return String((model as { provider: unknown }).provider);
}

function modelIdOf(model: unknown): string {
  if (typeof model !== "object" || model === null || !("modelId" in model)) {
    throw new Error("expected a provider-backed language model");
  }
  return String((model as { modelId: unknown }).modelId);
}

describe("normalizeProviderKind", () => {
  it("maps every registry alias to a canonical kind", () => {
    expect(normalizeProviderKind("openai_compatible")).toBe("openai_compatible");
    expect(normalizeProviderKind("anthropic_compatible")).toBe("anthropic_compatible");
    expect(normalizeProviderKind("openai_responses")).toBe("openai_responses");
    expect(normalizeProviderKind("responses")).toBe("openai_responses");
    expect(normalizeProviderKind("openai-chat")).toBe("openai_compatible");
    expect(normalizeProviderKind("anthropic")).toBe("anthropic_compatible");
    expect(normalizeProviderKind(undefined)).toBe("openai_compatible");
  });
});

describe("baseUrlForProvider", () => {
  it("appends /v1 for every AI SDK kind (inverse of the TanStack anthropic strip)", () => {
    expect(baseUrlForProvider("https://api.openai.com", "openai_compatible")).toBe("https://api.openai.com/v1");
    expect(baseUrlForProvider("https://api.openai.com/v1", "openai_compatible")).toBe("https://api.openai.com/v1");
    expect(baseUrlForProvider("https://api.anthropic.com", "anthropic_compatible")).toBe("https://api.anthropic.com/v1");
    expect(baseUrlForProvider("https://gateway.example/openai/v1/", "openai_responses")).toBe("https://gateway.example/openai/v1");
  });

  it("defaults a schemeless host to https", () => {
    expect(baseUrlForProvider("provider.example", "openai_compatible")).toBe("https://provider.example/v1");
  });
});

describe("x-opencode-session derivation (parity with provider.ts)", () => {
  it("prefixes a bare conversation id and preserves an existing prefix", () => {
    expect(opencodeSessionIdFor("chat-1")).toBe("lexa-assistant-chat-1");
    expect(opencodeSessionIdFor("lexa-assistant-chat-1")).toBe("lexa-assistant-chat-1");
    expect(opencodeSessionIdFor(" chat-1 ")).toBe("lexa-assistant-chat-1");
    expect(opencodeSessionIdFor("chat-1")).toBe(bunOpencodeSessionIdFor("chat-1"));
    expect(opencodeSessionIdFor("lexa-assistant-chat-1")).toBe(bunOpencodeSessionIdFor("lexa-assistant-chat-1"));
  });

  it("falls back to providerId then model when no session id is supplied", () => {
    expect(resolveOpencodeSessionId(undefined, { providerId: "prov-1", model: "m" })).toBe("lexa-assistant-prov-1");
    expect(resolveOpencodeSessionId(undefined, { model: "m" })).toBe("lexa-assistant-m");
    expect(resolveOpencodeSessionId("", { providerId: "prov-1", model: "m" })).toBe(bunResolveOpencodeSessionId("", { providerId: "prov-1", model: "m" }));
    expect(resolveOpencodeSessionId("thread-9", { providerId: "prov-1", model: "m" })).toBe(bunResolveOpencodeSessionId("thread-9", { providerId: "prov-1", model: "m" }));
  });
});

describe("buildLanguageModel", () => {
  it("maps openai_compatible and attaches the session header", () => {
    const model = buildLanguageModel(baseConfig);
    expect(providerOf(model)).toContain("openai-compatible");
    expect(modelIdOf(model)).toBe("deepseek-v4-flash");
    expect(headersOf(model)?.[OPENCODE_SESSION_HEADER]).toBe("lexa-assistant-chat-123");
  });

  it("maps anthropic_compatible", () => {
    const model = buildLanguageModel({ ...baseConfig, kind: "anthropic_compatible", model: "claude-x" });
    expect(providerOf(model)).toContain("anthropic");
    expect(modelIdOf(model)).toBe("claude-x");
    expect(headersOf(model)?.[OPENCODE_SESSION_HEADER]).toBe("lexa-assistant-chat-123");
  });

  it("maps openai_responses", () => {
    const model = buildLanguageModel({ ...baseConfig, kind: "openai_responses", model: "gpt-5" });
    expect(providerOf(model)).toContain("openai");
    expect(modelIdOf(model)).toBe("gpt-5");
    expect(headersOf(model)?.[OPENCODE_SESSION_HEADER]).toBe("lexa-assistant-chat-123");
  });

  it("falls back to providerId for the session header when the conversation id is absent", () => {
    const model = buildLanguageModel({ ...baseConfig, sessionId: undefined });
    expect(headersOf(model)?.[OPENCODE_SESSION_HEADER]).toBe("lexa-assistant-prov-1");
  });
});

describe("buildModelChain", () => {
  it("caps the chain at three configs", () => {
    const configs: RegistryModelConfig[] = [0, 1, 2, 3, 4].map((i) => ({ ...baseConfig, model: `m-${i}` }));
    expect(buildModelChain(configs)).toHaveLength(3);
  });
});

describe("error classification", () => {
  it("reads a status from common AI SDK error shapes", () => {
    expect(statusOfError({ status: 429 })).toBe(429);
    expect(statusOfError({ statusCode: "503" })).toBe(503);
    expect(statusOfError({ cause: { status: 401 } })).toBe(401);
    expect(statusOfError(new Error("boom"))).toBeUndefined();
  });

  it("classifies rate limits for PROVIDER_RATE_LIMITED", () => {
    expect(isRateLimitedError({ status: 429 })).toBe(true);
    expect(isRateLimitedError(new Error("Too Many Requests"))).toBe(true);
    expect(isRateLimitedError({ status: 500 })).toBe(false);
  });

  it("treats transient upstream failures as retryable and terminal ones as not", () => {
    expect(isRetryableModelError({ status: 429 })).toBe(true);
    expect(isRetryableModelError({ status: 503 })).toBe(true);
    expect(isRetryableModelError(new Error("fetch failed"))).toBe(true);
    expect(isRetryableModelError({ status: 401 })).toBe(false);
    expect(isRetryableModelError({ status: 400 })).toBe(false);
    expect(isRetryableModelError({ status: 422 })).toBe(false);
  });
});

describe("runWithModelFallback", () => {
  it("returns the primary result without touching fallbacks", async () => {
    const seen: string[] = [];
    const result = await runWithModelFallback([baseConfig, { ...baseConfig, model: "m2" }], async (config) => {
      seen.push(config.model);
      return "ok";
    });
    expect(result).toEqual({ value: "ok", configIndex: 0 });
    expect(seen).toEqual(["deepseek-v4-flash"]);
  });

  it("walks to the next config on a retryable failure", async () => {
    const result = await runWithModelFallback(
      [baseConfig, { ...baseConfig, model: "m2" }, { ...baseConfig, model: "m3" }],
      async (config) => {
        if (config.model !== "m3") throw Object.assign(new Error("upstream"), { status: 503 });
        return "ok";
      }
    );
    expect(result).toEqual({ value: "ok", configIndex: 2 });
  });

  it("does not walk past a terminal (non-retryable) failure", async () => {
    let calls = 0;
    await expect(
      runWithModelFallback([baseConfig, { ...baseConfig, model: "m2" }], async () => {
        calls += 1;
        throw Object.assign(new Error("unauthorized"), { status: 401 });
      })
    ).rejects.toMatchObject({ status: 401 });
    expect(calls).toBe(1);
  });

  it("rethrows the last retryable failure when the chain is exhausted", async () => {
    await expect(
      runWithModelFallback([baseConfig, { ...baseConfig, model: "m2" }], async () => {
        throw Object.assign(new Error("rate limited"), { status: 429 });
      })
    ).rejects.toMatchObject({ status: 429 });
  });
});
