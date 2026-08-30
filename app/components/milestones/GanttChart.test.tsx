// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi, beforeAll } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { GanttChart, type TimelineLane } from "./GanttChart";
import { DAY_WIDTH_PX } from "../../lib/gantt";
import type { Milestone, Swimlane } from "../../../shared/types";

// jsdom lacks ResizeObserver; GanttChart uses it to measure the container
// width for fill-to-width range extension. In tests the width is 0 → data
// range only.
beforeAll(() => {
  class RO {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as any).ResizeObserver = RO;
});

const TODAY = "2026-08-13";

function lane(id: string, startAt: string | null, dueAt: string | null, milestoneId: string | null = null, done = 0, total = 0): TimelineLane {
  const l: Swimlane = { id, projectId: "p1", name: id, description: "", position: 0, dueAt, archivedAt: null, startAt, kind: "sprint", milestoneId };
  return { lane: l, done, total };
}

const MILESTONES: Milestone[] = [
  { id: "m1", projectId: "p1", name: "v1.0 launch", description: "", position: 0, dueAt: "2026-09-21", archivedAt: null, sprintCount: 2, archivedSprintCount: 1 },
];

const PROPS = {
  lanes: [
    lane("s1", "2026-08-04", "2026-08-25", "m1", 8, 12),
    lane("s2", "2026-07-14", "2026-08-01", "m1", 12, 12),
    lane("s3", "2026-08-03", null, null, 3, 6),
    lane("s4", null, "2026-09-04", null),
    lane("s5", null, null, null),
    { lane: { id: "s9", projectId: "p1", name: "Backlog", description: "", position: 9, dueAt: null, archivedAt: null, startAt: null, kind: "backlog" as const, milestoneId: null }, done: 0, total: 0 },
  ],
  milestones: MILESTONES,
  today: TODAY,
  onRescheduleLane: vi.fn(),
  onRescheduleMilestone: vi.fn(),
  onOpenBoard: vi.fn(),
  onShowMilestoneList: vi.fn(),
};

describe("GanttChart", () => {
  it("renders milestone group rows, sprint bars, loose group, backlog caption, today line", () => {
    render(<GanttChart {...PROPS} />);
    expect(screen.getByText("v1.0 launch")).toBeInTheDocument();
    expect(screen.getByText("1/2 sprints archived")).toBeInTheDocument();
    // name renders in the left column and as the in-bar chip
    expect(screen.getAllByText("s1")).toHaveLength(2);
    expect(screen.getByText("Loose sprints")).toBeInTheDocument();
    expect(screen.getByText("Backlog")).toBeInTheDocument();
    // The "Today" shortcut button (when today is off-screen in the test's 0-width
    // wrap) plus the today line label both render the word "Today".
    expect(screen.getAllByText("Today").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Milestone / Sprint")).toBeInTheDocument();
  });
  it("positions the bar at the day-accurate x and fills done/total", () => {
    render(<GanttChart {...PROPS} />);
    // day-aligned range: earliest item start 07-14 → from = 07-14 − 4 = 07-10
    const s2bar = screen.getByTitle(/s2/).closest(".tl-bar")! as HTMLElement;
    expect(s2bar.style.left).toBe(`${4 * DAY_WIDTH_PX}px`); // Jul 14 is 4 days after Jul 10
    // Jul 14 → Aug 1 = 18 intervals + 1 (end-day column included) = 19 columns
    expect(s2bar.style.width).toBe(`${19 * DAY_WIDTH_PX}px`);
    const fill = s2bar.querySelector(".tl-fill")! as HTMLElement;
    expect(fill.style.width).toBe("100%");
  });
});
