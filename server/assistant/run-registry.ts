// Delegation run registry (ADR-0004 §3; H3).
//
// The D1 `assistant_runs` table is the durable registry behind the SDK's
// facet runs. The parent DO creates a row at dispatch and reports terminal
// status through the internal routes; transitions are atomic conditional
// UPDATEs and idempotent (a repeated terminal report is a clean no-op). No
// `task_activity` row is ever emitted here — `chat_run`/`schedule` are not
// task document runs (invariant #12 untouched).
//
// Worker-side (D1) module; unit-tested with a bun-sqlite driver.

import { Effect } from "effect";
import {
  queryFirst,
  run,
  type ConstraintViolation,
  type DbError,
  type DbDriver,
  type RowNotFound,
  type SqlParam,
} from "../db/db";
import type {
  AssistantRunCreateInput,
  AssistantRunKind,
  AssistantRunRow,
  AssistantRunStatus,
  AssistantRunTransitionInput,
} from "../../shared/assistant";

export interface AssistantRunRowRaw {
  id: string;
  project_id: string;
  thread_key: string;
  parent_run_id: string | null;
  kind: AssistantRunKind;
  status: AssistantRunStatus;
  goal: string;
  result: string | null;
  error: string | null;
  budget_ms: number | null;
  steps_used: number;
  created_by: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export function mapRunRow(row: AssistantRunRowRaw): AssistantRunRow {
  return {
    id: row.id,
    projectId: row.project_id,
    threadKey: row.thread_key,
    parentRunId: row.parent_run_id,
    kind: row.kind,
    status: row.status,
    goal: row.goal,
    result: row.result,
    error: row.error,
    budgetMs: row.budget_ms,
    stepsUsed: row.steps_used,
    createdBy: row.created_by,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

const RUN_SELECT = `SELECT id, project_id, thread_key, parent_run_id, kind, status, goal, result, error,
                           budget_ms, steps_used, created_by, created_at, started_at, finished_at
                    FROM assistant_runs`;

export function createAssistantRun(
  driver: DbDriver,
  input: AssistantRunCreateInput
): Effect.Effect<AssistantRunRow, RowNotFound | ConstraintViolation | DbError> {
  const id = input.id && input.id.length > 0 ? input.id : crypto.randomUUID();
  return Effect.gen(function* () {
    yield* run(
      driver,
      `INSERT INTO assistant_runs (id, project_id, thread_key, parent_run_id, kind, status, goal, budget_ms, created_by)
       VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
      id,
      input.projectId,
      input.threadKey,
      input.parentRunId ?? null,
      input.kind,
      input.goal.slice(0, 4000),
      input.budgetMs ?? null,
      input.createdBy ?? null
    );
    const row = yield* queryFirst<AssistantRunRowRaw>(driver, `${RUN_SELECT} WHERE id = ?`, id);
    return mapRunRow(row);
  });
}

export function getAssistantRun(
  driver: DbDriver,
  runId: string,
  projectId: string
): Effect.Effect<AssistantRunRow, RowNotFound | DbError> {
  return queryFirst<AssistantRunRowRaw>(driver, `${RUN_SELECT} WHERE id = ? AND project_id = ?`, runId, projectId).pipe(
    Effect.map(mapRunRow)
  );
}

/**
 * The statuses a run may transition FROM for a given target. `running` starts
 * a queued run; a terminal target closes a queued or running one. Any other
 * source is a no-op (idempotent repeat or an illegal regression).
 */
export function isRunTransitionable(from: AssistantRunStatus, to: AssistantRunStatus): boolean {
  if (to === "running") return from === "queued";
  return from === "queued" || from === "running";
}

/**
 * Atomic conditional transition. Returns `{ ok: true, changed }`; `changed`
 * is false for an idempotent repeat or an illegal source status. An unknown
 * run (or a project mismatch) is a `RowNotFound` the caller maps to 404.
 */
export function transitionAssistantRunRegistry(
  driver: DbDriver,
  input: AssistantRunTransitionInput
): Effect.Effect<{ ok: true; changed: boolean; run: AssistantRunRow }, RowNotFound | ConstraintViolation | DbError> {
  return Effect.gen(function* () {
    const existing = yield* queryFirst<AssistantRunRowRaw>(
      driver,
      `${RUN_SELECT} WHERE id = ? AND project_id = ?`,
      input.runId,
      input.projectId
    );
    if (!isRunTransitionable(existing.status, input.status)) {
      return { ok: true as const, changed: false, run: mapRunRow(existing) };
    }

    const sets = ["status = ?"];
    const params: SqlParam[] = [input.status];
    if (input.status === "running") {
      sets.push("started_at = COALESCE(started_at, datetime('now'))");
    } else {
      sets.push("finished_at = datetime('now')");
    }
    if (input.result !== undefined) {
      sets.push("result = ?");
      params.push(input.result === null ? null : input.result.slice(0, 1024 * 1024));
    }
    if (input.error !== undefined) {
      sets.push("error = ?");
      params.push(input.error === null ? null : input.error.slice(0, 2000));
    }
    if (input.stepsUsed !== undefined && Number.isFinite(input.stepsUsed)) {
      sets.push("steps_used = ?");
      params.push(Math.max(0, Math.floor(input.stepsUsed)));
    }
    const from = input.status === "running" ? "status = 'queued'" : "status IN ('queued', 'running')";
    params.push(input.runId, input.projectId);
    const changes = yield* run(
      driver,
      `UPDATE assistant_runs SET ${sets.join(", ")} WHERE id = ? AND project_id = ? AND ${from}`,
      ...params
    );
    const row = yield* queryFirst<AssistantRunRowRaw>(driver, `${RUN_SELECT} WHERE id = ?`, input.runId);
    return { ok: true as const, changed: changes > 0, run: mapRunRow(row) };
  });
}

export interface ActiveRunCounts {
  thread: number;
  project: number;
}

/** Active (queued|running) run counts for the concurrency caps (1/thread, 3/project). */
export function countActiveRuns(
  driver: DbDriver,
  projectId: string,
  threadKey: string
): Effect.Effect<ActiveRunCounts, RowNotFound | DbError> {
  return Effect.gen(function* () {
    const project = yield* queryFirst<{ n: number }>(
      driver,
      `SELECT COUNT(*) AS n FROM assistant_runs WHERE project_id = ? AND status IN ('queued', 'running')`,
      projectId
    ).pipe(Effect.catchTag("RowNotFound", () => Effect.succeed({ n: 0 })));
    const thread = yield* queryFirst<{ n: number }>(
      driver,
      `SELECT COUNT(*) AS n FROM assistant_runs WHERE project_id = ? AND thread_key = ? AND status IN ('queued', 'running')`,
      projectId,
      threadKey
    ).pipe(Effect.catchTag("RowNotFound", () => Effect.succeed({ n: 0 })));
    return { thread: Number(thread.n ?? 0), project: Number(project.n ?? 0) };
  });
}
