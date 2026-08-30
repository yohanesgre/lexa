// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MilestoneCard } from "./MilestoneCard";
import type { Board, Milestone } from "../../../shared/types";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, params, search, className, children }: any) => (
    <a href={`${to}`} className={className}>{children}</a>
  ),
}));

const MILESTONE: Milestone = { id: "m1", projectId: "p1", name: "v1.0 launch", description: "", position: 0, dueAt: "2026-09-21", archivedAt: null, sprintCount: 4, archivedSprintCount: 2 };

function makeBoard(): Board {
  return {
    project: { id: "p1", slug: "demo", key: "EG", name: "Demo", description: "", repos: [], createdAt: "t", updatedAt: "t" },
    columns: [{ id: "c1", projectId: "p1", name: "Todo", position: 0, color: "", wipLimit: null, requiredFields: [], githubState: null, isDone: false }],
    swimlanes: [{ id: "s1", projectId: "p1", name: "Sprint 7", description: "", position: 0, dueAt: null, archivedAt: null, startAt: null, kind: "sprint", milestoneId: "m1" }],
    milestones: [MILESTONE],
    fieldConfig: { priorities: [], types: [] },
    links: [],
    tasks: [
      { id: "t1", key: "EG-1", projectId: "p1", columnId: "c1", swimlaneId: "s1", title: "T1", description: { type: "doc", content: [] }, priority: "p", type: "t", assignees: [], position: "a0", githubs: [], dueAt: null, archivedAt: null, createdAt: "t", updatedAt: "t" },
      { id: "t2", key: "EG-1", projectId: "p1", columnId: "c1", swimlaneId: "s1", title: "T2", description: { type: "doc", content: [] }, priority: "p", type: "t", assignees: [], position: "a1", githubs: [], dueAt: null, archivedAt: "2026-01-01", createdAt: "t", updatedAt: "t" },
    ],
  };
}

describe("MilestoneCard", () => {
  it("renders name, progress bars, due chip, and Manage link", () => {
    render(<MilestoneCard slug="demo" milestone={MILESTONE} board={makeBoard()} />);
    expect(screen.getByText("Active milestone")).toBeInTheDocument();
    expect(screen.getByText("v1.0 launch")).toBeInTheDocument();
    expect(screen.getByText("Sprints 2/4 archived")).toBeInTheDocument();
    expect(screen.getByText("Tasks 1/2 done")).toBeInTheDocument(); // t2 archived counts
    expect(screen.getByText("Due Sep 21")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Manage milestones" })).toHaveAttribute("href", "/$slug/milestones");
  });
  it("shows the overdue chip in danger styling", () => {
    render(<MilestoneCard slug="demo" milestone={{ ...MILESTONE, dueAt: "2020-01-01" }} board={makeBoard()} />);
    expect(screen.getByText(/Overdue/)).toBeInTheDocument();
    expect(screen.getByText(/Overdue/).className).toContain("milestone-due-overdue");
  });
});
