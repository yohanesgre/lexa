// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const navigateMock = vi.hoisted(() => vi.fn());

const fx = vi.hoisted(() => {
  const task = {
    id: "t1",
    key: "EG-1",
    projectId: "p1",
    columnId: "c1",
    swimlaneId: "s1",
    title: "Crash on large board load",
    description: { type: "doc", content: [] },
    priority: "pr1",
    type: "tp1",
    assignees: [] as string[],
    position: "a0",
    githubs: [],
    dueAt: null,
    archivedAt: null,
    createdAt: "2026-05-13T00:00:00.000Z",
    updatedAt: "2026-05-13T00:00:00.000Z",
  };
  const listItem = {
    id: "t1",
    key: "EG-1",
    title: "Crash on large board load",
    priorityId: "pr1",
    priorityLabel: "High",
    priorityColor: "#f00",
    typeId: "tp1",
    typeLabel: "Bug",
    typeColor: "#0f0",
    columnId: "c1",
    columnName: "Todo",
    columnColor: "#00f",
    swimlaneId: "s1",
    swimlaneName: "Backlog",
    assignees: [] as string[],
    githubNumber: null,
    archivedAt: null,
    createdAt: "2026-05-13T00:00:00.000Z",
    updatedAt: "2026-05-13T00:00:00.000Z",
  };
  const board = {
    project: { id: "p1", name: "Nimbus" },
    columns: [],
    swimlanes: [],
    milestones: [],
    fieldConfig: { priorities: [], types: [] },
    links: [],
    tasks: [task],
  };
  return { board, listItem, state: { mode: "loaded" as "loaded" | "loading" | "error" } };
});

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
}));

vi.mock("../../lib/queries", () => ({
  useTasks: () => {
    if (fx.state.mode === "loading") {
      return { board: undefined, tasks: undefined, isLoading: true, error: null, refetch: vi.fn() };
    }
    if (fx.state.mode === "error") {
      return { board: undefined, tasks: undefined, isLoading: false, error: new Error("boom"), refetch: vi.fn() };
    }
    return { board: fx.board, tasks: [fx.listItem], isLoading: false, error: null, refetch: vi.fn() };
  },
  useBoard: () => ({ data: fx.state.mode === "loaded" ? fx.board : undefined }),
  useTask: () => ({ data: undefined }),
  useMoveTask: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
  useUpdateTask: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
  useDeleteTask: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
  useArchiveTask: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
  useRestoreTask: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
  useLinkGithubIssue: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
  useUnlinkGithubIssue: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
}));

vi.mock("../TaskDetail", () => ({ TaskDetail: () => null }));
vi.mock("../ui/Toast", () => ({ useToast: () => ({ push: vi.fn() }) }));

import { TasksPage } from "./TasksPage";

describe("TasksPage Clear filters", () => {
  afterEach(() => {
    cleanup();
    fx.state.mode = "loaded";
  });

  it("resets search + dropdowns but preserves the sort key (tasks.html:234)", () => {
    fx.state.mode = "loaded";
    render(<TasksPage slug="demo" search={{}} />);

    fireEvent.change(screen.getByLabelText("Sort order"), { target: { value: "priority" } });
    fireEvent.change(screen.getByLabelText("Search tasks"), { target: { value: "zzz" } });

    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));

    expect((screen.getByLabelText("Sort order") as HTMLSelectElement).value).toBe("priority");
    expect((screen.getByLabelText("Search tasks") as HTMLInputElement).value).toBe("");
  });
});

describe("TasksPage loading skeleton", () => {
  afterEach(() => {
    cleanup();
    fx.state.mode = "loaded";
  });

  it("includes the filter bar and the wireframe row widths", () => {
    fx.state.mode = "loading";
    render(<TasksPage slug="demo" search={{}} />);

    expect(document.querySelector(".tasks-page .tasks-filter")).not.toBeNull();
    const widths = Array.from(document.querySelectorAll(".tasks-list .card-row .skeleton")).map(
      (el) => (el as HTMLElement).style.width
    );
    expect(widths).toEqual(["55%", "49%", "58%", "43%", "52%"]);
  });
});

describe("TasksPage load error", () => {
  afterEach(() => {
    cleanup();
    fx.state.mode = "loaded";
  });

  it("renders the Network error copy, never the empty state", () => {
    fx.state.mode = "error";
    render(<TasksPage slug="demo" search={{}} />);

    expect(screen.getByText("Failed to load tasks")).toBeInTheDocument();
    expect(screen.getByText("Network error")).toBeInTheDocument();
    expect(document.querySelector(".tasks-error-sub")?.textContent).toContain("the board query failed to load");
    expect(screen.queryByText("No tasks yet")).not.toBeInTheDocument();
  });
});
