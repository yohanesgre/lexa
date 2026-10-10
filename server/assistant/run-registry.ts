// Delegation run registry — the admin read path for `assistant_runs`.
//
// ADR-0005 D3 retired delegation: no facet runner, no internal-route writers,
// no schedule drain. The `assistant_runs` table and the admin run read stay
// inert (ADR-0005 §Drop: "Keep `assistant_runs` table + admin read page
// inert"). This module keeps only the shared row mapper + the project-agnostic
// single-row read the REST handler uses; the writers, transitions, cap counts,
// and reconciliation that the DO facet + cron consumed were removed in W6.
//
// Worker-side (D1) module; unit-tested with a bun-sqlite driver.

import { Effect } from "effect";
import { queryFirst, type DbError, type DbDriver, type RowNotFound } from "../db/db";
import type { AssistantRunKind, AssistantRunRow, AssistantRunStatus } from "../../shared/assistant";

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

/**
 * Project-agnostic read for the shared REST path: the caller loads the row,
 * then gates on `row.projectId`. Runs in projects you cannot access are not
 * disclosed (404, same as unknown ids); contents are member-only.
 */
export function getAssistantRunById(
  driver: DbDriver,
  runId: string
): Effect.Effect<AssistantRunRow, RowNotFound | DbError> {
  return queryFirst<AssistantRunRowRaw>(driver, `${RUN_SELECT} WHERE id = ?`, runId).pipe(Effect.map(mapRunRow));
}
