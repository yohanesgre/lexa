import { describe, it, expect } from "vitest";
import type { Task, TipTapDoc } from "../../../shared/types";
import { computeDropTarget, computeDropPosition } from "./board-drop";

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
  it("drops onto a column cell → appends after the last task in that cell", () => {
    const target = computeDropTarget(tasks[0]!, over("cell:l1:c2", { type: "column", columnId: "c2", swimlaneId: "l1" }), tasksInCell, tasks);
    expect(target).toEqual({ columnId: "c2", swimlaneId: "l1", beforeTaskId: "t3", afterTaskId: undefined });
  });

  it("drops onto an empty column cell → no before/after anchor", () => {
    const target = computeDropTarget(tasks[0]!, over("cell:l1:cX", { type: "column", columnId: "cX", swimlaneId: "l1" }), tasksInCell, tasks);
    expect(target).toEqual({ columnId: "cX", swimlaneId: "l1", beforeTaskId: undefined, afterTaskId: undefined });
  });

  it("drops from above onto a task → lands before it", () => {
    const target = computeDropTarget(tasks[2]!, over("t2"), tasksInCell, tasks);
    expect(target).toEqual({ columnId: "c1", swimlaneId: "l1", beforeTaskId: "t2", afterTaskId: undefined });
  });

  it("drops from below onto a task → lands after it", () => {
    // t2 (a1) dragged onto t1 (a0) in the same column — below the target.
    const target = computeDropTarget(tasks[1]!, over("t1"), tasksInCell, tasks);
    expect(target).toEqual({ columnId: "c1", swimlaneId: "l1", beforeTaskId: undefined, afterTaskId: "t1" });
  });

  it("missing over task → null", () => {
    expect(computeDropTarget(tasks[0]!, over("ghost"), tasksInCell, tasks)).toBeNull();
  });
});

describe("computeDropPosition", () => {
  it("generates a key between anchors", () => {
    const before = tasks[2]!;
    const target = { columnId: "c1", swimlaneId: "l1", beforeTaskId: "t1", afterTaskId: "t2" };
    const pos = computeDropPosition(before, target, tasks);
    expect(pos > "a0" && pos < "a1").toBe(true);
  });

  it("appends after the trailing task when there is no before anchor", () => {
    const target = { columnId: "c1", swimlaneId: "l1", beforeTaskId: undefined, afterTaskId: undefined };
    expect(computeDropPosition(tasks[2]!, target, tasks)).toBe("a2");
  });
});