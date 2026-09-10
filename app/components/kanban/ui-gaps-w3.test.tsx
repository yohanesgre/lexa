// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Board, Column, FieldOption } from "../../../shared/types";
import { TaskCard } from "./TaskCard";
import { ColumnForm } from "./ColumnForm";
import { ColumnsSettingsSection } from "./ColumnsSettingsSection";
import { OptionSettingsSection } from "./OptionSettingsSection";
import { FilterButton } from "./BoardFilters";
import { emptyFilters } from "../../lib/filters";

const PRIORITIES: FieldOption[] = [{ id: "p1", label: "Low", color: "#6B6560", position: 0 }];
const TYPES: FieldOption[] = [{ id: "ty1", label: "Task", color: "#22D3EE", position: 0 }];

describe("TaskCard archived tag", () => {
  it("renders the Archived tag on archived cards", () => {
    render(
      <TaskCard
        id="t1"
        taskKey="EG-23"
        title="Retire old weather system"
        priority="p1"
        type="ty1"
        priorities={PRIORITIES}
        types={TYPES}
        assignees={["Jules D"]}
        githubs={[]}
        archived
      />
    );
    expect(screen.getByText("Archived")).toBeInTheDocument();
  });

  it("omits the Archived tag on live cards", () => {
    render(
      <TaskCard
        id="t1"
        taskKey="EG-23"
        title="Retire old weather system"
        priority="p1"
        type="ty1"
        priorities={PRIORITIES}
        types={TYPES}
        assignees={[]}
        githubs={[]}
      />
    );
    expect(screen.queryByText("Archived")).not.toBeInTheDocument();
  });
});

const COLUMN: Column = {
  id: "c1",
  projectId: "p1",
  name: "In Progress",
  position: 0,
  color: "#F0C040",
  wipLimit: 4,
  requiredFields: ["title"],
  githubState: "open",
  isDone: false,
};

describe("ColumnForm", () => {
  it("orders required fields Title, Description, Assignee", () => {
    render(
      <ColumnForm slug="demo" column={COLUMN} isOpen onClose={vi.fn()} onSubmit={vi.fn()} />
    );
    const rows = Array.from(document.querySelectorAll(".check-row")).slice(0, 3);
    expect(rows.map((r) => r.textContent)).toEqual(["Title", "Description", "Assignee"]);
  });

  it("edit mode renders Delete Column in the footer and calls onDelete", async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    render(
      <ColumnForm slug="demo" column={COLUMN} isOpen onClose={vi.fn()} onDelete={onDelete} onSubmit={vi.fn()} />
    );
    await user.click(screen.getByRole("button", { name: /delete column/i }));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("create mode has no Delete Column footer action", () => {
    render(<ColumnForm slug="demo" column={null} isOpen onClose={vi.fn()} onDelete={vi.fn()} onSubmit={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /delete column/i })).not.toBeInTheDocument();
  });
});

describe("ColumnsSettingsSection", () => {
  it("shows color names and zero-padded WIP limits", () => {
    const green: Column = { ...COLUMN, id: "c2", name: "Done", color: "#4ADE80", wipLimit: null };
    const none: Column = { ...COLUMN, id: "c3", name: "Backlog", color: null as unknown as string, wipLimit: 10 };
    render(
      <ColumnsSettingsSection
        columns={[COLUMN, green, none]}
        sensors={[]}
        onDragEnd={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onAdd={vi.fn()}
      />
    );
    expect(screen.getByText("Amber")).toBeInTheDocument();
    expect(screen.getByText("004")).toBeInTheDocument();
    expect(screen.getAllByText("None").length).toBeGreaterThan(0);
    expect(screen.getByText("Green")).toBeInTheDocument();
    expect(screen.getByText("010")).toBeInTheDocument();
  });
});

describe("OptionSettingsSection in-use guard", () => {
  const options: FieldOption[] = [{ id: "p1", label: "Urgent", color: "#FF4444", position: 0 }];

  it("disables delete when the option is used by tasks", async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    render(
      <OptionSettingsSection
        kind="priority"
        title="Priorities"
        description="desc"
        options={options}
        sensors={[]}
        onDragEnd={vi.fn()}
        onEdit={vi.fn()}
        onDelete={onDelete}
        onAdd={vi.fn()}
        inUseIds={new Set(["p1"])}
      />
    );
    const del = screen.getByRole("button", { name: /delete priority/i });
    expect(del).toBeDisabled();
    await user.click(del);
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("allows delete when the option is unused", () => {
    render(
      <OptionSettingsSection
        kind="priority"
        title="Priorities"
        description="desc"
        options={options}
        sensors={[]}
        onDragEnd={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onAdd={vi.fn()}
        inUseIds={new Set()}
      />
    );
    expect(screen.getByRole("button", { name: /delete priority/i })).toBeEnabled();
  });
});

const BOARD = {
  project: {},
  columns: [],
  swimlanes: [],
  milestones: [],
  fieldConfig: { priorities: [], types: [] },
  links: [],
  tasks: [
    { id: "t1", assignees: ["Mara K"] },
    { id: "t2", assignees: ["Jules D"] },
    { id: "t3", assignees: [] },
  ],
} as unknown as Board;

describe("BoardFilters assignee rows", () => {
  it("shows display names with 2-letter avatars and no Unassigned row", async () => {
    const user = userEvent.setup();
    render(<FilterButton board={BOARD} filters={emptyFilters()} onChange={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: /filter/i }));

    expect(screen.getByText("Mara K")).toBeInTheDocument();
    expect(screen.getByText("MK")).toBeInTheDocument();
    expect(screen.getByText("Jules D")).toBeInTheDocument();
    expect(screen.getByText("JD")).toBeInTheDocument();
    expect(screen.queryByText("Unassigned")).not.toBeInTheDocument();
  });
});
