// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const navigateMock = vi.hoisted(() => vi.fn());
const toastPush = vi.hoisted(() => vi.fn());
const bulkMutateAsync = vi.hoisted(() => vi.fn());
const createMutateAsync = vi.hoisted(() => vi.fn());
const detailProps = vi.hoisted(() => ({
  current: null as null | { mode?: string; onCreate?: (input: unknown) => Promise<void> },
}));

const fx = vi.hoisted(() => {
  function rawTask(id: string, key: string, title: string, overrides: Record<string, unknown> = {}) {
    return {
      id,
      key,
      projectId: "p1",
      columnId: "c1",
      swimlaneId: "s1",
      title,
      description: "",
      priority: "pr1",
      type: "tp1",
      assignees: [] as string[],
      position: `a${id}`,
      githubs: [],
      dueAt: null,
      archivedAt: null,
      createdAt: "2026-05-13T00:00:00.000Z",
      updatedAt: "2026-05-13T00:00:00.000Z",
      ...overrides,
    };
  }
  function listItem(id: string, key: string, title: string) {
    return {
      id,
      key,
      title,
      priorityId: "pr1",
      priorityLabel: "Urgent",
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
  }
  const board = {
    project: { id: "p1", name: "Nimbus" },
    columns: [
      { id: "c1", projectId: "p1", name: "Todo", position: 0, color: "#00f", wipLimit: null, requiredFields: [], githubState: null, isDone: false },
      { id: "c2", projectId: "p1", name: "Doing", position: 1, color: "#0ff", wipLimit: null, requiredFields: [], githubState: null, isDone: false },
    ],
    swimlanes: [
      { id: "s1", projectId: "p1", name: "Backlog", description: "", position: 0, dueAt: null, archivedAt: null, startAt: null, kind: "backlog", milestoneId: null },
      { id: "s2", projectId: "p1", name: "Sprint 1", description: "", position: 1, dueAt: null, archivedAt: null, startAt: null, kind: "sprint", milestoneId: null },
    ],
    milestones: [],
    fieldConfig: {
      priorities: [
        { id: "pr1", label: "Urgent", color: "#f00", position: 0 },
        { id: "pr2", label: "High", color: "#f80", position: 1 },
      ],
      types: [{ id: "tp1", label: "Bug", color: "#0f0", position: 0 }],
    },
    links: [],
    tasks: [rawTask("t1", "EG-1", "First task"), rawTask("t2", "EG-2", "Second task"), rawTask("t3", "EG-3", "Third task")],
  };
  const list = [listItem("t1", "EG-1", "First task"), listItem("t2", "EG-2", "Second task"), listItem("t3", "EG-3", "Third task")];
  const archivedList = list.map((t) => ({ ...t, archivedAt: "2026-05-01T00:00:00.000Z" }));
  return {
    board,
    list,
    archivedList,
    origList: list,
    makeListItem: listItem,
    caps: { assistant: false, flavor: "bun", tasksBulk: true } as { assistant: boolean; flavor: string; tasksBulk?: boolean },
  };
});

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
}));

vi.mock("../../lib/queries", () => ({
  useTasks: (_slug: string, showArchived?: boolean) => ({
    board: fx.board,
    tasks: showArchived ? fx.archivedList : fx.list,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
  useBoard: () => ({ data: fx.board }),
  useCapabilities: () => ({ data: fx.caps, isFetched: true }),
  useTask: () => ({ data: undefined }),
  useCreateTask: () => ({ mutate: vi.fn(), mutateAsync: createMutateAsync }),
  useMoveTask: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
  useUpdateTask: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
  useDeleteTask: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
  useArchiveTask: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
  useRestoreTask: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
  useLinkGithubIssue: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
  useUnlinkGithubIssue: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
  useBulkTaskAction: () => ({ mutate: vi.fn(), mutateAsync: bulkMutateAsync, isPending: false }),
}));

vi.mock("../TaskDetail", () => ({
  TaskDetail: (props: { mode?: string; onCreate?: (input: unknown) => Promise<void> }) => {
    detailProps.current = props;
    return <div data-testid="task-detail" data-mode={props.mode} />;
  },
}));
vi.mock("../ui/Toast", () => ({ useToast: () => ({ push: toastPush, dismiss: vi.fn() }) }));

import { TasksPage } from "./TasksPage";

function countText(): string | null {
  return document.querySelector(".tasks-selection-count")?.textContent ?? null;
}

async function selectTwo() {
  fireEvent.click(screen.getByRole("checkbox", { name: "Select EG-1 First task" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Select EG-2 Second task" }));
}

function clickMenuItem(trigger: string, item: string) {
  fireEvent.click(screen.getByRole("button", { name: trigger }));
  fireEvent.click(screen.getByRole("menuitem", { name: item }));
}

afterEach(() => {
  cleanup();
  fx.list = fx.origList;
  fx.board.tasks[0]!.assignees = [];
});

describe("TasksPage bulk actions", () => {
  beforeEach(() => {
    navigateMock.mockClear();
    toastPush.mockClear();
    bulkMutateAsync.mockReset();
    fx.caps = { assistant: false, flavor: "bun", tasksBulk: true };
  });

  it("hides selection controls when the capability is off, and keeps only the failed rows selected with the server reason", async () => {
    fx.caps = { assistant: false, flavor: "bun", tasksBulk: false };
    render(<TasksPage slug="demo" search={{}} />);
    expect(document.querySelector(".task-selectbox")).toBeNull();
    expect(document.querySelector(".tasks-list-head")).toBeNull();
    // The row body still opens the task.
    expect(screen.getByRole("button", { name: "Open EG-1: First task" })).toBeInTheDocument();
    cleanup();

    fx.caps = { assistant: false, flavor: "bun", tasksBulk: true };
    bulkMutateAsync.mockResolvedValueOnce({
      applied: ["t1"],
      failed: [{ id: "t2", code: "WIP_LIMIT", message: "Column is at its WIP limit" }],
    });
    render(<TasksPage slug="demo" search={{}} />);
    await selectTwo();

    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    fireEvent.click(screen.getByRole("button", { name: "Archive 2 tasks" }));

    await waitFor(() => expect(countText()).toBe("1 selected"));
    expect(screen.getByRole("checkbox", { name: "Deselect EG-2 Second task" })).toHaveAttribute("aria-checked", "true");
    expect(toastPush).toHaveBeenCalledWith("error", "1 task not updated", "EG-2: Column is at its WIP limit");
  });
});

describe("TasksPage bulk action payloads", () => {
  beforeEach(() => {
    navigateMock.mockClear();
    toastPush.mockClear();
    bulkMutateAsync.mockReset();
    bulkMutateAsync.mockResolvedValue({ applied: ["t1", "t2"], failed: [] });
    fx.caps = { assistant: false, flavor: "bun", tasksBulk: true };
  });

  it("sends { action: 'move' } with the target column, then with the target swimlane", async () => {
    render(<TasksPage slug="demo" search={{}} />);
    await selectTwo();

    clickMenuItem("Move to column…", "Doing");
    await waitFor(() => expect(bulkMutateAsync).toHaveBeenCalledWith({ ids: ["t1", "t2"], action: "move", columnId: "c2" }));

    await selectTwo();
    clickMenuItem("Move to sprint…", "Sprint 1");
    await waitFor(() => expect(bulkMutateAsync).toHaveBeenCalledWith({ ids: ["t1", "t2"], action: "move", swimlaneId: "s2" }));
  });

  it("sends { action: 'update' } for assignees, priority and dueAt", async () => {
    fx.board.tasks[0]!.assignees = ["Ada"];
    render(<TasksPage slug="demo" search={{}} />);
    await selectTwo();

    clickMenuItem("Set assignee…", "Ada");
    await waitFor(() => expect(bulkMutateAsync).toHaveBeenCalledWith({ ids: ["t1", "t2"], action: "update", assignees: ["Ada"] }));

    await selectTwo();
    clickMenuItem("Set priority…", "High");
    await waitFor(() => expect(bulkMutateAsync).toHaveBeenCalledWith({ ids: ["t1", "t2"], action: "update", priority: "pr2" }));

    await selectTwo();
    fireEvent.click(screen.getByRole("button", { name: "Set due date…" }));
    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    await waitFor(() => expect(bulkMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ ids: ["t1", "t2"], action: "update", dueAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) }),
    ));
  });

  it("sends { action: 'restore' } from the archived view", async () => {
    render(<TasksPage slug="demo" search={{}} />);
    fireEvent.click(screen.getByRole("button", { name: "Archived" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all tasks" }));

    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    fireEvent.click(screen.getByRole("button", { name: "Restore 3 tasks" }));
    await waitFor(() => expect(bulkMutateAsync).toHaveBeenCalledWith({ ids: ["t1", "t2", "t3"], action: "restore" }));
  });
});
