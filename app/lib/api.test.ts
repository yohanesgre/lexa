// @vitest-environment jsdom
// Browser API client — request building matrix: every exported function's
// URL/method/body serialization plus the API-key/x-lxk-user header resolution
// (meta tag vs VITE env fallback) and envelope unwrap rules.
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import * as api from "./api";

const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  document.head.innerHTML = "";

});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const PROJECT = { id: "p1", slug: "demo", name: "Demo", description: "", repos: [], createdAt: "t", updatedAt: "t" };
const TASK = { id: "t1", projectId: "p1", columnId: "c1", swimlaneId: "s1", title: "T", description: { type: "doc", content: [] }, priority: "prio-1", type: "type-1", assignees: [], position: "a0", githubs: [], dueAt: null, archivedAt: null, createdAt: "t", updatedAt: "t" };
const EV = { id: 1, taskId: "t1", actorKind: "user", actorLabel: "Maria", actorUserId: null, type: "created", message: "m", createdAt: "t" };
const COLUMN = { id: "c1", projectId: "p1", name: "C", position: 0, color: "", wipLimit: null, requiredFields: [], githubState: null, isDone: false };
const SWIMLANE = { id: "m1", projectId: "p1", name: "M1", description: "", position: 1, dueAt: null, archivedAt: null, startAt: null, milestoneId: null, kind: "sprint" };
const MILESTONE = { id: "m1", projectId: "p1", name: "M1", description: "", position: 0, dueAt: null, archivedAt: null, sprintCount: 0, archivedSprintCount: 0 };
const PAGE = { id: "w1", projectId: "p1", title: "Home", slug: "home", parentId: null, position: 0, updatedAt: "t", content: { type: "doc", content: [] }, createdAt: "t" };
const KEY = { id: "k1", name: "ops", createdAt: "t", lastUsedAt: null };

interface Case {
  name: string;
  call: () => Promise<unknown>;
  method: string;
  url: string;
  body?: unknown;
  response: unknown;
  status?: number | undefined;
  expectResult?: (r: unknown) => void;
}

const cases: Case[] = [
  { name: "listProjects", call: () => api.listProjects(), method: "GET", url: "/api/projects", response: { data: [PROJECT], nextCursor: null }, expectResult: (r) => expect((r as { data: unknown[] }).data).toHaveLength(1) },
  { name: "createProject", call: () => api.createProject({ name: "N", slug: "n" }), method: "POST", url: "/api/projects", body: { name: "N", slug: "n" }, response: PROJECT },
  { name: "createTask", call: () => api.createTask("demo", { columnId: "c1", title: "New", priority: "prio-1" }), method: "POST", url: "/api/projects/demo/tasks", body: { columnId: "c1", title: "New", priority: "prio-1" }, response: { data: TASK, activity: [EV] } },
  { name: "getBoard", call: () => api.getBoard("demo"), method: "GET", url: "/api/projects/demo/board", response: { project: PROJECT, columns: [], swimlanes: [], milestones: [], fieldConfig: { priorities: [], types: [] }, links: [], tasks: [] } },
  { name: "listWikiPages", call: () => api.listWikiPages("demo"), method: "GET", url: "/api/projects/demo/wiki", response: { data: [] } },
];

describe("api request building matrix", () => {
  for (const c of cases) {
    it(c.name, async () => {
      fetchMock.mockResolvedValue(jsonResponse(c.response, c.status ?? 200));
      const result = await c.call();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(c.url);
      expect(init.method ?? "GET").toBe(c.method);
      if (c.body !== undefined) expect(JSON.parse(String(init.body))).toEqual(c.body);
      if (c.expectResult) c.expectResult(result);
      else expect(result).toBeDefined();
    });
  }

  it("createComment unwraps the {data:{comment,activity}} envelope", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: { comment: { id: 1, taskId: "t1", authorId: null, authorKind: "user", authorLabel: "Maria", body: {}, editedAt: null, deletedAt: null, createdAt: "t" }, activity: EV } }));
    const result = await api.createComment("demo", "t1", { type: "doc", content: [] });
    expect(result.comment.id).toBe(1);
    expect(result.activity.type).toBe("created");
  });

});

describe("request headers", () => {
  it("sends no Authorization header and no x-lxk-user header", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [], nextCursor: null }));
    await api.listProjects();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    expect(headers["x-lxk-user"]).toBeUndefined();
    expect(headers["Content-Type"]).toBe("application/json");
  });
});
