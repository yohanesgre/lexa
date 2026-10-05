// @vitest-environment jsdom
// Mutation hooks — invariant 6: the mutation response is authoritative; the
// cache is updated via setQueryData from the response, NEVER via
// invalidateQueries (no refetch on the mutation path).
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import type { QueryClient } from "@tanstack/react-query";
import type { Board, Task, Project, Swimlane, Milestone, Column, WikiPage, FieldConfig, ActivityItem, Dashboard } from "../../shared/types";
import { createFetchMock, createQueryWrapper, createTestQueryClient, json } from "../test-utils";
import {
  useCreateProject, useUpdateProject, useDeleteProject, useCreateTask, useUpdateTask,
  useMoveTask, useDeleteTask, useArchiveTask, useRestoreTask, useBulkTaskAction, useCreateWikiPage,
  useUpdateWikiPage, useDeleteWikiPage, useUpdateFieldConfig, useCreateColumn,
  useUpdateColumn, useDeleteColumn, useCreateSwimlane, useUpdateSwimlane, useArchiveSwimlane,
  useRestoreSwimlane, useDeleteSwimlane, useCreateMilestone, useUpdateMilestone, useArchiveMilestone,
  useRestoreMilestone,
  useCreateApiKey, useDeleteApiKey, useAddComment, useDeleteComment,
  useUpdateComment, useAddTaskLink, useRemoveTaskLink,
  useAddSource, useRemoveSource, useCreateAgent,
  useUpdateRateLimit, useUpdateGithubSettings, useClearGithubSettings,
  useCreateGithubManifest, useCompleteGithubSetup,
  useCreateMyApiKey, useDeleteMyApiKey, useRestoreWikiRevision, wikiKeys,
  useSignIn, useSetPassword, useRevokeWorkspaceInvite,
} from "./queries";
import type { SessionResponse } from "./auth";
import type { WorkspaceInvite } from "../../shared/types";

const { fetchMock, routes, mockFetch } = createFetchMock();

const PROJECT: Project = { id: "p1", slug: "demo", key: "EG", name: "Demo", description: "", repos: [], createdAt: "t", updatedAt: "t" };
const PROJECT2: Project = { ...PROJECT, id: "p2", slug: "other", name: "Other" };
const PROJECT3: Project = { ...PROJECT, id: "p3", slug: "third", name: "Third" };
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
const MILESTONE2: Milestone = { ...MILESTONE, id: "m2", name: "v2.0", position: 1 };
const FIELD_CONFIG: FieldConfig = { priorities: [{ id: "prio-1", label: "Medium", color: "#888", position: 0 }], types: [{ id: "type-1", label: "Bug", color: "#f00", position: 0 }] };
const TASK: Task = {
  id: "t1", key: "EG-1", projectId: "p1", columnId: "c1", swimlaneId: "s1", title: "T1",
  description: { type: "doc", content: [] }, priority: "prio-1", type: "type-1",
  assignees: [], position: "a0", githubs: [], dueAt: null, archivedAt: null,
  createdAt: "t", updatedAt: "t",
};
const MOVED_TASK: Task = { ...TASK, columnId: "c2", position: "a1" };
const ARCHIVED_TASK: Task = { ...TASK, archivedAt: "2026-03-01T00:00:00.000Z" };
const BOARD: Board = { project: PROJECT, columns: [COLUMN], swimlanes: [SWIMLANE], milestones: [], fieldConfig: FIELD_CONFIG, links: [], tasks: [TASK] };
const BOARD2: Board = { ...BOARD, columns: [...BOARD.columns, { ...COLUMN, id: "c2", name: "Done", position: 1 }] };
const PAGE: WikiPage = { id: "w1", projectId: "p1", title: "Home", slug: "home", parentId: null, position: 0, updatedBy: null, updatedByName: null, updatedAt: "t", content: { type: "doc", content: [] }, createdAt: "t" };
const PAGE2: WikiPage = { ...PAGE, id: "w2", slug: "other", title: "Other" };
const EV = { id: 1, taskId: "t1", actorKind: "user" as const, actorLabel: "Maria", actorUserId: null, type: "created" as const, message: "m", createdAt: "t" };
const COMMENT = { id: 9, taskId: "t1", authorId: "u1", authorKind: "user" as const, authorLabel: "Maria", body: { type: "doc", content: [] }, viaAssistant: false, editedAt: null, deletedAt: null, createdAt: "t" };
const KEY = { id: "k1", name: "ops", createdAt: "t", lastUsedAt: null };
const LINK = { id: "l1", projectId: "p1", fromTaskId: "t1", toTaskId: "t2", relation: "blocked_by" as const, createdAt: "t" };

let queryClient: QueryClient;
let wrapper: ReturnType<typeof createQueryWrapper>;

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
  it("useCreateProject prepends the response to the projects cache — no refetch", async () => {
    routes.set("POST /api/projects", PROJECT2);
    queryClient.setQueryData(["projects"], [PROJECT]);
    const { result } = renderHook(() => useCreateProject(), { wrapper });
    await act(async () => { await result.current.mutateAsync({ name: "Other", slug: "other" }); });
    expect(queryClient.getQueryData<Project[]>(["projects"])).toEqual([PROJECT2, PROJECT]);
    const projectsCalls = fetchMock.mock.calls.filter((c) => String(c[0]) === "/api/projects" && (c[1] as RequestInit | undefined)?.method !== "POST");
    expect(projectsCalls).toHaveLength(0);
  });

  it("useCreateProject prepends the full-shape ProjectHealth entry to the dashboard and bumps activeProjects — no refetch", async () => {
    routes.set("POST /api/projects", PROJECT2);
    queryClient.setQueryData(["projects"], [PROJECT]);
    queryClient.setQueryData<Dashboard>(["dashboard"], DASHBOARD);
    const { result } = renderHook(() => useCreateProject(), { wrapper });
    await act(async () => { await result.current.mutateAsync({ name: "Other", slug: "other" }); });
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

  it("useCreateProject appends a second create without losing the first", async () => {
    fetchMock
      .mockImplementationOnce(() => Promise.resolve(json(PROJECT2)))
      .mockImplementationOnce(() => Promise.resolve(json(PROJECT3)));
    queryClient.setQueryData(["projects"], [PROJECT]);
    queryClient.setQueryData<Dashboard>(["dashboard"], DASHBOARD);
    const { result } = renderHook(() => useCreateProject(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ name: "Other", slug: "other" });
      await result.current.mutateAsync({ name: "Third", slug: "third" });
    });
    const dash = queryClient.getQueryData<Dashboard>(["dashboard"])!;
    expect(dash.projects.map((h) => h.project.id)).toEqual(["p3", "p2", "p1"]);
    expect(dash.stats.activeProjects).toBe(3);
  });

  it("useCreateProject failure writes nothing to either cache", async () => {
    fetchMock.mockImplementationOnce(() => Promise.resolve(json({ error: { code: "CONFLICT", message: "nope" } }, 409)));
    queryClient.setQueryData(["projects"], [PROJECT]);
    queryClient.setQueryData<Dashboard>(["dashboard"], DASHBOARD);
    const { result } = renderHook(() => useCreateProject(), { wrapper });
    await expect(result.current.mutateAsync({ name: "Other", slug: "other" })).rejects.toThrow("nope");
    expect(queryClient.getQueryData<Project[]>(["projects"])).toEqual([PROJECT]);
    expect(queryClient.getQueryData<Dashboard>(["dashboard"])).toEqual(DASHBOARD);
  });

  // Server reality: two POSTs yield distinct ids; a duplicate slug is 409
  // SLUG_TAKEN. This case only covers a client replaying the same response
  // (e.g. a retried request resolving twice) — the id guard must dedupe it.
  it("useCreateProject replayed same response yields exactly one dashboard entry", async () => {
    routes.set("POST /api/projects", PROJECT2);
    queryClient.setQueryData(["projects"], [PROJECT]);
    queryClient.setQueryData<Dashboard>(["dashboard"], DASHBOARD);
    const { result } = renderHook(() => useCreateProject(), { wrapper });
    await act(async () => {
      await Promise.all([
        result.current.mutateAsync({ name: "Other", slug: "other" }),
        result.current.mutateAsync({ name: "Other", slug: "other" }),
      ]);
    });
    const dash = queryClient.getQueryData<Dashboard>(["dashboard"])!;
    expect(dash.projects.filter((h) => h.project.id === "p2")).toHaveLength(1);
    expect(dash.projects.map((h) => h.project.id)).toEqual(["p2", "p1"]);
    expect(dash.stats.activeProjects).toBe(2);
    expect(queryClient.getQueryData<Project[]>(["projects"])!.filter((p) => p.id === "p2")).toHaveLength(1);
  });

  it("useCreateProject second submit 409 SLUG_TAKEN keeps exactly one entry and surfaces the error", async () => {
    fetchMock
      .mockImplementationOnce(() => Promise.resolve(json(PROJECT2)))
      .mockImplementationOnce(() => Promise.resolve(json({ error: { code: "SLUG_TAKEN", message: "Slug already taken" } }, 409)));
    queryClient.setQueryData(["projects"], [PROJECT]);
    queryClient.setQueryData<Dashboard>(["dashboard"], DASHBOARD);
    const { result } = renderHook(() => useCreateProject(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ name: "Other", slug: "other" });
    });
    await act(async () => {
      await expect(result.current.mutateAsync({ name: "Other", slug: "other" })).rejects.toThrow("Slug already taken");
    });
    const dash = queryClient.getQueryData<Dashboard>(["dashboard"])!;
    expect(dash.projects.filter((h) => h.project.id === "p2")).toHaveLength(1);
    expect(dash.projects.map((h) => h.project.id)).toEqual(["p2", "p1"]);
    expect(dash.stats.activeProjects).toBe(2);
    expect(queryClient.getQueryData<Project[]>(["projects"])!.filter((p) => p.id === "p2")).toHaveLength(1);
    await waitFor(() => expect(result.current.error).toBeInstanceOf(Error));
    expect((result.current.error as Error).message).toBe("Slug already taken");
  });

  it("useUpdateProject replaces the matching row in place", async () => {
    routes.set("PATCH /api/projects/demo", { ...PROJECT, name: "Renamed" });
    queryClient.setQueryData(["projects"], [PROJECT, PROJECT2]);
    const { result } = renderHook(() => useUpdateProject(), { wrapper });
    await act(async () => { await result.current.mutateAsync({ slug: "demo", name: "Renamed" }); });
    expect(queryClient.getQueryData<Project[]>(["projects"])![0]!.name).toBe("Renamed");
    expect(queryClient.getQueryData<Project[]>(["projects"])![1]!.id).toBe("p2");
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
    // The task detail cache is NOT refetched (it was never set) and the board
    // URL was not called again.
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

  it("useUpdateTask replaces the row in the task detail cache and both boards", async () => {
    routes.set("PATCH /api/projects/demo/tasks/t1", { data: { ...TASK, title: "Renamed" }, activity: [] });
    seedBoards();
    queryClient.setQueryData(["tasks", "demo", "t1"], TASK);
    const { result } = renderHook(() => useUpdateTask("demo"), { wrapper });
    await act(async () => { await result.current.mutateAsync({ id: "t1", title: "Renamed" }); });
    expect(queryClient.getQueryData<Task>(["tasks", "demo", "t1"])!.title).toBe("Renamed");
    expect(queryClient.getQueryData<Board>(["board", "demo", false])!.tasks[0]!.title).toBe("Renamed");
  });

  it("useDeleteTask removes the card from both boards and drops the detail/activity caches", async () => {
    routes.set("DELETE /api/projects/demo/tasks/t1", 204);
    seedBoards();
    queryClient.setQueryData(["tasks", "demo", "t1"], TASK);
    queryClient.setQueryData(["task-activity", "demo", "t1"], { pages: [], pageParams: [] });
    const { result } = renderHook(() => useDeleteTask("demo"), { wrapper });
    await act(async () => { await result.current.mutateAsync({ id: "t1" }); });
    expect(queryClient.getQueryData<Board>(["board", "demo", false])!.tasks).toHaveLength(0);
    expect(queryClient.getQueryData(["tasks", "demo", "t1"])).toBeUndefined();
    expect(queryClient.getQueryData(["task-activity", "demo", "t1"])).toBeUndefined();
  });

  it("useArchiveTask removes from the live board, updates the archived board", async () => {
    routes.set("POST /api/projects/demo/tasks/t1/archive", { data: ARCHIVED_TASK, activity: [] });
    seedBoards();
    const { result } = renderHook(() => useArchiveTask("demo"), { wrapper });
    await act(async () => { await result.current.mutateAsync({ id: "t1" }); });
    expect(queryClient.getQueryData<Board>(["board", "demo", false])!.tasks).toHaveLength(0);
    expect(queryClient.getQueryData<Board>(["board", "demo", true])!.tasks[0]!.archivedAt).toBe(ARCHIVED_TASK.archivedAt);
  });

  it("useRestoreTask re-inserts into the live board sorted by position", async () => {
    routes.set("POST /api/projects/demo/tasks/t1/restore", { data: { ...TASK, position: "a5" }, activity: [] });
    queryClient.setQueryData(["board", "demo", false], { ...BOARD2, tasks: [{ ...TASK, id: "t2", position: "a0" }] });
    queryClient.setQueryData(["board", "demo", true], { ...BOARD2, tasks: [ARCHIVED_TASK] });
    const { result } = renderHook(() => useRestoreTask("demo"), { wrapper });
    await act(async () => { await result.current.mutateAsync({ id: "t1" }); });
    const live = queryClient.getQueryData<Board>(["board", "demo", false])!;
    expect(live.tasks.map((t) => t.id)).toEqual(["t2", "t1"]);
    expect((queryClient.getQueryData<Board>(["board", "demo", true])!.tasks[0] as Task).archivedAt).toBeNull();
  });
});

describe("wiki mutations", () => {
  it("useCreateWikiPage appends to the list and seeds the detail cache", async () => {
    routes.set("POST /api/projects/demo/wiki", PAGE2);
    queryClient.setQueryData(["wiki", "demo"], [PAGE]);
    const { result } = renderHook(() => useCreateWikiPage("demo"), { wrapper });
    await act(async () => { await result.current.mutateAsync({ title: "Other" }); });
    expect(queryClient.getQueryData<WikiPage[]>(["wiki", "demo"])!.map((p) => p.slug)).toEqual(["home", "other"]);
    expect(queryClient.getQueryData(["wikiPage", "demo", "other"])).toEqual(PAGE2);
  });

  it("useUpdateWikiPage replaces the row in the list and detail caches", async () => {
    routes.set("PATCH /api/projects/demo/wiki/home", { ...PAGE, title: "Renamed" });
    queryClient.setQueryData(["wiki", "demo"], [PAGE, PAGE2]);
    queryClient.setQueryData(["wikiPage", "demo", "home"], PAGE);
    const { result } = renderHook(() => useUpdateWikiPage("demo"), { wrapper });
    await act(async () => { await result.current.mutateAsync({ pageSlug: "home", title: "Renamed" }); });
    expect(queryClient.getQueryData<WikiPage[]>(["wiki", "demo"])![0]!.title).toBe("Renamed");
    expect(queryClient.getQueryData<WikiPage>(["wikiPage", "demo", "home"])!.title).toBe("Renamed");
  });

  it("useDeleteWikiPage filters the list and removes the detail cache", async () => {
    routes.set("DELETE /api/projects/demo/wiki/home", 204);
    queryClient.setQueryData(["wiki", "demo"], [PAGE, PAGE2]);
    queryClient.setQueryData(["wikiPage", "demo", "home"], PAGE);
    const { result } = renderHook(() => useDeleteWikiPage("demo"), { wrapper });
    await act(async () => { await result.current.mutateAsync("home"); });
    expect(queryClient.getQueryData<WikiPage[]>(["wiki", "demo"])!.map((p) => p.slug)).toEqual(["other"]);
    expect(queryClient.getQueryData(["wikiPage", "demo", "home"])).toBeUndefined();
  });

  it("useUpdateWikiPage surfaces the server error and leaves the caches untouched", async () => {
    fetchMock.mockImplementationOnce(() => Promise.resolve(json({ error: { code: "INVALID_PARENT", message: "nope" } }, 422)));
    queryClient.setQueryData(wikiKeys.pages("demo"), [PAGE, PAGE2]);
    queryClient.setQueryData(wikiKeys.page("demo", "home"), PAGE);
    const { result } = renderHook(() => useUpdateWikiPage("demo"), { wrapper });
    await expect(result.current.mutateAsync({ pageSlug: "home", title: "Renamed" })).rejects.toThrow("nope");
    expect(queryClient.getQueryData(wikiKeys.pages("demo"))).toEqual([PAGE, PAGE2]);
    expect(queryClient.getQueryData(wikiKeys.page("demo", "home"))).toEqual(PAGE);
  });

  it("useRestoreWikiRevision refetches the limit-aware revisions key used by useRevisions", async () => {
    routes.set("POST /api/projects/demo/wiki/home/restore", PAGE);
    const fresh = [{ id: "r2", title: "Home", saveType: "manual" as const, createdAt: "t2" }];
    routes.set("GET /api/projects/demo/wiki/home/revisions?limit=20", { revisions: fresh });
    expect(wikiKeys.revisions("demo", "home", 20)).toEqual(["wikiRevisions", "demo", "home", 20]);
    queryClient.setQueryData(wikiKeys.revisions("demo", "home", 20), []);
    const { result } = renderHook(() => useRestoreWikiRevision("demo"), { wrapper });
    await act(async () => { await result.current.mutateAsync({ pageSlug: "home", revisionId: "r1" }); });
    await waitFor(() => {
      expect(queryClient.getQueryData(wikiKeys.revisions("demo", "home", 20))).toEqual(fresh);
    });
  });
});

describe("board-structure + settings mutations", () => {
  it("useUpdateFieldConfig updates field-config AND both embedded board caches", async () => {
    routes.set("PUT /api/projects/demo/field-config", { ...FIELD_CONFIG, priorities: [{ id: "prio-2", label: "High", color: "#f00", position: 0 }] });
    const newConfig = { ...FIELD_CONFIG, priorities: [{ id: "prio-2", label: "High", color: "#f00", position: 0 }] };
    queryClient.setQueryData(["field-config", "demo"], FIELD_CONFIG);
    queryClient.setQueryData(["board", "demo", false], BOARD);
    queryClient.setQueryData(["board", "demo", true], BOARD);
    const { result } = renderHook(() => useUpdateFieldConfig("demo"), { wrapper });
    await act(async () => { await result.current.mutateAsync({ priorities: [], types: [] }); });
    expect(queryClient.getQueryData(["field-config", "demo"])).toEqual(newConfig);
    expect(queryClient.getQueryData<Board>(["board", "demo", false])!.fieldConfig).toEqual(newConfig);
    expect(queryClient.getQueryData<Board>(["board", "demo", true])!.fieldConfig).toEqual(newConfig);
  });

  it("useCreateColumn appends to the columns cache AND both board caches — no refetch", async () => {
    const COLUMN2: Column = { ...COLUMN, id: "c2", name: "Done", position: 1 };
    routes.set("POST /api/projects/demo/columns", COLUMN2);
    queryClient.setQueryData(["projects", "demo", "columns"], [COLUMN]);
    queryClient.setQueryData(["board", "demo", false], BOARD);
    queryClient.setQueryData(["board", "demo", true], BOARD);
    const before = boardCalls();
    const { result } = renderHook(() => useCreateColumn("demo"), { wrapper });
    await act(async () => { await result.current.mutateAsync({ name: "Done" }); });
    expect(queryClient.getQueryData<Column[]>(["projects", "demo", "columns"])!.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(queryClient.getQueryData<Board>(["board", "demo", false])!.columns.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(queryClient.getQueryData<Board>(["board", "demo", true])!.columns.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(boardCalls()).toBe(before);
  });

  it("useUpdateColumn renames the column in the columns cache AND both boards — no refetch", async () => {
    const RENAMED: Column = { ...COLUMN, name: "In Progress" };
    routes.set("PATCH /api/projects/demo/columns/c1", RENAMED);
    queryClient.setQueryData(["projects", "demo", "columns"], [COLUMN]);
    queryClient.setQueryData(["board", "demo", false], BOARD);
    queryClient.setQueryData(["board", "demo", true], BOARD);
    const before = boardCalls();
    const { result } = renderHook(() => useUpdateColumn("demo"), { wrapper });
    await act(async () => { await result.current.mutateAsync({ id: "c1", name: "In Progress" }); });
    expect(queryClient.getQueryData<Column[]>(["projects", "demo", "columns"])![0]!.name).toBe("In Progress");
    expect(queryClient.getQueryData<Board>(["board", "demo", false])!.columns[0]!.name).toBe("In Progress");
    expect(queryClient.getQueryData<Board>(["board", "demo", true])!.columns[0]!.name).toBe("In Progress");
    expect(boardCalls()).toBe(before);
  });

  it("useCreateSwimlane appends to the lanes list and both boards", async () => {    const LANE2: Swimlane = { ...SWIMLANE, id: "s2", name: "M2", position: 1 };
    routes.set("POST /api/projects/demo/swimlanes", LANE2);
    queryClient.setQueryData(["projects", "demo", "swimlanes"], [SWIMLANE]);
    queryClient.setQueryData(["board", "demo", false], BOARD);
    queryClient.setQueryData(["board", "demo", true], BOARD);
    const { result } = renderHook(() => useCreateSwimlane("demo"), { wrapper });
    await act(async () => { await result.current.mutateAsync({ name: "M2" }); });
    expect(queryClient.getQueryData<Swimlane[]>(["projects", "demo", "swimlanes"])!.map((l) => l.id)).toEqual(["s1", "s2"]);
    expect(queryClient.getQueryData<Board>(["board", "demo", false])!.swimlanes).toHaveLength(2);
  });

  it("useArchiveSwimlane updates the lane and archives matching tasks via the activity rows", async () => {
    const LANE_ARCHIVED: Swimlane = { ...SWIMLANE, id: "s1", archivedAt: "2026-03-01T00:00:00.000Z" };
    const archivedEv = { ...EV, type: "archived" as const, taskId: "t1" };
    routes.set("POST /api/projects/demo/swimlanes/s1/archive", { data: LANE_ARCHIVED, activity: [archivedEv] });
    queryClient.setQueryData(["board", "demo", false], BOARD);
    queryClient.setQueryData(["projects", "demo", "swimlanes"], [SWIMLANE]);
    const { result } = renderHook(() => useArchiveSwimlane("demo"), { wrapper });
    await act(async () => { await result.current.mutateAsync({ id: "s1" }); });
    const live = queryClient.getQueryData<Board>(["board", "demo", false])!;
    expect(live.swimlanes[0]!.archivedAt).toBe(LANE_ARCHIVED.archivedAt);
    expect((live.tasks[0] as Task).archivedAt).toBe(LANE_ARCHIVED.archivedAt);
  });

  it("useRestoreSwimlane un-archives the tasks the lane archive took down via the restored activity rows", async () => {
    const archivedAt = "2026-03-01T00:00:00.000Z";
    const olderStamp = "2025-01-01T00:00:00.000Z";
    const archivedTask: Task = { ...TASK, archivedAt };
    // Individually-archived task (absent from the activity) must stay archived.
    const individuallyArchived: Task = { ...TASK, id: "t2", key: "EG-2", archivedAt: olderStamp };
    const restoredEv = { ...EV, type: "restored" as const, taskId: "t1" };
    routes.set("POST /api/projects/demo/swimlanes/s1/restore", { data: SWIMLANE, activity: [restoredEv] });
    for (const archived of [false, true]) {
      queryClient.setQueryData(["board", "demo", archived], { ...BOARD, tasks: [archivedTask, individuallyArchived] });
    }
    queryClient.setQueryData(["projects", "demo", "swimlanes"], [{ ...SWIMLANE, archivedAt }]);
    const { result } = renderHook(() => useRestoreSwimlane("demo"), { wrapper });
    await act(async () => { await result.current.mutateAsync({ id: "s1" }); });
    for (const archived of [false, true]) {
      const live = queryClient.getQueryData<Board>(["board", "demo", archived])!;
      expect(live.swimlanes[0]!.archivedAt).toBeNull();
      expect(live.tasks.find((t) => t.id === "t1")!.archivedAt).toBeNull();
      expect(live.tasks.find((t) => t.id === "t2")!.archivedAt).toBe(olderStamp);
    }
  });

  it("useCreateApiKey prepends the key (response has no rawKey in the cache)", async () => {
    routes.set("POST /api/settings/api-keys", { key: KEY, rawKey: "lxk_secret" });
    queryClient.setQueryData(["api-keys"], []);
    const { result } = renderHook(() => useCreateApiKey(), { wrapper });
    await act(async () => { await result.current.mutateAsync("ops"); });
    expect(queryClient.getQueryData(["api-keys"])).toEqual([KEY]);
  });

  it("useUpdateRateLimit replaces the cache from the authoritative response — no refetch", async () => {
    routes.set("PUT /api/settings/rate-limit", { max: 3000, windowMs: 300000, envOverride: false });
    queryClient.setQueryData(["rate-limit"], { max: 6000, windowMs: 600000, envOverride: false });
    const getCallsBefore = fetchMock.mock.calls.filter((c) => String(c[0]).includes("/rate-limit") && (c[1] as RequestInit | undefined)?.method !== "PUT").length;
    const { result } = renderHook(() => useUpdateRateLimit(), { wrapper });
    await act(async () => { await result.current.mutateAsync({ max: 3000, windowMs: 300000 }); });
    expect(queryClient.getQueryData(["rate-limit"])).toEqual({ max: 3000, windowMs: 300000, envOverride: false });
    const getCallsAfter = fetchMock.mock.calls.filter((c) => String(c[0]).includes("/rate-limit") && (c[1] as RequestInit | undefined)?.method !== "PUT").length;
    expect(getCallsAfter).toBe(getCallsBefore);
  });

  it("useUpdateGithubSettings replaces the cache from the authoritative response — no refetch", async () => {
    routes.set("PUT /api/settings/github", { appId: "123456", appSlug: "lexa-nimbus", privateKeySet: true, webhookSecretSet: true, source: "settings" });
    queryClient.setQueryData(["github-settings"], { appId: "1", appSlug: "", privateKeySet: false, webhookSecretSet: false, source: "none" });
    const getCallsBefore = fetchMock.mock.calls.filter((c) => String(c[0]).includes("/settings/github") && (c[1] as RequestInit | undefined)?.method !== "PUT").length;
    const { result } = renderHook(() => useUpdateGithubSettings(), { wrapper });
    await act(async () => { await result.current.mutateAsync({ appId: "123456", webhookSecret: "" }); });
    expect(queryClient.getQueryData(["github-settings"])).toEqual({ appId: "123456", appSlug: "lexa-nimbus", privateKeySet: true, webhookSecretSet: true, source: "settings" });
    const getCallsAfter = fetchMock.mock.calls.filter((c) => String(c[0]).includes("/settings/github") && (c[1] as RequestInit | undefined)?.method !== "PUT").length;
    expect(getCallsAfter).toBe(getCallsBefore);
  });

  it("useClearGithubSettings sends the all-empty clear body and replaces the cache — no refetch", async () => {
    routes.set("PUT /api/settings/github", { appId: "", appSlug: "", privateKeySet: false, webhookSecretSet: false, source: "none" });
    queryClient.setQueryData(["github-settings"], { appId: "123456", appSlug: "lexa-nimbus", privateKeySet: true, webhookSecretSet: true, source: "settings" });
    const getCallsBefore = fetchMock.mock.calls.filter((c) => String(c[0]).includes("/settings/github") && (c[1] as RequestInit | undefined)?.method !== "PUT").length;
    const { result } = renderHook(() => useClearGithubSettings(), { wrapper });
    await act(async () => { await result.current.mutateAsync(undefined); });
    const put = fetchMock.mock.calls.find((c) => String(c[0]).includes("/settings/github") && (c[1] as RequestInit | undefined)?.method === "PUT");
    expect(JSON.parse(String((put?.[1] as RequestInit | undefined)?.body))).toEqual({ appId: "", appSlug: "", privateKey: "", webhookSecret: "" });
    expect(queryClient.getQueryData(["github-settings"])).toEqual({ appId: "", appSlug: "", privateKeySet: false, webhookSecretSet: false, source: "none" });
    const getCallsAfter = fetchMock.mock.calls.filter((c) => String(c[0]).includes("/settings/github") && (c[1] as RequestInit | undefined)?.method !== "PUT").length;
    expect(getCallsAfter).toBe(getCallsBefore);
  });

  it("useCreateGithubManifest POSTs to the manifest endpoint and returns the redirect payload", async () => {
    const payload = { url: "https://github.com/settings/apps/new?state=s1", state: "s1", manifest: { name: "lexa" } };
    routes.set("POST /api/settings/github/manifest", payload);
    const { result } = renderHook(() => useCreateGithubManifest(), { wrapper });
    let res: import("./api").GithubAppManifestResponse | undefined;
    await act(async () => { res = await result.current.mutateAsync(undefined); });
    expect(res).toEqual(payload);
    const post = fetchMock.mock.calls.find((c) => String(c[0]).includes("/settings/github/manifest") && (c[1] as RequestInit | undefined)?.method === "POST");
    expect(post).toBeTruthy();
  });

  it("useCompleteGithubSetup posts {code,state} and seeds the github-settings cache — no refetch", async () => {
    const summary = { appId: "7654321", appSlug: "lexa-nimbus", privateKeySet: true, webhookSecretSet: true, source: "settings" };
    routes.set("POST /api/settings/github/setup", summary);
    const getCallsBefore = fetchMock.mock.calls.filter((c) => String(c[0]).includes("/settings/github") && (c[1] as RequestInit | undefined)?.method !== "POST").length;
    const { result } = renderHook(() => useCompleteGithubSetup(), { wrapper });
    await act(async () => { await result.current.mutateAsync({ code: "c0de", state: "s1" }); });
    const post = fetchMock.mock.calls.find((c) => String(c[0]).includes("/settings/github/setup") && (c[1] as RequestInit | undefined)?.method === "POST");
    expect(JSON.parse(String((post?.[1] as RequestInit | undefined)?.body))).toEqual({ code: "c0de", state: "s1" });
    expect(queryClient.getQueryData(["github-settings"])).toEqual(summary);
    const getCallsAfter = fetchMock.mock.calls.filter((c) => String(c[0]).includes("/settings/github") && (c[1] as RequestInit | undefined)?.method !== "POST").length;
    expect(getCallsAfter).toBe(getCallsBefore);
  });

  it("useDeleteApiKey filters the row", async () => {
    routes.set("DELETE /api/settings/api-keys/k1", 204);
    queryClient.setQueryData(["api-keys"], [KEY]);
    const { result } = renderHook(() => useDeleteApiKey(), { wrapper });
    await act(async () => { await result.current.mutateAsync("k1"); });
    expect(queryClient.getQueryData(["api-keys"])).toEqual([]);
  });

  it("useCreateMyApiKey prepends the key to the my-api-keys cache (rawKey never cached)", async () => {
    const MY_KEY = { ...KEY, id: "k2", name: "cli-myhost", ownerEmail: "maria@example.com", ownerName: "Maria" };
    routes.set("POST /api/me/api-keys", { key: MY_KEY, rawKey: "lxk_secret" });
    queryClient.setQueryData(["my-api-keys"], [KEY]);
    const { result } = renderHook(() => useCreateMyApiKey(), { wrapper });
    await act(async () => { await result.current.mutateAsync("cli-myhost"); });
    expect(queryClient.getQueryData(["my-api-keys"])).toEqual([MY_KEY, KEY]);
    const body = fetchMock.mock.calls.find((c) => String(c[0]) === "/api/me/api-keys" && (c[1] as RequestInit | undefined)?.method === "POST");
    expect(JSON.parse(String((body?.[1] as RequestInit | undefined)?.body))).toEqual({ name: "cli-myhost" });
  });

  it("useDeleteMyApiKey filters the row from my-api-keys", async () => {
    routes.set("DELETE /api/me/api-keys/k1", 204);
    queryClient.setQueryData(["my-api-keys"], [KEY]);
    const { result } = renderHook(() => useDeleteMyApiKey(), { wrapper });
    await act(async () => { await result.current.mutateAsync("k1"); });
    expect(queryClient.getQueryData(["my-api-keys"])).toEqual([]);
  });
});

describe("milestone ⇄ swimlane cache fan-in (LX-21)", () => {
  it("useCreateSwimlane recomputes the milestone sprint counts", async () => {
    routes.set("POST /api/projects/demo/swimlanes", SPRINT);
    queryClient.setQueryData(["projects", "demo", "swimlanes"], [SWIMLANE]);
    queryClient.setQueryData(["milestones", "demo"], [MILESTONE]);
    const { result } = renderHook(() => useCreateSwimlane("demo"), { wrapper });
    await act(async () => { await result.current.mutateAsync({ name: "Sprint 1", milestoneId: "m1" }); });
    const ms = queryClient.getQueryData<Milestone[]>(["milestones", "demo"])!;
    expect(ms[0]).toMatchObject({ sprintCount: 1, archivedSprintCount: 0 });
  });

  it("useArchiveSwimlane bumps the milestone archivedSprintCount", async () => {
    const archived: Swimlane = { ...SPRINT, archivedAt: "2026-03-01T00:00:00.000Z" };
    routes.set("POST /api/projects/demo/swimlanes/s2/archive", { data: archived, activity: [] });
    queryClient.setQueryData(["projects", "demo", "swimlanes"], [SWIMLANE, SPRINT]);
    queryClient.setQueryData(["milestones", "demo"], [MILESTONE]);
    const { result } = renderHook(() => useArchiveSwimlane("demo"), { wrapper });
    await act(async () => { await result.current.mutateAsync({ id: "s2" }); });
    const ms = queryClient.getQueryData<Milestone[]>(["milestones", "demo"])!;
    expect(ms[0]).toMatchObject({ sprintCount: 1, archivedSprintCount: 1 });
  });

  it("useRestoreSwimlane drops the milestone archivedSprintCount", async () => {
    const archived: Swimlane = { ...SPRINT, archivedAt: "2026-03-01T00:00:00.000Z" };
    routes.set("POST /api/projects/demo/swimlanes/s2/restore", { data: SPRINT, activity: [] });
    queryClient.setQueryData(["projects", "demo", "swimlanes"], [SWIMLANE, archived]);
    queryClient.setQueryData(["milestones", "demo"], [{ ...MILESTONE, sprintCount: 1, archivedSprintCount: 1 }]);
    const { result } = renderHook(() => useRestoreSwimlane("demo"), { wrapper });
    await act(async () => { await result.current.mutateAsync({ id: "s2" }); });
    const ms = queryClient.getQueryData<Milestone[]>(["milestones", "demo"])!;
    expect(ms[0]).toMatchObject({ sprintCount: 1, archivedSprintCount: 0 });
  });

  it("useDeleteSwimlane drops the lane from the board and the milestone count", async () => {
    routes.set("DELETE /api/projects/demo/swimlanes/s2", 204);
    queryClient.setQueryData(["projects", "demo", "swimlanes"], [SWIMLANE, SPRINT]);
    queryClient.setQueryData(["milestones", "demo"], [{ ...MILESTONE, sprintCount: 1 }]);
    queryClient.setQueryData(["board", "demo", false], { ...BOARD, swimlanes: [SWIMLANE, SPRINT] });
    const { result } = renderHook(() => useDeleteSwimlane("demo"), { wrapper });
    await act(async () => { await result.current.mutateAsync({ id: "s2" }); });
    expect(queryClient.getQueryData<Board>(["board", "demo", false])!.swimlanes.map((l) => l.id)).toEqual(["s1"]);
    expect(queryClient.getQueryData<Milestone[]>(["milestones", "demo"])![0]!.sprintCount).toBe(0);
  });

  it("useUpdateMilestone mirrors the rename into the board milestone lists", async () => {
    routes.set("PATCH /api/projects/demo/milestones/m1", { ...MILESTONE, name: "Renamed" });
    queryClient.setQueryData(["milestones", "demo"], [MILESTONE]);
    queryClient.setQueryData(["board", "demo", false], { ...BOARD, milestones: [MILESTONE] });
    queryClient.setQueryData(["board", "demo", true], { ...BOARD, milestones: [MILESTONE] });
    const { result } = renderHook(() => useUpdateMilestone("demo"), { wrapper });
    await act(async () => { await result.current.mutateAsync({ id: "m1", name: "Renamed" }); });
    expect(queryClient.getQueryData<Milestone[]>(["milestones", "demo"])![0]!.name).toBe("Renamed");
    expect(queryClient.getQueryData<Board>(["board", "demo", false])!.milestones[0]!.name).toBe("Renamed");
    expect(queryClient.getQueryData<Board>(["board", "demo", true])!.milestones[0]!.name).toBe("Renamed");
  });

  it("useCreateMilestone appends the milestone to the board lists", async () => {
    routes.set("POST /api/projects/demo/milestones", MILESTONE2);
    queryClient.setQueryData(["milestones", "demo"], [MILESTONE]);
    queryClient.setQueryData(["board", "demo", false], { ...BOARD, milestones: [MILESTONE] });
    queryClient.setQueryData(["board", "demo", true], { ...BOARD, milestones: [MILESTONE] });
    const { result } = renderHook(() => useCreateMilestone("demo"), { wrapper });
    await act(async () => { await result.current.mutateAsync({ name: "v2.0" }); });
    expect(queryClient.getQueryData<Milestone[]>(["milestones", "demo"])!.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(queryClient.getQueryData<Board>(["board", "demo", false])!.milestones.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(queryClient.getQueryData<Board>(["board", "demo", true])!.milestones.map((m) => m.id)).toEqual(["m1", "m2"]);
  });

  it("useCreateSwimlane falls back to the board-true lane source when the standalone list is absent", async () => {
    const archivedSprint: Swimlane = { ...SPRINT, archivedAt: "2026-03-01T00:00:00.000Z" };
    routes.set("POST /api/projects/demo/swimlanes", SPRINT);
    queryClient.setQueryData(["milestones", "demo"], [MILESTONE]);
    queryClient.setQueryData(["board", "demo", true], { ...BOARD, swimlanes: [archivedSprint], milestones: [MILESTONE] });
    queryClient.setQueryData(["board", "demo", false], { ...BOARD, swimlanes: [], milestones: [MILESTONE] });
    const { result } = renderHook(() => useCreateSwimlane("demo"), { wrapper });
    await act(async () => { await result.current.mutateAsync({ name: "Sprint 1", milestoneId: "m1" }); });
    // The standalone list stays absent; counts come from board-true (2 for m1, 1 archived).
    expect(queryClient.getQueryData(["projects", "demo", "swimlanes"])).toBeUndefined();
    expect(queryClient.getQueryData<Milestone[]>(["milestones", "demo"])![0]).toMatchObject({ sprintCount: 2, archivedSprintCount: 1 });
    expect(queryClient.getQueryData<Board>(["board", "demo", true])!.milestones[0]).toMatchObject({ sprintCount: 2, archivedSprintCount: 1 });
    expect(queryClient.getQueryData<Board>(["board", "demo", false])!.milestones[0]).toMatchObject({ sprintCount: 2, archivedSprintCount: 1 });
  });

  it("useCreateSwimlane with no lane source leaves the milestone counts untouched", async () => {
    routes.set("POST /api/projects/demo/swimlanes", SPRINT);
    queryClient.setQueryData(["milestones", "demo"], [MILESTONE]);
    const { result } = renderHook(() => useCreateSwimlane("demo"), { wrapper });
    await act(async () => { await result.current.mutateAsync({ name: "Sprint 1", milestoneId: "m1" }); });
    expect(queryClient.getQueryData<Milestone[]>(["milestones", "demo"])![0]).toMatchObject({ sprintCount: 0, archivedSprintCount: 0 });
  });

  it("useArchiveMilestone mirrors the sprint cascade into the standalone lane list", async () => {
    const archivedAt = "2026-03-01T00:00:00.000Z";
    routes.set("POST /api/projects/demo/milestones/m1/archive", { data: { ...MILESTONE, archivedAt }, activity: [] });
    queryClient.setQueryData(["projects", "demo", "swimlanes"], [SWIMLANE, SPRINT]);
    queryClient.setQueryData(["milestones", "demo"], [MILESTONE]);
    const { result } = renderHook(() => useArchiveMilestone("demo"), { wrapper });
    await act(async () => { await result.current.mutateAsync({ id: "m1" }); });
    const lanes = queryClient.getQueryData<Swimlane[]>(["projects", "demo", "swimlanes"])!;
    expect(lanes.find((l) => l.id === "s2")!.archivedAt).toBe(archivedAt);
    expect(lanes.find((l) => l.id === "s1")!.archivedAt).toBeNull();
    expect(queryClient.getQueryData<Milestone[]>(["milestones", "demo"])![0]!.archivedAt).toBe(archivedAt);
  });

  it("useRestoreMilestone restores the milestone's lanes and tasks and trusts the response counts", async () => {
    const archivedAt = "2026-03-01T00:00:00.000Z";
    const olderStamp = "2025-01-01T00:00:00.000Z";
    const doneColumn: Column = { ...COLUMN, id: "c2", name: "Done", position: 1, isDone: true };
    const archivedSprint: Swimlane = { ...SPRINT, archivedAt, tasksDone: 2, tasksTotal: 2 };
    // Individually-archived lane: a stamp older than the milestone's, so the
    // cascade restore must leave it archived (stamp-scoped clear).
    const individuallyArchivedSprint: Swimlane = { ...SPRINT, id: "s3", name: "Sprint 2", position: 2, archivedAt: olderStamp };
    const archivedTask: Task = { ...TASK, id: "t2", swimlaneId: "s2", archivedAt };
    // Restored task in a done column: its lane delta must be skipped (it was
    // already counted done; the restore does not flip it).
    const doneRestoredTask: Task = { ...TASK, id: "t4", key: "EG-4", swimlaneId: "s2", columnId: "c2", archivedAt };
    // Individually-archived task (absent from the activity) must stay archived.
    const otherTask: Task = { ...TASK, id: "t3", swimlaneId: "s2", archivedAt: olderStamp };
    const restoredEv = { ...EV, id: 2, type: "restored" as const, taskId: "t2" };
    const restoredDoneEv = { ...EV, id: 3, type: "restored" as const, taskId: "t4" };
    routes.set("POST /api/projects/demo/milestones/m1/restore", {
      data: { ...MILESTONE, sprintCount: 2, archivedSprintCount: 1, tasksDone: 1, tasksTotal: 2 },
      activity: [restoredEv, restoredDoneEv],
    });
    queryClient.setQueryData(["projects", "demo", "swimlanes"], [SWIMLANE, archivedSprint, individuallyArchivedSprint]);
    queryClient.setQueryData(["milestones", "demo"], [{ ...MILESTONE, archivedAt, sprintCount: 2, archivedSprintCount: 2, tasksDone: 2, tasksTotal: 2 }]);
    for (const archived of [false, true]) {
      queryClient.setQueryData(["board", "demo", archived], {
        ...BOARD,
        columns: [COLUMN, doneColumn],
        milestones: [{ ...MILESTONE, archivedAt }],
        swimlanes: [SWIMLANE, archivedSprint, individuallyArchivedSprint],
        tasks: [archivedTask, doneRestoredTask, otherTask],
      });
    }
    const { result } = renderHook(() => useRestoreMilestone("demo"), { wrapper });
    await act(async () => { await result.current.mutateAsync({ id: "m1" }); });

    const lanes = queryClient.getQueryData<Swimlane[]>(["projects", "demo", "swimlanes"])!;
    expect(lanes.find((l) => l.id === "s2")!.archivedAt).toBeNull();
    // Only the non-done restored task (t2) drops the done count; the done-column
    // task (t4) is skipped, so tasksDone is 1, not 0.
    expect(lanes.find((l) => l.id === "s2")!.tasksDone).toBe(1);
    expect(lanes.find((l) => l.id === "s3")!.archivedAt).toBe(olderStamp);
    expect(lanes.find((l) => l.id === "s1")!.archivedAt).toBeNull();

    for (const archived of [false, true]) {
      const board = queryClient.getQueryData<Board>(["board", "demo", archived])!;
      expect(board.milestones[0]!.archivedAt).toBeNull();
      expect(board.swimlanes.find((l) => l.id === "s2")!.archivedAt).toBeNull();
      expect(board.swimlanes.find((l) => l.id === "s3")!.archivedAt).toBe(olderStamp);
      expect(board.tasks.find((t) => t.id === "t2")!.archivedAt).toBeNull();
      expect(board.tasks.find((t) => t.id === "t3")!.archivedAt).toBe(olderStamp);
    }

    const m = queryClient.getQueryData<Milestone[]>(["milestones", "demo"])![0]!;
    expect(m.archivedAt).toBeNull();
    expect(m).toMatchObject({ sprintCount: 2, archivedSprintCount: 1, tasksDone: 1, tasksTotal: 2 });
  });
});

describe("activity + link mutations", () => {
  function seedActivity(): void {
    queryClient.setQueryData(["task-activity", "demo", "t1"], {
      pages: [{ data: [{ kind: "event", id: 1, taskId: "t1", actorKind: "user", actorLabel: "Maria", actorUserId: null, type: "created", message: "m", createdAt: "t1" } as ActivityItem], nextCursor: null }],
      pageParams: [null],
    });
  }

  it("useAddComment prepends comment + event to page 1", async () => {
    routes.set("POST /api/projects/demo/tasks/t1/comments", { data: { comment: COMMENT, activity: EV } });
    seedActivity();
    const { result } = renderHook(() => useAddComment("demo", "t1"), { wrapper });
    await act(async () => { await result.current.mutateAsync({ type: "doc", content: [] }); });
    const pages = (queryClient.getQueryData(["task-activity", "demo", "t1"]) as { pages: { data: ActivityItem[] }[] }).pages;
    expect(pages[0]!.data).toHaveLength(3);
    expect(pages[0]!.data[2]).toMatchObject({ kind: "event", type: "created" });
  });

  it("useUpdateComment replaces the matching comment row", async () => {
    routes.set("PATCH /api/projects/demo/tasks/t1/comments/9", { data: { ...COMMENT, editedAt: "t2" } });
    seedActivity();
    queryClient.setQueryData(["task-activity", "demo", "t1"], {
      pages: [{ data: [{ kind: "comment", ...COMMENT } as ActivityItem], nextCursor: null }],
      pageParams: [null],
    });
    const { result } = renderHook(() => useUpdateComment("demo", "t1"), { wrapper });
    await act(async () => { await result.current.mutateAsync({ commentId: 9, body: { type: "doc", content: [] } }); });
    const data = (queryClient.getQueryData(["task-activity", "demo", "t1"]) as { pages: { data: ActivityItem[] }[] }).pages[0]!.data;
    expect(data.find((i) => i.kind === "comment")).toMatchObject({ kind: "comment", editedAt: "t2" });
  });

  it("useDeleteComment removes the comment card and prepends a local comment_deleted row", async () => {
    routes.set("DELETE /api/projects/demo/tasks/t1/comments/9", 204);
    seedActivity();
    const { result } = renderHook(() => useDeleteComment("demo", "t1"), { wrapper });
    await act(async () => { await result.current.mutateAsync(9); });
    const data = (queryClient.getQueryData(["task-activity", "demo", "t1"]) as { pages: { data: ActivityItem[] }[] }).pages[0]!.data;
    expect(data.filter((i) => i.kind === "comment")).toHaveLength(0);
    const last = data[data.length - 1];
    expect(last).toMatchObject({ kind: "event", type: "comment_deleted" });
  });

  it("useAddTaskLink appends the link to the links cache and both boards", async () => {
    routes.set("POST /api/projects/demo/tasks/t1/links", { data: LINK, activity: [] });
    queryClient.setQueryData(["task-links", "demo", "t1"], []);
    queryClient.setQueryData(["board", "demo", false], BOARD);
    queryClient.setQueryData(["board", "demo", true], BOARD);
    const { result } = renderHook(() => useAddTaskLink("demo", "t1"), { wrapper });
    await act(async () => { await result.current.mutateAsync({ toTaskId: "t2", relation: "blocked_by" }); });
    expect(queryClient.getQueryData(["task-links", "demo", "t1"])).toEqual([LINK]);
    expect(queryClient.getQueryData<Board>(["board", "demo", false])!.links).toEqual([LINK]);
  });

  it("useRemoveTaskLink filters the link everywhere", async () => {
    routes.set("DELETE /api/projects/demo/tasks/t1/links/l1", 204);
    queryClient.setQueryData(["task-links", "demo", "t1"], [LINK]);
    queryClient.setQueryData(["board", "demo", false], { ...BOARD, links: [LINK] });
    const { result } = renderHook(() => useRemoveTaskLink("demo", "t1"), { wrapper });
    await act(async () => { await result.current.mutateAsync("l1"); });
    expect(queryClient.getQueryData(["task-links", "demo", "t1"])).toEqual([]);
    expect(queryClient.getQueryData<Board>(["board", "demo", false])!.links).toEqual([]);
  });

  it("useAddSource appends the source and prepends activity for task documents", async () => {
    routes.set("POST /api/projects/demo/documents/task/t1/sources", { data: { id: "s1", kind: "wiki", ref: "home" }, activity: [EV] });
    queryClient.setQueryData(["sources", "demo", "task", "t1"], []);
    seedActivity();
    const { result } = renderHook(() => useAddSource("demo", "task", "t1"), { wrapper });
    await act(async () => { await result.current.mutateAsync({ kind: "wiki", ref: "home" }); });
    expect(queryClient.getQueryData(["sources", "demo", "task", "t1"])).toHaveLength(1);
    const pages = (queryClient.getQueryData(["task-activity", "demo", "t1"]) as { pages: { data: ActivityItem[] }[] }).pages;
    expect(pages[0]!.data).toHaveLength(2);
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

  it("useCreateTask in a done column bumps lane and milestone done+total", async () => {
    routes.set("POST /api/projects/demo/tasks", { data: { ...DONE_TASK, id: "t9", title: "New" }, activity: [] });
    seedProgress();
    const { result } = renderHook(() => useCreateTask("demo"), { wrapper });
    await act(async () => { await result.current.mutateAsync({ columnId: "c2", title: "New" }); });
    expect(laneCounts(false)).toEqual({ tasksDone: 2, tasksTotal: 4 });
    expect(laneCounts(true)).toEqual({ tasksDone: 2, tasksTotal: 4 });
    expect(milestoneCounts()).toEqual({ tasksDone: 2, tasksTotal: 4 });
  });

  it("useArchiveTask counts the archived task done without changing total", async () => {
    routes.set("POST /api/projects/demo/tasks/t1/archive", { data: { ...OPEN_TASK, archivedAt: "2026-03-01T00:00:00.000Z" }, activity: [] });
    seedProgress();
    const { result } = renderHook(() => useArchiveTask("demo"), { wrapper });
    await act(async () => { await result.current.mutateAsync({ id: "t1" }); });
    expect(laneCounts(false)).toEqual({ tasksDone: 2, tasksTotal: 3 });
    expect(milestoneCounts()).toEqual({ tasksDone: 2, tasksTotal: 3 });
  });

  it("useRestoreTask into a non-done column drops done but keeps total", async () => {
    routes.set("POST /api/projects/demo/tasks/t3/restore", { data: { ...OPEN_TASK, id: "t3", archivedAt: null, position: "a2" }, activity: [] });
    seedProgress();
    // Counts are toggle-independent: both board caches already count t3
    // (archived → done) even though board(false) omits the task row.
    const withArchived: Swimlane = { ...LANE, tasksDone: 2, tasksTotal: 4 };
    queryClient.setQueryData<Board>(["board", "demo", false], (old) => (old ? { ...old, swimlanes: [withArchived] } : old));
    queryClient.setQueryData<Board>(["board", "demo", true], (old) =>
      old ? { ...old, swimlanes: [withArchived], tasks: [...old.tasks, { ...OPEN_TASK, id: "t3", archivedAt: "2026-03-01T00:00:00.000Z" }] } : old
    );
    queryClient.setQueryData(["projects", "demo", "swimlanes"], [withArchived]);
    queryClient.setQueryData(["milestones", "demo"], [{ ...MILESTONE_PROGRESS, tasksDone: 2, tasksTotal: 4 }]);
    const { result } = renderHook(() => useRestoreTask("demo"), { wrapper });
    await act(async () => { await result.current.mutateAsync({ id: "t3" }); });
    expect(laneCounts(false)).toEqual({ tasksDone: 1, tasksTotal: 4 });
    expect(milestoneCounts()).toEqual({ tasksDone: 1, tasksTotal: 4 });
  });

  it("useDeleteTask of a done task drops done and total", async () => {
    routes.set("DELETE /api/projects/demo/tasks/t2", 204);
    seedProgress();
    const { result } = renderHook(() => useDeleteTask("demo"), { wrapper });
    await act(async () => { await result.current.mutateAsync({ id: "t2" }); });
    expect(laneCounts(false)).toEqual({ tasksDone: 0, tasksTotal: 2 });
    expect(milestoneCounts()).toEqual({ tasksDone: 0, tasksTotal: 2 });
  });

  // Regression: a restore whose archived row is in NO cache (only board(false)
  // is seeded, no archived board, no task-detail cache). prev stays undefined,
  // so the delta must be derived from the response lane — total unchanged, done
  // drops by one — never the create-shaped +1 total.
  it("useRestoreTask with no cached source row keeps total and drops done", async () => {
    routes.set("POST /api/projects/demo/tasks/t3/restore", { data: { ...OPEN_TASK, id: "t3", archivedAt: null, position: "a2" }, activity: [] });
    const board: Board = { ...BOARD, columns: [COLUMN, DONE_COLUMN], swimlanes: [LANE], milestones: [MILESTONE_PROGRESS], tasks: [OPEN_TASK, DONE_TASK] };
    queryClient.setQueryData(["board", "demo", false], board);
    queryClient.setQueryData(["projects", "demo", "swimlanes"], [LANE]);
    queryClient.setQueryData(["milestones", "demo"], [MILESTONE_PROGRESS]);
    expect(queryClient.getQueryData(["board", "demo", true])).toBeUndefined();
    const { result } = renderHook(() => useRestoreTask("demo"), { wrapper });
    await act(async () => { await result.current.mutateAsync({ id: "t3" }); });
    expect(laneCounts(false)).toEqual({ tasksDone: 0, tasksTotal: 3 });
    expect(milestoneCounts()).toEqual({ tasksDone: 0, tasksTotal: 3 });
  });

  // Regression: deleting a row that is in no cache must not synthesize a delta
  // (the lane is unidentifiable) — counts stay stale rather than inflate.
  it("useDeleteTask of an unknown row leaves lane counts untouched", async () => {
    routes.set("DELETE /api/projects/demo/tasks/t9", 204);
    const board: Board = { ...BOARD, columns: [COLUMN, DONE_COLUMN], swimlanes: [LANE], milestones: [MILESTONE_PROGRESS], tasks: [OPEN_TASK, DONE_TASK] };
    queryClient.setQueryData(["board", "demo", false], board);
    queryClient.setQueryData(["projects", "demo", "swimlanes"], [LANE]);
    queryClient.setQueryData(["milestones", "demo"], [MILESTONE_PROGRESS]);
    const { result } = renderHook(() => useDeleteTask("demo"), { wrapper });
    await act(async () => { await result.current.mutateAsync({ id: "t9" }); });
    expect(laneCounts(false)).toEqual({ tasksDone: 1, tasksTotal: 3 });
    expect(milestoneCounts()).toEqual({ tasksDone: 1, tasksTotal: 3 });
  });

  // Regression: the task-detail cache fallback localizes a cross-lane move even
  // when neither board cache holds the row — one lane loses a task, the other
  // gains it, totals stay balanced.
  it("useMoveTask across lanes resolves the source row from the task cache", async () => {
    routes.set("POST /api/projects/demo/tasks/t1/move", { data: { ...OPEN_TASK, swimlaneId: "s2" }, activity: [] });
    const laneA: Swimlane = { ...LANE, id: "s1", tasksDone: 0, tasksTotal: 1 };
    const laneB: Swimlane = { ...LANE, id: "s2", name: "Other", milestoneId: null, tasksDone: 0, tasksTotal: 0 };
    const board: Board = { ...BOARD, columns: [COLUMN, DONE_COLUMN], swimlanes: [laneA, laneB], milestones: [], tasks: [] };
    queryClient.setQueryData(["board", "demo", false], board);
    queryClient.setQueryData(["projects", "demo", "swimlanes"], [laneA, laneB]);
    queryClient.setQueryData(["tasks", "demo", "t1"], OPEN_TASK);
    const { result } = renderHook(() => useMoveTask("demo"), { wrapper });
    await act(async () => { await result.current.mutateAsync({ id: "t1", columnId: "c1", swimlaneId: "s2" }); });
    const lanes = queryClient.getQueryData<Swimlane[]>(["projects", "demo", "swimlanes"])!;
    expect(lanes.find((l) => l.id === "s1")).toMatchObject({ tasksDone: 0, tasksTotal: 0 });
    expect(lanes.find((l) => l.id === "s2")).toMatchObject({ tasksDone: 0, tasksTotal: 1 });
  });

  it("useMoveTask into a done column bumps done, keeps total", async () => {
    routes.set("POST /api/projects/demo/tasks/t1/move", { data: { ...OPEN_TASK, columnId: "c2", position: "a1" }, activity: [] });
    seedProgress();
    const { result } = renderHook(() => useMoveTask("demo"), { wrapper });
    await act(async () => { await result.current.mutateAsync({ id: "t1", columnId: "c2", swimlaneId: "s1" }); });
    expect(laneCounts(false)).toEqual({ tasksDone: 2, tasksTotal: 3 });
  });

  it("useBulkTaskAction archive marks the applied tasks done", async () => {
    routes.set("POST /api/projects/demo/tasks/bulk", { applied: ["t1"], failed: [] });
    seedProgress();
    const { result } = renderHook(() => useBulkTaskAction("demo"), { wrapper });
    await act(async () => { await result.current.mutateAsync({ action: "archive", ids: ["t1"] }); });
    expect(laneCounts(false)).toEqual({ tasksDone: 2, tasksTotal: 3 });
    expect(milestoneCounts()).toEqual({ tasksDone: 2, tasksTotal: 3 });
  });

  it("useUpdateColumn isDone flip recomputes the lane done count from cached tasks", async () => {
    routes.set("PATCH /api/projects/demo/columns/c1", { ...COLUMN, isDone: true });
    seedProgress();
    const { result } = renderHook(() => useUpdateColumn("demo"), { wrapper });
    await act(async () => { await result.current.mutateAsync({ id: "c1", isDone: true }); });
    expect(laneCounts(false)).toEqual({ tasksDone: 2, tasksTotal: 3 });
    expect(laneCounts(true)).toEqual({ tasksDone: 2, tasksTotal: 3 });
  });

  it("useDeleteColumn removes the column from both board caches", async () => {
    routes.set("DELETE /api/projects/demo/columns/c1", 204);
    seedProgress();
    const { result } = renderHook(() => useDeleteColumn("demo"), { wrapper });
    await act(async () => { await result.current.mutateAsync({ id: "c1" }); });
    expect(queryClient.getQueryData<Board>(["board", "demo", false])!.columns.map((c) => c.id)).toEqual(["c2"]);
    expect(queryClient.getQueryData<Board>(["board", "demo", true])!.columns.map((c) => c.id)).toEqual(["c2"]);
  });
});

describe("session + invite mutation paths (LX-100/LX-102/LX-103)", () => {
  const USER = { id: "u1", email: "y@lexa.test", name: "Y", role: "superadmin" as const, createdAt: "t", lastSeen: null };

  it("useSignIn seeds the get-session shape, then writes the authoritative read back — never invalidate", async () => {
    const SERVER_SESSION = { session: { id: "s1", userId: "u1", expiresAt: "t", createdAt: "t" }, user: USER };
    routes.set("POST /api/auth/sign-in/email", { redirect: false, token: "tok", url: "/", user: USER });
    routes.set("GET /api/auth/get-session", SERVER_SESSION);
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(() => useSignIn(), { wrapper });
    await act(async () => { await result.current.mutateAsync({ email: "y@lexa.test", password: "pw" }); });

    // The sign-in seed is replaced by the authoritative get-session read
    // written through setQueryData — invariant 6, no invalidateQueries.
    await waitFor(() => {
      expect(queryClient.getQueryData<SessionResponse>(["session"])).toEqual(SERVER_SESSION);
    });
    expect(queryClient.getQueryData<SessionResponse>(["session"])).not.toHaveProperty("token");
    expect(spy).not.toHaveBeenCalled();
  });

  it("useSetPassword neither seeds nor invalidates the session cache", async () => {
    routes.set("POST /api/auth/reset-password", { status: true });
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(() => useSetPassword(), { wrapper });
    await act(async () => { await result.current.mutateAsync({ newPassword: "password1", token: "tok" }); });
    expect(queryClient.getQueryData(["session"])).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });

  it("useRevokeWorkspaceInvite drops the row without invalidating", async () => {
    const invite: WorkspaceInvite = { id: "inv1", email: "a@b.test", tokenHint: "", expiresAt: "t", acceptedAt: null };
    queryClient.setQueryData<WorkspaceInvite[]>(["workspace-invites"], [invite]);
    routes.set("DELETE /api/workspace/invites/inv1", 204);
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(() => useRevokeWorkspaceInvite(), { wrapper });
    await act(async () => { await result.current.mutateAsync("inv1"); });
    expect(queryClient.getQueryData<WorkspaceInvite[]>(["workspace-invites"])).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});