// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Board, FieldOption } from "../../../shared/types";
import { TaskCard } from "./TaskCard";
import { ColumnForm } from "./ColumnForm";
import { ColumnsSettingsSection } from "./ColumnsSettingsSection";
import { OptionSettingsSection } from "./OptionSettingsSection";
import { FilterButton } from "./BoardFilters";
import { BoardToolbar } from "./BoardToolbar";
import { emptyFilters } from "../../lib/filters";

const PRIORITIES: FieldOption[] = [{ id: "pr1", label: "High", color: "#F0C040", position: 0 }];
const TYPES: FieldOption[] = [{ id: "ty1", label: "Feature", color: "#4ADE80", position: 0 }];

describe("TaskCard type badge", () => {
  it("uses the documented type-* class for canonical type colors", () => {
    render(
      <TaskCard
        id="t1"
        taskKey="EG-1"
        title="Double jump"
        priority="pr1"
        type="ty1"
        priorities={PRIORITIES}
        types={TYPES}
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
        priorities={PRIORITIES}
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

describe("ColumnForm save icon", () => {
  const COLUMN = {
    id: "c1",
    projectId: "p1",
    name: "In Progress",
    position: 0,
    color: "#F0C040",
    wipLimit: 4,
    requiredFields: ["title"],
    githubState: "open" as const,
    isDone: false,
  };

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

describe("settings section headings", () => {
  it("Columns renders as an h2", () => {
    render(
      <ColumnsSettingsSection columns={[]} sensors={[]} onDragEnd={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()} onAdd={vi.fn()} />
    );
    expect(screen.getByRole("heading", { level: 2, name: "Columns" })).toBeInTheDocument();
  });

  it("Priorities renders as an h2", () => {
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

const BOARD = {
  project: { id: "p1", name: "Nimbus" },
  columns: [{ id: "c1", projectId: "p1", name: "Backlog", position: 0, color: null, wipLimit: null, requiredFields: [], githubState: null, isDone: false }],
  swimlanes: [],
  milestones: [],
  fieldConfig: { priorities: [], types: [] },
  links: [],
  tasks: [],
} as unknown as Board;

describe("BoardFilters Backlog column dot", () => {
  it("renders a hollow ring for a column with no color", async () => {
    const user = userEvent.setup();
    render(<FilterButton board={BOARD} filters={emptyFilters()} onChange={vi.fn()} />);
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
        board={BOARD}
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
