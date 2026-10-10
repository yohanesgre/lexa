import { describe, expect, it } from "vitest";
import { analyzeImage, resolveVisionMode, visionWireForKind, type AnalyzeDeps } from "./vision";
import { shouldEmitToolFrame, replaceImageRefsWithPlaceholders } from "../services/assistant.service";
import type { ProviderConfig } from "./provider";

const config = (kind: "openai_compatible" | "anthropic_compatible"): ProviderConfig => ({
  kind,
  baseUrl: "https://vision.example.com/v1",
  apiKey: "vk-test",
  model: "vl-1",
});

const deps = (fetchImpl: (input: string, init?: RequestInit) => Promise<Response>): AnalyzeDeps => ({
  config: config("openai_compatible"),
  loadImageBase64: async (key) => (key === "dead" ? null : "QkY="),
  resolveMimeType: async () => "image/png",
  fetchImpl: fetchImpl as unknown as typeof fetch,
});

describe("resolveVisionMode", () => {
  it("configured vision model → delegate, even when the primary is multimodal (current phase)", () => {
    expect(resolveVisionMode({ primary_supports_images: 0, vision_model: "vl-1" })).toBe("delegate");
    expect(resolveVisionMode({ primary_supports_images: 1, vision_model: "m" })).toBe("delegate");
    expect(resolveVisionMode({ primary_supports_images: true, vision_model: "m" })).toBe("delegate");
  });

  it("no vision model + primary_supports_images=1 → inline (later-target branch)", () => {
    expect(resolveVisionMode({ primary_supports_images: 1, vision_model: null })).toBe("inline");
    expect(resolveVisionMode({ primary_supports_images: true, vision_model: null })).toBe("inline");
  });

  it("neither → none", () => {
    expect(resolveVisionMode({ primary_supports_images: 0, vision_model: null })).toBe("none");
    expect(resolveVisionMode({ primary_supports_images: 0, vision_model: "" })).toBe("none");
  });
});

describe("visionWireForKind (M5b: workers_ai allowed)", () => {
  it("workers_ai rides the OpenAI wire (ADR-0005 D5); only Responses is openai too", () => {
    expect(visionWireForKind("workers_ai")).toBe("openai");
    expect(visionWireForKind("openai_compatible")).toBe("openai");
    expect(visionWireForKind("openai_responses")).toBe("openai");
    expect(visionWireForKind("anthropic_compatible")).toBe("anthropic");
  });
});

describe("analyzeImage wire formats (fake fetch)", () => {
  it("openai_compatible: POST {base}/chat/completions with image_url data URI", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(input), init: init ?? {} });
      return new Response(JSON.stringify({ choices: [{ message: { content: "a red button" } }] }), { status: 200 });
    };
    const out = await analyzeImage(deps(fetchImpl), "k1", "what is shown?");
    expect(out).toBe("a red button");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://vision.example.com/v1/chat/completions");
    const headers = new Headers(calls[0]!.init.headers as Record<string, string>);
    expect(headers.get("authorization")).toBe("Bearer vk-test");
    const body = JSON.parse(String(calls[0]!.init.body)) as { model: string; messages: Array<{ content: Array<Record<string, unknown>> }> };
    expect(body.model).toBe("vl-1");
    const img = body.messages[0]!.content.find((p) => p.type === "image_url") as { image_url: { url: string } };
    expect(img.image_url.url.startsWith("data:image/png;base64,QkY=")).toBe(true);
  });

  it("workers_ai: POST {cf-ai-base}/chat/completions with a Bearer CF token (M5b)", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(input), init: init ?? {} });
      return new Response(JSON.stringify({ choices: [{ message: { content: "a chart" } }] }), { status: 200 });
    };
    const d: AnalyzeDeps = {
      ...deps(fetchImpl),
      config: {
        kind: "workers_ai",
        baseUrl: "https://api.cloudflare.com/client/v4/accounts/acc/ai/v1",
        apiKey: "cf-token",
        model: "@cf/llava",
      },
    };
    const out = await analyzeImage(d, "k1", "what is shown?");
    expect(out).toBe("a chart");
    expect(calls[0]!.url).toBe("https://api.cloudflare.com/client/v4/accounts/acc/ai/v1/chat/completions");
    const headers = new Headers(calls[0]!.init.headers as Record<string, string>);
    expect(headers.get("authorization")).toBe("Bearer cf-token");
  });

  it("anthropic_compatible: POST {base}/v1/messages with base64 source block; joins text blocks", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(input), init: init ?? {} });
      return new Response(JSON.stringify({ content: [{ type: "text", text: "part1" }, { type: "text", text: "part2" }] }), { status: 200 });
    };
    const d = { ...deps(fetchImpl), config: config("anthropic_compatible") };
    const out = await analyzeImage(d, "k1", "describe");
    expect(out).toBe("part1\npart2");
    expect(calls[0]!.url).toBe("https://vision.example.com/v1/messages");
    const headers = new Headers(calls[0]!.init.headers as Record<string, string>);
    expect(headers.get("x-api-key")).toBe("vk-test");
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
    const body = JSON.parse(String(calls[0]!.init.body)) as { messages: Array<{ content: Array<Record<string, unknown>> }> };
    const img = body.messages[0]!.content.find((p) => p.type === "image") as { source: Record<string, unknown> };
    expect(img.source).toEqual({ type: "base64", media_type: "image/png", data: "QkY=" });
  });

  it("unreachable blob → throws; upstream non-ok → throws", async () => {
    await expect(analyzeImage(deps(async () => new Response("{}", { status: 200 })), "dead", "q")).rejects.toThrow("could not be loaded");
    await expect(
      analyzeImage(deps(async () => new Response("denied", { status: 403 })), "k1", "q")
    ).rejects.toThrow("vision HTTP 403");
    await expect(
      analyzeImage(deps(async () => new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }), { status: 200 })), "k1", "q")
    ).rejects.toThrow("empty vision response");
  });
});

describe("frame suppression + placeholder transform", () => {
  it("analyze_image frames are suppressed; other tool frames pass", () => {
    expect(shouldEmitToolFrame("analyze_image")).toBe(false);
    expect(shouldEmitToolFrame("web_search")).toBe(true);
    expect(shouldEmitToolFrame("fetch_url")).toBe(true);
  });

  it("replaceImageRefsWithPlaceholders swaps refs for text placeholders, keeps other parts", async () => {
    const out = await replaceImageRefsWithPlaceholders([
      { role: "user", content: ["look at", { type: "image-ref", storageKey: "k1", mimeType: "image/png" }, "and this"] },
      { role: "assistant", content: "plain" },
    ]);
    expect(out[0]!.content).toEqual(["look at", { type: "text", content: "[attached image: k1]" }, "and this"]);
    expect(out[1]!.content).toBe("plain");
  });
});
