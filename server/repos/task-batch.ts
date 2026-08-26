// Batch-array builders for the D1 atomicity re-expression (Phase 5).
//
// Each helper returns the `{ sql, params }[]` pair that the existing
// `withTx` path produces on Bun, AND that the D1 driver consumes
// directly via `db.batch(stmts)`. The Bun-side services continue to
// use `withTx { ... }`; the Workers-side services call
// `db.batch(buildXxxBatch(input))` and skip `withTx` entirely.
//
// These helpers are the single source of truth for both paths. They
// are pure functions of the input — no database access, no side
// effects — which makes them trivially testable. The existing
// `withTx` call sites can be refactored to call these builders and
// thread the result through `batch(db, ...)` once Phase 6 wires the
// D1 driver into the HTTP layer.

import type { SqlParam } from "../db/driver";

/** A single batch statement — both `withTx` (Bun, via `batch()`)
 *  and `db.batch()` (D1, native) consume this shape. */
export interface BatchStmt {
  sql: string;
  params: SqlParam[];
}

/** Build the batch for: update a task's archive state + emit one
 *  `archived` (or `restored`) activity row. The Bun path runs this
 *  inside `withTx`; the D1 path runs `db.batch(stmts)`. */
export function buildSetArchivedAndEmitBatch(input: {
  taskId: string;
  archivedAt: string | null;   // null = restore
  actorKind: "user" | "agent" | "system";
  actorLabel: string;
  actorUserId: string | null;
  archivedMessage: string;     // "X archived this task" or "X restored this task"
  restoredMessage: string;
  viaHerald: boolean;
}): BatchStmt[] {
  const now = new Date().toISOString();
  const type = input.archivedAt ? "archived" : "restored";
  const message = input.archivedAt ? input.archivedMessage : input.restoredMessage;
  return [
    {
      sql: `UPDATE tasks SET archived_at = ?, updated_at = ? WHERE id = ?`,
      params: [input.archivedAt, now, input.taskId],
    },
    {
      sql: `INSERT INTO task_activity (task_id, actor_kind, actor_label, actor_user_id, type, message, via_herald)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
      params: [
        input.taskId,
        input.actorKind,
        input.actorLabel,
        input.actorUserId,
        type,
        message,
        input.viaHerald ? 1 : 0,
      ],
    },
  ];
}

/** Build the batch for: the webhook move (UPDATE tasks + UPDATE
 *  task_github_issues synced_state). The plan's #2 invariant requires
 *  both writes to land atomically. The Bun path already does this via
 *  `withTx` + `batch()`; the D1 path does the same via a single
 *  `db.batch([...stmts])` call. */
export function buildWebhookMoveBatch(input: {
  taskId: string;
  issueId: string;
  columnId: string;
  swimlaneId: string;
  position: string;
  syncedState: "open" | "closed";
}): BatchStmt[] {
  return [
    {
      sql: `UPDATE tasks SET column_id = ?, swimlane_id = ?, position = ?, updated_at = datetime('now') WHERE id = ?`,
      params: [input.columnId, input.swimlaneId, input.position, input.taskId],
    },
    {
      sql: `UPDATE task_github_issues SET synced_state = ? WHERE task_id = ? AND issue_id = ?`,
      params: [input.syncedState, input.taskId, input.issueId],
    },
  ];
}
