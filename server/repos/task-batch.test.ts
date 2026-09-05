// Tests for the batch-array builders in `task-batch.ts`. The
// builders are pure functions of the input — these tests verify they
// return the same `{ sql, params }` pairs the existing `withTx` path
// produces on the Bun side. Phase 6 will route the Workers-side
// services through these same arrays via `db.batch(stmts)`.

import { describe, expect, it } from "vitest";
import {
  buildSetArchivedAndEmitBatch,
  buildTaskArchiveBatch,
  buildTaskCreateBatch,
  buildTaskDeleteBatch,
  buildTaskUpdateBatch,
  buildPlainMoveStmts,
  buildUnlinkBatch,
  buildWebhookMoveAndEmitBatch,
  buildWebhookMoveBatch,
  buildWipMoveStmt,
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

describe("emission builders (B2 batch re-expression)", () => {
  const actor = {
    actorKind: "user" as const,
    actorLabel: "Maria",
    actorUserId: "u1",
    type: "created",
    message: "Maria created this task",
    viaHerald: false,
  };

  it("buildTaskCreateBatch: task + assignees + subtask link + activity, in order", () => {
    const stmts = buildTaskCreateBatch({
      id: "t1",
      projectId: "p1",
      columnId: "c1",
      swimlaneId: "s1",
      title: "T",
      description: "{}",
      priority: "prio-1",
      type: "type-1",
      position: "a0",
      dueAt: null,
      number: 3,
      key: "EG-3",
      assignees: ["Maria", "Jo"],
      subtaskOfParentId: "parent-1",
      activity: [actor],
    });
    expect(stmts).toHaveLength(5);
    expect(stmts[0]!.sql).toMatch(/INSERT INTO tasks/);
    expect(stmts[0]!.params).toEqual(["t1", "p1", "c1", "s1", "T", "{}", "prio-1", "type-1", "a0", null, 3, "EG-3"]);
    expect(stmts[1]!.sql).toMatch(/INSERT INTO task_assignees/);
    expect(stmts[2]!.sql).toMatch(/INSERT INTO task_assignees/);
    expect(stmts[3]!.sql).toMatch(/INSERT INTO task_links/);
    expect(stmts[3]!.params).toEqual([expect.any(String), "p1", "t1", "parent-1"]);
    expect(stmts[4]!.sql).toMatch(/INSERT INTO task_activity/);
    expect(stmts[4]!.params).toEqual(["t1", "user", "Maria", "u1", "created", "Maria created this task", 0]);
  });

  it("buildTaskCreateBatch omits link and assignees when absent", () => {
    const stmts = buildTaskCreateBatch({
      id: "t1", projectId: "p1", columnId: "c1", swimlaneId: "s1", title: "T",
      description: "{}", priority: "p", type: "t", position: "a0", dueAt: null,
      number: 1, key: "EG-1", assignees: [], activity: [actor],
    });
    expect(stmts).toHaveLength(2);
  });

  it("buildTaskUpdateBatch: assignee replace + scalar sets + activity", () => {
    const stmts = buildTaskUpdateBatch({
      id: "t1",
      title: "New",
      dueAt: null,
      replaceAssignees: ["Jo"],
      activity: [{ ...actor, type: "field_changed", message: "Maria changed the title" }],
    });
    expect(stmts.map((s) => s.sql)).toEqual([
      expect.stringMatching(/DELETE FROM task_assignees/),
      expect.stringMatching(/INSERT INTO task_assignees/),
      expect.stringMatching(/UPDATE tasks SET title = \?, due_at = \?, updated_at = datetime\('now'\) WHERE id = \?/),
      expect.stringMatching(/INSERT INTO task_activity/),
    ]);
    expect(stmts[2]!.params).toEqual(["New", null, "t1"]);
  });

  it("buildTaskUpdateBatch with no changes and no activity returns []", () => {
    expect(buildTaskUpdateBatch({ id: "t1", activity: [] })).toEqual([]);
  });

  it("buildWipMoveStmt keeps the conditional UPDATE as one statement with 8 params", () => {
    const stmt = buildWipMoveStmt({
      taskId: "t1", projectId: "p1", columnId: "c2", swimlaneId: "s1", position: "a1", clearDueAt: true,
    });
    expect(stmt.sql).toMatch(/due_at = NULL/);
    expect(stmt.sql).toMatch(/SELECT COUNT\(\*\) FROM tasks/);
    expect(stmt.sql).toMatch(/COALESCE\(\(SELECT wip_limit FROM columns WHERE id = \?\), 9223372036854775807\)/);
    expect(stmt.params).toEqual(["c2", "s1", "a1", "t1", "c2", "p1", "c2", "c2"]);
    const plain = buildWipMoveStmt({ taskId: "t1", projectId: "p1", columnId: "c2", swimlaneId: "s1", position: "a1", clearDueAt: false });
    expect(plain.sql).not.toMatch(/due_at = NULL/);
  });

  it("buildPlainMoveStmts emits one bypass UPDATE per move", () => {
    const stmts = buildPlainMoveStmts([
      { taskId: "c1", columnId: "c2", swimlaneId: "s1", position: "a1" },
      { taskId: "c2", columnId: "c2", swimlaneId: "s1", position: "a2", clearDueAt: true },
    ]);
    expect(stmts).toHaveLength(2);
    expect(stmts[0]!.sql).not.toMatch(/SELECT COUNT/);
    expect(stmts[0]!.params).toEqual(["c2", "s1", "a1", "c1"]);
    expect(stmts[1]!.sql).toMatch(/due_at = NULL/);
  });

  it("buildWebhookMoveAndEmitBatch: move + synced-state + github_synced activity", () => {
    const stmts = buildWebhookMoveAndEmitBatch({
      taskId: "t1", issueId: "i1", columnId: "c2", swimlaneId: "s1",
      position: "a0", syncedState: "closed",
      activity: { actorKind: "system", actorLabel: "github", actorUserId: null, type: "github_synced", message: "GitHub synced #7 → closed", viaHerald: false },
    });
    expect(stmts).toHaveLength(3);
    expect(stmts[1]!.params).toEqual(["closed", "t1", "i1"]);
    expect(stmts[2]!.params).toEqual(["t1", "system", "github", null, "github_synced", "GitHub synced #7 → closed", 0]);
  });

  it("buildWebhookMoveAndEmitBatch without a link emits no activity row", () => {
    const stmts = buildWebhookMoveAndEmitBatch({
      taskId: "t1", issueId: "i1", columnId: "c2", swimlaneId: "s1",
      position: "a0", syncedState: "open", activity: null,
    });
    expect(stmts).toHaveLength(2);
  });

  it("buildTaskDeleteBatch inserts the deleted row before the DELETE", () => {
    const stmts = buildTaskDeleteBatch({ taskId: "t1", activity: { ...actor, type: "deleted", message: "Maria deleted this task" } });
    expect(stmts).toHaveLength(2);
    expect(stmts[0]!.sql).toMatch(/INSERT INTO task_activity/);
    expect(stmts[1]!.sql).toMatch(/DELETE FROM tasks WHERE id = \?/);
  });

  it("buildTaskArchiveBatch flips archived_at with datetime('now') updated_at", () => {
    const stmts = buildTaskArchiveBatch({ taskId: "t1", archivedAt: "now", activity: { ...actor, type: "archived", message: "x" } });
    expect(stmts[0]!.sql).toMatch(/UPDATE tasks SET archived_at = \?, updated_at = datetime\('now'\) WHERE id = \?/);
    expect(stmts[0]!.params).toEqual(["now", "t1"]);
    expect(stmts).toHaveLength(2);
  });

  it("buildUnlinkBatch deletes the link, activity only when linked", () => {
    expect(buildUnlinkBatch({ taskId: "t1", issueId: "i1", activity: null })).toHaveLength(1);
    expect(buildUnlinkBatch({ taskId: "t1", issueId: "i1", activity: actor })).toHaveLength(2);
  });
});
