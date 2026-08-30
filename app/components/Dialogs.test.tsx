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
});
