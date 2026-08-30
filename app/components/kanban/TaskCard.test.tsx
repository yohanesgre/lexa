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
  project: { id: "p1", slug: "demo", key: "EG", name: "Demo", description: "", repos: [], createdAt: "t", updatedAt: "t" },
  columns: [{ id: "c1", projectId: "p1", name: "Todo", position: 0, color: "#888", wipLimit: null, requiredFields: [], githubState: null, isDone: false }],
  swimlanes: [{ id: "s1", projectId: "p1", name: "Backlog", description: "", position: 0, dueAt: null, archivedAt: null, startAt: null, milestoneId: null, kind: "backlog" }],
  milestones: [],
  fieldConfig: FIELD_OPTIONS,
  links: [],
  tasks: [],
};

const TASK: Task = {
  id: "t1", key: "EG-1", projectId: "p1", columnId: "c1", swimlaneId: "s1", title: "Task One",
  description: { type: "doc", content: [] }, priority: "pr-high", type: "tp-feature",
  assignees: ["Maria", "Joao", "Ana", "Pedro"], position: "a0", githubs: [
    { issueId: "ghi1", issueNumber: 7, repo: "owner/repo", syncedState: "open", url: "https://github.com/owner/repo/issues/7", outOfSync: false, pushFailed: false },
  ], dueAt: null, archivedAt: null, createdAt: "t", updatedAt: "t",
};

describe("TaskCard", () => {
  it("renders type label, title, and github issue chips", () => {
    render(<TaskCard {...TASK} taskKey={TASK.key} priorities={FIELD_OPTIONS.priorities} types={FIELD_OPTIONS.types} />);
    expect(screen.getByText("Feature")).toBeInTheDocument();
    expect(screen.getByText("Task One")).toBeInTheDocument();
    expect(screen.getByText("#7")).toBeInTheDocument();
    expect(screen.getByText("+1")).toBeInTheDocument(); // 4 assignees → overflow
  });
  it("renders the ticket key before the title", () => {
    const { container } = render(
      <TaskCard {...TASK} taskKey={TASK.key} priorities={FIELD_OPTIONS.priorities} types={FIELD_OPTIONS.types} />
    );
    const key = container.querySelector(".task-key");
    expect(key).not.toBeNull();
    expect(key!.textContent).toBe("EG-1");
    const title = container.querySelector(".card-title")!;
    expect(title.textContent!.indexOf("EG-1")).toBeLessThan(title.textContent!.indexOf("Task One"));
  });
});
