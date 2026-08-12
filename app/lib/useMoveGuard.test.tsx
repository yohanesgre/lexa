// @vitest-environment jsdom
// useMoveGuard — the WIP/deadline confirmation gate in front of useMoveTask.
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { Board, Task, Swimlane, Column, FieldConfig } from "../../shared/types";
import { useMoveGuard } from "./useMoveGuard";

const fetchMock = vi.fn();

const COLUMN: Column = { id: "c1", projectId: "p1", name: "Todo", position: 0, color: "", wipLimit: null, requiredFields: [], githubState: null };
const FIELD_CONFIG: FieldConfig = { priorities: [], types: [] };
const LANE: Swimlane = { id: "s1", projectId: "p1", name: "Backlog", description: "", position: 0, dueAt: null, archivedAt: null, kind: "backlog" };
const LANE_OVERDUE: Swimlane = { ...LANE, id: "s-old", dueAt: "2020-01-01" };
const LANE_FUTURE: Swimlane = { ...LANE, id: "s-future", dueAt: "2099-01-01" };
const TASK: Task = {
  id: "t1", projectId: "p1", columnId: "c1", swimlaneId: "s1", title: "T1",
  description: { type: "doc", content: [] }, priority: "prio-1", type: "type-1",
  assignees: [], position: "a0", githubs: [], dueAt: null, archivedAt: null,
  createdAt: "t", updatedAt: "t",
};
const BOARD: Board = { project: { id: "p1", slug: "demo", name: "Demo", description: "", repos: [], createdAt: "t", updatedAt: "t" }, columns: [COLUMN], swimlanes: [LANE, LANE_OVERDUE, LANE_FUTURE], fieldConfig: FIELD_CONFIG, links: [], tasks: [TASK] };

const MOVE_TARGET = { columnId: "c1", swimlaneId: "s-future" };

let queryClient: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: TASK, activity: [] }), { status: 200, headers: { "Content-Type": "application/json" } }));
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  queryClient.clear();
});

async function waitForMove(): Promise<void> {
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/projects/demo/tasks/t1/move", expect.anything()));
}

describe("useMoveGuard", () => {
  it("moves immediately when the lane has no deadline and the task has none", async () => {
    const { result } = renderHook(() => useMoveGuard("demo", BOARD), { wrapper });
    let confirmed: boolean;
    await act(async () => {
      confirmed = result.current.confirmMove(TASK, { columnId: "c1", swimlaneId: "s1" });
      await waitForMove();
    });
    expect(confirmed!).toBe(true);
    expect(result.current.pending).toBeNull();
  });

  it("moves immediately when the lane deadline is in the future and the task due fits", async () => {
    const { result } = renderHook(() => useMoveGuard("demo", BOARD), { wrapper });
    let confirmed: boolean;
    await act(async () => {
      confirmed = result.current.confirmMove(TASK, MOVE_TARGET);
      await waitForMove();
    });
    expect(confirmed!).toBe(true);
  });

  it("defers the move when the target lane is overdue", async () => {
    const { result } = renderHook(() => useMoveGuard("demo", BOARD), { wrapper });
    let confirmed: boolean;
    await act(async () => {
      confirmed = result.current.confirmMove(TASK, { columnId: "c1", swimlaneId: "s-old" });
    });
    expect(confirmed!).toBe(false);
    expect(result.current.pending).toMatchObject({ task: TASK, target: { swimlaneId: "s-old" } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("defers the move when the task's due date exceeds the lane deadline", async () => {
    const overdueTask: Task = { ...TASK, dueAt: "2100-01-01" };
    const { result } = renderHook(() => useMoveGuard("demo", BOARD), { wrapper });
    let confirmed: boolean;
    await act(async () => {
      confirmed = result.current.confirmMove(overdueTask, MOVE_TARGET);
    });
    expect(confirmed!).toBe(false);
    expect(result.current.pending?.task.dueAt).toBe("2100-01-01");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resolve(false) moves without clearing the due date", async () => {
    const { result } = renderHook(() => useMoveGuard("demo", BOARD), { wrapper });
    act(() => {
      result.current.confirmMove({ ...TASK, dueAt: "2100-01-01" }, MOVE_TARGET);
    });
    await waitFor(() => expect(result.current.pending).not.toBeNull());
    await act(async () => {
      result.current.resolve(false);
      await waitForMove();
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ columnId: "c1", swimlaneId: "s-future" });
    expect(result.current.pending).toBeNull();
  });

  it("resolve(true) moves with clearDueAt: true", async () => {
    const { result } = renderHook(() => useMoveGuard("demo", BOARD), { wrapper });
    act(() => {
      result.current.confirmMove({ ...TASK, dueAt: "2100-01-01" }, MOVE_TARGET);
    });
    await waitFor(() => expect(result.current.pending).not.toBeNull());
    await act(async () => {
      result.current.resolve(true);
      await waitForMove();
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ columnId: "c1", swimlaneId: "s-future", clearDueAt: true });
  });

  it("cancel clears the pending move without mutating", async () => {
    const { result } = renderHook(() => useMoveGuard("demo", BOARD), { wrapper });
    await act(async () => {
      result.current.confirmMove({ ...TASK, dueAt: "2100-01-01" }, MOVE_TARGET);
      result.current.cancel();
    });
    expect(result.current.pending).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
