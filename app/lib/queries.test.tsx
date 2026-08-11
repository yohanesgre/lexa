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
  useProjectMembers, useRuntimes, useMachines, useForgeAgents, useForgeSkills,
  useRecentForgeTasks, useForgeTaskHistory, useSources, useTaskLinks, useTaskSearch,
  useTaskActivity, useForgeTask, useForgeTaskLogs, useRecentForgeTask,
  useRateLimit, useGithubSettings,
  deriveTaskList, selectProjectHealth, prependActivity,
} from "./queries";

const fetchMock = vi.fn();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const PROJECT: Project = { id: "p1", slug: "demo", name: "Demo", description: "", githubRepo: null, createdAt: "t", updatedAt: "t" };
const COLUMN: Column = { id: "c1", projectId: "p1", name: "Todo", position: 0, color: "#888", wipLimit: null, requiredFields: [], githubState: null };
const SWIMLANE: Swimlane = { id: "s1", projectId: "p1", name: "Backlog", description: "", position: 0, dueAt: null, archivedAt: null, kind: "backlog" };
const FIELD_CONFIG: FieldConfig = {
  priorities: [{ id: "prio-1", label: "Medium", color: "#888", position: 0 }],
  types: [{ id: "type-1", label: "Bug", color: "#f00", position: 0 }],
};
const TASK: Task = {
  id: "t1", projectId: "p1", columnId: "c1", swimlaneId: "s1", title: "T1",
  description: { type: "doc", content: [] }, priority: "prio-1", type: "type-1",
  assignees: ["Maria"], position: "a0", githubs: [], dueAt: null, archivedAt: null,
  createdAt: "t", updatedAt: "t",
};
const BOARD: Board = { project: PROJECT, columns: [COLUMN], swimlanes: [SWIMLANE], fieldConfig: FIELD_CONFIG, links: [], tasks: [TASK] };

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

  it("useDashboard fetches /api/dashboard", async () => {
    routes.set("GET /api/dashboard", { projects: [], stats: { totalTasks: 0, activeProjects: 0, wipExceeded: 0, outOfSync: 0 }, urgentTasks: [], outOfSyncTasks: [] });
    const { result } = renderHook(() => useDashboard(), { wrapper });
    await awaitData(result);
  });

  it("useFieldConfig / useWikiPages / useWikiPage / useRevisions hit their URLs", async () => {
    routes.set("GET /api/projects/demo/field-config", FIELD_CONFIG);
    routes.set("GET /api/projects/demo/wiki", { data: [] });
    routes.set("GET /api/projects/demo/wiki/home", { id: "w1", projectId: "p1", title: "Home", slug: "home", parentId: null, position: 0, updatedAt: "t", content: { type: "doc", content: [] }, createdAt: "t" });
    routes.set("GET /api/projects/demo/wiki/home/revisions?limit=20", { revisions: [] });
    const fc = renderHook(() => useFieldConfig("demo"), { wrapper });
    await awaitData(fc.result);
    const wiki = renderHook(() => useWikiPages("demo"), { wrapper });
    await awaitData(wiki.result);
    const page = renderHook(() => useWikiPage("demo", "home"), { wrapper });
    await awaitData(page.result);
    const rev = renderHook(() => useRevisions("demo", "home", 20), { wrapper });
    await awaitData(rev.result);
    expect(fetchMock).toHaveBeenCalledWith("/api/projects/demo/field-config", expect.anything());
    expect(fetchMock).toHaveBeenCalledWith("/api/projects/demo/wiki", expect.anything());
    expect(fetchMock).toHaveBeenCalledWith("/api/projects/demo/wiki/home", expect.anything());
    expect(fetchMock).toHaveBeenCalledWith("/api/projects/demo/wiki/home/revisions?limit=20", expect.anything());
    expect(queryClient.getQueryCache().findAll({ queryKey: ["wikiPage", "demo", "home"], exact: true })).toHaveLength(1);
  });

  it("useSearchWikiPages is disabled for an empty query", async () => {
    const { result } = renderHook(() => useSearchWikiPages("demo", ""), { wrapper });
    await waitFor(() => expect(result.current.isPending).toBe(true));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(queryClient.getQueryCache().findAll({ queryKey: ["wikiSearch", "demo", ""], exact: true })).toHaveLength(1);
  });

  it("useTaskSearch requires at least 2 trimmed characters", async () => {
    routes.set("GET /api/projects/demo/tasks/search?q=ab&exclude=", { data: [] });
    const short = renderHook(() => useTaskSearch("demo", "a"), { wrapper });
    await waitFor(() => expect(short.result.current.isPending).toBe(true));
    expect(fetchMock).not.toHaveBeenCalled();
    const ok = renderHook(() => useTaskSearch("demo", "ab"), { wrapper });
    await waitFor(() => expect(ok.result.current.isSuccess).toBe(true));
    expect(fetchMock).toHaveBeenCalledWith("/api/projects/demo/tasks/search?q=ab&exclude=", expect.anything());
  });

  it("useSources / useTaskLinks are disabled until both ids exist", async () => {
    routes.set("GET /api/projects/demo/documents/task/t1/sources", { data: [] });
    routes.set("GET /api/projects/demo/tasks/t1/links", { data: [] });
    const s1 = renderHook(() => useSources("", "task", ""), { wrapper });
    await waitFor(() => expect(s1.result.current.isPending).toBe(true));
    const s2 = renderHook(() => useSources("demo", "task", "t1"), { wrapper });
    await waitFor(() => expect(s2.result.current.isSuccess).toBe(true));
    const l1 = renderHook(() => useTaskLinks("demo", ""), { wrapper });
    await waitFor(() => expect(l1.result.current.isPending).toBe(true));
    const l2 = renderHook(() => useTaskLinks("demo", "t1"), { wrapper });
    await waitFor(() => expect(l2.result.current.isSuccess).toBe(true));
  });

  it("useForgeTask / useForgeTaskLogs / useRecentForgeTask respect the enabled flag + null id", async () => {
    routes.set("GET /api/forge/tasks/ft1", { id: "ft1", status: "queued" });
    routes.set("GET /api/forge/tasks/ft1/logs", { data: [] });
    routes.set("GET /api/forge/tasks?slug=demo&documentType=task&documentId=t1", { data: [] });
    const off = renderHook(() => useForgeTask("ft1", false), { wrapper });
    await waitFor(() => expect(off.result.current.isPending).toBe(true));
    const nullId = renderHook(() => useForgeTask(null, true), { wrapper });
    await waitFor(() => expect(nullId.result.current.isPending).toBe(true));
    const on = renderHook(() => useForgeTask("ft1", true), { wrapper });
    await waitFor(() => expect(on.result.current.isSuccess).toBe(true));
    const logs = renderHook(() => useForgeTaskLogs("ft1", true), { wrapper });
    await waitFor(() => expect(logs.result.current.isSuccess).toBe(true));
    const recent = renderHook(() => useRecentForgeTask("demo", "task", "", true), { wrapper });
    await waitFor(() => expect(recent.result.current.isPending).toBe(true));
    expect(fetchMock).not.toHaveBeenCalledWith("/api/forge/tasks?slug=demo&documentType=task&documentId=t1", expect.anything());
    const recentOn = renderHook(() => useRecentForgeTask("demo", "task", "t1", true), { wrapper });
    await waitFor(() => expect(recentOn.result.current.isSuccess).toBe(true));
    expect(fetchMock).toHaveBeenCalledWith("/api/forge/tasks?slug=demo&documentType=task&documentId=t1", expect.anything());
  });

  it("settings/forge list hooks hit their URLs", async () => {
    routes.set("GET /api/settings/api-keys", { data: [] });
    routes.set("GET /api/settings/rate-limit", { max: 6000, windowMs: 600000, envOverride: false });
    routes.set("GET /api/settings/github", { appId: "123456", privateKeySet: true, webhookSecretSet: true, source: "settings" });
    routes.set("GET /api/admin/users", { data: [] });
    routes.set("GET /api/projects/demo/members", { data: [] });
    routes.set("GET /api/forge/runtimes", { data: [] });
    routes.set("GET /api/forge/machines", { data: [] });
    routes.set("GET /api/forge/agents", { data: [] });
    routes.set("GET /api/forge/skills", { data: [] });
    routes.set("GET /api/forge/tasks/recent", { data: [] });
    routes.set("GET /api/forge/tasks/history", { data: [], nextCursor: null, summary: { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 } });
    const hooks: Array<() => unknown> = [
      () => useApiKeys(), () => useUsers(), () => useProjectMembers("demo"), () => useRuntimes(),
      () => useMachines(), () => useForgeAgents(), () => useForgeSkills(), () => useRecentForgeTasks(),
      () => useForgeTaskHistory({}, null), () => useRateLimit(), () => useGithubSettings(),
    ];
    for (const hook of hooks) {
      const { result } = renderHook(hook as () => unknown, { wrapper });
      await waitFor(() => expect((result.current as { isSuccess?: boolean }).isSuccess).toBe(true));
    }
    expect(queryClient.getQueryCache().findAll({ queryKey: ["api-keys"], exact: true })).toHaveLength(1);
    expect(queryClient.getQueryCache().findAll({ queryKey: ["forge-runtimes"], exact: true })).toHaveLength(1);
  });

  it("useTaskActivity is an infinite query — page 1 without cursor, next page with the cursor", async () => {
    routes.set("GET /api/projects/demo/tasks/t1/activity", { data: [{ kind: "event", id: 1, taskId: "t1", actorKind: "user", actorLabel: "Maria", actorUserId: null, type: "created", message: "m", createdAt: "t" }], nextCursor: "c1" });
    routes.set("GET /api/projects/demo/tasks/t1/activity?cursor=c1", { data: [], nextCursor: null });
    const { result } = renderHook(() => useTaskActivity("demo", "t1"), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data!.pages).toHaveLength(1);
    await result.current.fetchNextPage();
    await waitFor(() => expect(result.current.data!.pages).toHaveLength(2));
    expect(fetchMock).toHaveBeenCalledWith("/api/projects/demo/tasks/t1/activity?cursor=c1", expect.anything());
  });

  it("useTaskActivity is disabled for a missing task id", async () => {
    const { result } = renderHook(() => useTaskActivity("demo", ""), { wrapper });
    await waitFor(() => expect(result.current.isPending).toBe(true));
    expect(fetchMock).not.toHaveBeenCalled();
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
      tasks: [{ ...TASK, columnId: "c-x", swimlaneId: "s-x", priority: "prio-x", type: "type-x", githubs: [{ issueId: "g", issueNumber: 7, repo: "r", syncedState: null, url: "u", outOfSync: false }] }],
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
        { data: [{ kind: "event" as const, id: 1, taskId: "t1", actorKind: "user" as const, actorLabel: "A", actorUserId: null, type: "created" as const, message: "m1", createdAt: "t1" }], nextCursor: "c1" },
        { data: [], nextCursor: null },
      ],
      pageParams: [null, "c1"],
    });
    prependActivity(queryClient, "demo", "t1", [{ kind: "event" as const, id: 2, taskId: "t1", actorKind: "user" as const, actorLabel: "A", actorUserId: null, type: "moved" as const, message: "m2", createdAt: "t2" }]);
    const cached = queryClient.getQueryData(["task-activity", "demo", "t1"]) as { pages: { data: unknown[] }[] };
    expect(cached.pages[0].data).toHaveLength(2);
    expect(cached.pages[1].data).toHaveLength(0);
    expect((cached.pages[0].data[1] as { message: string }).message).toBe("m2");
  });
});
