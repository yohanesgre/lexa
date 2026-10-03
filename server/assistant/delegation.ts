// Delegation orchestration (ADR-0004 §3; H3).
//
// Pure, dependency-injected run control: concurrency caps (1/thread,
// 3/project), per-run budgets, registry create + dispatch + terminal update.
// The SDK facet dispatch (`runAgentTool`/`cancelAgentTool`) is injected as a
// `RunDispatcher` so the spawn/abort/budget/cap logic is unit-testable with a
// fake — no workerd, no real facets. `agent.ts` supplies the real dispatcher.

import type { AssistantRunRow } from "../../shared/assistant";

/** Concurrency caps (ADR-0004 §3): one active run per thread, three per project. */
export const THREAD_RUN_LIMIT = 1;
export const PROJECT_RUN_LIMIT = 3;
/** Default per-run wall-clock budget and the hard ceiling a run may request. */
export const DEFAULT_RUN_BUDGET_MS = 10 * 60_000;
export const MAX_RUN_BUDGET_MS = 30 * 60_000;

export interface DelegatedRunDispatchInput {
  runId: string;
  goal: string;
  projectId: string;
  threadKey: string;
  mode: string;
  budgetMs: number;
}

export interface RunDispatcher {
  /** Dispatch the facet run; returns immediately for detached runs. */
  dispatch(input: DelegatedRunDispatchInput): Promise<{ status: "running" | "error"; error?: string }>;
  /** Cancel a dispatched run (idempotent). */
  cancel(runId: string): Promise<void>;
}

export interface DelegationDeps {
  dispatcher: RunDispatcher;
  createRun: (input: {
    id: string;
    kind: "chat_run";
    goal: string;
    threadKey: string;
    projectId: string;
    budgetMs: number;
    createdBy: string | null;
  }) => Promise<AssistantRunRow | null>;
  updateRun: (input: {
    runId: string;
    status: "running" | "completed" | "failed" | "cancelled";
    result?: string | null;
    error?: string | null;
  }) => Promise<boolean>;
  getRun: (runId: string) => Promise<AssistantRunRow | null>;
  counts: () => Promise<{ thread: number; project: number }>;
}

export interface SpawnRunInput {
  goal: string;
  projectId: string;
  threadKey: string;
  mode: string;
  createdBy: string | null;
  budgetMs?: number | undefined;
  /** Test seam: deterministic run id. */
  runId?: string | undefined;
}

export type SpawnRunResult =
  | { ok: true; runId: string }
  | { ok: false; code: string; error: string };

function clampBudget(requested: number | undefined): { budgetMs: number } | { error: string } {
  if (requested === undefined) return { budgetMs: DEFAULT_RUN_BUDGET_MS };
  if (!Number.isFinite(requested) || requested <= 0) return { error: "run budget must be a positive number of milliseconds" };
  if (requested > MAX_RUN_BUDGET_MS) {
    return { error: `run budget ${requested}ms exceeds the ${MAX_RUN_BUDGET_MS}ms ceiling` };
  }
  return { budgetMs: Math.floor(requested) };
}

/**
 * Spawn one delegated chat run: enforce caps, record the registry row, dispatch
 * the facet, and mark the row running. Every failure path returns a typed
 * refusal the tool surfaces to the model; nothing is dispatched without a
 * registry row (no orphan runs).
 */
export async function spawnDelegatedRun(deps: DelegationDeps, input: SpawnRunInput): Promise<SpawnRunResult> {
  const goal = input.goal.trim();
  if (goal === "") return { ok: false, code: "INVALID_PAYLOAD", error: "run goal is required" };

  const budget = clampBudget(input.budgetMs);
  if ("error" in budget) {
    return { ok: false, code: "ASSISTANT_RUN_BUDGET_EXCEEDED", error: budget.error };
  }

  let counts: { thread: number; project: number };
  try {
    counts = await deps.counts();
  } catch {
    return { ok: false, code: "ASSISTANT_UNAVAILABLE", error: "could not read active run counts" };
  }
  if (counts.thread >= THREAD_RUN_LIMIT) {
    return { ok: false, code: "ASSISTANT_RUN_CAP_EXCEEDED", error: `this thread already has ${THREAD_RUN_LIMIT} active run` };
  }
  if (counts.project >= PROJECT_RUN_LIMIT) {
    return { ok: false, code: "ASSISTANT_RUN_CAP_EXCEEDED", error: `this project already has ${PROJECT_RUN_LIMIT} active runs` };
  }

  const runId = input.runId ?? crypto.randomUUID();
  const row = await deps.createRun({
    id: runId,
    kind: "chat_run",
    goal,
    threadKey: input.threadKey,
    projectId: input.projectId,
    budgetMs: budget.budgetMs,
    createdBy: input.createdBy,
  });
  if (row === null) {
    return { ok: false, code: "ASSISTANT_UNAVAILABLE", error: "could not record the run" };
  }

  const dispatched = await deps.dispatcher.dispatch({
    runId,
    goal,
    projectId: input.projectId,
    threadKey: input.threadKey,
    mode: input.mode,
    budgetMs: budget.budgetMs,
  });
  if (dispatched.status === "error") {
    await deps.updateRun({ runId, status: "failed", error: dispatched.error ?? "dispatch failed" });
    return { ok: false, code: "ASSISTANT_UNAVAILABLE", error: dispatched.error ?? "dispatch failed" };
  }
  await deps.updateRun({ runId, status: "running" });
  return { ok: true, runId };
}

/**
 * Dispatch a run whose registry row already exists (schedule runs, recovery).
 * No insert and no cap check — the caller owns creation; this only drives the
 * facet and lands the running/failed transition.
 */
export async function dispatchRegisteredRun(
  deps: DelegationDeps,
  input: DelegatedRunDispatchInput
): Promise<SpawnRunResult> {
  const dispatched = await deps.dispatcher.dispatch(input);
  if (dispatched.status === "error") {
    await deps.updateRun({ runId: input.runId, status: "failed", error: dispatched.error ?? "dispatch failed" });
    return { ok: false, code: "ASSISTANT_UNAVAILABLE", error: dispatched.error ?? "dispatch failed" };
  }
  await deps.updateRun({ runId: input.runId, status: "running" });
  return { ok: true, runId: input.runId };
}

/** Abort one delegated run: cancel the facet first, then land the terminal row. */
export async function abortDelegatedRun(deps: DelegationDeps, runId: string): Promise<{ ok: true } | { ok: false; code: string; error: string }> {
  const row = await deps.getRun(runId);
  if (row === null) return { ok: false, code: "ASSISTANT_RUN_NOT_FOUND", error: "Unknown run" };
  if (row.status === "completed" || row.status === "failed" || row.status === "cancelled") {
    return { ok: true };
  }
  try {
    await deps.dispatcher.cancel(runId);
  } catch {
    // Cancellation is best-effort; the registry row still lands cancelled.
  }
  await deps.updateRun({ runId, status: "cancelled" });
  return { ok: true };
}

export type AgentToolTerminalStatus = "completed" | "error" | "aborted" | "interrupted";

/**
 * Map an SDK agent-tool terminal onto the run registry's status domain. A
 * `budget-exceeded`/`no-progress` interrupt is a failed run; an explicit abort
 * is cancelled. Pure so the parent's `onRunFinished` is unit-testable.
 */
export function runStatusForTerminal(status: AgentToolTerminalStatus): "completed" | "failed" | "cancelled" {
  if (status === "completed") return "completed";
  if (status === "aborted") return "cancelled";
  return "failed";
}
