import { describe, expect, it } from "vitest";
import type { Task } from "../../shared/types";
import { laneNeighbors } from "./lane-neighbors";

function task(id: string, columnId: string, position: string): Task {
  return {
    id,
    key: id,
    projectId: "p1",
    columnId,
    swimlaneId: "s1",
    title: id,
    description: { type: "doc", content: [] },
    priority: "pr1",
    type: "tp1",
    assignees: [],
    position,
    githubs: [],
    dueAt: null,
    archivedAt: null,
    createdAt: "t",
    updatedAt: "t",
  };
}

describe("laneNeighbors", () => {
  it("returns the nearest same-column neighbors around a middle task", () => {
    const tasks = [
      task("a", "c1", "a0"),
      task("b", "c1", "a1"),
      task("c", "c1", "a2"),
      task("d", "c1", "a3"),
    ];
    expect(laneNeighbors(tasks, task("c", "c1", "a2"))).toEqual({
      beforeTaskId: "b",
      afterTaskId: "d",
    });
  });

  it("returns only the after neighbor for the first task in a column", () => {
    const tasks = [task("a", "c1", "a0"), task("b", "c1", "a1")];
    expect(laneNeighbors(tasks, task("a", "c1", "a0"))).toEqual({ afterTaskId: "b" });
  });

  it("returns only the before neighbor for the last task in a column", () => {
    const tasks = [task("a", "c1", "a0"), task("b", "c1", "a1")];
    expect(laneNeighbors(tasks, task("b", "c1", "a1"))).toEqual({ beforeTaskId: "a" });
  });

  it("returns no neighbors for a lone task or an empty list", () => {
    expect(laneNeighbors([], task("a", "c1", "a0"))).toEqual({});
    expect(laneNeighbors([task("a", "c1", "a0")], task("a", "c1", "a0"))).toEqual({});
  });

  it("ignores tasks in other columns", () => {
    const tasks = [
      task("other", "c2", "a0"),
      task("a", "c1", "a0"),
      task("other2", "c2", "a1"),
      task("b", "c1", "a5"),
    ];
    expect(laneNeighbors(tasks, task("a", "c1", "a0"))).toEqual({ afterTaskId: "b" });
  });
});
