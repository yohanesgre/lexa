// DO-side assistant engine (ADR-0003 §B.5/§C, P3).
//
// One chat turn: resolve the project's provider chain (via the Worker internal
// route), stream the model through the AI SDK with the built-in
// `x-opencode-session` header (model factory), and record the call log +
// terminal run status through the Worker internal routes. Tools, vision, prompt
// assembly, MCP, and Jev are layered on in later P3 passes.
//
// The module is transport-agnostic and dependency-injected so a stubbed
// provider + recording deps can drive the whole turn outside workerd.

import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  pruneMessages,
  stepCountIs,
  streamText,
  toUIMessageStream,
  type LanguageModel,
  type StopCondition,
  type TextStreamPart,
  type ToolSet,
  type UIMessage,
} from "ai";
import type { AssistantCallLogInput, AssistantCallLogPurpose } from "../../shared/assistant";
import {
  isRateLimitedError,
  isRetryableModelError,
  runWithModelFallback,
  statusOfError,
  type RegistryModelConfig,
} from "./model-factory";

/** Terminal run status the DO reports to the Worker internal route. */
export interface RunStatusTransition {
  runId: string;
  status: "completed" | "failed" | "cancelled";
  result?: string | null;
  error?: string | null;
  /**
   * Steps the turn actually took (AI SDK `steps.length`). Only registry-backed
   * runs persist it (`assistant_runs.steps_used`); the document-run route
   * ignores it. Omitted when unknown.
   */
  stepsUsed?: number | undefined;
}

/** Worker capabilities one turn needs, injected from `agent.ts`. */
export interface AssistantTurnDeps {
  /** `null` = the project has no provider binding (→ PROVIDER_NOT_CONFIGURED). */
  resolveProviderConfigs: (projectId: string) => Promise<RegistryModelConfig[] | null>;
  recordCallLog: (input: AssistantCallLogInput) => Promise<void>;
  transitionRun: (input: RunStatusTransition) => Promise<void>;
  /**
   * Best-effort per-attempt provider health report (H8): keeps
   * `assistant_provider_health` live between manual probes. Absent = no breaker
   * telemetry; a throw is swallowed by the engine so a health write can never
   * fail a turn.
   */
  recordProviderHealth?: ((input: { providerId: string; ok: boolean }) => Promise<void>) | undefined;
  /**
   * Attachment hydration (ADR-0003 §C). The DO transcript carries attachments
   * as `data-attachment` parts, which the AI SDK cannot see; these loaders turn
   * a storage key into provider-visible content — base64 for images, extracted
   * text for documents. Both are Workers-safe (the DO reaches blob storage
   * through an internal route, never a Bun module). Absent = the part is
   * dropped, mirroring the legacy `hydrateDocumentParts` loader-absent path.
   */
  loadImageBase64?: ((key: string) => Promise<string | null>) | undefined;
  loadDocumentText?: ((key: string) => Promise<string | null>) | undefined;
}

/**
 * Per-call tracing metadata (ADR-0004 addendum; H2). Structural twin of
 * `tracing.ts`'s params so the engine never imports `agents/observability/ai`
 * (which pulls `cloudflare:workers`) into its node-run unit tests.
 */
export interface AssistantTraceParams {
  runtimeContext: Record<string, unknown>;
  experimental_telemetry: {
    functionId: string;
    includeRuntimeContext: Record<string, boolean>;
  };
}

/**
 * Vision handling for image attachments, mirroring `vision.ts`'s `VisionMode`
 * without importing that module (which pulls `@tanstack/ai` into the DO bundle).
 * The DO resolves it from the harness `visionModel` field: set → `"delegate"`
 * (images become placeholder text parts; the model calls `analyze_image`);
 * unset → `"none"`. The inline branch is the later target.
 */
export type ImageMode = "inline" | "delegate" | "none";

export interface AssistantTurnInput {
  projectId: string;
  /** `<documentType>:<documentId>` — the DO's identity. */
  threadKey: string;
  /**
   * Per-conversation value for `x-opencode-session`. Parity with the Bun
   * adapter: this is the DOCUMENT id (not the thread key), i.e. `chat:c1` →
   * `lexa-assistant-c1`.
   */
  sessionId: string;
  messages: UIMessage[];
  /** Tool set built by the caller (read via internal routes, write proposals). */
  tools?: ToolSet | undefined;
  /** System prompt text (assembled by the caller from `prompt.ts`). */
  system?: string | undefined;
  /** Multi-step budget; the caller stops the loop early on a write proposal. */
  stopWhen?: StopCondition<ToolSet> | Array<StopCondition<ToolSet>> | undefined;
  /** Present only for document runs; chat turns have no `assistant_tasks` row. */
  runId?: string | null | undefined;
  /**
   * Which assistant flow issued this turn; stamped onto every call log as
   * `purpose`. `"turn"` for interactive turns, `"runner"` for delegated runs.
   */
  callLogPurpose?: AssistantCallLogPurpose | undefined;
  /**
   * How image attachments are hydrated (mirrors the legacy `StreamRunContext`).
   * `"delegate"` replaces each image with a placeholder text part (the model
   * calls the internal `analyze_image` delegation); `"inline"` embeds base64
   * image parts (later target); `"none"` refuses an image attachment with
   * VISION_NOT_CONFIGURED. Absent = `"none"` (the safe default when the harness
   * value is unknown).
   */
  imageMode?: ImageMode | undefined;
  abortSignal?: AbortSignal | undefined;
  /** Clock seam for latency in tests. */
  nowMs?: (() => number) | undefined;
  /** Traced `streamText` (the DO passes `tracedAI.streamText`); defaults to `ai`'s. */
  streamTextImpl?: typeof streamText | undefined;
  /** Per-call trace identity; absent = untraced (unit tests). */
  trace?: AssistantTraceParams | undefined;
}

export type AssistantTurnErrorCode =
  | "PROVIDER_NOT_CONFIGURED"
  | "PROVIDER_RATE_LIMITED"
  | "PROVIDER_AUTH_FAILED"
  | "PROVIDER_UNREACHABLE"
  | "VISION_NOT_CONFIGURED"
  | "ASSISTANT_GENERATION_FAILED";

/** Maps to the LAYERS catalog status in the DO's error response. */
export class AssistantTurnError extends Error {
  readonly code: AssistantTurnErrorCode;
  readonly status: number;
  constructor(code: AssistantTurnErrorCode, status: number, message: string) {
    super(message);
    this.name = "AssistantTurnError";
    this.code = code;
    this.status = status;
  }
}

export function turnErrorFor(e: unknown): AssistantTurnError {
  if (e instanceof AssistantTurnError) return e;
  const status = statusOfError(e);
  if (isRateLimitedError(e)) {
    return new AssistantTurnError("PROVIDER_RATE_LIMITED", 429, "Provider rate limited");
  }
  if (status === 401 || status === 403) {
    return new AssistantTurnError("PROVIDER_AUTH_FAILED", 502, "Provider rejected the credentials");
  }
  if (isRetryableModelError(e)) {
    return new AssistantTurnError("PROVIDER_UNREACHABLE", 502, "Provider unreachable");
  }
  return new AssistantTurnError(
    "ASSISTANT_GENERATION_FAILED",
    502,
    e instanceof Error ? e.message : "Assistant generation failed"
  );
}

type TurnPart = TextStreamPart<ToolSet>;

/**
 * Mutable per-attempt marker. `startStream` returns with `isFinal: false`; the
 * fallback walk sets it `true` once it has committed to that attempt. Only a
 * final attempt may transition the run to `failed` (a retryable pre-stream
 * failure that the walk will retry must not mark the run failed — the winning
 * attempt owns the terminal transition).
 */
interface AttemptState {
  isFinal: boolean;
}

interface StartedTurn {
  stream: ReadableStream<TurnPart>;
  config: RegistryModelConfig;
  attemptState: AttemptState;
}

/**
 * Read the head of the stream to decide whether the provider connection
 * succeeded. The AI SDK emits `start` (and `start-step`) before the provider
 * call completes, so those parts are skipped; the first meaningful part is
 * either an `error` (this config is unusable — the fallback walk moves on) or
 * real content (the request was accepted). Everything read is replayed onto the
 * returned stream so the caller sees the full stream.
 */
async function peekFirstPart(
  source: ReadableStream<TurnPart>,
  /**
   * Invoked when the source stream errors mid-read. The AI SDK's `onError`
   * callback only fires for `error` *parts* it surfaces; a transport-level body
   * failure (`controller.error(...)` on the provider stream) bypasses it, so the
   * caller needs this hook to land a terminal outcome.
   */
  onSourceError?: ((error: unknown) => Promise<void>) | undefined
): Promise<ReadableStream<TurnPart>> {
  const reader = source.getReader();
  const buffered: TurnPart[] = [];
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const part = next.value;
      if (part.type === "start" || part.type === "start-step") {
        buffered.push(part);
        continue;
      }
      if (part.type === "error") {
        await reader.cancel().catch(() => undefined);
        throw part.error;
      }
      buffered.push(part);
      break;
    }
  } catch (e) {
    await reader.cancel().catch(() => undefined);
    throw e;
  }
  return new ReadableStream<TurnPart>({
    start(controller) {
      for (const part of buffered) controller.enqueue(part);
      void (async () => {
        try {
          for (;;) {
            const next = await reader.read();
            if (next.done) {
              controller.close();
              return;
            }
            controller.enqueue(next.value);
          }
        } catch (e) {
          await onSourceError?.(e).catch(() => undefined);
          controller.error(e);
        }
      })();
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

async function startStream(
  config: RegistryModelConfig,
  model: LanguageModel,
  input: AssistantTurnInput,
  /**
   * The turn's latch-wrapped deps (see `runAssistantTurn`): routing every
   * terminal transition — including `onAbort` — through it guarantees at most
   * one terminal status per turn, so `cancelled` cannot land after a
   * `completed`/`failed`.
   */
  guardedDeps: AssistantTurnDeps,
  startedAtMs: number
): Promise<StartedTurn> {
  const modelMessages = await convertToModelMessages(input.messages);
  // H2 addendum: prune tool call/result content before the last 2 messages so a
  // long tool loop cannot balloon the request; the persisted thread summary
  // covers what falls out of the window. Cheap and bounded.
  const messages = pruneMessages({ messages: modelMessages, toolCalls: "before-last-2-messages" });
  // One terminal outcome per provider attempt: `onEnd` (success), `onError` (an
  // error part the SDK surfaces) and the transport catch below can race for the
  // same attempt, and exactly one call log must describe it.
  let settled = false;
  const attemptState: AttemptState = { isFinal: false };
  const failAttempt = async (error: unknown): Promise<void> => {
    const turnError = turnErrorFor(error);
    if (!settled) {
      settled = true;
      await guardedDeps.recordCallLog({
        projectId: input.projectId,
        providerId: config.providerId ?? null,
        threadKey: input.threadKey,
        runId: input.runId ?? null,
        model: config.model,
        kind: config.kind,
        status: "error",
        purpose: input.callLogPurpose ?? "turn",
        errorCode: turnError.code,
        latencyMs: (input.nowMs?.() ?? Date.now()) - startedAtMs,
        estimated: true,
      });
      await reportProviderHealthQuietly(guardedDeps, config.providerId, false);
    }
    // A retryable pre-stream failure may still be retried by the fallback walk,
    // so only the attempt the walk committed to may land `failed` (mid-stream
    // errors after the walk returned cannot be retried). The idempotency gate in
    // `transitionAssistantRun` makes a later `onEnd` (the SDK can fire both) a
    // no-op once this has landed.
    if (attemptState.isFinal) {
      await transitionRunQuietly(guardedDeps, input.runId, { status: "failed", result: null, error: turnError.message });
    }
  };
  const result = (input.streamTextImpl ?? streamText)({
    model,
    messages,
    // Tool loop: one step per assistant turn; the caller raises the cap with
    // `stepCountIs` and stops early when a write tool proposes (suspend).
    stopWhen: input.stopWhen ?? stepCountIs(1),
    ...(input.tools ? { tools: input.tools } : {}),
    ...(input.system ? { system: input.system } : {}),
    // The fallback walk owns retries: the SDK must not retry the same config
    // (that would multiply the rate-limit hit and defeat the walk).
    maxRetries: 0,
    ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    ...(input.trace
      ? {
          runtimeContext: input.trace.runtimeContext,
          experimental_telemetry: input.trace.experimental_telemetry,
        }
      : {}),
    onEnd: async (event) => {
      if (settled) return;
      settled = true;
      await guardedDeps.recordCallLog({
        projectId: input.projectId,
        providerId: config.providerId ?? null,
        threadKey: input.threadKey,
        runId: input.runId ?? null,
        model: config.model,
        kind: config.kind,
        status: "done",
        purpose: input.callLogPurpose ?? "turn",
        usageIn: event.usage.inputTokens ?? 0,
        usageOut: event.usage.outputTokens ?? 0,
        cachedIn: event.usage.inputTokenDetails?.cacheReadTokens ?? 0,
        cachedWriteIn: event.usage.inputTokenDetails?.cacheWriteTokens ?? 0,
        latencyMs: (input.nowMs?.() ?? Date.now()) - startedAtMs,
        estimated: event.usage.inputTokens === undefined && event.usage.outputTokens === undefined,
      });
      await reportProviderHealthQuietly(guardedDeps, config.providerId, true);
      await transitionRunQuietly(guardedDeps, input.runId, {
        status: "completed",
        result: event.text,
        error: null,
        stepsUsed: event.steps.length,
      });
    },
    onError: async (event) => {
      await failAttempt(event.error);
    },
    onAbort: async () => {
      await transitionRunQuietly(guardedDeps, input.runId, { status: "cancelled", result: null, error: null });
    },
  });
  // Transport-level failures bypass the SDK's `onError` (see `peekFirstPart`), so
  // the catch routes them through the same single-outcome helper before the
  // stream is re-errored for the client.
  const stream = await peekFirstPart(result.fullStream, failAttempt);
  return { stream, config, attemptState };
}

// Provider-health writes are best-effort from the stream callbacks: a failed
// report must never break the turn's stream (the breaker self-heals on the next
// turn). Absent provider id / unwired dep = nothing to report.
async function reportProviderHealthQuietly(
  deps: AssistantTurnDeps,
  providerId: string | null | undefined,
  ok: boolean
): Promise<void> {
  if (!providerId || !deps.recordProviderHealth) return;
  try {
    await deps.recordProviderHealth({ providerId, ok });
  } catch (e) {
    console.warn("[Assistant] provider-health report failed:", e instanceof Error ? e.message : String(e));
  }
}

// Run-status writes are best-effort from the stream callbacks: the turn's
// stream must never be broken by a failed run-status transition (the Worker
// route is authoritative and the next turn/recovery reconciles).
async function transitionRunQuietly(
  deps: AssistantTurnDeps,
  runId: string | null | undefined,
  input: Omit<RunStatusTransition, "runId">
): Promise<void> {
  if (!runId) return;
  try {
    await deps.transitionRun({ runId, ...input });
  } catch (e) {
    console.warn("[Assistant] run-status transition failed:", e instanceof Error ? e.message : String(e));
  }
}

interface AttachmentPartData {
  storageKey: string;
  mimeType: string;
  name: string;
}

// The `data-attachment` part the client sends on the user message
// (`assistant-agent-adapter.ts` `agentSendParts`): `{storageKey, mimeType, name}`.
function readAttachmentPart(part: unknown): AttachmentPartData | null {
  if (typeof part !== "object" || part === null) return null;
  const candidate = part as { type?: unknown; data?: unknown };
  if (candidate.type !== "data-attachment") return null;
  const data = candidate.data;
  if (typeof data !== "object" || data === null) return null;
  const record = data as { storageKey?: unknown; mimeType?: unknown; name?: unknown };
  if (typeof record.storageKey !== "string" || record.storageKey.length === 0) return null;
  return {
    storageKey: record.storageKey,
    mimeType: typeof record.mimeType === "string" ? record.mimeType : "application/octet-stream",
    name: typeof record.name === "string" ? record.name : "",
  };
}

function isImageAttachment(mimeType: string): boolean {
  return mimeType.startsWith("image/");
}

/**
 * Attachment hydration (ADR-0003 §C). `convertToModelMessages` cannot see the
 * DO transcript's `data-attachment` parts, so this rewrites them into
 * provider-visible content before the conversion: documents become extracted
 * text, images become inline base64 `file` parts when the project's primary
 * supports images (mirroring the legacy `hydrateImageParts` /
 * `hydrateDocumentParts` in `assistant-helpers.ts`). An image attachment with
 * vision disabled is refused server-side (the legacy `VISION_NOT_CONFIGURED`
 * gate). A part whose content cannot be loaded is dropped, mirroring the legacy
 * loaders. A message with no attachment parts passes through untouched.
 */
async function hydrateAttachmentParts(
  messages: UIMessage[],
  deps: AssistantTurnDeps,
  imageMode: ImageMode | undefined
): Promise<UIMessage[]> {
  const mode: ImageMode = imageMode ?? "none";
  let hasAttachment = false;
  let hasImage = false;
  for (const message of messages) {
    if (!Array.isArray(message.parts)) continue;
    for (const part of message.parts) {
      const attachment = readAttachmentPart(part);
      if (!attachment) continue;
      hasAttachment = true;
      if (isImageAttachment(attachment.mimeType)) hasImage = true;
    }
  }
  if (!hasAttachment) return messages;
  // Images gate on vision exactly as the legacy chat service does: only an
  // image attachment (documents never need vision) is refused.
  if (hasImage && mode === "none") {
    throw new AssistantTurnError("VISION_NOT_CONFIGURED", 409, "Image attachments are not enabled for this project");
  }
  return Promise.all(
    messages.map(async (message) => {
      if (!Array.isArray(message.parts)) return message;
      const parts = (
        await Promise.all(
          message.parts.map(async (part) => {
            const attachment = readAttachmentPart(part);
            if (!attachment) return part;
            if (isImageAttachment(attachment.mimeType)) {
              if (mode === "inline" && deps.loadImageBase64) {
                const base64 = await deps.loadImageBase64(attachment.storageKey).catch(() => null);
                if (base64 === null || base64 === "") return null;
                return { type: "file" as const, mediaType: attachment.mimeType, url: `data:${attachment.mimeType};base64,${base64}` };
              }
              // "delegate": the image is not sent to the primary. A placeholder
              // text part names it so the model calls the internal
              // `analyze_image` tool (offered only when a vision model is set).
              return { type: "text" as const, text: `[attached image: ${attachment.name || attachment.storageKey}]` };
            }
            if (!deps.loadDocumentText) return null;
            const text = await deps.loadDocumentText(attachment.storageKey).catch(() => null);
            if (text === null || text.trim() === "") return null;
            return { type: "text" as const, text: `[attached document: ${attachment.name}]\n${text}` };
          })
        )
      ).filter((part) => part !== null);
      return { ...message, parts } as UIMessage;
    })
  );
}

/**
 * Run one assistant turn and return the UI message stream response. Throws
 * `AssistantTurnError` when the provider chain cannot produce a stream (the
 * caller maps it to the response status).
 */
export async function runAssistantTurn(
  deps: AssistantTurnDeps,
  input: AssistantTurnInput
): Promise<Response> {
  const resolved = await deps.resolveProviderConfigs(input.projectId);
  if (resolved === null || resolved.length === 0) {
    throw new AssistantTurnError("PROVIDER_NOT_CONFIGURED", 409, "No provider binding for this project");
  }
  const configs = resolved.map((config) => ({ ...config, sessionId: input.sessionId }));
  const startedAtMs = input.nowMs?.() ?? Date.now();

  // Attachment hydration (ADR-0003 §C): rewrite the user turn's
  // `data-attachment` parts into provider-visible content ONCE for the whole
  // turn, so every fallback attempt shares it. A vision-disabled image
  // attachment refuses the turn here (before any provider call).
  const messages = await hydrateAttachmentParts(input.messages, deps, input.imageMode);
  const turnInput: AssistantTurnInput = { ...input, messages };

  // One terminal transition per turn. A pre-stream peek failure (the catch
  // below) and the SDK's `onError` can both fire for the same failed provider
  // call; the Worker route is idempotent, but this latch also avoids the
  // redundant retry-once POST. The first transition wins.
  let terminalSent = false;
  const guardedDeps: AssistantTurnDeps = {
    ...deps,
    transitionRun: async (transition) => {
      if (terminalSent) return;
      terminalSent = true;
      await deps.transitionRun(transition);
    },
  };

  let started: StartedTurn;
  try {
    const walked = await runWithModelFallback(configs, (config, model) =>
      startStream(config, model, turnInput, guardedDeps, startedAtMs)
    );
    started = walked.value;
    // The walk has committed to this attempt: a pre-stream `onError` on an
    // earlier attempt must not have marked the run failed, and from here on any
    // failure on this attempt is terminal (no retry remains).
    started.attemptState.isFinal = true;
  } catch (e) {
    const turnError = turnErrorFor(e);
    await transitionRunQuietly(guardedDeps, input.runId, {
      status: "failed",
      result: null,
      error: turnError.message,
    });
    throw turnError;
  }

  // W7b/WS3: the app reads `metadata.usage` (done-state token chip) and
  // `metadata.reasoningMs` (duration label) off the assistant message. Measure
  // reasoning wall-time by observing the reasoning part boundaries as the
  // stream flows past (the SDK only calls `messageMetadata` on `start` and
  // `finish`), then attach both on the terminal finish part.
  const now = (): number => input.nowMs?.() ?? Date.now();
  const reasoning = { startedAt: null as number | null, total: 0 };
  const observed = started.stream.pipeThrough(
    new TransformStream<TurnPart, TurnPart>({
      transform(part, controller) {
        if (part.type === "reasoning-start") {
          if (reasoning.startedAt === null) reasoning.startedAt = now();
        } else if (part.type === "reasoning-end" && reasoning.startedAt !== null) {
          reasoning.total += Math.max(0, now() - reasoning.startedAt);
          reasoning.startedAt = null;
        }
        controller.enqueue(part);
      },
    })
  );
  const uiStream = toUIMessageStream({
    stream: observed,
    messageMetadata: ({ part }) => {
      if (part.type !== "finish") return undefined;
      const inputTokens = part.totalUsage.inputTokens;
      const outputTokens = part.totalUsage.outputTokens;
      const metadata: { usage?: { in: number; out: number }; reasoningMs?: number } = {};
      // Omit `usage` entirely when the provider reported no token counts rather
      // than fabricating a `{0,0}` chip. A single defined count still surfaces.
      if (inputTokens !== undefined || outputTokens !== undefined) {
        metadata.usage = { in: inputTokens ?? 0, out: outputTokens ?? 0 };
      }
      const openMs = reasoning.startedAt !== null ? Math.max(0, now() - reasoning.startedAt) : 0;
      const reasoningMs = reasoning.total + openMs;
      if (reasoningMs > 0) metadata.reasoningMs = reasoningMs;
      return Object.keys(metadata).length > 0 ? metadata : undefined;
    },
  });
  return createUIMessageStreamResponse({ stream: uiStream });
}
