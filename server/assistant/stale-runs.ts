// Boot-time stale assistant-task sweep — the ADR-0005 §Reliability backstop.
//
// The in-process tier has no run recovery: a crash or isolate eviction mid-turn
// can leave an `assistant_tasks` row `running` forever, which blocks reset/resume
// for that document. At boot (both flavors) fail every `running` row whose start
// is older than the bound. `assistant_tasks` has no `updated_at` column, so
// staleness is measured from `COALESCE(started_at, created_at)`; a claimed row
// uses `started_at`, an unclaimed one falls back to `created_at`.
//
// Direct UPDATE (no `task_activity` row): an abandoned run that never produced a
// turn is visible on the task status alone — invariant #12 is not violated by a
// silent terminal write. Fail-open at the caller: boot must never block on this.

import { Effect } from "effect";
import { run, type ConstraintViolation, type DbDriver, type DbError } from "../db/db";

/** A `running` task older than this is treated as abandoned. */
export const STALE_ASSISTANT_TASK_MS = 30 * 60_000;

export interface SweepStaleAssistantTasksOptions {
  now?: Date | undefined;
  staleMs?: number | undefined;
}

function toSqlDate(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

/**
 * Fail `assistant_tasks` rows stuck `running` past the bound. Returns how many
 * rows were failed. Only `running` rows are touched — `queued` rows are left for
 * the normal claim, and terminal rows are never re-stamped.
 */
export function sweepStaleAssistantTasks(
  driver: DbDriver,
  options: SweepStaleAssistantTasksOptions = {}
): Effect.Effect<{ failed: number }, ConstraintViolation | DbError> {
  const now = options.now ?? new Date();
  const staleMs = options.staleMs ?? STALE_ASSISTANT_TASK_MS;
  return run(
    driver,
    `UPDATE assistant_tasks
        SET status = 'failed',
            error = COALESCE(error, 'run abandoned'),
            finished_at = datetime('now')
      WHERE status = 'running'
        AND datetime(COALESCE(started_at, created_at), '+' || (? / 1000) || ' seconds') <= ?`,
    staleMs,
    toSqlDate(now)
  ).pipe(Effect.map((changes) => ({ failed: changes })));
}
