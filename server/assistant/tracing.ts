// DO-side AI SDK tracing (ADR-0004 addendum; H2).
//
// Wraps the `ai` namespace with the Cloudflare Agents `wrapAISDK()` tracer so a
// turn emits `invoke_agent → chat → execute_tool → tool_approval` spans to the
// CF Agents dashboard (7-day debug surface). Identity is metadata-only:
// `functionId` groups the spans, `agentId` is the stable DO instance,
// `conversationId` is the thread key, plus scalar `runId`/`purpose`. Payload
// storage stays OFF (both `storeMessages`/`storeTools` default to false).
//
// Imported ONLY from `agent.ts` (the workerd-loaded DO). `engine.ts` receives
// the traced operations through injected seams so its node-run unit tests never
// pull `cloudflare:workers` transitively.

import * as aiNamespace from "ai";
import { wrapAISDK } from "agents/observability/ai";

export const ASSISTANT_FUNCTION_ID = "lexa-assistant";
export const ASSISTANT_TRACE_CONTEXT_KEYS = ["runId", "purpose"] as const;

export type AssistantTracePurpose = "turn" | "resume" | "runner" | "summary" | "preflight";

export interface AssistantTraceIdentity {
  /** Stable agent instance (the DO id). */
  agentId: string;
  /** Thread key. */
  conversationId: string;
  /** Terminal-run id when the turn belongs to a run row. */
  runId?: string | undefined;
  purpose?: AssistantTracePurpose | undefined;
}

export interface AssistantTraceParams {
  runtimeContext: Record<string, unknown>;
  experimental_telemetry: {
    functionId: string;
    includeRuntimeContext: Record<string, boolean>;
  };
}

/** Build the per-call trace params spread into `streamText` / `generateText`. */
export function assistantTraceParams(identity: AssistantTraceIdentity): AssistantTraceParams {
  const runtimeContext: Record<string, unknown> = {
    agentId: identity.agentId,
    conversationId: identity.conversationId,
  };
  if (identity.runId !== undefined) runtimeContext["runId"] = identity.runId;
  if (identity.purpose !== undefined) runtimeContext["purpose"] = identity.purpose;
  return {
    runtimeContext,
    experimental_telemetry: {
      functionId: ASSISTANT_FUNCTION_ID,
      includeRuntimeContext: { runId: true, purpose: true },
    },
  };
}

const wrapped = wrapAISDK(aiNamespace as unknown as Record<string, unknown>, {
  includeRuntimeContext: ASSISTANT_TRACE_CONTEXT_KEYS,
});

/** The traced `ai` namespace. Only the four generation operations are wrapped. */
export const tracedAI = wrapped as unknown as typeof aiNamespace;
