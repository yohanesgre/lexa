// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DndContext } from "@dnd-kit/core";
import type { Board, Column, FieldOption, Swimlane, Task } from "../../../shared/types";
import { makeBoard } from "../../test-utils";
import { emptyFilters } from "../../lib/filters";
import { Column as BoardColumn } from "./Column";
import { FilterButton } from "./BoardFilters";
import { MoveConfirmDialog } from "./MoveConfirmDialog";

const createTaskMutate = vi.hoisted(() => vi.fn());

vi.mock("../../lib/queries", () => ({
  useCreateTask: () => ({ mutate: createTaskMutate, isPending: false }),
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
  dueAt: "2026-10-05",
  startAt: null,
  archivedAt: null,
  kind: "sprint",
  milestoneId: null,
  tasksDone: 0,
  tasksTotal: 0,
};

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    key: "DEMO-1",
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

const PRIORITY: FieldOption = { id: "p1", label: "Low", color: "#6B6560", position: 0 };

beforeEach(() => {
  createTaskMutate.mockReset();
});

describe("FilterCheckbox pressed state", () => {
  const board = makeBoard({
    columns: [COLUMN],
    fieldConfig: { priorities: [PRIORITY], types: [] },
  });

  it("exposes the checked state via aria-pressed", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<FilterButton board={board} filters={emptyFilters()} onChange={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /filter/i }));
    expect(screen.getByRole("button", { name: "Todo" })).toHaveAttribute("aria-pressed", "false");

    rerender(
      <FilterButton
        board={board}
        filters={{ ...emptyFilters(), columns: new Set(["c1"]) }}
        onChange={vi.fn()}
      />
    );
    expect(screen.getByRole("button", { name: "Todo" })).toHaveAttribute("aria-pressed", "true");
  });
});

describe("Column inline create", () => {
  it("keeps the typed title when the create fails", async () => {
    const user = userEvent.setup();
    createTaskMutate.mockImplementation(
      (_input: unknown, options?: { onError?: (error: unknown) => void; onSettled?: (data: unknown, error: unknown) => void }) => {
        const error = new Error("create failed");
        options?.onError?.(error);
        options?.onSettled?.(undefined, error);
      }
    );
    render(
      <DndContext>
        <BoardColumn id="cell" slug="demo" columnId="c1" swimlaneId="s1" isEmpty children={null} />
      </DndContext>
    );

    await user.click(screen.getByRole("button", { name: /add task/i }));
    const input = screen.getByLabelText("Task title");
    await user.type(input, "Draft task");
    await user.click(screen.getByRole("button", { name: /save/i }));

    expect(createTaskMutate).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Task title")).toHaveValue("Draft task");
  });

  it("clears the form only on success", async () => {
    const user = userEvent.setup();
    render(
      <DndContext>
        <BoardColumn id="cell" slug="demo" columnId="c1" swimlaneId="s1" isEmpty children={null} />
      </DndContext>
    );

    await user.click(screen.getByRole("button", { name: /add task/i }));
    await user.type(screen.getByLabelText("Task title"), "Draft task");
    await user.click(screen.getByRole("button", { name: /save/i }));

    const options = createTaskMutate.mock.calls[0]![1] as { onSuccess: () => void };
    act(() => options.onSuccess());

    expect(screen.queryByLabelText("Task title")).not.toBeInTheDocument();
  });
});

describe("MoveConfirmDialog clear-deadline reset", () => {
  const board: Board = makeBoard({ swimlanes: [LANE], tasks: [makeTask({ dueAt: "2026-10-10" })] });

  it("resets the opt-in when a new move is queued", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <MoveConfirmDialog
        board={board}
        pending={{ task: makeTask({ dueAt: "2026-10-10" }), target: { columnId: "c2", swimlaneId: "s1" } }}
        resolve={vi.fn()}
        cancel={vi.fn()}
      />
    );

    await user.click(screen.getByRole("checkbox"));
    expect(screen.getByRole("checkbox")).toBeChecked();

    rerender(
      <MoveConfirmDialog
        board={board}
        pending={{ task: makeTask({ id: "t2", dueAt: "2026-10-20" }), target: { columnId: "c2", swimlaneId: "s1" } }}
        resolve={vi.fn()}
        cancel={vi.fn()}
      />
    );
    expect(screen.getByRole("checkbox")).not.toBeChecked();
  });
});
