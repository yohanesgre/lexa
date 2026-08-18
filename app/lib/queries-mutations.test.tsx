// @vitest-environment jsdom
// Mutation hooks — invariant 6: the mutation response is authoritative; the
// cache is updated via setQueryData from the response, NEVER via
// invalidateQueries (no refetch on the mutation path).
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { Board, Task, Project, Swimlane, Column, WikiPage, FieldConfig, ActivityItem } from "../../shared/types";
import {
  useCreateProject, useUpdateProject, useDeleteProject, useCreateTask, useUpdateTask,
  useMoveTask, useDeleteTask, useArchiveTask, useRestoreTask, useCreateWikiPage,
  useUpdateWikiPage, useDeleteWikiPage, useUpdateFieldConfig, useCreateColumn,
  useUpdateColumn, useDeleteColumn, useCreateSwimlane, useUpdateSwimlane, useArchiveSwimlane,
  useDeleteSwimlane, useCreateApiKey, useDeleteApiKey, useAddComment, useDeleteComment,
  useUpdateComment, useCancelForgeTask, useAddTaskLink, useRemoveTaskLink,
  useAddSource, useRemoveSource, useCreateForgeTask, useCreateForgeAgent,
  useUpdateRateLimit, useUpdateGithubSettings, useClearGithubSettings,
} from "./queries";

const fetchMock = vi.fn();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const PROJECT: Project = { id: "p1", slug: "demo", key: "EG", name: "Demo", description: "", repos: [], createdAt: "t", updatedAt: "t" };
const PROJECT2: Project = { ...PROJECT, id: "p2", slug: "other", name: "Other" };
const COLUMN: Column = { id: "c1", projectId: "p1", name: "Todo", position: 0, color: "#888", wipLimit: null, requiredFields: [], githubState: null, isDone: false };
const SWIMLANE: Swimlane = { id: "s1", projectId: "p1", name: "Backlog", description: "", position: 0, dueAt: null, archivedAt: null, startAt: null, milestoneId: null, kind: "backlog" };
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
const PAGE: WikiPage = { id: "w1", projectId: "p1", title: "Home", slug: "home", parentId: null, position: 0, updatedAt: "t", content: { type: "doc", content: [] }, createdAt: "t" };
const PAGE2: WikiPage = { ...PAGE, id: "w2", slug: "other", title: "Other" };
const EV = { id: 1, taskId: "t1", actorKind: "user" as const, actorLabel: "Maria", actorUserId: null, type: "created" as const, message: "m", createdAt: "t" };
const COMMENT = { id: 9, taskId: "t1", authorId: "u1", authorKind: "user" as const, authorLabel: "Maria", body: { type: "doc", content: [] }, editedAt: null, deletedAt: null, createdAt: "t" };
const KEY = { id: "k1", name: "ops", createdAt: "t", lastUsedAt: null };
const LINK = { id: "l1", projectId: "p1", fromTaskId: "t1", toTaskId: "t2", relation: "blocked_by" as const, createdAt: "t" };

const routes = new Map<string, unknown>();
function mockFetch(): void {
  fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const key = `${init?.method ?? "GET"} ${url}`;
    const hit = routes.get(key) ?? routes.get(`GET ${url}`);
    if (hit === undefined) return Promise.reject(new Error(`unmocked: ${key}`));
    if (hit === 204) return Promise.resolve(new Response(null, { status: 204 }));
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
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
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
    routes.set("PUT /api/settings/github", { appId: "123456", privateKeySet: true, webhookSecretSet: true, source: "settings" });
    queryClient.setQueryData(["github-settings"], { appId: "1", privateKeySet: false, webhookSecretSet: false, source: "none" });
    const getCallsBefore = fetchMock.mock.calls.filter((c) => String(c[0]).includes("/settings/github") && (c[1] as RequestInit | undefined)?.method !== "PUT").length;
    const { result } = renderHook(() => useUpdateGithubSettings(), { wrapper });
    await act(async () => { await result.current.mutateAsync({ appId: "123456", webhookSecret: "" }); });
    expect(queryClient.getQueryData(["github-settings"])).toEqual({ appId: "123456", privateKeySet: true, webhookSecretSet: true, source: "settings" });
    const getCallsAfter = fetchMock.mock.calls.filter((c) => String(c[0]).includes("/settings/github") && (c[1] as RequestInit | undefined)?.method !== "PUT").length;
    expect(getCallsAfter).toBe(getCallsBefore);
  });

  it("useClearGithubSettings sends the all-empty clear body and replaces the cache — no refetch", async () => {
    routes.set("PUT /api/settings/github", { appId: "", privateKeySet: false, webhookSecretSet: false, source: "none" });
    queryClient.setQueryData(["github-settings"], { appId: "123456", privateKeySet: true, webhookSecretSet: true, source: "settings" });
    const getCallsBefore = fetchMock.mock.calls.filter((c) => String(c[0]).includes("/settings/github") && (c[1] as RequestInit | undefined)?.method !== "PUT").length;
    const { result } = renderHook(() => useClearGithubSettings(), { wrapper });
    await act(async () => { await result.current.mutateAsync(undefined); });
    const put = fetchMock.mock.calls.find((c) => String(c[0]).includes("/settings/github") && (c[1] as RequestInit | undefined)?.method === "PUT");
    expect(JSON.parse(String((put?.[1] as RequestInit | undefined)?.body))).toEqual({ appId: "", privateKey: "", webhookSecret: "" });
    expect(queryClient.getQueryData(["github-settings"])).toEqual({ appId: "", privateKeySet: false, webhookSecretSet: false, source: "none" });
    const getCallsAfter = fetchMock.mock.calls.filter((c) => String(c[0]).includes("/settings/github") && (c[1] as RequestInit | undefined)?.method !== "PUT").length;
    expect(getCallsAfter).toBe(getCallsBefore);
  });

  it("useDeleteApiKey filters the row", async () => {
    routes.set("DELETE /api/settings/api-keys/k1", 204);
    queryClient.setQueryData(["api-keys"], [KEY]);
    const { result } = renderHook(() => useDeleteApiKey(), { wrapper });
    await act(async () => { await result.current.mutateAsync("k1"); });
    expect(queryClient.getQueryData(["api-keys"])).toEqual([]);
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
    expect(pages[0].data).toHaveLength(3);
    expect(pages[0].data[2]).toMatchObject({ kind: "event", type: "created" });
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
    const data = (queryClient.getQueryData(["task-activity", "demo", "t1"]) as { pages: { data: ActivityItem[] }[] }).pages[0].data;
    expect(data.find((i) => i.kind === "comment")).toMatchObject({ kind: "comment", editedAt: "t2" });
  });

  it("useDeleteComment removes the comment card and prepends a local comment_deleted row", async () => {
    routes.set("DELETE /api/projects/demo/tasks/t1/comments/9", 204);
    seedActivity();
    const { result } = renderHook(() => useDeleteComment("demo", "t1"), { wrapper });
    await act(async () => { await result.current.mutateAsync(9); });
    const data = (queryClient.getQueryData(["task-activity", "demo", "t1"]) as { pages: { data: ActivityItem[] }[] }).pages[0].data;
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
    expect(pages[0].data).toHaveLength(2);
  });
});

describe("forge mutations", () => {
  it("useCancelForgeTask updates recent + every cached history page in place", async () => {
    routes.set("POST /api/forge/tasks/ft1/cancel", { id: "ft1", status: "cancelled" });
    const recent = [{ id: "ft1", status: "queued", projectName: "Demo" }];
    queryClient.setQueryData(["forge-recent-tasks"], recent);
    queryClient.setQueryData(["forge-task-history", {}, null], { data: [{ id: "ft1", status: "queued" }], nextCursor: null, summary: { queued: 1, running: 0, completed: 0, failed: 0, cancelled: 0 } });
    const { result } = renderHook(() => useCancelForgeTask(), { wrapper });
    await act(async () => { await result.current.mutateAsync("ft1"); });
    expect((queryClient.getQueryData<{ status: string }[]>(["forge-recent-tasks"])![0] as { status: string }).status).toBe("cancelled");
    const page = queryClient.getQueryData<{ data: { status: string }[] }>(["forge-task-history", {}, null])!;
    expect(page.data[0]!.status).toBe("cancelled");
  });

  it("useCreateForgeTask seeds the recent list with the project name", async () => {
    routes.set("POST /api/forge/tasks", { id: "ft2", projectId: "p1", status: "queued" });
    queryClient.setQueryData(["projects"], [PROJECT]);
    queryClient.setQueryData(["forge-recent-tasks"], []);
    const { result } = renderHook(() => useCreateForgeTask(), { wrapper });
    await act(async () => { await result.current.mutateAsync({ slug: "demo", documentType: "task", documentId: "t1", agentId: "a1", skillId: "s1" }); });
    expect(queryClient.getQueryData<{ projectName: string }[]>(["forge-recent-tasks"])![0]).toMatchObject({ id: "ft2", projectName: "Demo" });
  });
});
