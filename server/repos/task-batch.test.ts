// Tests for the batch-array builders in `task-batch.ts`. The
// builders are pure functions of the input — these tests verify they
// return the same `{ sql, params }` pairs the existing `withTx` path
// produces on the Bun side. Phase 6 will route the Workers-side
// services through these same arrays via `db.batch(stmts)`.

import { describe, expect, it } from "vitest";
import {
  buildSetArchivedAndEmitBatch,
  buildWebhookMoveBatch,
  type BatchStmt,
} from "./task-batch";

describe("buildSetArchivedAndEmitBatch", () => {
  it("returns two statements: UPDATE tasks + INSERT task_activity", () => {
    const stmts = buildSetArchivedAndEmitBatch({
      taskId: "t1",
      archivedAt: "2026-08-25T10:00:00Z",
      actorKind: "user",
      actorLabel: "Maria",
      actorUserId: "u1",
      archivedMessage: "Maria archived this task",
      restoredMessage: "Maria restored this task",
      viaHerald: false,
    });
    expect(stmts).toHaveLength(2);
    expect(stmts[0]!.sql).toMatch(/UPDATE tasks SET archived_at = \?, updated_at = \? WHERE id = \?/);
    expect(stmts[0]!.params).toEqual(["2026-08-25T10:00:00Z", expect.anything(), "t1"]);
    expect(stmts[1]!.sql).toMatch(/INSERT INTO task_activity/);
    expect(stmts[1]!.sql).toMatch(/type, message, via_herald/);
    expect(stmts[1]!.params).toEqual([
      "t1",
      "user",
      "Maria",
      "u1",
      "archived",
      "Maria archived this task",
      0,
    ]);
  });

  it("uses `restored` type and message when archivedAt is null", () => {
    const stmts = buildSetArchivedAndEmitBatch({
      taskId: "t1",
      archivedAt: null,
      actorKind: "agent",
      actorLabel: "hearth-herald",
      actorUserId: null,
      archivedMessage: "Maria archived this task",
      restoredMessage: "hearth-herald restored this task",
      viaHerald: true,
    });
    expect(stmts).toHaveLength(2);
    expect(stmts[0]!.params[0]!).toBeNull();
    expect(stmts[1]!.params[4]!).toBe("restored");
    expect(stmts[1]!.params[5]!).toBe("hearth-herald restored this task");
    expect(stmts[1]!.params[6]!).toBe(1);
  });
});

describe("buildWebhookMoveBatch", () => {
  it("returns two statements: UPDATE tasks + UPDATE task_github_issues", () => {
    const stmts = buildWebhookMoveBatch({
      taskId: "t1",
      issueId: "i_node_1",
      columnId: "c-done",
      swimlaneId: "s1",
      position: "a0",
      syncedState: "closed",
    });
    expect(stmts).toHaveLength(2);
    expect(stmts[0]!.sql).toMatch(/UPDATE tasks SET column_id = \?, swimlane_id = \?, position = \?, updated_at = datetime\('now'\) WHERE id = \?/);
    expect(stmts[0]!.params).toEqual(["c-done", "s1", "a0", "t1"]);
    expect(stmts[1]!.sql).toMatch(/UPDATE task_github_issues SET synced_state = \? WHERE task_id = \? AND issue_id = \?/);
    expect(stmts[1]!.params).toEqual(["closed", "t1", "i_node_1"]);
  });

  it("preserves synced_state 'open' as a literal string param", () => {
    const open: BatchStmt[] = buildWebhookMoveBatch({
      taskId: "t1",
      issueId: "i1",
      columnId: "c1",
      swimlaneId: "s1",
      position: "a0",
      syncedState: "open",
    });
    expect(open[1]!.params[0]!).toBe("open");
  });
});
