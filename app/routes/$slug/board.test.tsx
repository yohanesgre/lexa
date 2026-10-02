// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { QueryClient } from "@tanstack/react-query";
import { createFetchMock, createQueryWrapper, createTestQueryClient } from "../../test-utils";
import { BoardPage } from "../../components/kanban/BoardPage";
import { readBoardMilestone, writeBoardMilestone } from "../../lib/board-milestone-store";

const searchMock = vi.hoisted(() => ({ value: { task: undefined as string | undefined, milestone: undefined as string | undefined, swimlane: undefined as string | undefined } as { task?: string | undefined; milestone?: string | undefined; swimlane?: string | undefined } }));
const navigateMock = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => () => ({}),
  useNavigate: () => navigateMock,
  useParams: () => ({ slug: "demo" }),
  Link: ({ to, params, search, className, children }: any) => (
    <a href={`${to}`} className={className}>{children}</a>
  ),
}));

const { fetchMock, routes, mockFetch } = createFetchMock();

const MILESTONE = { id: "m1", projectId: "p1", name: "v1.0 launch", description: "", position: 0, dueAt: null, archivedAt: null, sprintCount: 1, archivedSprintCount: 0 };

// Local fixture (keyless project + task) — diverges from the shared makeBoard
// base, so it stays local to preserve the exact board the page receives.
function makeBoard() {
  return {
    project: { id: "p1", slug: "demo", name: "Demo", description: "", repos: [], createdAt: "t", updatedAt: "t" },
    columns: [{ id: "c1", projectId: "p1", name: "Todo", position: 0, color: "", wipLimit: null, requiredFields: [], githubState: null, isDone: false }],
    swimlanes: [
      { id: "s1", projectId: "p1", name: "Sprint 7", description: "", position: 0, dueAt: null, archivedAt: null, startAt: null, kind: "sprint", milestoneId: "m1" },
      { id: "s2", projectId: "p1", name: "Hack week", description: "", position: 1, dueAt: null, archivedAt: null, startAt: null, kind: "sprint", milestoneId: null },
      { id: "s9", projectId: "p1", name: "Backlog", description: "", position: 2, dueAt: null, archivedAt: null, startAt: null, kind: "backlog", milestoneId: null },
    ],
    milestones: [MILESTONE],
    fieldConfig: { priorities: [], types: [] },
    links: [],
    tasks: [
      { id: "t1", projectId: "p1", columnId: "c1", swimlaneId: "s1", title: "Sprint task", description: { type: "doc", content: [] }, priority: "p", type: "t", assignees: [], position: "a0", githubs: [], dueAt: null, archivedAt: null, createdAt: "t", updatedAt: "t" },
    ],
  };
}

let queryClient: QueryClient;
let wrapper: ReturnType<typeof createQueryWrapper>;

function BoardPageWrapper() {
  return <BoardPage slug="demo" search={searchMock.value} />;
}

beforeEach(() => {
  searchMock.value = { task: undefined, milestone: undefined, swimlane: undefined };
  navigateMock.mockReset();
  window.sessionStorage.clear();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  routes.clear();
  mockFetch();
  routes.set("GET /api/projects/demo/board", makeBoard());
  routes.set("GET /api/projects/demo/swimlanes", { data: makeBoard().swimlanes });
  queryClient = createTestQueryClient();
  wrapper = createQueryWrapper(queryClient);
});

afterEach(() => {
  vi.unstubAllGlobals();
  queryClient.clear();
});

describe("board milestone selection", () => {
  it("defaults to the first non-archived milestone (sprints visible)", async () => {
    render(<BoardPageWrapper />, { wrapper });
    expect(await screen.findByText("Sprint 7")).toBeInTheDocument();
    expect(screen.queryByText("Hack week")).not.toBeInTheDocument();
    expect(screen.getByText("Backlog")).toBeInTheDocument();
  });

  it("selecting No milestone writes the sentinel and shows loose sprints + Backlog", async () => {
    const user = userEvent.setup();
    const view = render(<BoardPageWrapper />, { wrapper });
    await screen.findByText("Sprint 7");
    await user.click(document.querySelector(".ms-selector-trigger")!);
    await user.click(screen.getByText("No milestone"));
    expect(navigateMock).toHaveBeenCalledWith(expect.objectContaining({ search: { milestone: "none" } }));
    // simulate the navigate side effect: the param lands in the URL
    searchMock.value = { task: undefined, milestone: "none" };
    view.rerender(<BoardPageWrapper />);
    expect(await screen.findByText("Hack week")).toBeInTheDocument();
    expect(screen.queryByText("Sprint 7")).not.toBeInTheDocument();
    expect(screen.getByText("Backlog")).toBeInTheDocument();
  });

  it("reload with ?milestone=none keeps the loose-sprint choice (no fallback to active milestone)", async () => {
    searchMock.value = { task: undefined, milestone: "none" };
    render(<BoardPageWrapper />, { wrapper });
    expect(await screen.findByText("Hack week")).toBeInTheDocument();
    expect(screen.queryByText("Sprint 7")).not.toBeInTheDocument();
  });

  it("remembers the selection across navigation when the URL param is gone", async () => {
    const user = userEvent.setup();
    const view = render(<BoardPageWrapper />, { wrapper });
    await screen.findByText("Sprint 7");
    await user.click(document.querySelector(".ms-selector-trigger")!);
    await user.click(screen.getByText("No milestone"));
    expect(readBoardMilestone("demo")).toBe("none");
    searchMock.value = { task: undefined, milestone: undefined };
    view.rerender(<BoardPageWrapper />);
    expect(await screen.findByText("Hack week")).toBeInTheDocument();
    expect(screen.queryByText("Sprint 7")).not.toBeInTheDocument();
  });

  it("persists a milestone URL param for the next visit", async () => {
    searchMock.value = { task: undefined, milestone: "none" };
    const view = render(<BoardPageWrapper />, { wrapper });
    await screen.findByText("Hack week");
    view.unmount();
    searchMock.value = { task: undefined, milestone: undefined };
    render(<BoardPageWrapper />, { wrapper });
    expect(await screen.findByText("Hack week")).toBeInTheDocument();
    expect(screen.queryByText("Sprint 7")).not.toBeInTheDocument();
  });

  it("ignores a stored milestone id that is not in the list", async () => {
    writeBoardMilestone("demo", "ghost");
    render(<BoardPageWrapper />, { wrapper });
    expect(await screen.findByText("Sprint 7")).toBeInTheDocument();
    expect(screen.queryByText("Hack week")).not.toBeInTheDocument();
  });

  it("does not leak a stored milestone across projects", async () => {
    writeBoardMilestone("other", "none");
    render(<BoardPageWrapper />, { wrapper });
    expect(await screen.findByText("Sprint 7")).toBeInTheDocument();
  });

  it("a milestone change preserves the existing task and swimlane params", async () => {
    const user = userEvent.setup();
    searchMock.value = { task: "t1", milestone: undefined, swimlane: "s1" };
    render(<BoardPageWrapper />, { wrapper });
    await screen.findAllByText("Sprint task");
    await user.click(document.querySelector(".ms-selector-trigger")!);
    await user.click(screen.getByText("No milestone"));
    expect(navigateMock).toHaveBeenCalledWith(
      expect.objectContaining({ search: { task: "t1", swimlane: "s1", milestone: "none" } })
    );
  });

  it("empty ?milestone= falls back to the active milestone and is not persisted", async () => {
    searchMock.value = { task: undefined, milestone: "", swimlane: undefined };
    render(<BoardPageWrapper />, { wrapper });
    expect(await screen.findByText("Sprint 7")).toBeInTheDocument();
    expect(screen.queryByText("Hack week")).not.toBeInTheDocument();
    expect(readBoardMilestone("demo")).toBeNull();
  });
});

describe("board card actions", () => {
  it("card menu Delete calls the delete endpoint", async () => {
    const user = userEvent.setup();
    routes.set("DELETE /api/projects/demo/tasks/t1", 204);
    render(<BoardPageWrapper />, { wrapper });
    await screen.findByText("Sprint task");
    await user.click(document.querySelector('.icon-btn[title="Card menu"]')!);
    await user.click(await screen.findByText("Delete"));
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/projects/demo/tasks/t1"),
      expect.objectContaining({ method: "DELETE" })
    );
  });

  it("marks the card matching ?task as selected", async () => {
    searchMock.value = { task: "t1", milestone: undefined };
    render(<BoardPageWrapper />, { wrapper });
    await screen.findAllByText("Sprint task");
    expect(document.querySelector(".kanban-card.state-selected")).not.toBeNull();
  });
});
