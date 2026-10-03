// Scheduled assistant runs — storage + dispatcher (ADR-0004 §4; H7).
//
// `assistant_schedules` rows are created/edited through the REST surface and
// fired by the 15-minute Worker cron. `dispatchDueSchedules` selects due rows,
// creates a `kind='schedule'` row in `assistant_runs`, and advances
// `next_run_at` in ONE atomic batch guarded on the observed `next_run_at`, so
// two overlapping ticks cannot double-fire a schedule.
//
// Worker-side (D1). Unit-tested with a bun-sqlite driver.

import { Effect } from "effect";
import { batch, queryAll, queryFirst, run, type ConstraintViolation, type DbError, type DbDriver, type RowNotFound, type SqlParam } from "../db/db";
import { InvalidArgs } from "../api/errors";
import { nextRunAt, type ScheduleTiming } from "./cron";
import type {
  AssistantRunRow,
  AssistantScheduleInput,
  AssistantSchedulePatch,
  AssistantScheduleRow,
} from "../../shared/assistant";

interface ScheduleRowRaw {
  id: string;
  project_id: string;
  thread_key: string | null;
  created_by: string | null;
  title: string;
  prompt: string;
  cron: string | null;
  interval_seconds: number | null;
  enabled: number;
  next_run_at: string;
  last_run_at: string | null;
  last_run_id: string | null;
  created_at: string;
  updated_at: string;
}

const SCHEDULE_SELECT = `SELECT id, project_id, thread_key, created_by, title, prompt, cron, interval_seconds,
                                enabled, next_run_at, last_run_at, last_run_id, created_at, updated_at
                         FROM assistant_schedules`;

function mapSchedule(row: ScheduleRowRaw): AssistantScheduleRow {
  return {
    id: row.id,
    projectId: row.project_id,
    threadKey: row.thread_key,
    createdBy: row.created_by,
    title: row.title,
    prompt: row.prompt,
    cron: row.cron,
    intervalSeconds: row.interval_seconds,
    enabled: row.enabled === 1,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    lastRunId: row.last_run_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function timingOf(row: { cron: string | null; interval_seconds: number | null }): { cron: string | null; intervalSeconds: number | null } {
  return { cron: row.cron, intervalSeconds: row.interval_seconds };
}

function toSqlDate(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

const INVALID_TIMING_REASON = "a schedule needs a valid cron expression or a positive intervalSeconds";

/**
 * Does this timing produce at least one occurrence? Mirrors the 0021 CHECK
 * (`cron` non-empty OR `interval_seconds > 0`) and additionally rejects a
 * malformed cron, so a payload that would otherwise surface as a raw CHECK
 * violation is refused up front as `InvalidArgs` (422).
 */
export function hasUsableScheduleTiming(timing: ScheduleTiming): boolean {
  return nextRunAt(timing, new Date(0)) !== null;
}

export function listSchedules(driver: DbDriver, projectId: string): Effect.Effect<AssistantScheduleRow[], DbError> {
  return queryAll<ScheduleRowRaw>(driver, `${SCHEDULE_SELECT} WHERE project_id = ? ORDER BY created_at DESC`, projectId).pipe(
    Effect.map((rows) => rows.map(mapSchedule))
  );
}

export function getSchedule(
  driver: DbDriver,
  id: string,
  projectId: string
): Effect.Effect<AssistantScheduleRow, RowNotFound | DbError> {
  return queryFirst<ScheduleRowRaw>(driver, `${SCHEDULE_SELECT} WHERE id = ? AND project_id = ?`, id, projectId).pipe(
    Effect.map(mapSchedule)
  );
}

export function createSchedule(
  driver: DbDriver,
  projectId: string,
  input: AssistantScheduleInput,
  createdBy: string | null,
  now: Date = new Date()
): Effect.Effect<AssistantScheduleRow, InvalidArgs | RowNotFound | ConstraintViolation | DbError> {
  const id = crypto.randomUUID();
  const cron = input.cron ?? null;
  const intervalSeconds = input.intervalSeconds ?? null;
  return Effect.gen(function* () {
    if (!hasUsableScheduleTiming({ cron, intervalSeconds })) {
      return yield* new InvalidArgs({ reason: INVALID_TIMING_REASON });
    }
    const next = nextRunAt({ cron, intervalSeconds }, now) ?? new Date(now.getTime() + 15 * 60_000);
    yield* run(
      driver,
      `INSERT INTO assistant_schedules (id, project_id, thread_key, created_by, title, prompt, cron, interval_seconds, enabled, next_run_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      projectId,
      input.threadKey ?? null,
      createdBy,
      input.title.slice(0, 300),
      input.prompt.slice(0, 4000),
      cron,
      intervalSeconds,
      input.enabled === false ? 0 : 1,
      toSqlDate(next)
    );
    const row = yield* queryFirst<ScheduleRowRaw>(driver, `${SCHEDULE_SELECT} WHERE id = ?`, id);
    return mapSchedule(row);
  });
}

export function updateSchedule(
  driver: DbDriver,
  id: string,
  projectId: string,
  patch: AssistantSchedulePatch,
  now: Date = new Date()
): Effect.Effect<AssistantScheduleRow, InvalidArgs | RowNotFound | ConstraintViolation | DbError> {
  return Effect.gen(function* () {
    const current = yield* queryFirst<ScheduleRowRaw>(driver, `${SCHEDULE_SELECT} WHERE id = ? AND project_id = ?`, id, projectId);
    const cron = patch.cron !== undefined ? patch.cron : current.cron;
    const intervalSeconds = patch.intervalSeconds !== undefined ? patch.intervalSeconds : current.interval_seconds;
    if ((patch.cron !== undefined || patch.intervalSeconds !== undefined) && !hasUsableScheduleTiming({ cron, intervalSeconds })) {
      return yield* new InvalidArgs({ reason: INVALID_TIMING_REASON });
    }
    const enabled = patch.enabled !== undefined ? patch.enabled : current.enabled === 1;
    const sets: string[] = [];
    const params: SqlParam[] = [];
    if (patch.title !== undefined) {
      sets.push("title = ?");
      params.push(patch.title.slice(0, 300));
    }
    if (patch.prompt !== undefined) {
      sets.push("prompt = ?");
      params.push(patch.prompt.slice(0, 4000));
    }
    if (patch.cron !== undefined) {
      sets.push("cron = ?");
      params.push(cron);
    }
    if (patch.intervalSeconds !== undefined) {
      sets.push("interval_seconds = ?");
      params.push(intervalSeconds);
    }
    if (patch.threadKey !== undefined) {
      sets.push("thread_key = ?");
      params.push(patch.threadKey);
    }
    if (patch.enabled !== undefined) {
      sets.push("enabled = ?");
      params.push(enabled ? 1 : 0);
    }
    // Recompute the next fire when timing changed or the schedule is re-enabled.
    if (patch.cron !== undefined || patch.intervalSeconds !== undefined || (patch.enabled === true && current.enabled !== 1)) {
      const next = nextRunAt({ cron, intervalSeconds }, now) ?? new Date(now.getTime() + 15 * 60_000);
      sets.push("next_run_at = ?");
      params.push(toSqlDate(next));
    }
    if (sets.length > 0) {
      sets.push("updated_at = datetime('now')");
      params.push(id, projectId);
      yield* run(driver, `UPDATE assistant_schedules SET ${sets.join(", ")} WHERE id = ? AND project_id = ?`, ...params);
    }
    return mapSchedule(yield* queryFirst<ScheduleRowRaw>(driver, `${SCHEDULE_SELECT} WHERE id = ?`, id));
  });
}

export function deleteSchedule(
  driver: DbDriver,
  id: string,
  projectId: string
): Effect.Effect<{ ok: true }, RowNotFound | DbError> {
  return queryFirst<{ id: string }>(
    driver,
    "DELETE FROM assistant_schedules WHERE id = ? AND project_id = ? RETURNING id",
    id,
    projectId
  ).pipe(Effect.as({ ok: true as const }));
}

export interface ScheduleDispatchResult {
  dispatched: number;
  skipped: number;
  runs: AssistantRunRow[];
}

export interface ScheduleDispatcherDeps {
  now?: Date | undefined;
  /** Max schedules fired per tick (ADR-0004 §4 cap). */
  limit?: number | undefined;
  /** Test seam: default 15. */
  defaultIntervalMinutes?: number | undefined;
  /** Optional execution hook (best-effort; the registry row is already durable). */
  enqueue?: ((run: AssistantRunRow, schedule: AssistantScheduleRow) => Promise<void>) | undefined;
}

export const SCHEDULES_PER_TICK_CAP = 25;

/**
 * Fire every due enabled schedule (bounded per tick). For each row: create the
 * `assistant_runs` row and advance `next_run_at`/`last_run_at`/`last_run_id` in
 * one atomic batch, guarded on the observed `next_run_at` so a concurrent tick
 * cannot double-fire. Fail-open per row: a row whose next occurrence cannot be
 * computed is skipped, never fatal.
 */
export async function dispatchDueSchedules(
  driver: DbDriver,
  deps: ScheduleDispatcherDeps = {}
): Promise<ScheduleDispatchResult> {
  const now = deps.now ?? new Date();
  const limit = deps.limit ?? SCHEDULES_PER_TICK_CAP;
  const due = await Effect.runPromise(
    queryAll<ScheduleRowRaw>(
      driver,
      `${SCHEDULE_SELECT} WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at ASC LIMIT ?`,
      toSqlDate(now),
      limit
    )
  ).catch(() => [] as ScheduleRowRaw[]);

  let dispatched = 0;
  let skipped = 0;
  const runs: AssistantRunRow[] = [];

  for (const row of due) {
    const schedule = mapSchedule(row);
    const next = nextRunAt(timingOf(row), now);
    if (next === null) {
      skipped += 1;
      continue;
    }
    const runId = crypto.randomUUID();
    const threadKey = row.thread_key && row.thread_key !== "" ? row.thread_key : `chat:schedule-${row.id}`;
    const stmts = [
      {
        // Guarded INSERT: only fires when the schedule still holds the observed
        // next_run_at, so the losing side of a concurrent tick inserts nothing.
        sql: `INSERT INTO assistant_runs (id, project_id, thread_key, kind, status, goal, created_by)
              SELECT ?, project_id, ?, 'schedule', 'queued', prompt, created_by
              FROM assistant_schedules WHERE id = ? AND enabled = 1 AND next_run_at = ?`,
        params: [runId, threadKey, row.id, row.next_run_at] as SqlParam[],
      },
      {
        sql: `UPDATE assistant_schedules
              SET last_run_at = ?, last_run_id = ?, next_run_at = ?, updated_at = datetime('now')
              WHERE id = ? AND enabled = 1 AND next_run_at = ?`,
        params: [toSqlDate(now), runId, toSqlDate(next), row.id, row.next_run_at] as SqlParam[],
      },
    ];
    try {
      await Effect.runPromise(batch(driver, stmts));
    } catch {
      skipped += 1;
      continue;
    }
    const created = await Effect.runPromise(
      queryFirst<{ id: string }>(driver, "SELECT id FROM assistant_runs WHERE id = ?", runId)
    ).catch(() => null);
    if (!created) {
      skipped += 1;
      continue;
    }
    dispatched += 1;
    if (deps.enqueue) {
      const run = await Effect.runPromise(
        createRunRead(driver, runId)
      ).catch(() => null);
      if (run) {
        runs.push(run);
        await deps.enqueue(run, schedule).catch(() => undefined);
      }
    }
  }
  return { dispatched, skipped, runs };
}

function createRunRead(driver: DbDriver, runId: string): Effect.Effect<AssistantRunRow, RowNotFound | DbError> {
  return queryFirst<{
    id: string;
    project_id: string;
    thread_key: string;
    parent_run_id: string | null;
    kind: "chat_run" | "document" | "schedule";
    status: "queued" | "running" | "completed" | "failed" | "cancelled";
    goal: string;
    result: string | null;
    error: string | null;
    budget_ms: number | null;
    steps_used: number;
    created_by: string | null;
    created_at: string;
    started_at: string | null;
    finished_at: string | null;
  }>(
    driver,
    `SELECT id, project_id, thread_key, parent_run_id, kind, status, goal, result, error, budget_ms,
            steps_used, created_by, created_at, started_at, finished_at
     FROM assistant_runs WHERE id = ?`,
    runId
  ).pipe(
    Effect.map((row) => ({
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
    }))
  );
}
