import { describe, expect, it } from "vitest";
import type { BoardTask, Task, TipTapDoc } from "./types";
import { boardTaskToTask } from "./types";

const DOC: TipTapDoc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "body" }] }] };

const ROW: BoardTask = {
  id: "t1",
  key: "DEM-1",
  projectId: "p1",
  columnId: "c1",
  swimlaneId: "s1",
  title: "Task",
  priority: "prio-1",
  type: "type-1",
  assignees: [],
  position: "a0",
  githubs: [],
  dueAt: null,
  archivedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("boardTaskToTask", () => {
  it("falls back to the empty doc when the row carries no description", () => {
    expect(boardTaskToTask(ROW).description).toEqual({ type: "doc", content: [] });
  });

  it("preserves a description present on a mutation-cached row", () => {
    const cached = { ...ROW, description: DOC } as BoardTask;
    expect(boardTaskToTask(cached).description).toBe(DOC);
  });

  it("keeps the rest of the row intact", () => {
    const task: Task = boardTaskToTask({ ...ROW, description: DOC } as BoardTask);
    expect(task).toMatchObject({ id: "t1", key: "DEM-1", title: "Task" });
  });
});
