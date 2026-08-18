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
    expect(screen.getByText("Today")).toBeInTheDocument();
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

  it("renders start/end range guidelines from the day header to each sprint's own row bottom", () => {
    const { container } = render(<GanttChart {...PROPS} />);
    const canvas = container.querySelector(".tl-canvas")!;
    const guides = canvas.querySelectorAll(".tl-guideline");
    // s1 + s2 (both have start+due) → 2 edges each; start-only/due-only contribute none
    expect(guides).toHaveLength(4);
    // aligned with s2's bar edges, offset by the label column (bars live in
    // .tl-lane after the 264px label; canvas-level guidelines add LABEL_W)
    const s2bar = screen.getByTitle(/s2/).closest(".tl-bar")! as HTMLElement;
    const barLeft = parseFloat(s2bar.style.left);
    const barRight = barLeft + parseFloat(s2bar.style.width);
    const xs = [...guides].map((g) => parseFloat((g as HTMLElement).style.left)).sort((a, b) => a - b);
    expect(xs).toContain(barLeft + 264);
    expect(xs).toContain(barRight + 264);
    // top reaches the day-number header row: canvas-relative −22 (64px header − 42px year+month rows)
    for (const g of guides) {
      expect((g as HTMLElement).style.top).toBe("-22px");
    }
    // bottoms are per-sprint: s1 (first sprint row) hangs lower than s2 (second)
    const bottoms = [...guides].map((g) => parseFloat((g as HTMLElement).style.bottom));
    expect(bottoms[0]).toBe(bottoms[1]); // s1's start/end pair
    expect(bottoms[2]).toBe(bottoms[3]); // s2's pair
    expect(bottoms[0]).toBeGreaterThan(bottoms[2]);
    // no guidelines inside lanes — they live at the canvas level
    for (const lane of canvas.querySelectorAll(".tl-lane")) {
      expect(lane.querySelectorAll(".tl-guideline")).toHaveLength(0);
    }
  });

  it("renders a start-only bar and a due-only marker; unset lane absent from canvas", () => {
    render(<GanttChart {...PROPS} />);
    const startOnly = screen.getByTitle(/Start only/);
    expect(startOnly).toBeInTheDocument();
    const dueOnly = screen.getByTitle(/End only/);
    expect(dueOnly).toHaveClass("tl-marker");
    expect(dueOnly.textContent).toContain("Ends");
    // s5 (no dates) is not in the canvas — UNSET section handled by TimelineTab
    expect(screen.queryByText("s5")).not.toBeInTheDocument();
  });

  it("clicks a bar open the board via onOpenBoard", () => {
    render(<GanttChart {...PROPS} />);
    const bar = screen.getByTitle(/s1/).closest(".tl-bar")! as HTMLElement;
    fireEvent.pointerDown(bar, { clientX: 100 });
    fireEvent.pointerUp(bar);
    fireEvent.click(bar);
    expect(PROPS.onOpenBoard).toHaveBeenCalledWith("s1");
  });

  it("drags the bar body and commits shifted dates via onRescheduleLane", () => {
    const onRescheduleLane = vi.fn();
    render(<GanttChart {...PROPS} onRescheduleLane={onRescheduleLane} />);
    const bar = screen.getByTitle(/s1/).closest(".tl-bar")! as HTMLElement;
    const rect = { left: 0 };
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ ...rect, right: 0, top: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.pointerDown(bar, { clientX: 100 });
    // +5 days → shift both dates
    fireEvent.pointerMove(bar, { clientX: 100 + 5 * DAY_WIDTH_PX });
    fireEvent.pointerUp(bar);
    expect(onRescheduleLane).toHaveBeenCalledWith("s1", { startAt: "2026-08-09", dueAt: "2026-08-30" });
    vi.restoreAllMocks();
  });

  it("sub-3px movement is a click, not a drag — no commit", () => {
    const onRescheduleLane = vi.fn();
    render(<GanttChart {...PROPS} onRescheduleLane={onRescheduleLane} />);
    const bar = screen.getByTitle(/s1/).closest(".tl-bar")! as HTMLElement;
    fireEvent.pointerDown(bar, { clientX: 100 });
    fireEvent.pointerMove(bar, { clientX: 102 });
    fireEvent.pointerUp(bar);
    expect(onRescheduleLane).not.toHaveBeenCalled();
  });

  it("resize via right edge changes dueAt only and clamps start < due", () => {
    const onRescheduleLane = vi.fn();
    render(<GanttChart {...PROPS} onRescheduleLane={onRescheduleLane} />);
    const bar = screen.getByTitle(/s1/).closest(".tl-bar")! as HTMLElement;
    const edge = bar.querySelector(".tl-resize-edge")! as HTMLElement;
    fireEvent.pointerDown(edge, { clientX: 400 });
    // drag way left — due clamps to start+1 day
    fireEvent.pointerMove(edge, { clientX: 200 });
    fireEvent.pointerUp(edge);
    expect(onRescheduleLane).toHaveBeenCalledWith("s1", { startAt: "2026-08-04", dueAt: "2026-08-05" });
  });
});
