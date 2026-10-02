// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import type { Board, Column, FieldOption, Milestone, Swimlane } from "../../../shared/types";
import { MilestoneSelector } from "./MilestoneSelector";
import { TaskCard } from "./TaskCard";
import { ColumnForm } from "./ColumnForm";
import { ColumnsSettingsSection } from "./ColumnsSettingsSection";
import { OptionSettingsSection } from "./OptionSettingsSection";
import { FilterButton } from "./BoardFilters";
import { BoardToolbar } from "./BoardToolbar";
import { SwimlaneHeader } from "./SwimlaneHeader";
import { SwimlaneForm } from "./SwimlaneForm";
import { emptyFilters } from "../../lib/filters";

const restoreMutate = vi.hoisted(() => vi.fn());

vi.mock("../../lib/queries", () => ({
  useUpdateSwimlane: () => ({ mutate: vi.fn() }),
  useDeleteSwimlane: () => ({ mutate: vi.fn() }),
  useCreateColumn: () => ({ mutate: vi.fn() }),
  useArchiveSwimlane: () => ({ mutate: vi.fn() }),
  useRestoreSwimlane: () => ({ mutate: restoreMutate }),
  useMilestones: () => ({ data: [] }),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, className }: { children?: ReactNode; className?: string }) => (
    <a className={className}>{children}</a>
  ),
}));

const PRIORITIES: FieldOption[] = [{ id: "p1", label: "Low", color: "#6B6560", position: 0 }];
const TYPES: FieldOption[] = [{ id: "ty1", label: "Task", color: "#22D3EE", position: 0 }];
const W4_PRIORITIES: FieldOption[] = [{ id: "pr1", label: "High", color: "#F0C040", position: 0 }];
const W4_TYPES: FieldOption[] = [{ id: "ty1", label: "Feature", color: "#4ADE80", position: 0 }];

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

  it("uses a check leading icon on Save Changes (edit mode)", () => {
    render(<ColumnForm slug="demo" column={COLUMN} isOpen onClose={vi.fn()} onSubmit={vi.fn()} />);
    const svg = screen.getByRole("button", { name: /save changes/i }).querySelector("svg");
    expect(svg?.innerHTML).toContain("M20 6 9 17l-5-5");
  });

  it("keeps the plus icon on Create Column (create mode)", () => {
    render(<ColumnForm slug="demo" column={null} isOpen onClose={vi.fn()} onSubmit={vi.fn()} />);
    const svg = screen.getByRole("button", { name: /create column/i }).querySelector("svg");
    expect(svg?.innerHTML).toContain("M12 5v14");
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

  it("renders Columns as an h2", () => {
    render(
      <ColumnsSettingsSection columns={[]} sensors={[]} onDragEnd={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()} onAdd={vi.fn()} />
    );
    expect(screen.getByRole("heading", { level: 2, name: "Columns" })).toBeInTheDocument();
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

  it("renders Priorities as an h2", () => {
    render(
      <OptionSettingsSection
        kind="priority"
        title="Priorities"
        description="desc"
        options={[]}
        sensors={[]}
        onDragEnd={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onAdd={vi.fn()}
      />
    );
    expect(screen.getByRole("heading", { level: 2, name: "Priorities" })).toBeInTheDocument();
  });
});

describe("TaskCard type badge", () => {
  it("uses the documented type-* class for canonical type colors", () => {
    render(
      <TaskCard
        id="t1"
        taskKey="EG-1"
        title="Double jump"
        priority="pr1"
        type="ty1"
        priorities={W4_PRIORITIES}
        types={W4_TYPES}
        assignees={[]}
        githubs={[]}
      />
    );
    const badge = screen.getByText("Feature");
    expect(badge).toHaveClass("type-badge", "type-feature");
    expect(badge).not.toHaveAttribute("style");
  });

  it("falls back to inline color for non-canonical type colors", () => {
    const custom: FieldOption[] = [{ id: "ty2", label: "Chore", color: "#B8B2AB", position: 0 }];
    render(
      <TaskCard
        id="t1"
        taskKey="EG-1"
        title="Custom task"
        priority="pr1"
        type="ty2"
        priorities={W4_PRIORITIES}
        types={custom}
        assignees={[]}
        githubs={[]}
      />
    );
    const badge = screen.getByText("Chore");
    expect(badge.className).not.toMatch(/type-feature|type-bug|type-task|type-asset/);
    expect(badge).toHaveStyle({ color: "#B8B2AB" });
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

const BOARD_WITH_COLUMN = {
  project: { id: "p1", name: "Nimbus" },
  columns: [{ id: "c1", projectId: "p1", name: "Backlog", position: 0, color: null, wipLimit: null, requiredFields: [], githubState: null, isDone: false }],
  swimlanes: [],
  milestones: [],
  fieldConfig: { priorities: [], types: [] },
  links: [],
  tasks: [],
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

describe("BoardFilters Backlog column dot", () => {
  it("renders a hollow ring for a column with no color", async () => {
    const user = userEvent.setup();
    render(<FilterButton board={BOARD_WITH_COLUMN} filters={emptyFilters()} onChange={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: /filter/i }));
    const dot = screen.getByText("Backlog").previousElementSibling as HTMLElement;
    expect(dot).toHaveClass("priority-dot");
    expect(dot.style.background).toBe("transparent");
    expect(dot.style.border).toContain("2px solid");
  });
});

describe("BoardToolbar subtitle", () => {
  it("renders the Kanban tagline next to the project name", () => {
    render(
      <BoardToolbar
        board={BOARD_WITH_COLUMN}
        showArchived={false}
        filters={emptyFilters()}
        onToggleArchived={vi.fn()}
        onFiltersChange={vi.fn()}
        onOpenSettings={vi.fn()}
      />
    );
    expect(screen.getByText("Kanban — the heart of Lexa")).toBeInTheDocument();
  });
});

const ARCHIVED_LANE: Swimlane = {
  id: "s1",
  projectId: "p1",
  name: "Demo 0",
  description: "",
  position: 0,
  dueAt: null,
  startAt: null,
  archivedAt: "2026-01-01T00:00:00.000Z",
  kind: "sprint",
  milestoneId: null,
  tasksDone: 0,
  tasksTotal: 0,
};

describe("SwimlaneHeader archived lane", () => {
  it("shows a direct Restore button that restores the lane", async () => {
    const user = userEvent.setup();
    restoreMutate.mockClear();
    render(<SwimlaneHeader slug="demo" lane={ARCHIVED_LANE} count={6} />);

    await user.click(screen.getByRole("button", { name: "Restore" }));
    expect(restoreMutate).toHaveBeenCalledWith({ id: "s1" });
  });

  it("does not show the direct Restore button on a live lane", () => {
    render(<SwimlaneHeader slug="demo" lane={{ ...ARCHIVED_LANE, archivedAt: null }} count={6} />);
    expect(screen.queryByRole("button", { name: "Restore" })).not.toBeInTheDocument();
  });
});

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

describe("SwimlaneForm delete", () => {
  it("edit mode calls onDelete with the swimlane instead of closing", async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    const onClose = vi.fn();
    const onSubmit = vi.fn();

    render(
      <SwimlaneForm
        slug="demo"
        swimlane={LANE}
        isOpen
        onClose={onClose}
        onDelete={onDelete}
        onSubmit={onSubmit}
      />
    );

    await user.click(screen.getByRole("button", { name: /delete swimlane/i }));

    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledWith(LANE);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("create mode has no delete button", () => {
    render(
      <SwimlaneForm
        slug="demo"
        swimlane={null}
        isOpen
        onClose={vi.fn()}
        onDelete={vi.fn()}
        onSubmit={vi.fn()}
      />
    );

    expect(screen.queryByRole("button", { name: /delete swimlane/i })).not.toBeInTheDocument();
  });
});

const SELECTOR_MILESTONES: Milestone[] = [
  { id: "m1", projectId: "p1", name: "v1.0 launch", description: "", position: 0, dueAt: null, archivedAt: null, sprintCount: 4, archivedSprintCount: 2, tasksDone: 0, tasksTotal: 0 },
  { id: "m2", projectId: "p1", name: "Beta milestone", description: "", position: 1, dueAt: null, archivedAt: null, sprintCount: 3, archivedSprintCount: 1, tasksDone: 0, tasksTotal: 0 },
];

describe("MilestoneSelector light-dismiss", () => {
  function detailsOf(container: HTMLElement): HTMLDetailsElement {
    return container.querySelector(".ms-selector-details") as HTMLDetailsElement;
  }

  it("closes on outside click", async () => {
    const user = userEvent.setup();
    const { container } = render(<MilestoneSelector milestones={SELECTOR_MILESTONES} value="m1" onChange={vi.fn()} slug="demo" />);

    await user.click(screen.getByTitle("Filter board by milestone"));
    expect(detailsOf(container).open).toBe(true);

    await user.click(document.body);
    expect(detailsOf(container).open).toBe(false);
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    const { container } = render(<MilestoneSelector milestones={SELECTOR_MILESTONES} value="m1" onChange={vi.fn()} slug="demo" />);

    await user.click(screen.getByTitle("Filter board by milestone"));
    expect(detailsOf(container).open).toBe(true);

    await user.keyboard("{Escape}");
    expect(detailsOf(container).open).toBe(false);
  });

  it("restores focus to the summary on Escape", async () => {
    const user = userEvent.setup();
    const { container } = render(<MilestoneSelector milestones={SELECTOR_MILESTONES} value="m1" onChange={vi.fn()} slug="demo" />);

    const summary = screen.getByTitle("Filter board by milestone");
    await user.click(summary);
    expect(detailsOf(container).open).toBe(true);

    await user.keyboard("{Escape}");
    expect(document.activeElement).toBe(summary);
  });

  it("selecting an option calls onChange and closes", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { container } = render(<MilestoneSelector milestones={SELECTOR_MILESTONES} value="m1" onChange={onChange} slug="demo" />);

    await user.click(screen.getByTitle("Filter board by milestone"));
    expect(detailsOf(container).open).toBe(true);

    await user.click(screen.getByRole("button", { name: /no milestone/i }));

    expect(onChange).toHaveBeenCalledWith(null);
    expect(detailsOf(container).open).toBe(false);
  });

  it("keeps the selected milestone label and navigation link", async () => {
    const user = userEvent.setup();
    render(<MilestoneSelector milestones={SELECTOR_MILESTONES} value="m2" onChange={vi.fn()} slug="demo" />);

    expect(screen.getByTitle("Filter board by milestone").textContent).toContain("Beta milestone");

    await user.click(screen.getByTitle("Filter board by milestone"));
    expect(screen.getByText("Manage milestones")).toBeInTheDocument();
  });
});
