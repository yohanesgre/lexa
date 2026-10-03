import { describe, expect, it } from "vitest";
import type { generateText } from "ai";
import {
  needsSummary,
  renderMessages,
  summarizeTranscript,
  summaryWindow,
  SUMMARY_THRESHOLD_BYTES,
  SUMMARY_THRESHOLD_MESSAGES,
  SUMMARY_WINDOW,
  type AssistantTraceParams,
} from "./summarize";
import type { RegistryModelConfig } from "./model-factory";

function msg(i: number): { id: string; role: "user" | "assistant"; parts: Array<{ type: "text"; text: string }> } {
  return {
    id: `m${i}`,
    role: i % 2 === 0 ? "user" : "assistant",
    parts: [{ type: "text", text: `message ${i}` }],
  };
}

function many(count: number): ReturnType<typeof msg>[] {
  return Array.from({ length: count }, (_, i) => msg(i));
}

const CONFIG: RegistryModelConfig = {
  kind: "openai_compatible",
  baseUrl: "https://provider.test",
  apiKey: "sk-test",
  model: "test-model",
  providerId: "prov-1",
};

function stubGenerate(text: string | null, onCall?: (params: unknown) => void): typeof generateText {
  return ((params: unknown) => {
    onCall?.(params);
    return Promise.resolve({ text: text ?? "" });
  }) as unknown as typeof generateText;
}

describe("needsSummary", () => {
  it("is false under both thresholds and true past the message threshold", () => {
    expect(needsSummary(many(SUMMARY_THRESHOLD_MESSAGES))).toBe(false);
    expect(needsSummary(many(SUMMARY_THRESHOLD_MESSAGES + 1))).toBe(true);
  });

  it("triggers on the byte threshold for a small-but-large transcript", () => {
    const big = [{ id: "m", role: "user", parts: [{ type: "text", text: "x".repeat(SUMMARY_THRESHOLD_BYTES + 1) }] }];
    expect(needsSummary(big)).toBe(true);
  });

  it("measures UTF-8 bytes, not UTF-16 code units, for the byte threshold", () => {
    // 16_384 four-byte emoji = 65_536 UTF-8 bytes but only 32_768 code units,
    // so the old `JSON.stringify(...).length` check would miss it.
    const text = "😀".repeat(16_384);
    const msg = [{ id: "m", role: "user", parts: [{ type: "text", text }] }];
    expect(JSON.stringify(msg).length).toBeLessThanOrEqual(SUMMARY_THRESHOLD_BYTES);
    expect(needsSummary(msg)).toBe(true);
  });
});

describe("summaryWindow", () => {
  it("returns null under threshold or when the window is already summarized", () => {
    expect(summaryWindow(many(10), 0)).toBeNull();
    expect(summaryWindow(many(41), 33)).toBeNull();
    expect(summaryWindow(many(41), 40)).toBeNull();
  });

  it("slides only the not-yet-summarized prefix and reports the new total", () => {
    const window = summaryWindow(many(41), 0);
    expect(window?.older).toHaveLength(41 - SUMMARY_WINDOW);
    expect(window?.summarizedCount).toBe(41 - SUMMARY_WINDOW);
    const incremental = summaryWindow(many(42), 33);
    expect(incremental?.older).toHaveLength(1);
    expect(incremental?.summarizedCount).toBe(34);
  });

  it("is idempotent: a repeat of the same transcript yields no window", () => {
    const window = summaryWindow(many(41), 0);
    expect(window).not.toBeNull();
    expect(summaryWindow(many(41), window!.summarizedCount)).toBeNull();
  });
});

describe("renderMessages", () => {
  it("renders UIMessage parts and legacy string content as role-tagged text", () => {
    const out = renderMessages([
      { role: "user", parts: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: "world" },
      { role: "user", parts: [{ type: "text", text: "   " }] },
    ]);
    expect(out).toBe("user: hello\n\nassistant: world");
  });
});

describe("summarizeTranscript", () => {
  it("uses the primary config and the injected generateText, and returns the text", async () => {
    let seen: unknown;
    const summary = await summarizeTranscript([msg(0)], null, [CONFIG], {
      generateTextImpl: stubGenerate("CONDENSED", (p) => (seen = p)),
    });
    expect(summary).toBe("CONDENSED");
    expect((seen as { model?: unknown }).model).toBeDefined();
    expect((seen as { system?: string }).system).toContain("condense");
  });

  it("passes the prior summary into the prompt for a cumulative result", async () => {
    let seen: { prompt?: string } | undefined;
    await summarizeTranscript([msg(0)], "PRIOR", [CONFIG], {
      generateTextImpl: stubGenerate("x", (p) => (seen = p as { prompt?: string })),
    });
    expect(seen?.prompt).toContain("PRIOR");
  });

  it("returns null with no config, empty input, or an empty model reply", async () => {
    expect(await summarizeTranscript([msg(0)], null, [])).toBeNull();
    expect(await summarizeTranscript([], null, [CONFIG], { generateTextImpl: stubGenerate("x") })).toBeNull();
    expect(await summarizeTranscript([msg(0)], null, [CONFIG], { generateTextImpl: stubGenerate("  ") })).toBeNull();
  });

  it("returns null when the provider call throws (failure skips)", async () => {
    const boom = (() => Promise.reject(new Error("provider down"))) as unknown as typeof generateText;
    expect(await summarizeTranscript([msg(0)], null, [CONFIG], { generateTextImpl: boom })).toBeNull();
  });

  it("forwards the trace params to the call", async () => {
    let seen: { runtimeContext?: unknown } | undefined;
    const trace: AssistantTraceParams = {
      runtimeContext: { agentId: "do-1", conversationId: "chat:abc", purpose: "summary" },
      experimental_telemetry: { functionId: "lexa-assistant", includeRuntimeContext: { purpose: true } },
    };
    await summarizeTranscript([msg(0)], null, [CONFIG], {
      generateTextImpl: stubGenerate("ok", (p) => (seen = p as { runtimeContext?: unknown })),
      trace,
    });
    expect(seen?.runtimeContext).toEqual({ agentId: "do-1", conversationId: "chat:abc", purpose: "summary" });
  });
});
