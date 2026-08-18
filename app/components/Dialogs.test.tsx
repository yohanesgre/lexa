// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DeleteTaskDialog } from "./DeleteTaskDialog";
import { MissingFieldsWarning } from "./MissingFieldsWarning";
import { MoveConfirmDialog, type PendingMove } from "./kanban/MoveConfirmDialog";
import type { Board, Task } from "../../shared/types";

const TASK: Task = {
  id: "t1", key: "EG-1", projectId: "p1", columnId: "c1", swimlaneId: "s1", title: "Task One",
  description: { type: "doc", content: [] }, priority: "p", type: "t",
  assignees: [], position: "a0", githubs: [], dueAt: null, archivedAt: null, createdAt: "t", updatedAt: "t",
};

const BOARD: Board = {
  project: { id: "p1", slug: "demo", key: "EG", name: "Demo", description: "", repos: [], createdAt: "t", updatedAt: "t" },
  columns: [{ id: "c1", projectId: "p1", name: "Todo", position: 0, color: "#888", wipLimit: null, requiredFields: [], githubState: null, isDone: false }],
  swimlanes: [
    { id: "s1", projectId: "p1", name: "Main", description: "", position: 0, dueAt: "2099-08-01", archivedAt: null, startAt: null, milestoneId: null, kind: "sprint" },
    { id: "s2", projectId: "p1", name: "Old", description: "", position: 1, dueAt: "2000-01-01", archivedAt: null, startAt: null, milestoneId: null, kind: "sprint" },
  ],
  milestones: [],
  fieldConfig: { priorities: [], types: [] },
  links: [],
  tasks: [TASK],
};

describe("DeleteTaskDialog", () => {
  it("renders nothing when closed", () => {
    render(<DeleteTaskDialog task={TASK} open={false} deleting={false} onClose={() => {}} onDelete={() => {}} />);
    expect(screen.queryByText("Delete task")).not.toBeInTheDocument();
  });

  it("shows the task title and confirms deletion", async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    const onClose = vi.fn();
    render(<DeleteTaskDialog task={TASK} open deleting={false} onClose={onClose} onDelete={onDelete} />);
    expect(screen.getByText("Delete task")).toBeInTheDocument();
    expect(screen.getByText(/Task One/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("cancel and overlay close without deleting", async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    const onClose = vi.fn();
    render(<DeleteTaskDialog task={TASK} open deleting={false} onClose={onClose} onDelete={onDelete} />);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onDelete).not.toHaveBeenCalled();
    await user.click(screen.getByLabelText("Close"));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("disables the delete button while deleting", () => {
    render(<DeleteTaskDialog task={TASK} open deleting onClose={() => {}} onDelete={() => {}} />);
    expect(screen.getByRole("button", { name: "Deleting..." })).toBeDisabled();
  });
});

describe("MissingFieldsWarning", () => {
  it("renders the column and required fields and dismisses", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(<MissingFieldsWarning columnName="Done" fields={["description", "assignee"]} onDismiss={onDismiss} />);
    expect(screen.getByText("Done requires description, assignee")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Dismiss warning" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe("MoveConfirmDialog", () => {
  function pending(task: Task, swimlaneId: string): PendingMove {
    return { task, target: { columnId: "c1", swimlaneId } };
  }

  it("renders nothing without a pending move or an unknown lane", () => {
    render(<MoveConfirmDialog board={BOARD} pending={null} resolve={() => {}} cancel={() => {}} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("deadline conflict: resolving with the checkbox checked passes clearDueAt", async () => {
    const user = userEvent.setup();
    const resolve = vi.fn();
    const cancel = vi.fn();
    const task = { ...TASK, dueAt: "2099-09-01" }; // later than the lane's 2099-08-01
    render(<MoveConfirmDialog board={BOARD} pending={pending(task, "s1")} resolve={resolve} cancel={cancel} />);
    expect(screen.getByText("Deadline conflict")).toBeInTheDocument();
    // un-checked → resolve(false)
    await user.click(screen.getByRole("button", { name: "Move anyway" }));
    expect(resolve).toHaveBeenCalledWith(false);
    // checked → resolve(true)
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Move anyway" }));
    expect(resolve).toHaveBeenCalledWith(true);
  });

  it("overdue lane: shows the overdue message and resolves without clearing", async () => {
    const user = userEvent.setup();
    const resolve = vi.fn();
    render(<MoveConfirmDialog board={BOARD} pending={pending(TASK, "s2")} resolve={resolve} cancel={() => {}} />);
    expect(screen.getByText("Overdue lane")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Move" }));
    expect(resolve).toHaveBeenCalledWith(false);
  });

  it("cancel closes the dialog without resolving", async () => {
    const user = userEvent.setup();
    const resolve = vi.fn();
    const cancel = vi.fn();
    render(<MoveConfirmDialog board={BOARD} pending={pending(TASK, "s2")} resolve={resolve} cancel={cancel} />);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(resolve).not.toHaveBeenCalled();
  });
});
