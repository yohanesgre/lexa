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
  status?: number;
  expectResult?: (r: unknown) => void;
}

const cases: Case[] = [
  { name: "listProjects", call: () => api.listProjects(), method: "GET", url: "/api/projects", response: { data: [PROJECT], nextCursor: null }, expectResult: (r) => expect((r as { data: unknown[] }).data).toHaveLength(1) },
  { name: "getSetupStatus", call: () => api.getSetupStatus(), method: "GET", url: "/api/setup/status", response: { configured: true, needsAdmin: false, hasApiKey: true, hasProjects: true, hasUsers: true } },
  { name: "setSetupAdmin", call: () => api.setSetupAdmin("a@b.c"), method: "POST", url: "/api/setup/admin", body: { email: "a@b.c" }, response: { ok: true } },
  { name: "createSetupApiKey", call: () => api.createSetupApiKey(), method: "POST", url: "/api/setup/api-key", response: { key: "lxk_x" } },
  { name: "seedSampleData", call: () => api.seedSampleData(), method: "POST", url: "/api/setup/seed", response: { seeded: true } },
  { name: "completeSetup", call: () => api.completeSetup(), method: "POST", url: "/api/setup/complete", response: { ok: true } },
  { name: "getDashboard", call: () => api.getDashboard(), method: "GET", url: "/api/dashboard", response: { projects: [], stats: { totalTasks: 0, activeProjects: 0, wipExceeded: 0, outOfSync: 0 }, urgentTasks: [], outOfSyncTasks: [] } },
  { name: "createProject", call: () => api.createProject({ name: "N", slug: "n" }), method: "POST", url: "/api/projects", body: { name: "N", slug: "n" }, response: PROJECT },
  { name: "getProject", call: () => api.getProject("demo"), method: "GET", url: "/api/projects/demo", response: PROJECT },
  { name: "updateProject", call: () => api.updateProject("demo", { name: "X" }), method: "PATCH", url: "/api/projects/demo", body: { name: "X" }, response: PROJECT },
  { name: "listColumns", call: () => api.listColumns("demo"), method: "GET", url: "/api/projects/demo/columns", response: { data: [] } },
  { name: "createColumn", call: () => api.createColumn("demo", { name: "C", wipLimit: 2, requiredFields: ["assignee"] }), method: "POST", url: "/api/projects/demo/columns", body: { name: "C", wipLimit: 2, requiredFields: ["assignee"] }, response: COLUMN },
  { name: "updateColumn", call: () => api.updateColumn("demo", "c1", { position: 3 }), method: "PATCH", url: "/api/projects/demo/columns/c1", body: { position: 3 }, response: COLUMN },
  { name: "listSwimlanes", call: () => api.listSwimlanes("demo"), method: "GET", url: "/api/projects/demo/swimlanes", response: { data: [] } },
  { name: "createSwimlane", call: () => api.createSwimlane("demo", { name: "M1", dueAt: "2026-06-01" }), method: "POST", url: "/api/projects/demo/swimlanes", body: { name: "M1", dueAt: "2026-06-01" }, response: SWIMLANE },
  { name: "updateSwimlane", call: () => api.updateSwimlane("demo", "m1", { dueAt: null }), method: "PATCH", url: "/api/projects/demo/swimlanes/m1", body: { dueAt: null }, response: SWIMLANE },
  { name: "archiveSwimlane", call: () => api.archiveSwimlane("demo", "m1"), method: "POST", url: "/api/projects/demo/swimlanes/m1/archive", response: { data: SWIMLANE, activity: [] } },
  { name: "restoreSwimlane", call: () => api.restoreSwimlane("demo", "m1"), method: "POST", url: "/api/projects/demo/swimlanes/m1/restore", response: { data: SWIMLANE, activity: [] } },
  { name: "listMilestones", call: () => api.listMilestones("demo"), method: "GET", url: "/api/projects/demo/milestones", response: { data: [] } },
  { name: "createMilestone", call: () => api.createMilestone("demo", { name: "v1", dueAt: "2026-09-01" }), method: "POST", url: "/api/projects/demo/milestones", body: { name: "v1", dueAt: "2026-09-01" }, response: MILESTONE },
  { name: "updateMilestone", call: () => api.updateMilestone("demo", "m1", { dueAt: null }), method: "PATCH", url: "/api/projects/demo/milestones/m1", body: { dueAt: null }, response: MILESTONE },
  { name: "deleteMilestone", call: () => api.deleteMilestone("demo", "m1"), method: "DELETE", url: "/api/projects/demo/milestones/m1", response: 204 },
  { name: "archiveMilestone", call: () => api.archiveMilestone("demo", "m1"), method: "POST", url: "/api/projects/demo/milestones/m1/archive", response: { data: MILESTONE, activity: [EV] } },
  { name: "restoreMilestone", call: () => api.restoreMilestone("demo", "m1"), method: "POST", url: "/api/projects/demo/milestones/m1/restore", response: { data: MILESTONE, activity: [EV] } },
  { name: "createTask", call: () => api.createTask("demo", { columnId: "c1", title: "New", priority: "prio-1" }), method: "POST", url: "/api/projects/demo/tasks", body: { columnId: "c1", title: "New", priority: "prio-1" }, response: { data: TASK, activity: [EV] } },
  { name: "updateTask", call: () => api.updateTask("demo", "t1", { title: "X" }), method: "PATCH", url: "/api/projects/demo/tasks/t1", body: { title: "X" }, response: { data: TASK, activity: [] } },
  { name: "moveTask", call: () => api.moveTask("demo", "t1", { columnId: "c2", swimlaneId: "s1", clearDueAt: true }), method: "POST", url: "/api/projects/demo/tasks/t1/move", body: { columnId: "c2", swimlaneId: "s1", clearDueAt: true }, response: { data: TASK, activity: [] } },
  { name: "archiveTask", call: () => api.archiveTask("demo", "t1"), method: "POST", url: "/api/projects/demo/tasks/t1/archive", response: { data: TASK, activity: [EV] } },
  { name: "restoreTask", call: () => api.restoreTask("demo", "t1"), method: "POST", url: "/api/projects/demo/tasks/t1/restore", response: { data: TASK, activity: [EV] } },
  { name: "getTaskActivity", call: () => api.getTaskActivity("demo", "t1"), method: "GET", url: "/api/projects/demo/tasks/t1/activity", response: { data: [], nextCursor: null } },
  { name: "getTaskActivity cursor", call: () => api.getTaskActivity("demo", "t1", "c|u r"), method: "GET", url: "/api/projects/demo/tasks/t1/activity?cursor=c%7Cu%20r", response: { data: [], nextCursor: null } },
  { name: "getBoard", call: () => api.getBoard("demo"), method: "GET", url: "/api/projects/demo/board", response: { project: PROJECT, columns: [], swimlanes: [], milestones: [], fieldConfig: { priorities: [], types: [] }, links: [], tasks: [] } },
  { name: "getBoard includeArchived", call: () => api.getBoard("demo", true), method: "GET", url: "/api/projects/demo/board?includeArchived=true", response: { project: PROJECT, columns: [], swimlanes: [], milestones: [], fieldConfig: { priorities: [], types: [] }, links: [], tasks: [] } },
  { name: "getFieldConfig", call: () => api.getFieldConfig("demo"), method: "GET", url: "/api/projects/demo/field-config", response: { priorities: [], types: [] } },
  { name: "updateFieldConfig", call: () => api.updateFieldConfig("demo", { priorities: [{ label: "P" }], types: [] }), method: "PUT", url: "/api/projects/demo/field-config", body: { priorities: [{ label: "P" }], types: [] }, response: { priorities: [], types: [] } },
  { name: "listWikiPages", call: () => api.listWikiPages("demo"), method: "GET", url: "/api/projects/demo/wiki", response: { data: [] } },
  { name: "createWikiPage", call: () => api.createWikiPage("demo", { title: "New", parentId: null }), method: "POST", url: "/api/projects/demo/wiki", body: { title: "New", parentId: null }, response: PAGE },
  { name: "searchWikiPages", call: () => api.searchWikiPages("demo", "hello world"), method: "GET", url: "/api/projects/demo/wiki/search?q=hello%20world", response: { data: [] } },
  { name: "getWikiPage", call: () => api.getWikiPage("demo", "home"), method: "GET", url: "/api/projects/demo/wiki/home", response: PAGE },
  { name: "updateWikiPage", call: () => api.updateWikiPage("demo", "home", { title: "X" }), method: "PATCH", url: "/api/projects/demo/wiki/home", body: { title: "X" }, response: PAGE },
  { name: "listRevisions", call: () => api.listRevisions("demo", "home"), method: "GET", url: "/api/projects/demo/wiki/home/revisions", response: { revisions: [] } },
  { name: "listRevisions limit", call: () => api.listRevisions("demo", "home", 5), method: "GET", url: "/api/projects/demo/wiki/home/revisions?limit=5", response: { revisions: [] } },
  { name: "getWikiRevision", call: () => api.getWikiRevision("demo", "home", "r1"), method: "GET", url: "/api/projects/demo/wiki/home/revisions/r1", response: { revision: { id: "r1", pageId: "w1", title: "T", slug: "home", content: { type: "doc", content: [] }, contentText: "", saveType: "manual", createdAt: "t" } } },
  { name: "restoreWikiRevision", call: () => api.restoreWikiRevision("demo", "home", "r1"), method: "POST", url: "/api/projects/demo/wiki/home/restore", body: { revisionId: "r1" }, response: PAGE },
  { name: "listApiKeys", call: () => api.listApiKeys(), method: "GET", url: "/api/settings/api-keys", response: { data: [KEY] } },
  { name: "createApiKey", call: () => api.createApiKey("ops"), method: "POST", url: "/api/settings/api-keys", body: { name: "ops" }, response: { key: KEY, rawKey: "lxk_abc" }, expectResult: (r) => expect((r as { rawKey: string }).rawKey).toBe("lxk_abc") },
  { name: "getRateLimit", call: () => api.getRateLimit(), method: "GET", url: "/api/settings/rate-limit", response: { max: 6000, windowMs: 600000, envOverride: false } },
  { name: "updateRateLimit", call: () => api.updateRateLimit({ max: 3000, windowMs: 300000 }), method: "PUT", url: "/api/settings/rate-limit", body: { max: 3000, windowMs: 300000 }, response: { max: 3000, windowMs: 300000, envOverride: false } },
  { name: "getGithubSettings", call: () => api.getGithubSettings(), method: "GET", url: "/api/settings/github", response: { appId: "123456", privateKeySet: true, webhookSecretSet: true, source: "settings" } },
  { name: "updateGithubSettings", call: () => api.updateGithubSettings({ appId: "123456", webhookSecret: "" }), method: "PUT", url: "/api/settings/github", body: { appId: "123456", webhookSecret: "" }, response: { appId: "123456", privateKeySet: true, webhookSecretSet: false, source: "settings" } },
  { name: "listUsers", call: () => api.listUsers(), method: "GET", url: "/api/admin/users", response: { data: [] } },
  { name: "updateMyName", call: () => api.updateMyName("Maria"), method: "PATCH", url: "/api/me", body: { name: "Maria" }, response: { id: "u1", email: "a@b.c", name: "Maria", role: "member", createdAt: "t", lastSeen: null } },
  { name: "listProjectMembers", call: () => api.listProjectMembers("demo"), method: "GET", url: "/api/projects/demo/members", response: { data: [] } },
  { name: "addProjectMember", call: () => api.addProjectMember("u1", "p1"), method: "PUT", url: "/api/admin/users/u1/projects", body: { projectId: "p1", role: "member" }, response: { projectId: "p1", projectSlug: "demo", role: "member" } },
  { name: "removeProjectMember", call: () => api.removeProjectMember("u1", "p1"), method: "DELETE", url: "/api/admin/users/u1/projects/p1", response: undefined, status: 204, expectResult: (r) => expect(r).toBeUndefined() },
  { name: "createHearthTask", call: () => api.createHearthTask({ slug: "demo", documentType: "task", documentId: "t1", agentId: "a1", skillId: "s1" }), method: "POST", url: "/api/hearth/tasks", body: { slug: "demo", documentType: "task", documentId: "t1", agentId: "a1", skillId: "s1" }, response: { id: "ft1", status: "queued" } },
  { name: "getHearthTask", call: () => api.getHearthTask("ft1"), method: "GET", url: "/api/hearth/tasks/ft1", response: { id: "ft1", status: "queued" } },
  { name: "cancelHearthTask", call: () => api.cancelHearthTask("ft1"), method: "POST", url: "/api/hearth/tasks/ft1/cancel", response: { id: "ft1", status: "cancelled" } },
  { name: "listHearthTaskLogs", call: () => api.listHearthTaskLogs("ft1"), method: "GET", url: "/api/hearth/tasks/ft1/logs", response: { data: [] } },
  { name: "listHearthTasks", call: () => api.listHearthTasks("demo", "wiki", "w 1"), method: "GET", url: "/api/hearth/tasks?slug=demo&documentType=wiki&documentId=w%201", response: { data: [] } },
  { name: "listRecentHearthTasks", call: () => api.listRecentHearthTasks(), method: "GET", url: "/api/hearth/tasks/recent", response: { data: [] } },
  { name: "listHearthTaskHistory", call: () => api.listHearthTaskHistory({ slug: "demo", status: "running", limit: 10, cursor: "c1" }), method: "GET", url: "/api/hearth/tasks/history?slug=demo&status=running&limit=10&cursor=c1", response: { data: [], nextCursor: null, summary: { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 } } },
  { name: "listHearthAgents", call: () => api.listHearthAgents(), method: "GET", url: "/api/agents", response: { data: [] } },
  { name: "createHearthAgent", call: () => api.createHearthAgent({ name: "A", instructions: "i" }), method: "POST", url: "/api/agents", body: { name: "A", instructions: "i" }, response: { id: "a1" } },
  { name: "updateHearthAgent", call: () => api.updateHearthAgent("a1", { name: "B" }), method: "PATCH", url: "/api/agents/a1", body: { name: "B" }, response: { id: "a1", name: "B" } },
  { name: "replaceAgentSkills", call: () => api.replaceAgentSkills("a1", ["s1", "s2"]), method: "PUT", url: "/api/agents/a1/skills", body: { skillIds: ["s1", "s2"] }, response: { id: "a1", skillIds: ["s1", "s2"] } },
  { name: "resetHearthAgent", call: () => api.resetHearthAgent("a1"), method: "POST", url: "/api/agents/a1/reset", response: { id: "a1" } },
  { name: "listHearthSkills", call: () => api.listHearthSkills(), method: "GET", url: "/api/skills", response: { data: [] } },
  { name: "createHearthSkill", call: () => api.createHearthSkill({ name: "S", instructions: "i" }), method: "POST", url: "/api/skills", body: { name: "S", instructions: "i" }, response: { id: "s1" } },
  { name: "updateHearthSkill", call: () => api.updateHearthSkill("s1", { name: "S2" }), method: "PATCH", url: "/api/skills/s1", body: { name: "S2" }, response: { id: "s1", name: "S2" } },
  { name: "resetHearthSkill", call: () => api.resetHearthSkill("s1"), method: "POST", url: "/api/skills/s1/reset", response: { id: "s1" } },
  { name: "listRuntimes", call: () => api.listRuntimes(), method: "GET", url: "/api/hearth/runtimes", response: { data: [] } },
  { name: "updateRuntime", call: () => api.updateRuntime("r1", { model: "m1" }), method: "PATCH", url: "/api/hearth/runtimes/r1", body: { model: "m1" }, response: { id: "r1" } },
  { name: "removeRuntime", call: () => api.removeRuntime("r1"), method: "DELETE", url: "/api/hearth/runtimes/r1", response: undefined, status: 204, expectResult: (r) => expect(r).toBeUndefined() },
  { name: "removeMachine", call: () => api.removeMachine("m1"), method: "DELETE", url: "/api/hearth/machines/m1", response: undefined, status: 204, expectResult: (r) => expect(r).toBeUndefined() },
  { name: "createRuntimeEvent", call: () => api.createRuntimeEvent({ machineId: "m1", action: "install", agentCli: "opencode" }), method: "POST", url: "/api/hearth/runtime-events", body: { machineId: "m1", action: "install", agentCli: "opencode" }, response: { id: "e1" } },
  { name: "getRuntimeEvent", call: () => api.getRuntimeEvent("e1"), method: "GET", url: "/api/hearth/runtime-events/e1", response: { id: "e1" } },
  { name: "listMachines", call: () => api.listMachines(), method: "GET", url: "/api/hearth/machines", response: { data: [] } },
  { name: "listSources", call: () => api.listSources("demo", "task", "t1"), method: "GET", url: "/api/projects/demo/documents/task/t1/sources", response: { data: [] } },
  { name: "addSource", call: () => api.addSource("demo", "task", "t1", { kind: "wiki", ref: "home" }), method: "POST", url: "/api/projects/demo/documents/task/t1/sources", body: { kind: "wiki", ref: "home" }, response: { data: { id: "s1" }, activity: [] } },
  { name: "removeSource", call: () => api.removeSource("demo", "task", "t1", "s1"), method: "DELETE", url: "/api/projects/demo/documents/task/t1/sources/s1", response: undefined, status: 204, expectResult: (r) => expect(r).toBeUndefined() },
  { name: "listTaskLinks", call: () => api.listTaskLinks("demo", "t1"), method: "GET", url: "/api/projects/demo/tasks/t1/links", response: { data: [] } },
  { name: "addTaskLink", call: () => api.addTaskLink("demo", "t1", { toTaskId: "t2", relation: "blocked_by" }), method: "POST", url: "/api/projects/demo/tasks/t1/links", body: { toTaskId: "t2", relation: "blocked_by" }, response: { data: { id: "l1" }, activity: [] } },
  { name: "removeTaskLink", call: () => api.removeTaskLink("demo", "t1", "l1"), method: "DELETE", url: "/api/projects/demo/tasks/t1/links/l1", response: undefined, status: 204, expectResult: (r) => expect(r).toBeUndefined() },
  { name: "searchTasks", call: () => api.searchTasks("demo", "hel lo", "t1"), method: "GET", url: "/api/projects/demo/tasks/search?q=hel%20lo&exclude=t1", response: { data: [] } },
  { name: "linkGithubIssue", call: () => api.linkGithubIssue("demo", "t1", "owner/repo"), method: "POST", url: "/api/projects/demo/tasks/t1/github-link", body: { repo: "owner/repo" }, response: { data: TASK, activity: [] } },
  { name: "unlinkGithubIssue", call: () => api.unlinkGithubIssue("demo", "t1", "ghi1"), method: "DELETE", url: "/api/projects/demo/tasks/t1/github-link/ghi1", response: { data: TASK, activity: [] } },
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

  it("updateComment unwraps the {data} envelope", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: { id: 1, taskId: "t1", authorId: null, authorKind: "user", authorLabel: "Maria", body: {}, editedAt: "t", deletedAt: null, createdAt: "t" } }));
    const result = await api.updateComment("demo", "t1", 1, { type: "doc", content: [] });
    expect(result.id).toBe(1);
  });

  it("deleteTask maps 204 to undefined", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(api.deleteTask("demo", "t1")).resolves.toBeUndefined();
  });
});

describe("request headers", () => {
  // Session-based auth: no bearer key, no x-lxk-user header — the session
  // cookie is the only credential (same-origin fetch sends it automatically).
  it("sends no Authorization header and no x-lxk-user header", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [], nextCursor: null }));
    await api.listProjects();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    expect(headers["x-lxk-user"]).toBeUndefined();
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("merges caller-provided init headers with the default content-type", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    await api.completeSetup();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });
});
