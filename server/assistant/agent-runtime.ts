// DO ↔ Worker runtime helpers (ADR-0003 §B.3): legacy import-on-read and the
// per-step D1 mirror. Fetch-based with an injectable `fetchImpl` so the
// request/response contract, the retry-once policy, and the conversion are
// unit-testable outside workerd.
//
// Wire contract with the Worker internal routes (`server/assistant/internal-routes.ts`):
//   GET  /api/internal/assistant/legacy/<threadKey>  → { messages: LegacyStoredMessage[] }
//   POST /api/internal/assistant/mirror              → { ok: true }
// Both carry a freshly signed `X-Lexa-Internal` identity (D6).

import { signInternalAuth, type InternalAuthIdentity } from "./internal-auth";
import {
  INTERNAL_AUTH_ACTOR_HEADER,
  INTERNAL_AUTH_HEADER,
  INTERNAL_AUTH_PROJECT_HEADER,
  INTERNAL_AUTH_THREAD_HEADER,
} from "./internal-auth";
import {
  convertLegacyMessages,
  type ConvertedUIMessage,
  type LegacyStoredMessage,
} from "./legacy-convert";
import type { RegistryModelConfig } from "./model-factory";
import type { AssistantCallLogInput } from "../../shared/assistant";
import type { AssistantRunKind, AssistantRunRow, AssistantRunStatus } from "../../shared/assistant";
import type { AssistantRunStatusInput, HarnessTurnContext, HarnessTurnContextRequest } from "./internal-routes";
import type { ReadToolResponse, WriteExecuteResponse, WriteToolResponse } from "./tools-ai";

export const INTERNAL_LEGACY_PATH = "/api/internal/assistant/legacy";
export const INTERNAL_MIRROR_PATH = "/api/internal/assistant/mirror";
export const INTERNAL_PROVIDER_CONFIG_PATH = "/api/internal/assistant/provider-config";
export const INTERNAL_TURN_CONTEXT_PATH = "/api/internal/assistant/turn-context";
export const INTERNAL_CALL_LOG_PATH = "/api/internal/assistant/call-log";
export const INTERNAL_RUN_STATUS_PATH = "/api/internal/assistant/run-status";
export const INTERNAL_RUN_CREATE_PATH = "/api/internal/assistant/run-create";
export const INTERNAL_RUN_UPDATE_PATH = "/api/internal/assistant/run-update";
export const INTERNAL_RUN_GET_PATH = "/api/internal/assistant/run";
export const INTERNAL_RUN_COUNTS_PATH = "/api/internal/assistant/run-counts";
export const INTERNAL_TOOL_PATH = "/api/internal/assistant/tool";
export const INTERNAL_WRITE_TOOL_PATH = "/api/internal/assistant/write-tool";
export const INTERNAL_WRITE_EXECUTE_PATH = "/api/internal/assistant/write-execute";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface AssistantInternalDeps {
  /** Public worker origin, e.g. `https://lexa.example` (no trailing slash). */
  origin: string;
  identity: InternalAuthIdentity;
  masterKey: string;
  fetchImpl?: FetchLike | undefined;
  nowMs?: (() => number) | undefined;
}

export interface MirrorTranscriptInput {
  messages: unknown[];
  summary: string | null;
  // `null` = "the DO has no engine value yet, keep the D1 column" (the SQL uses
  // COALESCE). Never send a literal 0 here: 0 is a real value and would clobber
  // a seeded `summarized_count` on every persist.
  summarizedCount: number | null;
  title?: string | null | undefined;
}

async function signedHeaders(deps: AssistantInternalDeps): Promise<Headers> {
  const internal = await signInternalAuth(deps.masterKey, deps.identity, deps.nowMs?.() ?? Date.now());
  const headers = new Headers({ "Content-Type": "application/json" });
  headers.set(INTERNAL_AUTH_ACTOR_HEADER, deps.identity.actorUserId);
  headers.set(INTERNAL_AUTH_PROJECT_HEADER, deps.identity.projectId);
  headers.set(INTERNAL_AUTH_THREAD_HEADER, deps.identity.threadKey);
  headers.set(INTERNAL_AUTH_HEADER, internal);
  return headers;
}

function originOf(deps: AssistantInternalDeps): string {
  return deps.origin.endsWith("/") ? deps.origin.slice(0, -1) : deps.origin;
}

/** Raised when the DO cannot reach its Worker internal routes. */
export class AssistantInternalUnavailable extends Error {
  constructor(message = "Assistant internal route unavailable") {
    super(message);
    this.name = "AssistantInternalUnavailable";
  }
}

async function withRetryOnce<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch {
    return await run();
  }
}

/**
 * Read the legacy D1 transcript for this thread and convert it to UIMessages.
 * Returns `null` when the thread has no legacy D1 row/messages (nothing to
 * import). Throws `AssistantInternalUnavailable` after the retry-once policy
 * fails — the caller maps that to `502 ASSISTANT_UNAVAILABLE`.
 */
export async function fetchLegacyTranscript(deps: AssistantInternalDeps): Promise<ConvertedUIMessage[] | null> {
  const fetchImpl: FetchLike = deps.fetchImpl ?? ((input, init) => fetch(input, init));
  const url = `${originOf(deps)}${INTERNAL_LEGACY_PATH}/${encodeURIComponent(deps.identity.threadKey)}`;
  try {
    return await withRetryOnce(async () => {
      const res = await fetchImpl(url, { method: "GET", headers: await signedHeaders(deps) });
      if (res.status === 404) return null;
      if (!res.ok) throw new AssistantInternalUnavailable(`legacy read failed (${res.status})`);
      const body = (await res.json()) as { messages?: unknown };
      const messages = Array.isArray(body.messages) ? (body.messages as LegacyStoredMessage[]) : [];
      return convertLegacyMessages(messages);
    });
  } catch (e) {
    if (e instanceof AssistantInternalUnavailable) throw e;
    throw new AssistantInternalUnavailable(e instanceof Error ? e.message : String(e));
  }
}

/**
 * Mirror the persisted transcript to D1 (`assistant_threads`). Retries once on
 * failure; returns whether the mirror landed. Never throws — a mirror failure
 * is a warn + leave the cursor advanced by the caller so the next step
 * re-mirrors the tail.
 */
export async function mirrorTranscript(deps: AssistantInternalDeps, input: MirrorTranscriptInput): Promise<boolean> {
  const fetchImpl: FetchLike = deps.fetchImpl ?? ((input_, init) => fetch(input_, init));
  const url = `${originOf(deps)}${INTERNAL_MIRROR_PATH}`;
  const body = JSON.stringify({
    threadKey: deps.identity.threadKey,
    projectId: deps.identity.projectId,
    messages: input.messages,
    summary: input.summary,
    summarizedCount: input.summarizedCount,
    title: input.title ?? null,
  });
  try {
    return await withRetryOnce(async () => {
      const res = await fetchImpl(url, { method: "POST", headers: await signedHeaders(deps), body });
      if (!res.ok) throw new AssistantInternalUnavailable(`mirror failed (${res.status})`);
      return true;
    });
  } catch (e) {
    console.warn("[Assistant] mirror failed after retry:", e instanceof Error ? e.message : String(e));
    return false;
  }
}

/**
 * Resolve the project's provider chain for one turn (ADR-0003 §C). Keys are
 * decrypted Worker-side and never persisted by the DO. `null` covers both "no
 * binding" (409) and an unreachable Worker — the engine maps either to
 * PROVIDER_NOT_CONFIGURED, and the next turn retries.
 */
export async function resolveProviderConfigs(
  deps: AssistantInternalDeps,
  projectId: string
): Promise<RegistryModelConfig[] | null> {
  const fetchImpl: FetchLike = deps.fetchImpl ?? ((input, init) => fetch(input, init));
  const url = `${originOf(deps)}${INTERNAL_PROVIDER_CONFIG_PATH}?projectId=${encodeURIComponent(projectId)}`;
  try {
    const res = await fetchImpl(url, { method: "GET", headers: await signedHeaders(deps) });
    if (!res.ok) return null;
    const body = (await res.json()) as { configs?: unknown };
    return Array.isArray(body.configs) ? (body.configs as RegistryModelConfig[]) : null;
  } catch (e) {
    console.warn("[Assistant] provider config resolution failed:", e instanceof Error ? e.message : String(e));
    return null;
  }
}

/**
 * Resolve the project's per-turn harness context bundle (ADR-0004 §1). `null`
 * when the Worker cannot answer — the DO then offers the core read set, NO write
 * tools, and the identity-only system prompt (reads degrade gracefully).
 * The request body carries only thread/run/userText/mode; project/actor/thread
 * identity is the signed HMAC header set, never the body.
 */
export async function resolveHarnessContext(
  deps: AssistantInternalDeps,
  request: HarnessTurnContextRequest
): Promise<HarnessTurnContext | null> {
  const fetchImpl: FetchLike = deps.fetchImpl ?? ((input, init) => fetch(input, init));
  const url = `${originOf(deps)}${INTERNAL_TURN_CONTEXT_PATH}`;
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: await signedHeaders(deps),
      body: JSON.stringify({ ...request, threadKey: deps.identity.threadKey }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { context?: unknown };
    const context = body.context as HarnessTurnContext | undefined;
    if (!context || !Array.isArray(context.readTools) || !Array.isArray(context.writeTools)) return null;
    return context;
  } catch (e) {
    console.warn("[Assistant] turn-context resolution failed:", e instanceof Error ? e.message : String(e));
    return null;
  }
}

/**
 * Record one provider call (call-log row). Best-effort with the retry-once
 * policy: a failed call-log write is warned, never thrown — the turn's stream
 * must not be broken by telemetry.
 */
export async function recordCallLog(deps: AssistantInternalDeps, input: AssistantCallLogInput): Promise<boolean> {
  return postInternal(deps, INTERNAL_CALL_LOG_PATH, input, "call-log");
}

/**
 * Report a terminal run status (task/wiki runs). Best-effort with retry-once;
 * the engine treats a false result as "Worker unreachable, leave the run row
 * to the next recovery".
 */
export async function transitionRun(deps: AssistantInternalDeps, input: AssistantRunStatusInput): Promise<boolean> {
  return postInternal(deps, INTERNAL_RUN_STATUS_PATH, input, "run-status");
}

// ── Delegation run registry transports (ADR-0004 §3; H3) ───────────────────

export interface RunCreateRemoteInput {
  kind: AssistantRunKind;
  goal: string;
  id?: string | undefined;
  threadKey?: string | undefined;
  budgetMs?: number | null | undefined;
  parentRunId?: string | null | undefined;
  createdBy?: string | null | undefined;
}

/**
 * Create a run registry row in the Worker. Best-effort retry-once; returns the
 * created row, or `null` when the Worker is unreachable (the caller refuses to
 * dispatch a run it cannot record).
 */
export async function createRunRemote(
  deps: AssistantInternalDeps,
  input: RunCreateRemoteInput
): Promise<AssistantRunRow | null> {
  const fetchImpl: FetchLike = deps.fetchImpl ?? ((input_, init) => fetch(input_, init));
  const url = `${originOf(deps)}${INTERNAL_RUN_CREATE_PATH}`;
  try {
    return await withRetryOnce(async () => {
      const res = await fetchImpl(url, { method: "POST", headers: await signedHeaders(deps), body: JSON.stringify(input) });
      if (!res.ok) throw new AssistantInternalUnavailable(`run-create failed (${res.status})`);
      const body = (await res.json()) as { run?: unknown };
      return body.run ? (body.run as AssistantRunRow) : null;
    });
  } catch (e) {
    console.warn("[Assistant] run-create failed after retry:", e instanceof Error ? e.message : String(e));
    return null;
  }
}

export interface RunUpdateRemoteInput {
  runId: string;
  status: AssistantRunStatus;
  result?: string | null | undefined;
  error?: string | null | undefined;
  stepsUsed?: number | undefined;
}

/** Report a run registry transition. Best-effort retry-once; `false` = not landed. */
export async function updateRunRemote(deps: AssistantInternalDeps, input: RunUpdateRemoteInput): Promise<boolean> {
  return postInternal(deps, INTERNAL_RUN_UPDATE_PATH, input, "run-update");
}

/** Read a run registry row. `null` when unknown/unreachable. */
export async function getRunRemote(deps: AssistantInternalDeps, runId: string): Promise<AssistantRunRow | null> {
  const fetchImpl: FetchLike = deps.fetchImpl ?? ((input_, init) => fetch(input_, init));
  const url = `${originOf(deps)}${INTERNAL_RUN_GET_PATH}?id=${encodeURIComponent(runId)}`;
  try {
    const res = await fetchImpl(url, { method: "GET", headers: await signedHeaders(deps) });
    if (!res.ok) return null;
    const body = (await res.json()) as { run?: unknown };
    return body.run ? (body.run as AssistantRunRow) : null;
  } catch {
    return null;
  }
}

/** Active run counts for the concurrency caps (1/thread, 3/project). */
export async function countRunsRemote(
  deps: AssistantInternalDeps
): Promise<{ thread: number; project: number } | null> {
  const fetchImpl: FetchLike = deps.fetchImpl ?? ((input_, init) => fetch(input_, init));
  const url = `${originOf(deps)}${INTERNAL_RUN_COUNTS_PATH}`;
  try {
    const res = await fetchImpl(url, { method: "POST", headers: await signedHeaders(deps), body: "{}" });
    if (!res.ok) return null;
    const body = (await res.json()) as { thread?: unknown; project?: unknown };
    return { thread: Number(body.thread ?? 0), project: Number(body.project ?? 0) };
  } catch {
    return null;
  }
}

async function postInternal(
  deps: AssistantInternalDeps,
  path: string,
  body: unknown,
  label: string
): Promise<boolean> {
  const fetchImpl: FetchLike = deps.fetchImpl ?? ((input, init) => fetch(input, init));
  const url = `${originOf(deps)}${path}`;
  try {
    return await withRetryOnce(async () => {
      const res = await fetchImpl(url, { method: "POST", headers: await signedHeaders(deps), body: JSON.stringify(body) });
      if (!res.ok) throw new AssistantInternalUnavailable(`${label} failed (${res.status})`);
      return true;
    });
  } catch (e) {
    console.warn(`[Assistant] ${label} failed after retry:`, e instanceof Error ? e.message : String(e));
    return false;
  }
}

/** One write proposal sent to the Worker internal route. */
export interface AssistantWriteToolCallInput {
  name: string;
  args: Record<string, unknown>;
  batchId: string;
  seq: number;
  projectId: string;
  documentType: "task" | "wiki" | "chat";
  documentId: string;
  ownerUserId: string;
  // Run attribution (ADR-0004 §3; plan line 140): present when a delegated run
  // proposes the write; the Worker persists it on the pending row and echoes it
  // back so the client can attribute the chip.
  runId?: string | undefined;
}

/**
 * Execute one read tool in the Worker. Best-effort with the retry-once policy;
 * a transport failure is returned as a typed `{ ok: false, error }` so the
 * model can recover rather than breaking the stream.
 */
export async function callReadTool(
  deps: AssistantInternalDeps,
  name: string,
  args: Record<string, unknown>,
  agentId?: string | undefined
): Promise<ReadToolResponse> {
  const fetchImpl: FetchLike = deps.fetchImpl ?? ((input, init) => fetch(input, init));
  const url = `${originOf(deps)}${INTERNAL_TOOL_PATH}`;
  try {
    return await withRetryOnce(async () => {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: await signedHeaders(deps),
        body: JSON.stringify({ name, args, ...(agentId ? { agentId } : {}) }),
      });
      if (!res.ok) throw new AssistantInternalUnavailable(`tool ${name} failed (${res.status})`);
      const body = (await res.json()) as { ok?: unknown; result?: unknown; error?: unknown };
      return {
        ok: body.ok === true,
        ...(body.result !== undefined ? { result: body.result } : {}),
        ...(typeof body.error === "string" ? { error: body.error } : {}),
      } satisfies ReadToolResponse;
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "tool call failed" };
  }
}

/**
 * Persist one write proposal in the Worker. Best-effort with retry-once; a
 * failure is returned as `{ ok: false, error }` so the tool result tells the
 * model the proposal did not land (never a false `proposed: true`).
 */
export async function proposeWrite(
  deps: AssistantInternalDeps,
  input: AssistantWriteToolCallInput
): Promise<WriteToolResponse> {
  const fetchImpl: FetchLike = deps.fetchImpl ?? ((input_, init) => fetch(input_, init));
  const url = `${originOf(deps)}${INTERNAL_WRITE_TOOL_PATH}`;
  try {
    return await withRetryOnce(async () => {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: await signedHeaders(deps),
        body: JSON.stringify(input),
      });
      if (!res.ok) throw new AssistantInternalUnavailable(`write-tool ${input.name} failed (${res.status})`);
      const body = (await res.json()) as {
        proposed?: unknown;
        approvalId?: unknown;
        batchId?: unknown;
        name?: unknown;
        detail?: unknown;
        diff?: unknown;
        proposedByRunId?: unknown;
        error?: unknown;
      };
      if (body.proposed === true && typeof body.approvalId === "string") {
        return {
          ok: true,
          proposed: true,
          approvalId: body.approvalId,
          batchId: typeof body.batchId === "string" ? body.batchId : input.batchId,
          seq: input.seq,
          name: typeof body.name === "string" ? body.name : input.name,
          ...(typeof body.detail === "string" ? { detail: body.detail } : {}),
          ...(body.diff !== undefined ? { diff: body.diff } : {}),
          ...(typeof body.proposedByRunId === "string" && body.proposedByRunId.length > 0
            ? { proposedByRunId: body.proposedByRunId }
            : {}),
        } satisfies WriteToolResponse;
      }
      return {
        ok: false,
        proposed: false,
        error: typeof body.error === "string" ? body.error : "write proposal failed",
      } satisfies WriteToolResponse;
    });
  } catch (e) {
    return { ok: false, proposed: false, error: e instanceof Error ? e.message : "write proposal failed" };
  }
}

/** One auto-mode write sent to the Worker internal `/write-execute` route. */
export interface AssistantWriteExecuteCallInput {
  name: string;
  args: Record<string, unknown>;
  projectId: string;
  ownerUserId: string;
}

/**
 * Apply one write immediately in the Worker (auto mode, D4). NO retry: a lost
 * response after the Worker applied the write would double-apply it on the
 * second attempt (unlike a read, apply is not idempotent), so a transport
 * failure returns an INDETERMINATE `{ ok: false, applied: false, indeterminate:
 * true, error }` — the model is told the write may have landed and must not
 * retry (reviewer MED). A Worker-decided 200 `{ ok: false }` is a definite
 * failure and stays non-indeterminate. Zero applied is already a Worker-side
 * failure.
 */
export async function callWriteExecute(
  deps: AssistantInternalDeps,
  input: AssistantWriteExecuteCallInput
): Promise<WriteExecuteResponse> {
  const fetchImpl: FetchLike = deps.fetchImpl ?? ((input_, init) => fetch(input_, init));
  const url = `${originOf(deps)}${INTERNAL_WRITE_EXECUTE_PATH}`;
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: await signedHeaders(deps),
      body: JSON.stringify(input),
    });
    if (!res.ok) throw new AssistantInternalUnavailable(`write-execute ${input.name} failed (${res.status})`);
    const body = (await res.json()) as {
      ok?: unknown;
      applied?: unknown;
      result?: unknown;
      error?: unknown;
      partial?: unknown;
    };
    if (body.ok === true && body.applied === true) {
      return {
        ok: true,
        applied: true,
        ...(body.result !== undefined ? { result: body.result } : {}),
        ...(isApprovalPartial(body.partial) ? { partial: body.partial } : {}),
      } satisfies WriteExecuteResponse;
    }
    return {
      ok: false,
      applied: false,
      error: typeof body.error === "string" ? body.error : "write failed",
      ...(isApprovalPartial(body.partial) ? { partial: body.partial } : {}),
    } satisfies WriteExecuteResponse;
  } catch {
    // The response was lost or the route errored: the Worker may or may not have
    // applied the write. Never claim `applied: false` as fact and never retry.
    return {
      ok: false,
      applied: false,
      indeterminate: true,
      error: `Write may have applied — do not retry. ${input.name} transport failed after the request was sent.`,
    } satisfies WriteExecuteResponse;
  }
}

function isApprovalPartial(value: unknown): value is { applied: number; failed: number; errors?: string[] } {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { applied?: unknown }).applied === "number" &&
    typeof (value as { failed?: unknown }).failed === "number"
  );
}
