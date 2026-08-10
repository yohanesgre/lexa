// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import { TaskCard } from "./TaskCard";
import { SortableTaskCard } from "./SortableTaskCard";
import type { Board, Task } from "../../../shared/types";

const FIELD_OPTIONS = {
  priorities: [
    { id: "pr-high", label: "High", color: "#FF4444", position: 0 },
    { id: "pr-low", label: "Low", color: "#6B6560", position: 1 },
  ],
  types: [
    { id: "tp-feature", label: "Feature", color: "#4ADE80", position: 0 },
    { id: "tp-bug", label: "Bug", color: "#FF4444", position: 1 },
  ],
};

const BOARD: Board = {
  project: { id: "p1", slug: "demo", name: "Demo", description: "", githubRepo: null, createdAt: "t", updatedAt: "t" },
  columns: [{ id: "c1", projectId: "p1", name: "Todo", position: 0, color: "#888", wipLimit: null, requiredFields: [], githubState: null }],
  swimlanes: [{ id: "s1", projectId: "p1", name: "Backlog", description: "", position: 0, dueAt: null, archivedAt: null, kind: "backlog" }],
  fieldConfig: FIELD_OPTIONS,
  links: [],
  tasks: [],
};

const TASK: Task = {
  id: "t1", projectId: "p1", columnId: "c1", swimlaneId: "s1", title: "Task One",
  description: { type: "doc", content: [] }, priority: "pr-high", type: "tp-feature",
  assignees: ["Maria", "Joao", "Ana", "Pedro"], position: "a0", githubs: [
    { issueId: "ghi1", issueNumber: 7, repo: "owner/repo", syncedState: "open", url: "https://github.com/owner/repo/issues/7", outOfSync: false },
  ], dueAt: null, archivedAt: null, createdAt: "t", updatedAt: "t",
};

describe("TaskCard", () => {
  it("renders type label, title, and github issue chips", () => {
    render(<TaskCard {...TASK} priorities={FIELD_OPTIONS.priorities} types={FIELD_OPTIONS.types} />);
    expect(screen.getByText("Feature")).toBeInTheDocument();
    expect(screen.getByText("Task One")).toBeInTheDocument();
    expect(screen.getByText("#7")).toBeInTheDocument();
    expect(screen.getByText("+1")).toBeInTheDocument(); // 4 assignees → overflow
  });

  it("marks an overdue due date with the overdue style", () => {
    const { container } = render(
      <TaskCard {...TASK} dueAt="2000-01-01" priorities={FIELD_OPTIONS.priorities} types={FIELD_OPTIONS.types} />
    );
    expect(screen.getByText(/Overdue/)).toBeInTheDocument();
    expect(container.querySelector(".card-due-overdue")).not.toBeNull();
  });

  it("shows the diverged sync dot when a linked issue is out of sync", () => {
    const { container } = render(
      <TaskCard
        {...TASK}
        priorities={FIELD_OPTIONS.priorities}
        types={FIELD_OPTIONS.types}
        githubs={[{ ...TASK.githubs[0]!, outOfSync: true }]}
      />
    );
    expect(screen.getByTitle("Out of sync with GitHub")).toBeInTheDocument();
    expect(container.querySelector(".sync-diverged")).not.toBeNull();
  });

  it("renders the blocked-by tooltip when blockers are present", () => {
    render(<TaskCard {...TASK} priorities={FIELD_OPTIONS.priorities} types={FIELD_OPTIONS.types} blockedBy={["Blocker Task"]} />);
    expect(screen.getByTitle("Blocked by: Blocker Task")).toBeInTheDocument();
  });
});

describe("SortableTaskCard", () => {
  function renderCard(overrides: Partial<Parameters<typeof SortableTaskCard>[0]> = {}) {
    const onSelect = vi.fn();
    const onArchive = vi.fn();
    const onDelete = vi.fn();
    render(
      <DndContext>
        <SortableTaskCard
          task={TASK}
          board={BOARD}
          onSelect={onSelect}
          dimmed={false}
          onArchive={onArchive}
          onRestore={vi.fn()}
          onDelete={onDelete}
          {...overrides}
        />
      </DndContext>
    );
    return { onSelect, onArchive, onDelete };
  }

  it("clicking the card selects the task", () => {
    const { onSelect } = renderCard();
    // fireEvent, not user-event: with dnd-kit's sortable listeners attached,
    // user-event's pointer sequence never reaches the React onClick in jsdom
    // (fireEvent.click dispatches a bare click, which dnd-kit leaves alone).
    fireEvent.click(screen.getByRole("button", { name: "Open task Task One" }));
    expect(onSelect).toHaveBeenCalledWith(TASK);
  });

  it("archived tasks are not selectable", () => {
    const { onSelect } = renderCard({ task: { ...TASK, archivedAt: "2026-03-01T00:00:00.000Z" } });
    fireEvent.click(screen.getByRole("button", { name: "Open task Task One" }));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("card menu archive action calls onArchive with the task id", () => {
    const { onArchive } = renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Card menu" }));
    const archive = screen.getAllByRole("button").find((b) => b.textContent === "Archive");
    expect(archive).toBeDefined();
    fireEvent.click(archive!);
    expect(onArchive).toHaveBeenCalledWith("t1");
  });

  it("card menu delete action calls onDelete with the task id", () => {
    const { onDelete } = renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Card menu" }));
    const del = screen.getAllByRole("button").find((b) => b.textContent === "Delete");
    expect(del).toBeDefined();
    fireEvent.click(del!);
    expect(onDelete).toHaveBeenCalledWith("t1");
  });

  it("archived cards offer Restore instead of Archive", () => {
    const onRestore = vi.fn();
    render(
      <DndContext>
        <SortableTaskCard
          task={{ ...TASK, archivedAt: "2026-03-01T00:00:00.000Z" }}
          board={BOARD}
          dimmed={false}
          onArchive={vi.fn()}
          onRestore={onRestore}
          onDelete={vi.fn()}
        />
      </DndContext>
    );
    fireEvent.click(screen.getByRole("button", { name: "Card menu" }));
    const restore = screen.getAllByRole("button").find((b) => b.textContent === "Restore");
    expect(restore).toBeDefined();
    fireEvent.click(restore!);
    expect(onRestore).toHaveBeenCalledWith("t1");
  });
});
