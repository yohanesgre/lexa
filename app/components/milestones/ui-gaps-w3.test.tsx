// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { Board, Milestone, Task } from "../../../shared/types";

const navigate = vi.hoisted(() => vi.fn());

vi.mock("../../lib/queries", () => ({
  useBoard: vi.fn(),
  useMilestones: vi.fn(),
  useCreateMilestone: () => ({ mutate: vi.fn() }),
  useUpdateMilestone: () => ({ mutate: vi.fn() }),
  useDeleteMilestone: () => ({ mutate: vi.fn() }),
  useArchiveMilestone: () => ({ mutate: vi.fn() }),
  useRestoreMilestone: () => ({ mutate: vi.fn() }),
  useSession: vi.fn(),
  useUpdateSwimlane: () => ({ mutate: vi.fn() }),
  useDeleteSwimlane: () => ({ mutate: vi.fn() }),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
  Link: ({ children, className }: { children?: ReactNode; className?: string }) => <a className={className}>{children}</a>,
}));

import { useBoard, useMilestones, useSession } from "../../lib/queries";
import { MilestonesPage } from "./MilestonesPage";
import { TimelineTab } from "./TimelineTab";
import { MilestoneForm } from "./MilestoneForm";

const useBoardMock = vi.mocked(useBoard);
const useMilestonesMock = vi.mocked(useMilestones);
const useSessionMock = vi.mocked(useSession);

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});
afterAll(() => vi.unstubAllGlobals());

const MILESTONES: Milestone[] = [
  { id: "m1", projectId: "p1", name: "v1.0 launch", description: "", position: 0, dueAt: "2026-09-21", archivedAt: null, sprintCount: 2, archivedSprintCount: 0 },
  { id: "m2", projectId: "p1", name: "Beta milestone", description: "", position: 1, dueAt: null, archivedAt: null, sprintCount: 1, archivedSprintCount: 0 },
  { id: "m3", projectId: "p1", name: "Beta 2", description: "", position: 2, dueAt: null, archivedAt: null, sprintCount: 0, archivedSprintCount: 0 },
  { id: "m4", projectId: "p1", name: "Prototype", description: "", position: 3, dueAt: "2026-06-30", archivedAt: "2026-07-01", sprintCount: 1, archivedSprintCount: 1 },
];

function tasksFor(laneId: string, count: number): Task[] {
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
    archivedAt: null,
    createdAt: "t",
    updatedAt: "t",
  }));
}

function makeBoard(): Board {
  return {
    project: { id: "p1", slug: "demo", name: "Demo", key: "DEMO", description: "", repos: [], createdAt: "t", updatedAt: "t" },
    columns: [],
    swimlanes: [
      { id: "s1", projectId: "p1", name: "Sprint 7 — Core", description: "", position: 0, dueAt: "2026-08-21", startAt: "2026-08-18", archivedAt: null, kind: "sprint", milestoneId: "m1" },
      { id: "s2", projectId: "p1", name: "Sprint 6 — Ash & Bone", description: "", position: 1, dueAt: null, startAt: null, archivedAt: null, kind: "sprint", milestoneId: "m1" },
      { id: "s3", projectId: "p1", name: "Sprint 3 — UI kit", description: "", position: 2, dueAt: null, startAt: null, archivedAt: null, kind: "sprint", milestoneId: "m2" },
      { id: "s5", projectId: "p1", name: "Backlog", description: "", position: 3, dueAt: null, startAt: null, archivedAt: null, kind: "backlog", milestoneId: null },
    ],
    milestones: MILESTONES,
    fieldConfig: { priorities: [], types: [] },
    links: [],
    tasks: [...tasksFor("s1", 12), ...tasksFor("s2", 12), ...tasksFor("s3", 1)],
  };
}

function seedListMocks() {
  useBoardMock.mockReturnValue({ data: makeBoard() } as unknown as ReturnType<typeof useBoard>);
  useMilestonesMock.mockReturnValue({ data: MILESTONES, isLoading: false, error: null, refetch: vi.fn() } as unknown as ReturnType<typeof useMilestones>);
  useSessionMock.mockReturnValue({ data: { user: { role: "superadmin" } } } as unknown as ReturnType<typeof useSession>);
}

beforeEach(() => {
  vi.clearAllMocks();
  seedListMocks();
});

function cardFor(name: string): HTMLElement {
  return screen.getByText(name).closest(".milestone-card") as HTMLElement;
}

describe("MilestonesPage active badge + due pill", () => {
  it("renders the Active badge on every live milestone", () => {
    render(<MilestonesPage slug="demo" tab="list" />);
    expect(screen.getAllByText("Active")).toHaveLength(3);
    expect(within(cardFor("Prototype")).queryByText("Active")).not.toBeInTheDocument();
  });

  it("renders a muted no-due-date pill when a milestone has no due date", () => {
    render(<MilestonesPage slug="demo" tab="list" />);
    expect(screen.getAllByText("no due date")).toHaveLength(2);
    expect(within(cardFor("v1.0 launch")).queryByText("no due date")).not.toBeInTheDocument();
  });
});

describe("Complete milestone confirm", () => {
  it("names the remaining sprints and the live-task split", async () => {
    const user = userEvent.setup();
    render(<MilestonesPage slug="demo" tab="list" />);
    await user.click(within(cardFor("v1.0 launch")).getByRole("button", { name: /complete milestone/i }));
    const dialog = document.querySelector("dialog") as HTMLElement;
    expect(dialog).toHaveTextContent(/2 remaining sprints — Sprint 7 — Core and Sprint 6 — Ash & Bone — plus their 24 live tasks \(12 \+ 12, none archived yet\)/);
  });
});

describe("MilestoneForm delete footer", () => {
  const base = { id: "m3", projectId: "p1", name: "Beta 2", description: "", position: 0, dueAt: null, archivedAt: null, sprintCount: 0, archivedSprintCount: 0 } as Milestone;

  it("shows Delete Milestone on edit when no sprints are attached", async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    render(<MilestoneForm slug="demo" milestone={base} isOpen onClose={vi.fn()} onDelete={onDelete} onSubmit={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: /delete milestone/i }));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("hides Delete Milestone when sprints are attached", () => {
    render(
      <MilestoneForm slug="demo" milestone={{ ...base, sprintCount: 2 }} isOpen onClose={vi.fn()} onDelete={vi.fn()} onSubmit={vi.fn()} />
    );
    expect(screen.queryByRole("button", { name: /delete milestone/i })).not.toBeInTheDocument();
  });

  it("hides Delete Milestone in create mode", () => {
    render(<MilestoneForm slug="demo" milestone={null} isOpen onClose={vi.fn()} onDelete={vi.fn()} onSubmit={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /delete milestone/i })).not.toBeInTheDocument();
  });
});

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe("TimelineTab sprint bar tooltip + navigation", () => {
  it("shows title / date+done / milestone on hover and opens the board with the lane", async () => {
    const user = userEvent.setup();
    const board = makeBoard();
    const { container } = render(<TimelineTab slug="demo" board={board} milestones={MILESTONES} />, { wrapper });

    const bar = container.querySelector(".tl-bar") as HTMLElement;
    expect(bar).toBeTruthy();
    await user.hover(bar);

    const tooltip = container.querySelector(".tl-tooltip") as HTMLElement;
    expect(tooltip).toBeTruthy();
    expect(tooltip.querySelector(".tt-title")).toHaveTextContent("Sprint 7 — Core");
    const lines = tooltip.querySelectorAll(".tt-line");
    expect(lines[0]).toHaveTextContent("Aug 18 → Aug 21 · 0/12 done");
    expect(lines[1]).toHaveTextContent("Milestone: v1.0 launch");

    await user.click(bar);
    expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ to: "/$slug/board", search: { swimlane: "s1" } }));
  });
});
