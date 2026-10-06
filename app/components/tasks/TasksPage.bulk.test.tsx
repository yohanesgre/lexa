// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

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
      description: { type: "doc", content: [] },
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

describe("TasksPage selection semantics", () => {
  beforeEach(() => {
    navigateMock.mockClear();
    toastPush.mockClear();
    bulkMutateAsync.mockReset();
    fx.caps = { assistant: false, flavor: "bun", tasksBulk: true };
  });

  it("toggles a row without opening the task and shows the count", () => {
    render(<TasksPage slug="demo" search={{}} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Select EG-1 First task" }));

    expect(screen.getByRole("checkbox", { name: "Deselect EG-1 First task" })).toHaveAttribute("aria-checked", "true");
    expect(countText()).toBe("1 selected");
    // The selection control never opens the detail slideover.
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("marks select-all mixed when only some rows are selected", () => {
    render(<TasksPage slug="demo" search={{}} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Select EG-1 First task" }));

    expect(screen.getByRole("checkbox", { name: /Select all tasks/ })).toHaveAttribute("aria-checked", "mixed");
  });

  it("shift-clicks a contiguous range in displayed order", () => {
    render(<TasksPage slug="demo" search={{}} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Select EG-1 First task" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select EG-3 Third task" }), { shiftKey: true });

    expect(countText()).toBe("3 selected");
    expect(screen.getByRole("checkbox", { name: "Deselect EG-2 Second task" })).toHaveAttribute("aria-checked", "true");
  });

  it("select-all flips checked and back", () => {
    render(<TasksPage slug="demo" search={{}} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all tasks" }));
    expect(countText()).toBe("3 selected");
    expect(screen.getByRole("checkbox", { name: "Deselect all tasks" })).toHaveAttribute("aria-checked", "true");

    fireEvent.click(screen.getByRole("checkbox", { name: "Deselect all tasks" }));
    expect(countText()).toBeNull();
  });

  it("clears selection when the sort changes", () => {
    render(<TasksPage slug="demo" search={{}} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Select EG-1 First task" }));
    expect(countText()).toBe("1 selected");

    fireEvent.change(screen.getByLabelText("Sort order"), { target: { value: "priority" } });
    expect(countText()).toBeNull();
  });

  it("clears selection on Escape inside the list", () => {
    render(<TasksPage slug="demo" search={{}} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Select EG-1 First task" }));
    expect(countText()).toBe("1 selected");

    fireEvent.keyDown(document.querySelector(".tasks-list")!, { key: "Escape" });
    expect(countText()).toBeNull();
  });

  it("hides selection controls and the bulk bar when the capability is off", () => {
    fx.caps = { assistant: false, flavor: "bun", tasksBulk: false };
    render(<TasksPage slug="demo" search={{}} />);

    expect(document.querySelector(".task-selectbox")).toBeNull();
    expect(document.querySelector(".tasks-list-head")).toBeNull();
    // The row body still opens the task.
    expect(screen.getByRole("button", { name: "Open EG-1: First task" })).toBeInTheDocument();
  });
});

describe("TasksPage bulk actions", () => {
  beforeEach(() => {
    navigateMock.mockClear();
    toastPush.mockClear();
    bulkMutateAsync.mockReset();
    fx.caps = { assistant: false, flavor: "bun", tasksBulk: true };
  });

  it("archives the selection through the named confirm dialog", async () => {
    bulkMutateAsync.mockResolvedValueOnce({ applied: ["t1", "t2"], failed: [] });
    render(<TasksPage slug="demo" search={{}} />);
    await selectTwo();

    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    expect(screen.getByText("Archive 2 tasks?")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Archive 2 tasks" }));
    await waitFor(() => expect(bulkMutateAsync).toHaveBeenCalledWith({ ids: ["t1", "t2"], action: "archive" }));
    await waitFor(() => expect(countText()).toBeNull());
  });

  it("keeps only the failed rows selected and names them with the server reason", async () => {
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

  it("changes nothing when the request fails", async () => {
    bulkMutateAsync.mockRejectedValueOnce(new Error("network"));
    render(<TasksPage slug="demo" search={{}} />);
    await selectTwo();

    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    fireEvent.click(screen.getByRole("button", { name: "Archive 2 tasks" }));

    await waitFor(() => expect(bulkMutateAsync).toHaveBeenCalled());
    expect(countText()).toBe("2 selected");
    expect(document.querySelector(".bulk-bar-count")?.textContent).toBe("2 selected");
  });

  it("keeps the selection when the confirm is cancelled", () => {
    render(<TasksPage slug="demo" search={{}} />);
    void selectTwo();

    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(bulkMutateAsync).not.toHaveBeenCalled();
    expect(countText()).toBe("2 selected");
  });

  it("focuses Cancel, cancels on Escape, and returns focus to the bulk bar", async () => {
    render(<TasksPage slug="demo" search={{}} />);
    await selectTwo();

    const archiveBtn = screen.getByRole("button", { name: "Archive" });
    archiveBtn.focus();
    fireEvent.click(archiveBtn);

    const cancel = screen.getByRole("button", { name: "Cancel" });
    await waitFor(() => expect(cancel).toHaveFocus());

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByText("Archive 2 tasks?")).toBeNull());
    expect(countText()).toBe("2 selected");
    expect(archiveBtn).toHaveFocus();
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

  it("sends { action: 'move', columnId }", async () => {
    render(<TasksPage slug="demo" search={{}} />);
    await selectTwo();

    clickMenuItem("Move to column…", "Doing");
    await waitFor(() => expect(bulkMutateAsync).toHaveBeenCalledWith({ ids: ["t1", "t2"], action: "move", columnId: "c2" }));
  });

  it("sends { action: 'move', swimlaneId }", async () => {
    render(<TasksPage slug="demo" search={{}} />);
    await selectTwo();

    clickMenuItem("Move to sprint…", "Sprint 1");
    await waitFor(() => expect(bulkMutateAsync).toHaveBeenCalledWith({ ids: ["t1", "t2"], action: "move", swimlaneId: "s2" }));
  });

  it("sends { action: 'update', assignees }", async () => {
    fx.board.tasks[0]!.assignees = ["Ada"];
    render(<TasksPage slug="demo" search={{}} />);
    await selectTwo();

    clickMenuItem("Set assignee…", "Ada");
    await waitFor(() => expect(bulkMutateAsync).toHaveBeenCalledWith({ ids: ["t1", "t2"], action: "update", assignees: ["Ada"] }));
  });

  it("sends { action: 'update', priority }", async () => {
    render(<TasksPage slug="demo" search={{}} />);
    await selectTwo();

    clickMenuItem("Set priority…", "High");
    await waitFor(() => expect(bulkMutateAsync).toHaveBeenCalledWith({ ids: ["t1", "t2"], action: "update", priority: "pr2" }));
  });

  it("sends { action: 'update', dueAt }", async () => {
    render(<TasksPage slug="demo" search={{}} />);
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

describe("TasksPage create trigger", () => {
  beforeEach(() => {
    navigateMock.mockClear();
    createMutateAsync.mockReset();
    fx.caps = { assistant: false, flavor: "bun", tasksBulk: true };
  });

  it("opens the create slideover at ?new=1", async () => {
    render(<TasksPage slug="demo" search={{ new: true }} />);
    expect(await screen.findByTestId("task-detail")).toHaveAttribute("data-mode", "create");
  });

  it("navigates to ?new=1 from the header New task control", () => {
    render(<TasksPage slug="demo" search={{}} />);
    fireEvent.click(screen.getByRole("button", { name: /New task/ }));
    expect(navigateMock).toHaveBeenCalledWith({ search: { new: true }, replace: true });
  });

  it("submits the create payload and renders the created task in the list", async () => {
    createMutateAsync.mockResolvedValueOnce({ data: {}, activity: [] });
    const { rerender } = render(<TasksPage slug="demo" search={{ new: true }} />);
    const input = {
      title: "New task",
      columnId: "c1",
      priority: "pr1",
      type: "tp1",
      assignees: [] as string[],
      description: { type: "doc", content: [] },
    };

    await act(async () => { await detailProps.current!.onCreate!(input); });
    expect(createMutateAsync).toHaveBeenCalledWith(input);

    // The real useCreateTask appends the created task to the board cache, which
    // deriveTaskList feeds into this list — the row must render.
    fx.list = [...fx.list, fx.makeListItem("t9", "EG-9", "New task")];
    rerender(<TasksPage slug="demo" search={{ new: true }} />);
    expect(screen.getByRole("button", { name: "Open EG-9: New task" })).toBeInTheDocument();
  });
});
