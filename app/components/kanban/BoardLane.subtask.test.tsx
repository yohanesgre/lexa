// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { render, renderHook, screen } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import type { ReactNode } from "react";
import type { Board, BoardTask, Column, Swimlane, Task } from "../../../shared/types";
import { makeBoard } from "../../test-utils";
import { BoardLane } from "./BoardLane";
import { buildCellMap, useLinkMaps } from "./board-utils";

vi.mock("../../lib/queries", () => ({
  useBoard: () => ({ data: undefined }),
  useUpdateColumn: () => ({ mutate: vi.fn() }),
  useDeleteColumn: () => ({ mutate: vi.fn() }),
  useDeleteTask: () => ({ mutate: vi.fn() }),
  useCreateTask: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateSwimlane: () => ({ mutate: vi.fn() }),
  useDeleteSwimlane: () => ({ mutate: vi.fn() }),
  useCreateColumn: () => ({ mutate: vi.fn() }),
  useArchiveSwimlane: () => ({ mutate: vi.fn() }),
  useRestoreSwimlane: () => ({ mutate: vi.fn() }),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, className }: { children?: ReactNode; className?: string }) => (
    <a className={className}>{children}</a>
  ),
}));

const COLUMN: Column = {
  id: "c1",
  projectId: "p1",
  name: "Todo",
  position: 0,
  color: "",
  wipLimit: null,
  requiredFields: [],
  githubState: null,
  isDone: false,
};

const LANE: Swimlane = {
  id: "s1",
  projectId: "p1",
  name: "Sprint 7",
  description: "",
  position: 0,
  dueAt: null,
  startAt: null,
  archivedAt: null,
  kind: "sprint",
  milestoneId: null,
  tasksDone: 0,
  tasksTotal: 0,
};

function makeTask(overrides: Partial<Task>): Task {
  return {
    id: "t0",
    key: "DEMO-0",
    projectId: "p1",
    columnId: "c1",
    swimlaneId: "s1",
    title: "Task",
    description: { type: "doc", content: [] },
    priority: "p1",
    type: "ty1",
    assignees: [],
    position: "a0",
    githubs: [],
    dueAt: null,
    archivedAt: null,
    createdAt: "t",
    updatedAt: "t",
    ...overrides,
  };
}

const PARENT = makeTask({ id: "t1", key: "DEMO-1", title: "Parent task", position: "a0" });
const CHILD = makeTask({ id: "t2", key: "DEMO-2", title: "Child task", position: "a1" });

const BOARD: Board = makeBoard({
  columns: [COLUMN],
  swimlanes: [LANE],
  links: [
    { id: "l1", projectId: "p1", fromTaskId: "t2", toTaskId: "t1", relation: "subtask_of", createdAt: "t" },
  ],
  tasks: [PARENT, CHILD],
});

function renderLane(boardTask: Board = BOARD, cardHidden: (t: BoardTask) => boolean = () => false) {
  const { result } = renderHook(() => useLinkMaps(boardTask));
  const { childrenByParent, parentOf, blockedBy } = result.current;
  render(
    <DndContext>
      <BoardLane
        slug="demo"
        lane={LANE}
        columns={[COLUMN]}
        board={boardTask}
        localTasks={boardTask.tasks}
        cellMap={buildCellMap(boardTask.tasks)}
        childrenByParent={childrenByParent}
        parentOf={parentOf}
        blockedBy={blockedBy}
        cardHidden={cardHidden}
        cardDimmed={() => false}
        columnTotalCount={() => boardTask.tasks.length}
        columnDimmed={() => false}
        cellDropId={(columnId, laneId) => `cell:${laneId}:${columnId}`}
        flashColumnId={null}
        collapsed={new Set()}
        toggleLane={vi.fn()}
        onOpenCreateTask={vi.fn()}
        onSelectTask={vi.fn()}
        onDelete={vi.fn()}
        selectedTaskId={null}
        newTaskIds={new Set()}
        shakeTaskId={null}
        archiveTask={{ mutate: vi.fn() }}
        restoreTask={{ mutate: vi.fn() }}
        collapsedParents={new Set()}
        setCollapsedParents={vi.fn()}
      />
    </DndContext>
  );
}

describe("useLinkMaps subtask relations", () => {
  it("maps the child to its parent and the parent to its children", () => {
    const { result } = renderHook(() => useLinkMaps(BOARD));
    expect(result.current.parentOf.get("t2")).toBe("t1");
    expect(result.current.childrenByParent.get("t1")).toEqual(["t2"]);
  });
});

describe("BoardLane subtask rendering", () => {
  it("renders a task with subtasks as parent plus indented child", () => {
    renderLane();

    const parentCard = screen.getByRole("button", { name: "Open task Parent task" }).querySelector(".kanban-card");
    const childCard = screen.getByRole("button", { name: "Open task Child task" }).querySelector(".kanban-card");

    expect(parentCard).not.toBeNull();
    expect(childCard).not.toBeNull();
    expect(parentCard).not.toHaveClass("kanban-card-subtask");
    expect(childCard).toHaveClass("kanban-card-subtask");
    expect(parentCard?.textContent).toContain("01");
    expect(document.querySelectorAll(".kanban-card")).toHaveLength(2);
  });

  it("renders an orphaned child top-level when its parent is absent (archived)", () => {
    const orphaned: Board = makeBoard({ columns: [COLUMN], swimlanes: [LANE], links: BOARD.links, tasks: [CHILD] });
    renderLane(orphaned);

    const childCard = screen.getByRole("button", { name: "Open task Child task" }).querySelector(".kanban-card");
    expect(childCard).not.toBeNull();
    expect(childCard).not.toHaveClass("kanban-card-subtask");
    expect(document.querySelectorAll(".kanban-card")).toHaveLength(1);
  });

  it("renders an orphaned child top-level when its parent is filtered out", () => {
    renderLane(BOARD, (t) => t.id === "t1");

    const childCard = screen.getByRole("button", { name: "Open task Child task" }).querySelector(".kanban-card");
    expect(childCard).not.toBeNull();
    expect(childCard).not.toHaveClass("kanban-card-subtask");
    expect(document.querySelectorAll(".kanban-card")).toHaveLength(1);
  });

  it("renders a child with two parents once, under its canonical parent", () => {
    const secondParent = makeTask({ id: "t3", key: "DEMO-3", title: "Second parent", position: "a2" });
    const twoParents: Board = makeBoard({
      columns: [COLUMN],
      swimlanes: [LANE],
      links: [
        { id: "l1", projectId: "p1", fromTaskId: "t2", toTaskId: "t1", relation: "subtask_of", createdAt: "t" },
        { id: "l2", projectId: "p1", fromTaskId: "t2", toTaskId: "t3", relation: "subtask_of", createdAt: "t" },
      ],
      tasks: [PARENT, secondParent, CHILD],
    });
    renderLane(twoParents);

    expect(screen.getAllByRole("button", { name: "Open task Child task" })).toHaveLength(1);
    expect(document.querySelectorAll(".kanban-card")).toHaveLength(3);
  });
});
