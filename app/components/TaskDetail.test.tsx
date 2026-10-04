// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { QueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { Board, Milestone, Swimlane, Task } from "../../shared/types";
import { createQueryWrapper, createTestQueryClient, json } from "../test-utils";
import { TaskDetail } from "./TaskDetail";

const navigateMock = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => () => ({}),
  useNavigate: () => navigateMock,
  useParams: () => ({ slug: "demo" }),
  Link: ({ children, className }: { children: ReactNode; className?: string }) => <a className={className}>{children}</a>,
}));

const fetchMock = vi.fn();

const TASK: Task = {
  id: "t1",
  key: "EG-18",
  projectId: "p1",
  columnId: "c1",
  swimlaneId: "sp1",
  title: "Crash on large board load",
  description: { type: "doc", content: [] },
  priority: "pr1",
  type: "tp1",
  assignees: [],
  position: "a0",
  githubs: [],
  dueAt: null,
  archivedAt: null,
  createdAt: "t",
  updatedAt: "t",
};

function lane(overrides: Partial<Swimlane>): Swimlane {
  return {
    id: "sp",
    projectId: "p1",
    name: "Sprint 6",
    description: "",
    position: 0,
    dueAt: null,
    archivedAt: null,
    startAt: null,
    kind: "sprint",
    milestoneId: null,
    tasksDone: 0,
    tasksTotal: 0,
    ...overrides,
  };
}

function milestone(overrides: Partial<Milestone>): Milestone {
  return {
    id: "m1",
    projectId: "p1",
    name: "v1.0",
    description: "",
    position: 0,
    dueAt: null,
    archivedAt: null,
    sprintCount: 1,
    archivedSprintCount: 0,
    tasksDone: 0,
    tasksTotal: 0,
    ...overrides,
  };
}

let queryClient: QueryClient;
let wrapper: ReturnType<typeof createQueryWrapper>;

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  fetchMock.mockImplementation(() => Promise.resolve(json({ data: [] })));
  navigateMock.mockReset();
  queryClient = createTestQueryClient();
  wrapper = createQueryWrapper(queryClient);
});

afterEach(() => {
  vi.unstubAllGlobals();
  queryClient.clear();
});

function renderDetail(overrides: Partial<Parameters<typeof TaskDetail>[0]> = {}) {
  return render(
    <TaskDetail
      mode="view"
      from="board"
      task={TASK}
      columns={[]}
      swimlanes={[]}
      fieldConfig={{ priorities: [], types: [] }}
      onClose={vi.fn()}
      onUpdate={vi.fn()}
      {...overrides}
    />,
    { wrapper }
  );
}

describe("TaskDetail expand", () => {
  it("navigates to the full page with the ticket key and origin", () => {
    const { container } = renderDetail();
    const dialog = container.querySelector("dialog.slideover");
    expect(dialog).not.toBeNull();
    expect(dialog!.classList.contains("task-detail-panel")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Open full page" }));
    expect(navigateMock).toHaveBeenCalledWith({
      to: "/$slug/tasks/$taskId",
      params: { slug: "demo", taskId: "EG-18" },
      search: { from: "board" },
    });
  });

  it("hides expand in create mode", () => {
    renderDetail({ mode: "create" });
    expect(screen.queryByRole("button", { name: "Open full page" })).not.toBeInTheDocument();
  });

  it("uses the wiki-style editor in the slideover", async () => {
    const { container } = renderDetail();
    const prose = container.querySelector(".td-prose");
    expect(prose).not.toBeNull();
    fireEvent.doubleClick(prose!);
    expect(await screen.findByText("Editing description")).toBeInTheDocument();
    const editorWrapper = container.querySelector(".editor-wrapper");
    expect(editorWrapper).not.toBeNull();
    expect(editorWrapper!.querySelector(".editor-toolbar")).not.toBeNull();
  });
});

describe("TaskDetail swimlane labels", () => {
  it("disambiguates same-name lanes in the view dropdown by milestone", () => {
    renderDetail({
      swimlanes: [
        lane({ id: "sp1", name: "Sprint 6", milestoneId: "m1" }),
        lane({ id: "sp2", name: "Sprint 6", milestoneId: null }),
      ],
      milestones: [milestone({ id: "m1", name: "v1.0" })],
    });

    fireEvent.click(screen.getByRole("button", { name: "Sprint 6" }));
    expect(screen.getByRole("button", { name: "Sprint 6 - v1.0" })).toBeInTheDocument();
    expect(screen.getAllByText("Sprint 6")).toHaveLength(2);
  });

  it("labels create-mode options and falls back to bare names", () => {
    renderDetail({
      mode: "create",
      task: undefined,
      showCreateSwimlane: true,
      defaultSwimlaneId: "sp1",
      swimlanes: [
        lane({ id: "sp1", name: "Sprint 6", milestoneId: "m1" }),
        lane({ id: "sp2", name: "Sprint 6", milestoneId: "missing" }),
        lane({ id: "sp3", name: "Sprint 7", milestoneId: "m2" }),
      ],
      milestones: [
        milestone({ id: "m1", name: "v1.0" }),
        milestone({ id: "m2", name: "v2.0", archivedAt: "2026-01-01" }),
      ],
    });

    expect(screen.getByRole("option", { name: "Sprint 6 - v1.0" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Sprint 6" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Sprint 7 - v2.0 (archived)" })).toBeInTheDocument();
  });
});

function boardTask(id: string, columnId: string, position: string): Task {
  return { ...TASK, id, key: id, columnId, position };
}

const MID_TASK: Task = boardTask("t1", "c1", "a1");

function laneBoard(overrides: Partial<Swimlane>[] = []): Board {
  return {
    project: { id: "p1", slug: "demo", name: "Demo", description: "", repos: [], createdAt: "t", updatedAt: "t" },
    columns: [
      { id: "c1", projectId: "p1", name: "Todo", position: 0, color: "", wipLimit: null, requiredFields: [], githubState: null, isDone: false },
      { id: "c2", projectId: "p1", name: "Doing", position: 1, color: "", wipLimit: null, requiredFields: [], githubState: null, isDone: false },
    ],
    swimlanes: [
      lane({ id: "sp1", name: "Sprint 6" }),
      lane({ id: "sp2", name: "Sprint 7" }),
      ...overrides,
    ],
    milestones: [],
    fieldConfig: { priorities: [], types: [] },
    links: [],
    tasks: [
      boardTask("b0", "c1", "a0"),
      MID_TASK,
      boardTask("b2", "c1", "a2"),
    ],
  } as unknown as Board;
}

describe("TaskDetail lane-only move anchors", () => {
  it("injects same-column neighbors for a lane-only move", () => {
    const onMove = vi.fn().mockResolvedValue(undefined);
    queryClient.setQueryData<Board>(["board", "demo", false], laneBoard());
    renderDetail({
      task: MID_TASK,
      onMove,
      columns: [{ id: "c1", name: "Todo" }, { id: "c2", name: "Doing" }],
      swimlanes: [lane({ id: "sp1", name: "Sprint 6" }), lane({ id: "sp2", name: "Sprint 7" })],
    });

    fireEvent.click(screen.getByRole("button", { name: "Sprint 6" }));
    fireEvent.click(screen.getByRole("button", { name: "Sprint 7" }));

    expect(onMove).toHaveBeenCalledWith("t1", {
      columnId: "c1",
      swimlaneId: "sp2",
      beforeTaskId: "b0",
      afterTaskId: "b2",
    });
  });

  it("falls back to the boardTasks prop when no board cache is present", () => {
    const onMove = vi.fn().mockResolvedValue(undefined);
    queryClient.clear();
    renderDetail({
      task: MID_TASK,
      boardTasks: laneBoard().tasks,
      onMove,
      columns: [{ id: "c1", name: "Todo" }, { id: "c2", name: "Doing" }],
      swimlanes: [lane({ id: "sp1", name: "Sprint 6" }), lane({ id: "sp2", name: "Sprint 7" })],
    });

    fireEvent.click(screen.getByRole("button", { name: "Sprint 6" }));
    fireEvent.click(screen.getByRole("button", { name: "Sprint 7" }));

    expect(onMove).toHaveBeenCalledWith("t1", {
      columnId: "c1",
      swimlaneId: "sp2",
      beforeTaskId: "b0",
      afterTaskId: "b2",
    });
  });

  it("sends no anchors for a column move", () => {
    const onMove = vi.fn().mockResolvedValue(undefined);
    queryClient.setQueryData<Board>(["board", "demo", false], laneBoard());
    renderDetail({
      task: MID_TASK,
      onMove,
      columns: [{ id: "c1", name: "Todo" }, { id: "c2", name: "Doing" }],
      swimlanes: [lane({ id: "sp1", name: "Sprint 6" }), lane({ id: "sp2", name: "Sprint 7" })],
    });

    fireEvent.click(screen.getByRole("button", { name: "Todo" }));
    fireEvent.click(screen.getByRole("button", { name: "Doing" }));

    expect(onMove).toHaveBeenCalledWith("t1", { columnId: "c2", swimlaneId: "sp1" });
  });
});
