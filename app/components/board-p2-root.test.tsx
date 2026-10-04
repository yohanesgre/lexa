// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Task } from "../../shared/types";
import { DeleteTaskDialog } from "./DeleteTaskDialog";
import { MissingFieldsWarning } from "./MissingFieldsWarning";
import { TaskFooter } from "./TaskFooter";
import { AssigneeChips } from "./AssigneeChips";

const TASK: Task = {
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
};

describe("DeleteTaskDialog focus management", () => {
  function Harness({ open }: { open: boolean }) {
    return (
      <>
        <button type="button" data-testid="outside">outside</button>
        {open && (
          <DeleteTaskDialog task={TASK} open deleting={false} onClose={vi.fn()} onDelete={vi.fn()} />
        )}
      </>
    );
  }

  it("moves focus in, traps Tab, and restores focus on unmount", () => {
    const { rerender } = render(<Harness open={false} />);
    const outside = screen.getByTestId("outside");
    outside.focus();
    expect(outside).toHaveFocus();

    rerender(<Harness open />);
    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(cancel).toHaveFocus();

    const del = screen.getByRole("button", { name: "Delete" });
    del.focus();
    fireEvent.keyDown(del, { key: "Tab" });
    expect(cancel).toHaveFocus();

    rerender(<Harness open={false} />);
    expect(outside).toHaveFocus();
  });
});

describe("MissingFieldsWarning copy", () => {
  it("joins multiple missing fields with 'and'", () => {
    render(<MissingFieldsWarning columnName="In Progress" fields={["description", "assignee"]} onDismiss={vi.fn()} />);
    expect(screen.getByText("In Progress requires description and assignee")).toBeInTheDocument();
  });

  it("renders a single field without a conjunction", () => {
    render(<MissingFieldsWarning columnName="In Progress" fields={["assignee"]} onDismiss={vi.fn()} />);
    expect(screen.getByText("In Progress requires assignee")).toBeInTheDocument();
  });
});

describe("TaskFooter archive pending guard", () => {
  const props = {
    isCreate: false,
    isArchived: false,
    creating: false,
    createTitle: "",
    createColumnId: "c1",
    createBlocked: false,
    onClose: vi.fn(),
    onCreate: vi.fn(),
    onArchive: vi.fn(),
    onRestore: vi.fn(),
    onDeleteClick: vi.fn(),
    taskId: "t1",
  };

  it("disables archive/restore while a toggle is in flight", () => {
    const { rerender } = render(<TaskFooter {...props} archivePending={false} />);
    expect(screen.getByRole("button", { name: /archive/i })).toBeEnabled();

    rerender(<TaskFooter {...props} archivePending />);
    expect(screen.getByRole("button", { name: /archive/i })).toBeDisabled();
  });
});

describe("AssigneeChips suggestion click", () => {
  it("adds the clicked suggestion once, not the typed draft", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <AssigneeChips assignees={[]} availableAssignees={["Alice"]} placeholder="Add" onChange={onChange} />
    );

    await user.type(screen.getByPlaceholderText("Add"), "Ali");
    await user.click(screen.getByRole("button", { name: /alice/i }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(["Alice"]);
  });
});
