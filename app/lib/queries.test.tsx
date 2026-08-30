// @vitest-environment jsdom
// TanStack Query hook surface — query keys, fetch URLs, enabled flags, and the
// pure helpers (deriveTaskList / selectProjectHealth / prependActivity).
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { Board, Task, Project, Swimlane, Column, FieldConfig } from "../../shared/types";
import {
  useProjects, useDashboard, useBoard, useTasks, useFieldConfig, useWikiPages, useWikiPage,
  useSearchWikiPages, useRevisions, useColumns, useSwimlanes, useApiKeys, useUsers,
  useProjectMembers, useRuntimes, useMachines, useAgents, useSkills,
  useRecentHearthTasks, useHearthTaskHistory, useSources, useTaskLinks, useTaskSearch,
  useTaskActivity, useHearthTask, useHearthTaskLogs, useRecentHearthTask,
  useRateLimit, useGithubSettings,
  deriveTaskList, selectProjectHealth, prependActivity,
} from "./queries";

const fetchMock = vi.fn();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const PROJECT: Project = { id: "p1", slug: "demo", key: "EG", name: "Demo", description: "", repos: [], createdAt: "t", updatedAt: "t" };
const COLUMN: Column = { id: "c1", projectId: "p1", name: "Todo", position: 0, color: "#888", wipLimit: null, requiredFields: [], githubState: null, isDone: false };
const SWIMLANE: Swimlane = { id: "s1", projectId: "p1", name: "Backlog", description: "", position: 0, dueAt: null, archivedAt: null, startAt: null, milestoneId: null, kind: "backlog" };
const FIELD_CONFIG: FieldConfig = {
  priorities: [{ id: "prio-1", label: "Medium", color: "#888", position: 0 }],
  types: [{ id: "type-1", label: "Bug", color: "#f00", position: 0 }],
};
const TASK: Task = {
  id: "t1", key: "EG-1", projectId: "p1", columnId: "c1", swimlaneId: "s1", title: "T1",
  description: { type: "doc", content: [] }, priority: "prio-1", type: "type-1",
  assignees: ["Maria"], position: "a0", githubs: [], dueAt: null, archivedAt: null,
  createdAt: "t", updatedAt: "t",
};
const BOARD: Board = { project: PROJECT, columns: [COLUMN], swimlanes: [SWIMLANE], milestones: [], fieldConfig: FIELD_CONFIG, links: [], tasks: [TASK] };

// Mock fetch keyed by "METHOD url" (query part included).
const routes = new Map<string, unknown>();
function mockFetch(): void {
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const key = `${init?.method ?? "GET"} ${url}`;
    const hit = routes.get(key) ?? routes.get(`GET ${url}`);
    if (hit === undefined) return Promise.reject(new Error(`unmocked: ${key}`));
    return Promise.resolve(json(hit));
  });
}

let queryClient: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  routes.clear();
  mockFetch();
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  queryClient.clear();
});

async function awaitData<T>(result: { current: { data?: T; isSuccess?: boolean } }): Promise<T> {
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  return result.current.data as T;
}

describe("query hooks — keys + URLs", () => {
  it("useProjects fetches /api/projects and unwraps data", async () => {
    routes.set("GET /api/projects", { data: [PROJECT], nextCursor: null });
    const { result } = renderHook(() => useProjects(), { wrapper });
    const data = await awaitData(result);
    expect(data).toEqual([PROJECT]);
    expect(queryClient.getQueryCache().findAll({ queryKey: ["projects"], exact: true })).toHaveLength(1);
  });
  it("useBoard keys on slug + includeArchived and builds the query string", async () => {
    routes.set("GET /api/projects/demo/board", BOARD);
    routes.set("GET /api/projects/demo/board?includeArchived=true", BOARD);
    const { result } = renderHook(() => useBoard("demo", true), { wrapper });
    await awaitData(result);
    expect(fetchMock).toHaveBeenCalledWith("/api/projects/demo/board?includeArchived=true", expect.anything());
    expect(queryClient.getQueryCache().findAll({ queryKey: ["board", "demo", true], exact: true })).toHaveLength(1);
    // Same key as useTasks — shared cache, no double fetch.
    routes.set("GET /api/projects/demo/board", { ...BOARD });
    const tasks = renderHook(() => useTasks("demo"), { wrapper });
    await waitFor(() => expect(tasks.result.current.tasks).toBeDefined());
    const boardCalls = fetchMock.mock.calls.filter((c) => String(c[0]) === "/api/projects/demo/board").length;
    expect(boardCalls).toBe(1);
    expect(tasks.result.current.tasks![0]!.title).toBe("T1");
  });
});
describe("deriveTaskList", () => {
  it("resolves names/colors from the board maps and falls back to ids", () => {
    const rows = deriveTaskList(BOARD);
    expect(rows[0]).toMatchObject({
      id: "t1",
      columnName: "Todo",
      swimlaneName: "Backlog",
      priorityLabel: "Medium",
      priorityColor: "#888",
      typeLabel: "Bug",
      assignees: ["Maria"],
      githubNumber: null,
    });
    const bare = deriveTaskList({
      ...BOARD,
      columns: [],
      swimlanes: [],
      fieldConfig: { priorities: [], types: [] },
      tasks: [{ ...TASK, columnId: "c-x", swimlaneId: "s-x", priority: "prio-x", type: "type-x", githubs: [{ issueId: "g", issueNumber: 7, repo: "r", syncedState: null, url: "u", outOfSync: false, pushFailed: false }] }],
    });
    expect(bare[0]).toMatchObject({
      columnName: "Unknown column",
      swimlaneName: "Unknown swimlane",
      priorityLabel: "prio-x",
      typeLabel: "type-x",
      githubNumber: 7,
    });
  });
});
describe("selectProjectHealth", () => {
  it("finds the project's health entry or returns undefined", () => {
    const dashboard = {
      projects: [{ project: PROJECT, taskCount: 1, columnCount: 1, urgentCount: 0, syncCount: 0, health: "ok" as const, wipSegments: [] }],
      stats: { totalTasks: 1, activeProjects: 1, wipExceeded: 0, outOfSync: 0 },
      urgentTasks: [], outOfSyncTasks: [],
    };
    expect(selectProjectHealth(dashboard, "demo")).toMatchObject({ health: "ok" });
    expect(selectProjectHealth(dashboard, "nope")).toBeUndefined();
    expect(selectProjectHealth(undefined, "demo")).toBeUndefined();
    expect(selectProjectHealth(dashboard, undefined)).toBeUndefined();
  });
});
describe("prependActivity", () => {
  it("appends items to the end of page 1 only", () => {
    queryClient.setQueryData(["task-activity", "demo", "t1"], {
      pages: [
        { data: [{ kind: "event" as const, id: 1, taskId: "t1", actorKind: "user" as const, actorLabel: "A", actorUserId: null, type: "created" as const, message: "m1", viaHerald: false, createdAt: "t1" }], nextCursor: "c1" },
        { data: [], nextCursor: null },
      ],
      pageParams: [null, "c1"],
    });
    prependActivity(queryClient, "demo", "t1", [{ kind: "event" as const, id: 2, taskId: "t1", actorKind: "user" as const, actorLabel: "A", actorUserId: null, type: "moved" as const, message: "m2", viaHerald: false, createdAt: "t2" }]);
    const cached = queryClient.getQueryData(["task-activity", "demo", "t1"]) as { pages: { data: unknown[] }[] };
    expect(cached.pages[0]!.data).toHaveLength(2);
    expect(cached.pages[1]!.data).toHaveLength(0);
    expect((cached.pages[0]!.data[1] as { message: string }).message).toBe("m2");
  });
});
