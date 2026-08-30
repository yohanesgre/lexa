// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FilterButton, ActiveFilterBar } from "./BoardFilters";
import { emptyFilters, type FilterState } from "../../lib/filters";
import type { Board } from "../../../shared/types";

const BOARD: Board = {
  project: { id: "p1", slug: "demo", key: "EG", name: "Demo", description: "", repos: [], createdAt: "t", updatedAt: "t" },
  columns: [
    { id: "c1", projectId: "p1", name: "Todo", position: 0, color: "#888", wipLimit: null, requiredFields: [], githubState: null, isDone: false },
    { id: "c2", projectId: "p1", name: "Done", position: 1, color: "#888", wipLimit: null, requiredFields: [], githubState: null, isDone: false },
  ],
  swimlanes: [{ id: "s1", projectId: "p1", name: "Backlog", description: "", position: 0, dueAt: null, archivedAt: null, startAt: null, milestoneId: null, kind: "backlog" }],
  milestones: [],
  fieldConfig: {
    priorities: [{ id: "pr-high", label: "High", color: "#FF4444", position: 0 }, { id: "pr-low", label: "Low", color: "#6B6560", position: 1 }],
    types: [{ id: "tp-feature", label: "Feature", color: "#4ADE80", position: 0 }, { id: "tp-bug", label: "Bug", color: "#FF4444", position: 1 }],
  },
  links: [],
  tasks: [
    { id: "t1", key: "EG-1", projectId: "p1", columnId: "c1", swimlaneId: "s1", title: "T1", description: { type: "doc", content: [] }, priority: "pr-high", type: "tp-feature", assignees: ["Maria"], position: "a0", githubs: [], dueAt: null, archivedAt: null, createdAt: "t", updatedAt: "t" },
    { id: "t2", key: "EG-1", projectId: "p1", columnId: "c2", swimlaneId: "s1", title: "T2", description: { type: "doc", content: [] }, priority: "pr-low", type: "tp-bug", assignees: [], position: "a1", githubs: [], dueAt: null, archivedAt: null, createdAt: "t", updatedAt: "t" },
  ],
};

describe("FilterButton", () => {
  it("shows no badge when inactive and opens the popover on click", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<FilterButton board={BOARD} filters={emptyFilters()} onChange={onChange} />);
    expect(screen.getByRole("button", { name: /Filter/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Filter/ }));
    expect(screen.getByText("Column")).toBeInTheDocument();
    expect(screen.getByText("Priority")).toBeInTheDocument();
    expect(screen.getByText("Type")).toBeInTheDocument();
    expect(screen.getByText("Assignee")).toBeInTheDocument();
    expect(screen.getByText("Swimlane")).toBeInTheDocument();
  });
  it("toggling a column filter calls onChange with the updated FilterState", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<FilterButton board={BOARD} filters={emptyFilters()} onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: /Filter/ }));
    await user.click(await screen.findByRole("button", { name: /Todo/ }));
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0]![0] as FilterState;
    expect(Array.from(next.columns)).toEqual(["c1"]);
    expect(next.priorities.size).toBe(0);
  });
});
