// DO-side thread compaction (ADR-0004 §2; H2).
//
// Mirrors the legacy REST/SSE tier's `needsSummary`/`summarizeOlder` pair
// (`server/assistant/build-stream.ts`) on the DO's canonical transcript:
// thresholds 40 messages / 64 KiB, window 8. The summary is cumulative —
// each event condenses only the messages that grew past the window since the
// last summary, incorporating the prior summary — so repeated persists of the
// same transcript are idempotent ("threshold once") and a wake re-reads the
// persisted `thread_meta` values instead of recomputing.
//
// DO-safe: imports only `ai` + the pure model factory, never the Bun/Worker
// stack. The `generateText` implementation is injectable so the wrapper
// (`tracing.ts`) can supply the traced namespace and unit tests can stub it.

import { generateText } from "ai";
import { buildLanguageModel, type RegistryModelConfig } from "./model-factory";

export const SUMMARY_THRESHOLD_MESSAGES = 40;
export const SUMMARY_THRESHOLD_BYTES = 64 * 1024;
export const SUMMARY_WINDOW = 8;
export const SUMMARY_INPUT_MAX_CHARS = 60_000;
export const SUMMARY_TIMEOUT_MS = 20_000;

export const SUMMARY_SYSTEM_PROMPT =
  "You condense working conversations. Reply with a terse bullet summary of decisions, constraints and open threads only.";

export type GenerateTextImpl = typeof generateText;

const textEncoder = new TextEncoder();

/** UTF-8 byte length — `String.length` undercounts multibyte characters. */
function utf8ByteLength(value: string): number {
  return textEncoder.encode(value).length;
}

/** True when the transcript crossed the message or byte threshold. */
export function needsSummary(messages: readonly unknown[]): boolean {
  if (messages.length > SUMMARY_THRESHOLD_MESSAGES) return true;
  try {
    return utf8ByteLength(JSON.stringify(messages)) > SUMMARY_THRESHOLD_BYTES;
  } catch {
    return false;
  }
}

export interface SummaryWindow {
  /** Messages to condense now (the not-yet-summarized prefix). */
  older: unknown[];
  /** Total messages condensed after this event (all-but-window). */
  summarizedCount: number;
}

/**
 * Decide what (if anything) to summarize. Returns `null` when the transcript is
 * under threshold or everything outside the window is already summarized.
 * `older` is the incremental slice `[summarizedCount, len - window)` so the
 * provider only sees new content; the caller supplies the prior summary to keep
 * the result cumulative.
 */
export function summaryWindow(messages: readonly unknown[], summarizedCount: number): SummaryWindow | null {
  const safeCount = Number.isFinite(summarizedCount) && summarizedCount > 0 ? Math.floor(summarizedCount) : 0;
  if (!needsSummary(messages)) return null;
  const toSummarize = messages.length - SUMMARY_WINDOW;
  if (toSummarize <= safeCount) return null;
  return { older: messages.slice(safeCount, toSummarize), summarizedCount: toSummarize };
}

/** Flatten UI/model messages to plain role-tagged text for the summarizer. */
export function renderMessages(messages: readonly unknown[]): string {
  const out: string[] = [];
  for (const raw of messages) {
    const message = raw as { role?: unknown; content?: unknown; parts?: unknown } | null;
    if (!message || typeof message !== "object") continue;
    const role = typeof message.role === "string" ? message.role : "message";
    let text = "";
    if (typeof message.content === "string") {
      text = message.content;
    } else if (Array.isArray(message.parts)) {
      text = message.parts
        .filter((p): p is { type?: unknown; text?: unknown } => typeof p === "object" && p !== null)
        .filter((p) => (p.type === "text" || p.type === undefined) && typeof p.text === "string")
        .map((p) => p.text as string)
        .join("\n");
    } else if (Array.isArray(message.content)) {
      text = message.content
        .filter((p): p is { type?: unknown; text?: unknown } => typeof p === "object" && p !== null)
        .filter((p) => (p.type === "text" || p.type === undefined) && typeof p.text === "string")
        .map((p) => p.text as string)
        .join("\n");
    }
    const trimmed = text.trim();
    if (trimmed === "") continue;
    out.push(`${role}: ${trimmed}`);
  }
  return out.join("\n\n").slice(0, SUMMARY_INPUT_MAX_CHARS);
}

export interface SummarizeOptions {
  /** Injected `generateText` (traced namespace or a test stub). */
  generateTextImpl?: GenerateTextImpl | undefined;
  timeoutMs?: number | undefined;
  nowMs?: (() => number) | undefined;
  /** Per-call trace params (H2); absent = untraced. */
  trace?: AssistantTraceParams | undefined;
}

/** Structural twin of `engine.ts`'s trace params (no `cloudflare:workers` import). */
export interface AssistantTraceParams {
  runtimeContext: Record<string, unknown>;
  experimental_telemetry: {
    functionId: string;
    includeRuntimeContext: Record<string, boolean>;
  };
}

/**
 * Condense the given messages with one cheap `generateText` on the project
 * chain's primary config. Returns `null` on any failure (no provider binding,
 * transport error, empty output) — the caller skips and retries next persist.
 */
export async function summarizeTranscript(
  older: readonly unknown[],
  priorSummary: string | null,
  configs: readonly RegistryModelConfig[],
  options: SummarizeOptions = {}
): Promise<string | null> {
  const config = configs[0];
  if (!config) return null;
  const transcript = renderMessages(older);
  if (transcript === "") return null;
  const prior = priorSummary && priorSummary.trim() !== "" ? `\n\nExisting summary so far:\n${priorSummary.trim()}` : "";
  const prompt = `Summarize these earlier conversation turns for continuity. Reply with bullets only.${prior}\n\n${transcript}`;
  const generate = options.generateTextImpl ?? generateText;
  try {
    const result = await generate({
      model: buildLanguageModel(config),
      system: SUMMARY_SYSTEM_PROMPT,
      prompt,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(options.timeoutMs ?? SUMMARY_TIMEOUT_MS),
      ...(options.trace
        ? {
            runtimeContext: options.trace.runtimeContext,
            experimental_telemetry: options.trace.experimental_telemetry,
          }
        : {}),
    });
    const text = typeof result.text === "string" ? result.text.trim() : "";
    return text === "" ? null : text;
  } catch {
    return null;
  }
}
