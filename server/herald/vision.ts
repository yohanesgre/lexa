import { toolDefinition } from "@tanstack/ai";
import { z } from "zod";
import type { ProviderConfig } from "./provider";
import { normalizeBaseUrl } from "./provider";

export type VisionMode = "inline" | "delegate" | "none";

// Vision resolution chain (docs/SCHEMA.md — Hearth): primary supports images
// → inline parts; else a vision model is configured → internal analyze_image
// delegation on the PRIMARY provider (same kind/api_key/base_url, only the
// model differs); else attachments are rejected up front.
export function resolveVisionMode(row: { primary_supports_images: number | boolean; vision_model: string | null }): VisionMode {
  if (row.primary_supports_images === 1 || row.primary_supports_images === true) return "inline";
  if (row.vision_model !== null && row.vision_model !== "") return "delegate";
  return "none";
}

export interface AnalyzeDeps {
  config: ProviderConfig;
  loadImageBase64: (key: string) => Promise<string | null>;
  resolveMimeType: (key: string) => Promise<string>;
  fetchImpl: typeof fetch;
}

const VISION_TIMEOUT_MS = 60_000;
const VISION_MAX_TOKENS = 1024;

function dataUri(mimeType: string, base64: string): string {
  return `data:${mimeType};base64,${base64}`;
}

async function analyzeOpenAiCompatible(deps: AnalyzeDeps, prompt: string, mimeType: string, base64: string): Promise<string> {
  const base = normalizeBaseUrl(deps.config.baseUrl, "openai_compatible").replace(/\/+$/, "");
  const res = await deps.fetchImpl(`${base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${deps.config.apiKey}` },
    body: JSON.stringify({
      model: deps.config.model,
      max_tokens: VISION_MAX_TOKENS,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: dataUri(mimeType, base64) } },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(VISION_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`vision HTTP ${res.status}`);
  const body = (await res.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim() === "") throw new Error("empty vision response");
  return content;
}

async function analyzeAnthropicCompatible(deps: AnalyzeDeps, prompt: string, mimeType: string, base64: string): Promise<string> {
  const base = normalizeBaseUrl(deps.config.baseUrl, "anthropic_compatible").replace(/\/+$/, "");
  const res = await deps.fetchImpl(`${base}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": deps.config.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: deps.config.model,
      max_tokens: VISION_MAX_TOKENS,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mimeType, data: base64 } },
            { type: "text", text: prompt },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(VISION_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`vision HTTP ${res.status}`);
  const body = (await res.json()) as { content?: Array<{ type?: unknown; text?: unknown }> };
  const text = (body.content ?? [])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n");
  if (text.trim() === "") throw new Error("empty vision response");
  return text;
}

export async function analyzeImage(deps: AnalyzeDeps, storageKey: string, prompt: string): Promise<string> {
  const [base64, mimeType] = await Promise.all([deps.loadImageBase64(storageKey), deps.resolveMimeType(storageKey)]);
  if (base64 === null) throw new Error(`attachment '${storageKey}' could not be loaded`);
  return deps.config.kind === "openai_compatible"
    ? analyzeOpenAiCompatible(deps, prompt, mimeType, base64)
    : analyzeAnthropicCompatible(deps, prompt, mimeType, base64);
}

// Internal plumbing — the analyze_image tool frame is SUPPRESSED from the
// member-facing stream (see buildStream); members see the description woven
// into the reply, never the delegation chip.
export function buildAnalyzeImageTool(deps: AnalyzeDeps) {
  return toolDefinition({
    name: "analyze_image",
    description:
      "Describe an attached image. Call this once per attached image before answering; the user cannot see images directly.",
    inputSchema: z.object({
      storageKey: z.string().min(1).describe("Storage key of the attached image"),
      question: z.string().min(1).describe("What to extract from the image for the user's request"),
    }),
    outputSchema: z.object({ description: z.string(), error: z.string().optional() }),
  }).server(async ({ storageKey, question }) => {
    try {
      const description = await analyzeImage(deps, storageKey, question);
      return { description };
    } catch (e) {
      return { description: "", error: e instanceof Error ? e.message : "image analysis failed" };
    }
  });
}
