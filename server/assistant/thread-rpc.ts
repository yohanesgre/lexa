// Assistant thread RPC seam (ADR-0003 §B.4). The shared REST handlers in
// `server/api/http.ts` forward thread-lifecycle operations to the per-thread
// Durable Object through this Effect tag, but `http.ts` must never import
// `agents` / `server/assistant/agent.ts` (Bun bundle guard, ADR §F).
//
// Two implementations:
//   - Bun flavor / tests → `assistantThreadRpcNoop`: every call resolves
//     `null`, so the handlers keep their current D1 / in-process behavior
//     byte-for-byte (this is the P5-deprecated server path until removal).
//   - Workers flavor → `server/workers-entry.ts` builds a DO-backed shape from
//     the `ASSISTANT_AGENT` namespace and injects it into the handler factory.
//
// A `null` result means "no Durable Object answered" — always safe: the caller
// falls back to its existing path. Transport errors are caught by the caller
// helper and also degrade to `null`.

import { Context } from "effect";
import type { AssistantToolPermissionMode } from "../../shared/assistant";

export interface AssistantThreadRpcShape {
  /**
   * Whether a Durable Object backs this shape. `false` = Bun/no-op flavor, so
   * a `null` result is the legitimate "no DO" fallback; `true` = Workers
   * flavor, where a rejected call is a real DO failure (logged, not silent).
   */
  readonly available: boolean;
  /** DO canonical transcript read; `null` = no DO (Bun) or unreachable. */
  getTranscript(
    threadKey: string
  ): Promise<{
    messages: unknown[];
    summary: string | null;
    summarizedCount: number | null;
    /** Sticky per-thread WRITE permission mode (D2); "ask" fallback. */
    permissionMode: AssistantToolPermissionMode;
  } | null>;
  /** Resume the suspended approval batch for a thread (`null` batchId = current). */
  resumeBatch(threadKey: string, batchId: string | null): Promise<{ ok: true } | null>;
  /** Destroy a thread's DO storage (chat delete). */
  destroyThread(threadKey: string): Promise<{ ok: true } | null>;
  /** Clear the DO transcript but keep the thread (document reset). */
  resetThread(threadKey: string): Promise<{ ok: true } | null>;
  /**
   * Enqueue per-thread work: a schedule tick hands over `{projectId, runId,
   * actorUserId}` so the DO can dispatch the detached facet for the registry
   * row; a document run (no registry row) pins the run-id cursor.
   */
  enqueueRun(
    threadKey: string,
    input: { projectId: string; runId: string; actorUserId: string }
  ): Promise<{ ok: true } | null>;
  /** Abort an in-flight document run. */
  abortRun(threadKey: string, taskId: string): Promise<{ ok: true } | null>;
}

export class AssistantThreadRpc extends Context.Tag("Lexa/AssistantThreadRpc")<
  AssistantThreadRpc,
  AssistantThreadRpcShape
>() {}

export const assistantThreadRpcNoop: AssistantThreadRpcShape = {
  available: false,
  getTranscript: async () => null,
  resumeBatch: async () => null,
  destroyThread: async () => null,
  resetThread: async () => null,
  enqueueRun: async () => null,
  abortRun: async () => null,
};
