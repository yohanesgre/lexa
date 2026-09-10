// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

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
  return { board, listItem };
});

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
}));

vi.mock("../../lib/queries", () => ({
  useTasks: () => ({ board: fx.board, tasks: [fx.listItem], isLoading: false, error: null, refetch: vi.fn() }),
  useBoard: () => ({ data: fx.board }),
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
  it("resets search + dropdowns but preserves the sort key (tasks.html:234)", () => {
    render(<TasksPage slug="demo" search={{}} />);

    fireEvent.change(screen.getByLabelText("Sort order"), { target: { value: "priority" } });
    fireEvent.change(screen.getByLabelText("Search tasks"), { target: { value: "zzz" } });

    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));

    expect((screen.getByLabelText("Sort order") as HTMLSelectElement).value).toBe("priority");
    expect((screen.getByLabelText("Search tasks") as HTMLInputElement).value).toBe("");
  });
});
