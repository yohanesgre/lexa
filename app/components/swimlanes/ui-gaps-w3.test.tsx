// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import type { Board, Swimlane, Task } from "../../../shared/types";

const h = vi.hoisted(() => ({ milestones: [] as unknown[] }));

vi.mock("../../lib/queries", () => ({
  useBoard: vi.fn(),
  useMilestones: () => ({ data: h.milestones }),
  useUpdateSwimlane: () => ({ mutate: vi.fn() }),
  useDeleteSwimlane: () => ({ mutate: vi.fn() }),
  useArchiveSwimlane: () => ({ mutate: vi.fn() }),
  useRestoreSwimlane: () => ({ mutate: vi.fn() }),
  useCreateSwimlane: () => ({ mutate: vi.fn() }),
  useSession: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, className }: { children?: ReactNode; className?: string }) => <a className={className}>{children}</a>,
}));

import { useBoard, useSession } from "../../lib/queries";
import { SwimlanesPage } from "./SwimlanesPage";
import { DeleteSwimlaneDialog } from "./DeleteSwimlaneDialog";

const useBoardMock = vi.mocked(useBoard);
const useSessionMock = vi.mocked(useSession);

const LANE: Swimlane = { id: "s1", projectId: "p1", name: "Sprint 5 — Audio pass", description: "", position: 0, dueAt: null, startAt: null, archivedAt: "2026-07-22", kind: "sprint", milestoneId: null };

function archivedTasks(laneId: string, count: number): Task[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${laneId}-t${i}`,
    key: `DEMO-${i}`,
    projectId: "p1",
    columnId: "c1",
    swimlaneId: laneId,
    title: `Task ${i}`,
    description: { type: "doc", content: [] },
    priority: "p",
    type: "t",
    assignees: [],
    position: `a${i}`,
    githubs: [],
    dueAt: null,
    archivedAt: "2026-07-22",
    createdAt: "t",
    updatedAt: "t",
  }));
}

function makeBoard(): Board {
  return {
    project: { id: "p1", slug: "demo", name: "Demo", key: "DEMO", description: "", repos: [], createdAt: "t", updatedAt: "t" },
    columns: [],
    swimlanes: [
      LANE,
      { id: "s2", projectId: "p1", name: "Sprint 4 — Save system", description: "", position: 1, dueAt: null, startAt: null, archivedAt: "2026-07-22", kind: "sprint", milestoneId: null },
    ],
    milestones: [],
    fieldConfig: { priorities: [], types: [] },
    links: [],
    tasks: archivedTasks(LANE.id, 9),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.milestones = [];
  useBoardMock.mockReturnValue({ data: makeBoard(), isLoading: false, error: null, refetch: vi.fn() } as unknown as ReturnType<typeof useBoard>);
  useSessionMock.mockReturnValue({ data: { user: { role: "superadmin" } } } as unknown as ReturnType<typeof useSession>);
});

function laneRow(name: string): HTMLElement {
  return screen.getByText(name).closest(".sl-row") as HTMLElement;
}

describe("SwimlanesPage archived lane progress", () => {
  it("keeps the progress pill on archived lanes without the ready-to-archive emphasis", () => {
    render(<SwimlanesPage slug="demo" />);
    const row = laneRow("Sprint 5 — Audio pass");
    expect(within(row).getByText("9/9 done")).toBeInTheDocument();
    expect(within(row).queryByText("Ready to archive")).not.toBeInTheDocument();
  });
});

describe("SwimlanesPage delete gating", () => {
  it("disables Delete for a lane with tasks and enables it for an empty lane", () => {
    render(<SwimlanesPage slug="demo" />);
    expect(within(laneRow("Sprint 5 — Audio pass")).getByRole("button", { name: /delete/i })).toBeDisabled();
    expect(within(laneRow("Sprint 4 — Save system")).getByRole("button", { name: /delete/i })).toBeEnabled();
  });
});

describe("SwimlanesPage archived-only state", () => {
  it("renders archived lanes in the dimmed lower section, not inside milestone groups", async () => {
    const user = userEvent.setup();
    h.milestones = [{ id: "m1", name: "v1.0 launch", dueAt: null, archivedAt: null, sprintCount: 1, archivedSprintCount: 1 }];
    const board = makeBoard();
    useBoardMock.mockReturnValue({
      data: { ...board, swimlanes: [{ ...LANE, milestoneId: "m1" }], milestones: h.milestones },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useBoard>);

    render(<SwimlanesPage slug="demo" />);
    await user.selectOptions(screen.getByLabelText("State filter"), "archived");

    const row = laneRow("Sprint 5 — Audio pass");
    expect(row.closest(".tasks-state-block")).toBeTruthy();
    expect(row.closest(".sl-group")).toBeNull();
  });
});

describe("DeleteSwimlaneDialog copy", () => {
  it("describes an empty lane", () => {
    render(<DeleteSwimlaneDialog target={LANE} taskCount={0} onClose={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.getByText(/has no tasks/i)).toBeInTheDocument();
    expect(screen.queryByText(/will unassign/i)).not.toBeInTheDocument();
  });

  it("explains that a lane with tasks must be emptied first", () => {
    render(<DeleteSwimlaneDialog target={LANE} taskCount={3} onClose={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.getByText(/3 tasks\. Reassign them to another swimlane first/i)).toBeInTheDocument();
  });
});
