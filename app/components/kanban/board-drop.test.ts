import { describe, it, expect } from "vitest";
import type { Task, TipTapDoc } from "../../../shared/types";
import { computeDropTarget, computeDropPosition } from "./board-drop";
import { laneNeighbors } from "../../lib/lane-neighbors";

const doc: TipTapDoc = { type: "doc", content: [] };

const tasks: Task[] = [
  { id: "t1", columnId: "c1", swimlaneId: "l1", position: "a0", key: "P-1", title: "One", priority: "p", type: "t", assignees: [], githubs: [], archivedAt: null, dueAt: null, createdAt: "", updatedAt: "", projectId: "p1", description: doc },
  { id: "t2", columnId: "c1", swimlaneId: "l1", position: "a1", key: "P-2", title: "Two", priority: "p", type: "t", assignees: [], githubs: [], archivedAt: null, dueAt: null, createdAt: "", updatedAt: "", projectId: "p1", description: doc },
  { id: "t3", columnId: "c2", swimlaneId: "l1", position: "b0", key: "P-3", title: "Three", priority: "p", type: "t", assignees: [], githubs: [], archivedAt: null, dueAt: null, createdAt: "", updatedAt: "", projectId: "p1", description: doc },
];

const tasksInCell = (columnId: string, laneId: string) =>
  tasks.filter((t) => t.columnId === columnId && t.swimlaneId === laneId).sort((a, b) => (a.position < b.position ? -1 : 1));

const over = (id: string, data?: unknown) => ({ id, data: { current: data } }) as never;

describe("computeDropTarget", () => {
  it("drops onto a column cell after its last task, or with no anchors when the cell is empty", () => {
    expect(computeDropTarget(tasks[0]!, over("cell:l1:c2", { type: "column", columnId: "c2", swimlaneId: "l1" }), tasksInCell, tasks)).toEqual(
      { columnId: "c2", swimlaneId: "l1", beforeTaskId: "t3", afterTaskId: undefined },
    );
    expect(computeDropTarget(tasks[0]!, over("cell:l1:cX", { type: "column", columnId: "cX", swimlaneId: "l1" }), tasksInCell, tasks)).toEqual(
      { columnId: "cX", swimlaneId: "l1", beforeTaskId: undefined, afterTaskId: undefined },
    );
  });

  it("drops onto a task before it from above and after it from below, and is null for a missing over task", () => {
    // t3 (c2) dragged onto t2 (c1) — approaches from above.
    expect(computeDropTarget(tasks[2]!, over("t2"), tasksInCell, tasks)).toEqual({ columnId: "c1", swimlaneId: "l1", beforeTaskId: "t2", afterTaskId: undefined });
    // t2 (a1) dragged onto t1 (a0) in the same column — below the target.
    expect(computeDropTarget(tasks[1]!, over("t1"), tasksInCell, tasks)).toEqual({ columnId: "c1", swimlaneId: "l1", beforeTaskId: undefined, afterTaskId: "t1" });
    expect(computeDropTarget(tasks[0]!, over("ghost"), tasksInCell, tasks)).toBeNull();
  });
});

describe("computeDropPosition", () => {
  it("generates a key between anchors and appends after the trailing task without a before anchor", () => {
    const between = computeDropPosition(tasks[2]!, { columnId: "c1", swimlaneId: "l1", beforeTaskId: "t1", afterTaskId: "t2" }, tasks);
    expect(between > "a0" && between < "a1").toBe(true);
    expect(computeDropPosition(tasks[2]!, { columnId: "c1", swimlaneId: "l1", beforeTaskId: undefined, afterTaskId: undefined }, tasks)).toBe("a2");
  });
});

// Merged from lib/lane-neighbors.test.ts — the same-column anchors a lane-only
// move sends (TaskDetail spreads laneNeighbors into the move payload), so the
// move keeps the task's relative order instead of repositioning it.
describe("laneNeighbors — same-column anchors for a lane-only move", () => {
  const laneTask = (id: string, columnId: string, position: string): Task => ({ ...tasks[0]!, id, key: id, columnId, position });

  it("returns the nearest same-column neighbors, with one-sided edges at the ends", () => {
    const lane = [laneTask("a", "c1", "a0"), laneTask("b", "c1", "a1"), laneTask("c", "c1", "a2"), laneTask("d", "c1", "a3")];
    expect(laneNeighbors(lane, laneTask("c", "c1", "a2"))).toEqual({ beforeTaskId: "b", afterTaskId: "d" });
    expect(laneNeighbors(lane, laneTask("a", "c1", "a0"))).toEqual({ afterTaskId: "b" });
    expect(laneNeighbors(lane, laneTask("d", "c1", "a3"))).toEqual({ beforeTaskId: "c" });
  });

  it("ignores tasks in other columns", () => {
    const lane = [laneTask("other", "c2", "a0"), laneTask("a", "c1", "a0"), laneTask("other2", "c2", "a1"), laneTask("b", "c1", "a5")];
    expect(laneNeighbors(lane, laneTask("a", "c1", "a0"))).toEqual({ afterTaskId: "b" });
  });
});