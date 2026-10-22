// @vitest-environment jsdom
// Mutation hooks — invariant 6: the mutation response is authoritative; the
// cache is updated via setQueryData from the response, NEVER via
// invalidateQueries (no refetch on the mutation path).
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { renderHook, waitFor, act, screen } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import type { Board, Task, Project, Swimlane, Milestone, Column, WikiPage, FieldConfig, Dashboard, Team } from "../../shared/types";
import { createFetchMock, createQueryWrapper, createTestQueryClient, json } from "../test-utils";
import type { ComponentType, ReactNode } from "react";
import {
  useCreateProject, useDeleteProject, useCreateTask,
  useMoveTask, useDeleteTask, useArchiveTask, useCreateWikiPage, useUpdateTask,
  useUpdateWikiPage, useUpdateFieldConfig, useCreateColumn,
  useCreateSwimlane,
  useUpdateRateLimit, useClearGithubSettings,
  useRestoreWikiRevision, useRevisions, wikiKeys,
  useSignIn, useRevokeWorkspaceInvite,
} from "./queries";
import { useUpdateTeam } from "./queries/team";
import { settleThreadCache } from "../components/chat/assistant-chat-logic";
import type { SessionResponse } from "./auth";
import type { WorkspaceInvite } from "../../shared/types";

const { fetchMock, routes, mockFetch } = createFetchMock();

const PROJECT: Project = { id: "p1", slug: "demo", key: "EG", name: "Demo", description: "", repos: [], createdAt: "t", updatedAt: "t" };
const PROJECT2: Project = { ...PROJECT, id: "p2", slug: "other", name: "Other" };
const DASHBOARD: Dashboard = {
  projects: [{ project: PROJECT, taskCount: 2, columnCount: 1, urgentCount: 0, syncCount: 0, health: "ok", wipSegments: [] }],
  stats: { totalTasks: 2, activeProjects: 1, wipExceeded: 0, outOfSync: 0 },
  urgentTasks: [],
  outOfSyncTasks: [],
};
const COLUMN: Column = { id: "c1", projectId: "p1", name: "Todo", position: 0, color: "#888", wipLimit: null, requiredFields: [], githubState: null, isDone: false };
const SWIMLANE: Swimlane = { id: "s1", projectId: "p1", name: "Backlog", description: "", position: 0, dueAt: null, archivedAt: null, startAt: null, milestoneId: null, kind: "backlog", tasksDone: 0, tasksTotal: 0 };
const SPRINT: Swimlane = { ...SWIMLANE, id: "s2", name: "Sprint 1", position: 1, kind: "sprint", milestoneId: "m1" };
const MILESTONE: Milestone = { id: "m1", projectId: "p1", name: "v1.0", description: "", position: 0, dueAt: null, archivedAt: null, sprintCount: 0, archivedSprintCount: 0, tasksDone: 0, tasksTotal: 0 };
const FIELD_CONFIG: FieldConfig = { priorities: [{ id: "prio-1", label: "Medium", color: "#888", position: 0 }], types: [{ id: "type-1", label: "Bug", color: "#f00", position: 0 }] };
const TASK: Task = {
  id: "t1", key: "EG-1", projectId: "p1", columnId: "c1", swimlaneId: "s1", title: "T1",
  description: "", priority: "prio-1", type: "type-1",
  assignees: [], position: "a0", githubs: [], dueAt: null, archivedAt: null,
  createdAt: "t", updatedAt: "t",
};
const MOVED_TASK: Task = { ...TASK, columnId: "c2", position: "a1" };
const ARCHIVED_TASK: Task = { ...TASK, archivedAt: "2026-03-01T00:00:00.000Z" };
const BOARD: Board = { project: PROJECT, columns: [COLUMN], swimlanes: [SWIMLANE], milestones: [], fieldConfig: FIELD_CONFIG, links: [], tasks: [TASK] };
const BOARD2: Board = { ...BOARD, columns: [...BOARD.columns, { ...COLUMN, id: "c2", name: "Done", position: 1 }] };
const PAGE: WikiPage = { id: "w1", projectId: "p1", title: "Home", slug: "home", parentId: null, position: 0, updatedBy: null, updatedByName: null, updatedAt: "t", content: "", createdAt: "t" };
const PAGE2: WikiPage = { ...PAGE, id: "w2", slug: "other", title: "Other" };
const EV = { id: 1, taskId: "t1", actorKind: "user" as const, actorLabel: "Maria", actorUserId: null, type: "created" as const, message: "m", createdAt: "t" };

type Wrapper = ComponentType<{ children: ReactNode }>;

let queryClient: QueryClient;
let wrapper: Wrapper;

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  routes.clear();
  mockFetch();
  queryClient = createTestQueryClient();
  wrapper = createQueryWrapper(queryClient);
});

afterEach(() => {
  vi.unstubAllGlobals();
  queryClient.clear();
});

function boardCalls(): number {
  return fetchMock.mock.calls.filter((c) => String(c[0]).includes("/board")).length;
}

describe("project mutations", () => {
  it("useCreateProject prepends the response to the projects cache and the dashboard entry — no refetch", async () => {
    routes.set("POST /api/projects", PROJECT2);
    queryClient.setQueryData(["projects"], [PROJECT]);
    queryClient.setQueryData<Dashboard>(["dashboard"], DASHBOARD);
    const { result } = renderHook(() => useCreateProject(), { wrapper });
    await act(async () => { await result.current.mutateAsync({ name: "Other", slug: "other" }); });
    expect(queryClient.getQueryData<Project[]>(["projects"])).toEqual([PROJECT2, PROJECT]);
    const projectsCalls = fetchMock.mock.calls.filter((c) => String(c[0]) === "/api/projects" && (c[1] as RequestInit | undefined)?.method !== "POST");
    expect(projectsCalls).toHaveLength(0);
    const dash = queryClient.getQueryData<Dashboard>(["dashboard"])!;
    expect(dash.projects[0]).toEqual({
      project: PROJECT2,
      taskCount: 0,
      columnCount: 0,
      urgentCount: 0,
      syncCount: 0,
      health: "ok",
      wipSegments: [],
    });
    expect(dash.projects[1]!.project.id).toBe("p1");
    expect(dash.stats).toEqual({ totalTasks: 2, activeProjects: 2, wipExceeded: 0, outOfSync: 0 });
    const dashboardCalls = fetchMock.mock.calls.filter((c) => String(c[0]) === "/api/dashboard");
    expect(dashboardCalls).toHaveLength(0);
  });

  it("useDeleteProject filters the row and removes the project's query families", async () => {
    routes.set("DELETE /api/projects/demo", 204);
    queryClient.setQueryData(["projects"], [PROJECT, PROJECT2]);
    queryClient.setQueryData(["board", "demo", false], BOARD);
    queryClient.setQueryData(["board", "other", false], { ...BOARD, project: PROJECT2 });
    queryClient.setQueryData(["wiki", "demo"], [PAGE]);
    const { result } = renderHook(() => useDeleteProject(), { wrapper });
    await act(async () => { await result.current.mutateAsync("demo"); });
    expect(queryClient.getQueryData<Project[]>(["projects"])!.map((p) => p.slug)).toEqual(["other"]);
    expect(queryClient.getQueryData(["board", "demo", false])).toBeUndefined();
    expect(queryClient.getQueryData(["wiki", "demo"])).toBeUndefined();
    expect(queryClient.getQueryData(["board", "other", false])).toBeDefined();
  });
});

describe("task mutations — board cache from the authoritative response", () => {
  function seedBoards(): void {
    queryClient.setQueryData(["board", "demo", false], BOARD2);
    queryClient.setQueryData(["board", "demo", true], BOARD2);
  }

  it("useCreateTask appends the response task to both board caches", async () => {
    routes.set("POST /api/projects/demo/tasks", { data: { ...TASK, id: "t9", title: "New" }, activity: [EV] });
    seedBoards();
    const before = boardCalls();
    const { result } = renderHook(() => useCreateTask("demo"), { wrapper });
    await act(async () => { await result.current.mutateAsync({ columnId: "c1", title: "New" }); });
    const live = queryClient.getQueryData<Board>(["board", "demo", false])!;
    expect(live.tasks.map((t) => t.id)).toEqual(["t1", "t9"]);
    expect((queryClient.getQueryData<Board>(["board", "demo", true])!.tasks.at(-1) as Task).id).toBe("t9");
    // The detail cache is seeded from the authoritative response (create-then-
    // open renders the cached doc while the detail query is pending) and the
    // board URL was not called again.
    expect(queryClient.getQueryData<Task>(["tasks", "demo", "t9"])).toEqual({ ...TASK, id: "t9", title: "New" });
    expect(boardCalls()).toBe(before);
    // Activity prepended into the timeline cache.
    const actCache = queryClient.getQueryData(["task-activity", "demo", "t9"]);
    expect(actCache).toBeUndefined(); // prepend only touches existing caches
  });

  it("useMoveTask replaces the moved task in both boards from the response — never a refetch", async () => {
    routes.set("POST /api/projects/demo/tasks/t1/move", { data: MOVED_TASK, activity: [] });
    seedBoards();
    const before = boardCalls();
    const { result } = renderHook(() => useMoveTask("demo"), { wrapper });
    await act(async () => { await result.current.mutateAsync({ id: "t1", columnId: "c2", swimlaneId: "s1" }); });
    const live = queryClient.getQueryData<Board>(["board", "demo", false])!;
    expect(live.tasks[0]).toMatchObject({ id: "t1", columnId: "c2", position: "a1" });
    expect(boardCalls()).toBe(before);
  });
  it("scopes a task mutation response to its request project", async () => {
    const response = { ...TASK, title: "Saved for original project", description: "Markdown source" };
    routes.set("PATCH /api/projects/demo/tasks/t1", { data: response, activity: [] });
    queryClient.setQueryData(["tasks", "demo", "t1"], TASK);
    queryClient.setQueryData(["tasks", "other-project", "t1"], { ...TASK, description: "Other project" });
    queryClient.setQueryData<Board>(["board", "demo", false], BOARD);
    queryClient.setQueryData<Board>(["board", "demo", true], BOARD);
    queryClient.setQueryData<Board>(["board", "other-project", false], { ...BOARD, tasks: [{ ...TASK, title: "Other project" }] });
    const update = renderHook(() => useUpdateTask("other-project"), { wrapper });
    await act(async () => {
      await update.result.current.mutateAsync({ id: "t1", projectSlug: "demo", description: response.description });
    });

    expect(queryClient.getQueryData<Task>(["tasks", "demo", "t1"])?.description).toBe(response.description);
    expect(queryClient.getQueryData<Task>(["tasks", "other-project", "t1"])?.description).toBe("Other project");
    expect(queryClient.getQueryData<Board>(["board", "demo", false])?.tasks[0]?.title).toBe(response.title);
    expect(queryClient.getQueryData<Board>(["board", "other-project", false])?.tasks[0]?.title).toBe("Other project");
  });

  it("useDeleteTask drops the card, detail and activity caches; useArchiveTask moves it to the archived board", async () => {
    routes.set("DELETE /api/projects/demo/tasks/t1", 204);
    seedBoards();
    queryClient.setQueryData(["tasks", "demo", "t1"], TASK);
    queryClient.setQueryData(["task-activity", "demo", "t1"], { pages: [], pageParams: [] });
    const del = renderHook(() => useDeleteTask("demo"), { wrapper });
    await act(async () => { await del.result.current.mutateAsync({ id: "t1" }); });
    expect(queryClient.getQueryData<Board>(["board", "demo", false])!.tasks).toHaveLength(0);
    expect(queryClient.getQueryData(["tasks", "demo", "t1"])).toBeUndefined();
    expect(queryClient.getQueryData(["task-activity", "demo", "t1"])).toBeUndefined();

    routes.set("POST /api/projects/demo/tasks/t1/archive", { data: ARCHIVED_TASK, activity: [] });
    seedBoards();
    const arch = renderHook(() => useArchiveTask("demo"), { wrapper });
    await act(async () => { await arch.result.current.mutateAsync({ id: "t1" }); });
    expect(queryClient.getQueryData<Board>(["board", "demo", false])!.tasks).toHaveLength(0);
    expect(queryClient.getQueryData<Board>(["board", "demo", true])!.tasks[0]!.archivedAt).toBe(ARCHIVED_TASK.archivedAt);
  });
});

describe("wiki mutations", () => {
  it("useCreateWikiPage appends to the list and seeds the detail cache; useUpdateWikiPage replaces both rows", async () => {
    routes.set("POST /api/projects/demo/wiki", PAGE2);
    queryClient.setQueryData(["wiki", "demo"], [PAGE]);
    const create = renderHook(() => useCreateWikiPage("demo"), { wrapper });
    await act(async () => { await create.result.current.mutateAsync({ title: "Other" }); });
    expect(queryClient.getQueryData<WikiPage[]>(["wiki", "demo"])!.map((p) => p.slug)).toEqual(["home", "other"]);
    expect(queryClient.getQueryData(["wikiPage", "demo", "other"])).toEqual(PAGE2);

    routes.set("PATCH /api/projects/demo/wiki/home", { ...PAGE, title: "Renamed" });
    queryClient.setQueryData(["wiki", "demo"], [PAGE, PAGE2]);
    queryClient.setQueryData(["wikiPage", "demo", "home"], PAGE);
    const update = renderHook(() => useUpdateWikiPage("demo"), { wrapper });
    await act(async () => { await update.result.current.mutateAsync({ pageSlug: "home", title: "Renamed" }); });
    expect(queryClient.getQueryData<WikiPage[]>(["wiki", "demo"])![0]!.title).toBe("Renamed");
    expect(queryClient.getQueryData<WikiPage>(["wikiPage", "demo", "home"])!.title).toBe("Renamed");
  });
  it("scopes a wiki mutation response to request project, not hook project", async () => {
    const response = { ...PAGE, title: "Saved in original project" };
    routes.set("PATCH /api/projects/demo/wiki/home", response);
    queryClient.setQueryData(["wiki", "demo"], [PAGE]);
    queryClient.setQueryData(["wikiPage", "demo", "home"], PAGE);
    queryClient.setQueryData(["wiki", "other-project"], [PAGE2]);
    queryClient.setQueryData(["wikiPage", "other-project", "home"], PAGE2);

    const update = renderHook(() => useUpdateWikiPage("other-project"), { wrapper });
    await act(async () => {
      await update.result.current.mutateAsync({ projectSlug: "demo", pageSlug: "home", title: response.title });
    });

    expect(queryClient.getQueryData<WikiPage[]>(["wiki", "demo"])?.[0]?.title).toBe(response.title);
    expect(queryClient.getQueryData<WikiPage[]>(["wiki", "other-project"])).toEqual([PAGE2]);
    expect(queryClient.getQueryData<WikiPage>(["wikiPage", "demo", "home"])?.title).toBe(response.title);
    expect(queryClient.getQueryData<WikiPage>(["wikiPage", "other-project", "home"])).toEqual(PAGE2);
  });


  it("keeps history current across a pending initial read and a fresh cached restore", async () => {
    queryClient.setDefaultOptions({ queries: { retry: false, staleTime: 30_000 } });
    const saved = [{ id: "r2", title: "Home", saveType: "manual" as const, createdAt: "t2" }];
    const restored = [{ id: "r3", title: "Home", saveType: "restore" as const, createdAt: "t3" }, ...saved];
    routes.set("PATCH /api/projects/demo/wiki/home", PAGE);
    routes.set("POST /api/projects/demo/wiki/home/restore", PAGE);
    routes.set("GET /api/projects/demo/wiki/home/revisions?limit=20", { revisions: saved });
    let releaseInitial!: (response: Response) => void;
    let initialStarted = false;
    const initial = new Promise<Response>((resolve) => { releaseInitial = resolve; });
    fetchMock.mockImplementationOnce(() => { initialStarted = true; return initial; });
    const history = renderHook(() => useRevisions("demo", "home", 20), { wrapper });
    const update = renderHook(() => useUpdateWikiPage("demo"), { wrapper });
    const restore = renderHook(() => useRestoreWikiRevision("demo"), { wrapper });

    await waitFor(() => { expect(initialStarted).toBe(true); });
    await act(async () => { await update.result.current.mutateAsync({ pageSlug: "home", content: "Saved" }); });
    await waitFor(() => { expect(history.result.current.data).toEqual(saved); });
    await act(async () => { releaseInitial(json({ revisions: [] })); });
    expect(history.result.current.data).toEqual(saved);
    routes.set("GET /api/projects/demo/wiki/home/revisions?limit=20", { revisions: restored });
    await act(async () => { await restore.result.current.mutateAsync({ pageSlug: "home", revisionId: "r2" }); });
    await waitFor(() => { expect(history.result.current.data).toEqual(restored); });
  });
});

describe("board-structure + settings mutations", () => {
  it("useUpdateFieldConfig updates field-config and both boards; useCreateColumn appends to the columns cache and both boards — no refetch", async () => {
    const newConfig = { ...FIELD_CONFIG, priorities: [{ id: "prio-2", label: "High", color: "#f00", position: 0 }] };
    routes.set("PUT /api/projects/demo/field-config", newConfig);
    queryClient.setQueryData(["field-config", "demo"], FIELD_CONFIG);
    queryClient.setQueryData(["board", "demo", false], BOARD);
    queryClient.setQueryData(["board", "demo", true], BOARD);
    const config = renderHook(() => useUpdateFieldConfig("demo"), { wrapper });
    await act(async () => { await config.result.current.mutateAsync({ priorities: [], types: [] }); });
    expect(queryClient.getQueryData(["field-config", "demo"])).toEqual(newConfig);
    expect(queryClient.getQueryData<Board>(["board", "demo", false])!.fieldConfig).toEqual(newConfig);
    expect(queryClient.getQueryData<Board>(["board", "demo", true])!.fieldConfig).toEqual(newConfig);

    const COLUMN2: Column = { ...COLUMN, id: "c2", name: "Done", position: 1 };
    routes.set("POST /api/projects/demo/columns", COLUMN2);
    queryClient.setQueryData(["projects", "demo", "columns"], [COLUMN]);
    queryClient.setQueryData(["board", "demo", false], BOARD);
    queryClient.setQueryData(["board", "demo", true], BOARD);
    const before = boardCalls();
    const column = renderHook(() => useCreateColumn("demo"), { wrapper });
    await act(async () => { await column.result.current.mutateAsync({ name: "Done" }); });
    expect(queryClient.getQueryData<Column[]>(["projects", "demo", "columns"])!.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(queryClient.getQueryData<Board>(["board", "demo", false])!.columns.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(queryClient.getQueryData<Board>(["board", "demo", true])!.columns.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(boardCalls()).toBe(before);
  });

  it("useUpdateRateLimit and useClearGithubSettings replace their caches from the authoritative response — no refetch", async () => {
    routes.set("PUT /api/settings/rate-limit", { max: 3000, windowMs: 300000, envOverride: false });
    queryClient.setQueryData(["rate-limit"], { max: 6000, windowMs: 600000, envOverride: false });
    const rateCallsBefore = fetchMock.mock.calls.filter((c) => String(c[0]).includes("/rate-limit") && (c[1] as RequestInit | undefined)?.method !== "PUT").length;
    const rate = renderHook(() => useUpdateRateLimit(), { wrapper });
    await act(async () => { await rate.result.current.mutateAsync({ max: 3000, windowMs: 300000 }); });
    expect(queryClient.getQueryData(["rate-limit"])).toEqual({ max: 3000, windowMs: 300000, envOverride: false });
    const rateCallsAfter = fetchMock.mock.calls.filter((c) => String(c[0]).includes("/rate-limit") && (c[1] as RequestInit | undefined)?.method !== "PUT").length;
    expect(rateCallsAfter).toBe(rateCallsBefore);

    routes.set("PUT /api/settings/github", { appId: "", appSlug: "", privateKeySet: false, webhookSecretSet: false, source: "none" });
    queryClient.setQueryData(["github-settings"], { appId: "123456", appSlug: "lexa-nimbus", privateKeySet: true, webhookSecretSet: true, source: "settings" });
    const ghCallsBefore = fetchMock.mock.calls.filter((c) => String(c[0]).includes("/settings/github") && (c[1] as RequestInit | undefined)?.method !== "PUT").length;
    const gh = renderHook(() => useClearGithubSettings(), { wrapper });
    await act(async () => { await gh.result.current.mutateAsync(undefined); });
    const put = fetchMock.mock.calls.find((c) => String(c[0]).includes("/settings/github") && (c[1] as RequestInit | undefined)?.method === "PUT");
    expect(JSON.parse(String((put?.[1] as RequestInit | undefined)?.body))).toEqual({ appId: "", appSlug: "", privateKey: "", webhookSecret: "" });
    expect(queryClient.getQueryData(["github-settings"])).toEqual({ appId: "", appSlug: "", privateKeySet: false, webhookSecretSet: false, source: "none" });
    const ghCallsAfter = fetchMock.mock.calls.filter((c) => String(c[0]).includes("/settings/github") && (c[1] as RequestInit | undefined)?.method !== "PUT").length;
    expect(ghCallsAfter).toBe(ghCallsBefore);
  });
});

describe("milestone ⇄ swimlane cache fan-in (LX-21)", () => {
  it("useCreateSwimlane recomputes the milestone sprint counts from the standalone list, or from the board-true fallback when it is absent", async () => {
    routes.set("POST /api/projects/demo/swimlanes", SPRINT);
    queryClient.setQueryData(["projects", "demo", "swimlanes"], [SWIMLANE]);
    queryClient.setQueryData(["milestones", "demo"], [MILESTONE]);
    const standalone = renderHook(() => useCreateSwimlane("demo"), { wrapper });
    await act(async () => { await standalone.result.current.mutateAsync({ name: "Sprint 1", milestoneId: "m1" }); });
    const ms = queryClient.getQueryData<Milestone[]>(["milestones", "demo"])!;
    expect(ms[0]).toMatchObject({ sprintCount: 1, archivedSprintCount: 0 });

    // Fallback: the standalone list is absent, so counts come from board-true
    // (2 for m1, 1 archived).
    queryClient.removeQueries({ queryKey: ["projects", "demo", "swimlanes"] });
    const archivedSprint: Swimlane = { ...SPRINT, archivedAt: "2026-03-01T00:00:00.000Z" };
    queryClient.setQueryData(["milestones", "demo"], [MILESTONE]);
    queryClient.setQueryData(["board", "demo", true], { ...BOARD, swimlanes: [archivedSprint], milestones: [MILESTONE] });
    queryClient.setQueryData(["board", "demo", false], { ...BOARD, swimlanes: [], milestones: [MILESTONE] });
    const fallback = renderHook(() => useCreateSwimlane("demo"), { wrapper });
    await act(async () => { await fallback.result.current.mutateAsync({ name: "Sprint 1", milestoneId: "m1" }); });
    expect(queryClient.getQueryData(["projects", "demo", "swimlanes"])).toBeUndefined();
    expect(queryClient.getQueryData<Milestone[]>(["milestones", "demo"])![0]).toMatchObject({ sprintCount: 2, archivedSprintCount: 1 });
    expect(queryClient.getQueryData<Board>(["board", "demo", true])!.milestones[0]).toMatchObject({ sprintCount: 2, archivedSprintCount: 1 });
    expect(queryClient.getQueryData<Board>(["board", "demo", false])!.milestones[0]).toMatchObject({ sprintCount: 2, archivedSprintCount: 1 });
  });
});

describe("progress counts stay fresh after mutations (LX 63450bf5)", () => {
  const DONE_COLUMN: Column = { ...COLUMN, id: "c2", name: "Done", position: 1, isDone: true };
  const LANE: Swimlane = { ...SWIMLANE, id: "s1", name: "Sprint", kind: "sprint", milestoneId: "m1", tasksDone: 1, tasksTotal: 3 };
  const MILESTONE_PROGRESS: Milestone = { ...MILESTONE, id: "m1", sprintCount: 1, tasksDone: 1, tasksTotal: 3 };
  const OPEN_TASK: Task = { ...TASK, id: "t1", swimlaneId: "s1", columnId: "c1", archivedAt: null };
  const DONE_TASK: Task = { ...TASK, id: "t2", key: "EG-2", swimlaneId: "s1", columnId: "c2", archivedAt: null };

  function seedProgress(): void {
    const board: Board = {
      ...BOARD,
      columns: [COLUMN, DONE_COLUMN],
      swimlanes: [LANE],
      milestones: [MILESTONE_PROGRESS],
      tasks: [OPEN_TASK, DONE_TASK],
    };
    queryClient.setQueryData(["board", "demo", false], board);
    queryClient.setQueryData(["board", "demo", true], board);
    queryClient.setQueryData(["milestones", "demo"], [MILESTONE_PROGRESS]);
    queryClient.setQueryData(["projects", "demo", "swimlanes"], [LANE]);
  }

  function laneCounts(archived: boolean): { tasksDone: number; tasksTotal: number } {
    const lane = queryClient.getQueryData<Board>(["board", "demo", archived])!.swimlanes.find((l) => l.id === "s1")!;
    return { tasksDone: lane.tasksDone, tasksTotal: lane.tasksTotal };
  }

  function milestoneCounts(): { tasksDone: number; tasksTotal: number } {
    const m = queryClient.getQueryData<Milestone[]>(["milestones", "demo"])![0]!;
    return { tasksDone: m.tasksDone, tasksTotal: m.tasksTotal };
  }

  it("lane and milestone progress counts stay fresh after a create in a done column and after a cross-lane move", async () => {
    routes.set("POST /api/projects/demo/tasks", { data: { ...DONE_TASK, id: "t9", title: "New" }, activity: [] });
    seedProgress();
    const create = renderHook(() => useCreateTask("demo"), { wrapper });
    await act(async () => { await create.result.current.mutateAsync({ columnId: "c2", title: "New" }); });
    expect(laneCounts(false)).toEqual({ tasksDone: 2, tasksTotal: 4 });
    expect(laneCounts(true)).toEqual({ tasksDone: 2, tasksTotal: 4 });
    expect(milestoneCounts()).toEqual({ tasksDone: 2, tasksTotal: 4 });

    // Regression: the task-detail cache fallback localizes a cross-lane move even
    // when neither board cache holds the row — one lane loses a task, the other
    // gains it, totals stay balanced.
    routes.set("POST /api/projects/demo/tasks/t1/move", { data: { ...OPEN_TASK, swimlaneId: "s2" }, activity: [] });
    const laneA: Swimlane = { ...LANE, id: "s1", tasksDone: 0, tasksTotal: 1 };
    const laneB: Swimlane = { ...LANE, id: "s2", name: "Other", milestoneId: null, tasksDone: 0, tasksTotal: 0 };
    const board: Board = { ...BOARD, columns: [COLUMN, DONE_COLUMN], swimlanes: [laneA, laneB], milestones: [], tasks: [] };
    queryClient.setQueryData(["board", "demo", false], board);
    queryClient.setQueryData(["projects", "demo", "swimlanes"], [laneA, laneB]);
    queryClient.setQueryData(["tasks", "demo", "t1"], OPEN_TASK);
    const move = renderHook(() => useMoveTask("demo"), { wrapper });
    await act(async () => { await move.result.current.mutateAsync({ id: "t1", columnId: "c1", swimlaneId: "s2" }); });
    const lanes = queryClient.getQueryData<Swimlane[]>(["projects", "demo", "swimlanes"])!;
    expect(lanes.find((l) => l.id === "s1")).toMatchObject({ tasksDone: 0, tasksTotal: 0 });
    expect(lanes.find((l) => l.id === "s2")).toMatchObject({ tasksDone: 0, tasksTotal: 1 });
  });
});

describe("session + invite mutation paths (LX-100/LX-102/LX-103)", () => {
  const USER = { id: "u1", email: "y@lexa.test", name: "Y", role: "superadmin" as const, createdAt: "t", lastSeen: null };

  it("useSignIn writes the authoritative session read back and useRevokeWorkspaceInvite drops its row — never invalidate", async () => {
    const SERVER_SESSION = { session: { id: "s1", userId: "u1", expiresAt: "t", createdAt: "t" }, user: USER };
    routes.set("POST /api/auth/sign-in/email", { redirect: false, token: "tok", url: "/", user: USER });
    routes.set("GET /api/auth/get-session", SERVER_SESSION);
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    const signIn = renderHook(() => useSignIn(), { wrapper });
    await act(async () => { await signIn.result.current.mutateAsync({ email: "y@lexa.test", password: "pw" }); });

    // The sign-in seed is replaced by the authoritative get-session read
    // written through setQueryData — invariant 6, no invalidateQueries.
    await waitFor(() => {
      expect(queryClient.getQueryData<SessionResponse>(["session"])).toEqual(SERVER_SESSION);
    });
    expect(queryClient.getQueryData<SessionResponse>(["session"])).not.toHaveProperty("token");

    const invite: WorkspaceInvite = { id: "inv1", email: "a@b.test", tokenHint: "", expiresAt: "t", acceptedAt: null };
    queryClient.setQueryData<WorkspaceInvite[]>(["workspace-invites"], [invite]);
    routes.set("DELETE /api/workspace/invites/inv1", 204);
    const revoke = renderHook(() => useRevokeWorkspaceInvite(), { wrapper });
    await act(async () => { await revoke.result.current.mutateAsync("inv1"); });
    expect(queryClient.getQueryData<WorkspaceInvite[]>(["workspace-invites"])).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});

// Merged from queries/team.test.tsx — same invariant 6 (PATCH response is
// authoritative and the ["teams"] list is written from it, never invalidated).
describe("useUpdateTeam", () => {
  const TEAM: Team = { id: "t1", name: "Emberfall", slug: "emberfall", createdAt: "t" };
  const OTHER: Team = { id: "t2", name: "Other", slug: "other", createdAt: "t" };

  it("seeds the teams cache from the PATCH response and toasts on failure — no invalidation", async () => {
    routes.set("PATCH /api/teams/t1", { ...TEAM, name: "Renamed" });
    queryClient.setQueryData<Team[]>(["teams"], [TEAM, OTHER]);
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    const toastWrapper = createQueryWrapper(queryClient, { toast: true });
    const { result } = renderHook(() => useUpdateTeam(), { wrapper: toastWrapper });
    await act(async () => { await result.current.mutateAsync({ teamId: "t1", name: "Renamed" }); });

    const teams = queryClient.getQueryData<Team[]>(["teams"])!;
    expect(teams.find((t) => t.id === "t1")?.name).toBe("Renamed");
    expect(teams.find((t) => t.id === "t2")?.name).toBe("Other");
    expect(invalidateSpy).not.toHaveBeenCalled();

    routes.delete("PATCH /api/teams/t1");
    await act(async () => { await result.current.mutateAsync({ teamId: "t1", name: "Nope" }).catch(() => {}); });
    await waitFor(() => expect(screen.getByText("Failed to update team")).toBeTruthy());
  });
});

// Merged from components/chat/assistant-chat-logic.test.ts — the dynamic
// companion of invariant 6: the persisted transcript key is refetched exactly
// (server-authoritative reconcile), the derivable thread list is written from
// client-known fields, and nothing is invalidated or seeded blind.
describe("settleThreadCache — terminal/resume cache settle (invariant 6)", () => {
  const row = (chatId: string, updatedAt: string) => ({ chatId, title: chatId, pinned: false, snippet: null, createdAt: "2020-01-01T00:00:00Z", updatedAt });

  it("refetches the exact transcript key and bumps the row in every cached list variant, never seeding a missing row", () => {
    const qc = new QueryClient();
    qc.setQueryData(["assistant-chats", "p1", null], [row("A", "2020-01-01T00:00:00Z"), row("B", "2020-01-01T00:00:00Z")]);
    qc.setQueryData(["assistant-chats", "p1", "runbook"], [row("A", "2020-01-01T00:00:00Z")]);
    qc.setQueryData(["assistant-chat", "A"], { messages: [] });
    const refetch = vi.spyOn(qc, "refetchQueries");
    const invalidate = vi.spyOn(qc, "invalidateQueries");

    settleThreadCache({ qc, chatId: "A", projectId: "p1", now: "2026-10-06T00:00:00Z" });

    expect(refetch).toHaveBeenCalledWith({ queryKey: ["assistant-chat", "A"], exact: true, type: "active" });
    const list = qc.getQueryData<Array<{ chatId: string; updatedAt: string }>>(["assistant-chats", "p1", null]) ?? [];
    expect(list.map((t) => [t.chatId, t.updatedAt])).toEqual([
      ["A", "2026-10-06T00:00:00Z"],
      ["B", "2020-01-01T00:00:00Z"],
    ]);
    const filtered = qc.getQueryData<Array<{ chatId: string; updatedAt: string }>>(["assistant-chats", "p1", "runbook"]) ?? [];
    expect(filtered[0]!.updatedAt).toBe("2026-10-06T00:00:00Z");
    expect(invalidate).not.toHaveBeenCalled();

    // Never seeds a missing row — the ingress path owns seeding.
    const fresh = new QueryClient();
    fresh.setQueryData(["assistant-chats", "p1", "runbook"], [row("B", "2020-01-01T00:00:00Z")]);
    settleThreadCache({ qc: fresh, chatId: "A", projectId: "p1", now: "2026-10-06T00:00:00Z" });
    expect((fresh.getQueryData<Array<{ chatId: string }>>(["assistant-chats", "p1", "runbook"]) ?? []).map((t) => t.chatId)).toEqual(["B"]);
  });
});
