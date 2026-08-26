import type { Project, ProjectRepo, Column, Swimlane, Task, Board, Milestone, WikiPageMeta, WikiPage, WikiPageRevision, WikiPageRevisionSummary, TipTapDoc, ApiKey, ApiKeyCreateResult, Dashboard, FieldConfig, HearthTask, HearthTaskLog, HearthTaskStatus, LexaAgent, LexaSkill, HearthProvider, HearthSession, DocumentSource, Runtime, RuntimeEvent, Machine, TaskLink, TaskLinkSuggestion, ActivityEvent, ActivityItem, TaskComment, GithubIssueSummary, Team, TeamMember, TeamMemberRole, WorkspaceInvite, SessionInfo, LexaUser, Attachment } from "../../shared/types";
import type { HeraldSettingsMasked, HeraldSettingsInput, HeraldChatTranscript, ModelListResult, HeraldProvider, HeraldProviderModel, HeraldUsage, HeraldCall, HeraldProjectSettings } from "../../shared/herald";

const BASE = "/api";

// SSR: resolve the request's origin + cookie so a server-side prefetch (route
// loader during SSR) hits the same REST API the browser uses. Safe because
// vite.config.ts excludes @tanstack/react-start-server from the client dep
// optimizer. Client-side this is never called — fetch stays same-origin and
// the session cookie flows implicitly.
async function serverRequestContext(): Promise<{ origin: string; cookie?: string }> {
  const origin =
    typeof process !== "undefined"
      ? (process.env.LXK_PUBLIC_URL ?? "http://localhost:3000")
      : "http://localhost:3000";
  try {
    const { getRequest } = await import("@tanstack/react-start-server");
    const req = getRequest();
    return { origin, cookie: req?.headers.get("cookie") ?? undefined };
  } catch {
    // No request context (unit tests) — fetch absolute, no cookie.
    return { origin, cookie: undefined };
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  // FormData bodies must reach the browser untouched — it supplies the
  // multipart boundary via Content-Type; a JSON override breaks the upload.
  const isForm = typeof FormData !== "undefined" && init?.body instanceof FormData;
  const headers: Record<string, string> = { ...(isForm ? {} : { "Content-Type": "application/json" }), ...init?.headers as Record<string, string> };
  let target = url;
  if (typeof window === "undefined") {
    const { origin, cookie } = await serverRequestContext();
    target = `${origin}${url}`;
    if (cookie) headers.cookie = cookie;
  }
  const res = await fetch(target, { ...init, headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: { code?: string; message?: string; details?: unknown } };
    const err = new Error(body.error?.message ?? `HTTP ${res.status}`) as Error & { code?: string; details?: unknown };
    err.code = body.error?.code;
    err.details = body.error?.details;
    throw err;
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export function listProjects(): Promise<{ data: Project[]; nextCursor: string | null }> {
  return request(`${BASE}/projects`);
}

// ── Setup wizard (first-run bootstrap) ──
export interface SetupStatus {
  configured: boolean;
  needsAdmin: boolean;
  hasApiKey: boolean;
  hasProjects: boolean;
  hasUsers: boolean;
}

export function getSetupStatus(): Promise<SetupStatus> {
  return request(`${BASE}/setup/status`);
}

export function setSetupAdmin(email: string): Promise<{ ok: boolean }> {
  return request(`${BASE}/setup/admin`, { method: "POST", body: JSON.stringify({ email }) });
}

export function createSetupApiKey(): Promise<{ key: string }> {
  return request(`${BASE}/setup/api-key`, { method: "POST" });
}

export function seedSampleData(): Promise<{ seeded: boolean }> {
  return request(`${BASE}/setup/seed`, { method: "POST" });
}

export function completeSetup(): Promise<{ ok: boolean }> {
  return request(`${BASE}/setup/complete`, { method: "POST" });
}

export function getDashboard(): Promise<Dashboard> {
  return request(`${BASE}/dashboard`);
}

export function createProject(input: { name: string; slug?: string; description?: string; teamId?: string | null }): Promise<Project> {
  return request(`${BASE}/projects`, { method: "POST", body: JSON.stringify(input) });
}

export function getProject(slug: string): Promise<Project> {
  return request(`${BASE}/projects/${slug}`);
}

export function deleteProject(slug: string): Promise<void> {
  return request(`${BASE}/projects/${slug}`, { method: "DELETE" });
}

export function updateProject(slug: string, input: { name?: string; description?: string }): Promise<Project> {
  return request(`${BASE}/projects/${slug}`, { method: "PATCH", body: JSON.stringify(input) });
}

export function listProjectRepos(slug: string): Promise<{ data: ProjectRepo[] }> {
  return request(`${BASE}/projects/${slug}/repos`);
}

export function replaceProjectRepos(slug: string, repos: ProjectRepo[]): Promise<{ data: ProjectRepo[] }> {
  return request(`${BASE}/projects/${slug}/repos`, { method: "PUT", body: JSON.stringify({ repos }) });
}

export function searchGithubRepos(q: string): Promise<{ data: string[] }> {
  return request(`${BASE}/settings/github/search-repos?q=${encodeURIComponent(q)}`);
}

export function listGithubIssues(slug: string, repo: string, q?: string): Promise<{ data: GithubIssueSummary[] }> {
  const qs = new URLSearchParams({ repo });
  if (q) qs.set("q", q);
  return request(`${BASE}/projects/${slug}/github/issues?${qs.toString()}`);
}

export function createTaskFromIssue(slug: string, repo: string, issueNumber: number): Promise<TaskMutationResult> {
  return request(`${BASE}/projects/${slug}/github/task-from-issue`, {
    method: "POST",
    body: JSON.stringify({ repo, issueNumber }),
  });
}

export function linkExistingIssue(slug: string, taskId: string, repo: string, issueNumber: number): Promise<TaskMutationResult> {
  return request(`${BASE}/projects/${slug}/tasks/${taskId}/github-link-existing`, {
    method: "POST",
    body: JSON.stringify({ repo, issueNumber }),
  });
}

export function listColumns(slug: string): Promise<{ data: Column[] }> {
  return request(`${BASE}/projects/${slug}/columns`);
}

export function createColumn(slug: string, input: { name: string; wipLimit?: number | null; requiredFields?: string[]; color?: string; githubState?: "open" | "closed" | null; isDone?: boolean }): Promise<Column> {
  return request(`${BASE}/projects/${slug}/columns`, { method: "POST", body: JSON.stringify(input) });
}

export function updateColumn(slug: string, id: string, input: { name?: string; wipLimit?: number | null; requiredFields?: string[]; color?: string; position?: number; githubState?: "open" | "closed" | null; isDone?: boolean }): Promise<Column> {
  return request(`${BASE}/projects/${slug}/columns/${id}`, { method: "PATCH", body: JSON.stringify(input) });
}

export function deleteColumn(slug: string, id: string): Promise<void> {
  return request(`${BASE}/projects/${slug}/columns/${id}`, { method: "DELETE" });
}

export function listSwimlanes(slug: string): Promise<{ data: Swimlane[] }> {
  return request(`${BASE}/projects/${slug}/swimlanes`);
}

export function createSwimlane(slug: string, input: { name: string; description?: string; dueAt?: string | null; startAt?: string | null; milestoneId?: string | null }): Promise<Swimlane> {
  return request(`${BASE}/projects/${slug}/swimlanes`, { method: "POST", body: JSON.stringify(input) });
}

export function updateSwimlane(slug: string, id: string, input: { name?: string; position?: number; description?: string; dueAt?: string | null; startAt?: string | null; milestoneId?: string | null }): Promise<Swimlane> {
  return request(`${BASE}/projects/${slug}/swimlanes/${id}`, { method: "PATCH", body: JSON.stringify(input) });
}

export function deleteSwimlane(slug: string, id: string): Promise<void> {
  return request(`${BASE}/projects/${slug}/swimlanes/${id}`, { method: "DELETE" });
}

export interface SwimlaneMutationResult {
  data: Swimlane;
  activity: ActivityEvent[];
}

export function archiveSwimlane(slug: string, id: string): Promise<SwimlaneMutationResult> {
  return request(`${BASE}/projects/${slug}/swimlanes/${id}/archive`, { method: "POST" });
}

export function restoreSwimlane(slug: string, id: string): Promise<SwimlaneMutationResult> {
  return request(`${BASE}/projects/${slug}/swimlanes/${id}/restore`, { method: "POST" });
}

export function listMilestones(slug: string): Promise<{ data: Milestone[] }> {
  return request(`${BASE}/projects/${slug}/milestones`);
}

export function createMilestone(slug: string, input: { name: string; description?: string; position?: number; dueAt?: string | null }): Promise<Milestone> {
  return request(`${BASE}/projects/${slug}/milestones`, { method: "POST", body: JSON.stringify(input) });
}

export function updateMilestone(slug: string, id: string, input: { name?: string; description?: string; position?: number; dueAt?: string | null }): Promise<Milestone> {
  return request(`${BASE}/projects/${slug}/milestones/${id}`, { method: "PATCH", body: JSON.stringify(input) });
}

export function deleteMilestone(slug: string, id: string): Promise<void> {
  return request(`${BASE}/projects/${slug}/milestones/${id}`, { method: "DELETE" });
}

export interface MilestoneMutationResult {
  data: Milestone;
  activity: ActivityEvent[];
}

export function archiveMilestone(slug: string, id: string): Promise<MilestoneMutationResult> {
  return request(`${BASE}/projects/${slug}/milestones/${id}/archive`, { method: "POST" });
}

export function restoreMilestone(slug: string, id: string): Promise<MilestoneMutationResult> {
  return request(`${BASE}/projects/${slug}/milestones/${id}/restore`, { method: "POST" });
}


export interface TaskMutationResult {
  data: Task;
  activity: ActivityEvent[];
}

export function createTask(slug: string, input: { columnId: string; swimlaneId?: string; title: string; description?: TipTapDoc; priority?: string; type?: string; parentId?: string; assignees?: string[]; dueAt?: string | null }): Promise<TaskMutationResult> {
  return request(`${BASE}/projects/${slug}/tasks`, { method: "POST", body: JSON.stringify(input) });
}


export function updateTask(slug: string, id: string, input: { title?: string; description?: TipTapDoc; priority?: string; type?: string; assignees?: string[]; dueAt?: string | null }): Promise<TaskMutationResult> {
  return request(`${BASE}/projects/${slug}/tasks/${id}`, { method: "PATCH", body: JSON.stringify(input) });
}

export function moveTask(slug: string, id: string, target: { columnId: string; swimlaneId: string; beforeTaskId?: string; afterTaskId?: string; clearDueAt?: boolean }): Promise<TaskMutationResult> {
  return request(`${BASE}/projects/${slug}/tasks/${id}/move`, { method: "POST", body: JSON.stringify(target) });
}

export function deleteTask(slug: string, id: string): Promise<void> {
  return request(`${BASE}/projects/${slug}/tasks/${id}`, { method: "DELETE" });
}

export function archiveTask(slug: string, id: string): Promise<TaskMutationResult> {
  return request(`${BASE}/projects/${slug}/tasks/${id}/archive`, { method: "POST" });
}

export function restoreTask(slug: string, id: string): Promise<TaskMutationResult> {
  return request(`${BASE}/projects/${slug}/tasks/${id}/restore`, { method: "POST" });
}

export function getTask(slug: string, taskId: string): Promise<Task> {
  return request(`${BASE}/projects/${slug}/tasks/${taskId}`);
}

// ── Activity timeline + comments ──

export interface ActivityPage {
  data: ActivityItem[];
  nextCursor: string | null;
}

export function getTaskActivity(slug: string, taskId: string, cursor?: string): Promise<ActivityPage> {
  return request(`${BASE}/projects/${slug}/tasks/${taskId}/activity${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
}

export async function createComment(slug: string, taskId: string, body: TipTapDoc): Promise<{ comment: TaskComment; activity: ActivityEvent }> {
  // The wire wraps the pair in { data: ... } (comment create envelope) — the
  // plan's consumers use result.comment/result.activity directly, so unwrap
  // here, at the boundary.
  const res = await request<{ data: { comment: TaskComment; activity: ActivityEvent } }>(`${BASE}/projects/${slug}/tasks/${taskId}/comments`, { method: "POST", body: JSON.stringify({ body }) });
  return res.data;
}

export async function updateComment(slug: string, taskId: string, commentId: number, body: TipTapDoc): Promise<TaskComment> {
  const res = await request<{ data: TaskComment }>(`${BASE}/projects/${slug}/tasks/${taskId}/comments/${commentId}`, { method: "PATCH", body: JSON.stringify({ body }) });
  return res.data;
}

export function deleteComment(slug: string, taskId: string, commentId: number): Promise<void> {
  return request<void>(`${BASE}/projects/${slug}/tasks/${taskId}/comments/${commentId}`, { method: "DELETE" });
}

export function getBoard(slug: string, includeArchived = false): Promise<Board> {
  const qs = includeArchived ? "?includeArchived=true" : "";
  return request(`${BASE}/projects/${slug}/board${qs}`);
}

// ── Field config (per-project priority/type options) ──

export function getFieldConfig(slug: string): Promise<FieldConfig> {
  return request(`${BASE}/projects/${slug}/field-config`);
}

export function updateFieldConfig(slug: string, input: { priorities: { id?: string; label: string; color?: string; position?: number }[]; types: { id?: string; label: string; color?: string; position?: number }[] }): Promise<FieldConfig> {
  return request(`${BASE}/projects/${slug}/field-config`, { method: "PUT", body: JSON.stringify(input) });
}

export function listWikiPages(slug: string): Promise<{ data: WikiPageMeta[] }> {
  return request(`${BASE}/projects/${slug}/wiki`);
}

export function createWikiPage(slug: string, input: { parentId?: string | null; title: string; slug?: string; content?: TipTapDoc }): Promise<WikiPage> {
  return request(`${BASE}/projects/${slug}/wiki`, { method: "POST", body: JSON.stringify(input) });
}

export function searchWikiPages(slug: string, query: string): Promise<{ data: (WikiPage & { snippet: string })[] }> {
  return request(`${BASE}/projects/${slug}/wiki/search?q=${encodeURIComponent(query)}`);
}

export function getWikiPage(slug: string, pageSlug: string): Promise<WikiPage> {
  return request(`${BASE}/projects/${slug}/wiki/${pageSlug}`);
}


export function updateWikiPage(slug: string, pageSlug: string, input: { title?: string; slug?: string; content?: TipTapDoc; parentId?: string | null; position?: number; saveType?: "autosave" | "manual" }): Promise<WikiPage> {
  return request(`${BASE}/projects/${slug}/wiki/${pageSlug}`, { method: "PATCH", body: JSON.stringify(input) });
}

export function deleteWikiPage(slug: string, pageSlug: string): Promise<void> {
  return request(`${BASE}/projects/${slug}/wiki/${pageSlug}`, { method: "DELETE" });
}

export function listRevisions(slug: string, pageSlug: string, limit?: number): Promise<{ revisions: WikiPageRevisionSummary[] }> {
  const qs = limit ? `?limit=${limit}` : "";
  return request(`${BASE}/projects/${slug}/wiki/${pageSlug}/revisions${qs}`);
}

export function getWikiRevision(slug: string, pageSlug: string, revisionId: string): Promise<{ revision: WikiPageRevision }> {
  return request(`${BASE}/projects/${slug}/wiki/${pageSlug}/revisions/${revisionId}`);
}

export function restoreWikiRevision(slug: string, pageSlug: string, revisionId: string): Promise<WikiPage> {
  return request(`${BASE}/projects/${slug}/wiki/${pageSlug}/restore`, { method: "POST", body: JSON.stringify({ revisionId }) });
}

export interface WikiShareLink {
  id: string;
  url: string;
  expiresAt: string | null;
  createdAt: string;
}

export function createWikiShareLink(slug: string, pageSlug: string, expiresAt?: string): Promise<{ link: WikiShareLink }> {
  return request(`${BASE}/projects/${slug}/wiki/pages/${pageSlug}/share`, { method: "POST", body: JSON.stringify(expiresAt ? { expiresAt } : {}) });
}

export function listWikiShareLinks(slug: string, pageSlug: string): Promise<{ data: WikiShareLink[] }> {
  return request(`${BASE}/projects/${slug}/wiki/pages/${pageSlug}/share`);
}

export function revokeWikiShareLink(slug: string, linkId: string): Promise<void> {
  return request(`${BASE}/projects/${slug}/wiki/share/${linkId}`, { method: "DELETE" });
}



export function listApiKeys(): Promise<{ data: ApiKey[] }> {
  return request(`${BASE}/settings/api-keys`);
}

export function createApiKey(name: string): Promise<ApiKeyCreateResult> {
  return request(`${BASE}/settings/api-keys`, { method: "POST", body: JSON.stringify({ name }) });
}

export function deleteApiKey(id: string): Promise<void> {
  return request(`${BASE}/settings/api-keys/${id}`, { method: "DELETE" });
}

// ── Rate limiting (app scope — admin only) ──

export interface RateLimitSettings {
  max: number;
  windowMs: number;
  envOverride: boolean;
}

export function getRateLimit(): Promise<RateLimitSettings> {
  return request(`${BASE}/settings/rate-limit`);
}

export function updateRateLimit(input: { max: number; windowMs: number }): Promise<RateLimitSettings> {
  return request(`${BASE}/settings/rate-limit`, { method: "PUT", body: JSON.stringify(input) });
}

// ── GitHub sync settings (app scope — admin only) ──

export interface GithubSettings {
  appId: string;
  privateKeySet: boolean;
  webhookSecretSet: boolean;
  source: "settings" | "env" | "none";
}

export function getGithubSettings(): Promise<GithubSettings> {
  return request(`${BASE}/settings/github`);
}

export function updateGithubSettings(input: { appId: string; privateKey?: string; webhookSecret?: string }): Promise<GithubSettings> {
  return request(`${BASE}/settings/github`, { method: "PUT", body: JSON.stringify(input) });
}

// ---- teams (Better Auth organizations) ----

export function listTeams(): Promise<{ data: Team[] }> {
  return request(`${BASE}/teams`);
}

export function createTeam(input: { name: string; slug?: string }): Promise<Team> {
  return request(`${BASE}/teams`, { method: "POST", body: JSON.stringify(input) });
}

export function deleteTeam(teamId: string): Promise<void> {
  return request(`${BASE}/teams/${teamId}`, { method: "DELETE" });
}

export function listTeamMembers(teamId: string): Promise<{ data: TeamMember[] }> {
  return request(`${BASE}/teams/${teamId}/members`);
}

export function addTeamMember(teamId: string, input: { email: string; role: TeamMemberRole }): Promise<TeamMember> {
  return request(`${BASE}/teams/${teamId}/members`, { method: "POST", body: JSON.stringify(input) });
}

export function updateTeamMemberRole(teamId: string, userId: string, role: TeamMemberRole): Promise<TeamMember> {
  return request(`${BASE}/teams/${teamId}/members/${userId}`, { method: "PATCH", body: JSON.stringify({ role }) });
}

export function removeTeamMember(teamId: string, userId: string): Promise<void> {
  return request(`${BASE}/teams/${teamId}/members/${userId}`, { method: "DELETE" });
}

// ---- workspace members / invites (superadmin) ----

export interface WorkspaceMember extends LexaUser {
  teams: Array<{ teamId: string; teamName: string; role: TeamMemberRole }>;
}

export function listWorkspaceMembers(): Promise<{ data: WorkspaceMember[] }> {
  return request(`${BASE}/workspace/members`);
}

export function updateWorkspaceMember(userId: string, action: "deactivate" | "reactivate"): Promise<LexaUser> {
  return request(`${BASE}/workspace/members/${userId}`, { method: "PATCH", body: JSON.stringify({ action }) });
}

export function deleteWorkspaceMember(userId: string): Promise<void> {
  return request(`${BASE}/workspace/members/${userId}`, { method: "DELETE" });
}

export function createWorkspaceInvite(email: string): Promise<{ link: string }> {
  return request(`${BASE}/workspace/invites`, { method: "POST", body: JSON.stringify({ email }) });
}

// Not in the contract surface (POST/DELETE only) — the wireframe's pending
// invites table needs a list; the FE calls it defensively and degrades to
// mutation-seeded rows when the endpoint is absent.
export function listWorkspaceInvites(): Promise<{ data: WorkspaceInvite[] }> {
  return request(`${BASE}/workspace/invites`);
}

export function revokeWorkspaceInvite(inviteId: string): Promise<void> {
  return request(`${BASE}/workspace/invites/${inviteId}`, { method: "DELETE" });
}

export function createSetPasswordLink(userId: string): Promise<{ link: string }> {
  return request(`${BASE}/workspace/members/${userId}/set-password-link`, { method: "POST" });
}

// ---- sessions (own only) ----

export function listSessions(): Promise<{ data: SessionInfo[] }> {
  return request(`${BASE}/sessions`);
}

export function revokeSession(sessionId: string): Promise<void> {
  return request(`${BASE}/sessions/${sessionId}/revoke`, { method: "POST" });
}

// ---- project → team assignment (superadmin any; team admin own team) ----

export function updateProjectTeam(projectId: string, teamId: string | null): Promise<Project> {
  return request(`${BASE}/projects/${projectId}/team`, { method: "PATCH", body: JSON.stringify({ teamId }) });
}

export function updateMyName(name: string): Promise<LexaUser> {
  return request(`${BASE}/me`, { method: "PATCH", body: JSON.stringify({ name }) });
}

export function listProjectMembers(slug: string): Promise<{ data: LexaUser[] }> {
  return request(`${BASE}/projects/${slug}/members`);
}

// Full user list — still the source for the project-members type-ahead
// (workspace-scoped member management lives on /api/workspace/members).
export function listUsers(): Promise<{ data: LexaUser[] }> {
  return request(`${BASE}/admin/users`);
}

export function addProjectMember(userId: string, projectId: string): Promise<{ projectId: string; projectSlug: string; role: string }> {
  return request(`${BASE}/admin/users/${userId}/projects`, { method: "PUT", body: JSON.stringify({ projectId, role: "member" }) });
}

export function removeProjectMember(userId: string, projectId: string): Promise<void> {
  return request(`${BASE}/admin/users/${userId}/projects/${projectId}`, { method: "DELETE" });
}

// ── Hearth (AI writing assistant) ──

export function createHearthTask(input: {
  slug: string;
  documentType: "task" | "wiki";
  documentId: string;
  agentId: string;
  skillId: string;
  extraPrompt?: string;
  selection?: string;
  runtimeId?: string;
}): Promise<HearthTask> {
  return request(`${BASE}/hearth/tasks`, { method: "POST", body: JSON.stringify(input) });
}

export function getHearthTask(id: string): Promise<HearthTask> {
  return request(`${BASE}/hearth/tasks/${id}`);
}

export function cancelHearthTask(id: string): Promise<HearthTask> {
  return request(`${BASE}/hearth/tasks/${id}/cancel`, { method: "POST" });
}

export function listHearthTaskLogs(id: string): Promise<{ data: HearthTaskLog[] }> {
  return request(`${BASE}/hearth/tasks/${id}/logs`);
}

export function listHearthTasks(slug: string, documentType: "task" | "wiki", documentId: string): Promise<{ data: HearthTask[] }> {
  return request(`${BASE}/hearth/tasks?slug=${encodeURIComponent(slug)}&documentType=${documentType}&documentId=${encodeURIComponent(documentId)}`);
}

export interface RecentHearthTask extends HearthTask {
  projectName: string;
}

export function listRecentHearthTasks(): Promise<{ data: RecentHearthTask[] }> {
  return request(`${BASE}/hearth/tasks/recent`);
}

export interface HearthHistoryPage {
  data: RecentHearthTask[];
  nextCursor: string | null;
  summary: Record<HearthTaskStatus, number>;
}

// Full Hearth task history (control panel): optional filters + keyset cursor.
export function listHearthTaskHistory(filters: {
  slug?: string;
  status?: HearthTaskStatus;
  skillId?: string;
  documentType?: "task" | "wiki";
  limit?: number;
  cursor?: string;
}): Promise<HearthHistoryPage> {
  const q = new URLSearchParams();
  if (filters.slug) q.set("slug", filters.slug);
  if (filters.status) q.set("status", filters.status);
  if (filters.skillId) q.set("skillId", filters.skillId);
  if (filters.documentType) q.set("documentType", filters.documentType);
  if (filters.limit) q.set("limit", String(filters.limit));
  if (filters.cursor) q.set("cursor", filters.cursor);
  const qs = q.toString();
  return request(`${BASE}/hearth/tasks/history${qs ? `?${qs}` : ""}`);
}

// ── Hearth sessions (warm opencode serve conversation mappings) ──

export function listHearthSessions(documentType: "task" | "wiki", documentId: string): Promise<{ data: HearthSession[] }> {
  return request(`${BASE}/hearth/sessions?documentType=${documentType}&documentId=${encodeURIComponent(documentId)}`);
}

// Drops the session mapping so the next Generate mints a fresh session.
// Returns 409 (HEARTH_SESSION_ACTIVE) while a task for the document runs on
// that runtime — surfaced as an error toast by the caller.
export function resetHearthSession(input: { documentType: "task" | "wiki"; documentId: string; runtimeId: string }): Promise<void> {
  return request(`${BASE}/hearth/sessions/reset`, { method: "POST", body: JSON.stringify(input) });
}

// ── Lexa Agents & Skills (global rule bundles, shared by both Hearth tiers) ──
// Routes moved off /hearth/* in migration 0010 (S14 hard cutover).

export function listHearthAgents(): Promise<{ data: LexaAgent[] }> {
  return request(`${BASE}/agents`);
}

export function createHearthAgent(input: { name: string; description?: string; instructions: string }): Promise<LexaAgent> {
  return request(`${BASE}/agents`, { method: "POST", body: JSON.stringify(input) });
}

export function updateHearthAgent(id: string, patch: { name?: string; description?: string; instructions?: string }): Promise<LexaAgent> {
  return request(`${BASE}/agents/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
}

export function deleteHearthAgent(id: string): Promise<void> {
  return request(`${BASE}/agents/${id}`, { method: "DELETE" });
}

export function replaceAgentSkills(id: string, skillIds: string[]): Promise<LexaAgent> {
  return request(`${BASE}/agents/${id}/skills`, { method: "PUT", body: JSON.stringify({ skillIds }) });
}

export function resetHearthAgent(id: string): Promise<LexaAgent> {
  return request(`${BASE}/agents/${id}/reset`, { method: "POST" });
}

export function listHearthSkills(): Promise<{ data: LexaSkill[] }> {
  return request(`${BASE}/skills`);
}

export function createHearthSkill(input: { name: string; description?: string; instructions: string }): Promise<LexaSkill> {
  return request(`${BASE}/skills`, { method: "POST", body: JSON.stringify(input) });
}

export function updateHearthSkill(id: string, patch: { name?: string; description?: string; instructions?: string }): Promise<LexaSkill> {
  return request(`${BASE}/skills/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
}

export function deleteHearthSkill(id: string): Promise<void> {
  return request(`${BASE}/skills/${id}`, { method: "DELETE" });
}

export function resetHearthSkill(id: string): Promise<LexaSkill> {
  return request(`${BASE}/skills/${id}/reset`, { method: "POST" });
}

export function listRuntimes(teamId?: string): Promise<{ data: Runtime[] }> {
  const qs = teamId ? `?teamId=${encodeURIComponent(teamId)}` : "";
  return request(`${BASE}/hearth/runtimes${qs}`);
}

export function updateRuntime(id: string, patch: { name?: string; provider?: "opencode" | "hermes" | "command-code"; agent?: string; model?: string; printLogs?: boolean; logLevel?: "" | "DEBUG" | "INFO" | "WARN" | "ERROR"; extraArgs?: string[] }): Promise<Runtime> {
  return request(`${BASE}/hearth/runtimes/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
}

export function removeRuntime(id: string): Promise<void> {
  return request(`${BASE}/hearth/runtimes/${id}`, { method: "DELETE" });
}

export function removeMachine(id: string): Promise<void> {
  return request(`${BASE}/hearth/machines/${id}`, { method: "DELETE" });
}

// ── Runtime setup events (web wizard → machine CLI listener) ──

export function createRuntimeEvent(input: {
  machineId: string;
  action: "install" | "update";
  agentCli: "opencode" | "hermes" | "command-code";
  apiKeyId?: string;
  rawKey?: string;
}): Promise<RuntimeEvent> {
  return request(`${BASE}/hearth/runtime-events`, { method: "POST", body: JSON.stringify(input) });
}

export function getRuntimeEvent(id: string): Promise<RuntimeEvent> {
  return request(`${BASE}/hearth/runtime-events/${id}`);
}

export function listMachines(): Promise<{ data: Machine[] }> {
  return request(`${BASE}/hearth/machines`);
}

export function listSources(slug: string, documentType: "task" | "wiki", documentId: string): Promise<{ data: DocumentSource[] }> {
  return request(`${BASE}/projects/${slug}/documents/${documentType}/${documentId}/sources`);
}

export function addSource(slug: string, documentType: "task" | "wiki", documentId: string, input: { kind: "wiki" | "external"; ref: string }): Promise<{ data: DocumentSource; activity: ActivityEvent[] }> {
  return request(`${BASE}/projects/${slug}/documents/${documentType}/${documentId}/sources`, { method: "POST", body: JSON.stringify(input) });
}

export function removeSource(slug: string, documentType: "task" | "wiki", documentId: string, sourceId: string): Promise<void> {
  return request(`${BASE}/projects/${slug}/documents/${documentType}/${documentId}/sources/${sourceId}`, { method: "DELETE" });
}

// ── Task links (subtask / blocked-by / related) ──

export function listTaskLinks(slug: string, taskId: string): Promise<{ data: TaskLink[] }> {
  return request(`${BASE}/projects/${slug}/tasks/${taskId}/links`);
}

export function addTaskLink(slug: string, taskId: string, input: { toTaskId: string; relation: "subtask_of" | "blocked_by" | "related_to" }): Promise<{ data: TaskLink; activity: ActivityEvent[] }> {
  return request(`${BASE}/projects/${slug}/tasks/${taskId}/links`, { method: "POST", body: JSON.stringify(input) });
}

export function removeTaskLink(slug: string, taskId: string, linkId: string): Promise<void> {
  return request(`${BASE}/projects/${slug}/tasks/${taskId}/links/${linkId}`, { method: "DELETE" });
}

export function searchTasks(slug: string, q: string, exclude = ""): Promise<{ data: TaskLinkSuggestion[] }> {
  return request(`${BASE}/projects/${slug}/tasks/search?q=${encodeURIComponent(q)}&exclude=${encodeURIComponent(exclude)}`);
}

// ── Task ↔ GitHub issue links ──

export function linkGithubIssue(slug: string, taskId: string, repo: string): Promise<TaskMutationResult> {
  return request(`${BASE}/projects/${slug}/tasks/${taskId}/github-link`, { method: "POST", body: JSON.stringify({ repo }) });
}

export function unlinkGithubIssue(slug: string, taskId: string, issueId: string): Promise<TaskMutationResult> {
  return request(`${BASE}/projects/${slug}/tasks/${taskId}/github-link/${issueId}`, { method: "DELETE" });
}

// ── Herald (server-side assistant tier) ──

export interface HeraldMemoryEntry {
  id: string;
  projectId: string;
  content: string;
  source: "manual" | "herald";
  createdAt: string;
  updatedAt: string;
}

export function getHeraldSettings(projectId: string): Promise<HeraldSettingsMasked> {
  return request(`${BASE}/herald/settings/${projectId}`);
}

export function putHeraldSettings(projectId: string, input: HeraldSettingsInput): Promise<HeraldSettingsMasked> {
  return request(`${BASE}/herald/settings/${projectId}`, { method: "PUT", body: JSON.stringify(input) });
}

export async function testHeraldSettings(
  projectId: string,
  input: HeraldSettingsInput,
  opts?: { signal?: AbortSignal }
): Promise<{ ok: boolean; latencyMs: number }> {
  try {
    return await request<{ ok: boolean; latencyMs: number }>(`${BASE}/herald/settings/${projectId}/test`, {
      method: "POST",
      body: JSON.stringify(input),
      signal: opts?.signal ?? AbortSignal.timeout(35_000),
    });
  } catch (e) {
    const err = e as { code?: string; name?: string; message?: string };
    if (!err.code) {
      const msg = `${err.name ?? ""} ${err.message ?? ""}`.toLowerCase();
      if (msg.includes("timeout") || msg.includes("abort")) {
        const mapped = new Error("Provider unreachable (timeout)") as Error & { code?: string };
        mapped.code = "PROVIDER_UNREACHABLE";
        throw mapped;
      }
    }
    throw e;
  }
}

export function listHeraldModels(projectId: string, input: HeraldSettingsInput): Promise<ModelListResult> {
  return request(`${BASE}/herald/settings/${projectId}/models`, { method: "POST", body: JSON.stringify(input) });
}

export function listHeraldProviders(): Promise<{ data: HeraldProvider[] }> {
  return request(`${BASE}/herald/providers`);
}

export function createHeraldProvider(input: { label: string; baseUrl: string; apiKey: string }): Promise<HeraldProvider> {
  return request(`${BASE}/herald/providers`, { method: "POST", body: JSON.stringify({ label: input.label, base_url: input.baseUrl, api_key: input.apiKey }) });
}

export function updateHeraldProvider(id: string, input: { label?: string; baseUrl?: string; apiKey?: string }): Promise<HeraldProvider> {
  const body: Record<string, string> = {};
  if (input.label !== undefined) body.label = input.label;
  if (input.baseUrl !== undefined) body.base_url = input.baseUrl;
  if (input.apiKey !== undefined) body.api_key = input.apiKey;
  return request(`${BASE}/herald/providers/${id}`, { method: "PATCH", body: JSON.stringify(body) });
}

export function deleteHeraldProvider(id: string): Promise<void> {
  return request(`${BASE}/herald/providers/${id}`, { method: "DELETE" });
}

export function testHeraldProvider(id: string): Promise<{ ok: boolean; latencyMs: number }> {
  return request(`${BASE}/herald/providers/${id}/test`, { method: "POST" });
}

export function fetchHeraldProviderModels(id: string): Promise<{ data: HeraldProviderModel[] }> {
  return request(`${BASE}/herald/providers/${id}/models`, { method: "POST" });
}

export function updateHeraldProviderModel(id: string, modelId: string, patch: { enabled?: boolean; priority?: number }): Promise<HeraldProviderModel> {
  return request(`${BASE}/herald/providers/${id}/models/${encodeURIComponent(modelId)}`, { method: "PATCH", body: JSON.stringify(patch) });
}

export function getHeraldUsage(): Promise<HeraldUsage> {
  return request(`${BASE}/herald/usage`);
}

export function listHeraldCalls(params?: { projectId?: string; limit?: number }): Promise<{ data: HeraldCall[] }> {
  const qs = new URLSearchParams();
  if (params?.projectId) qs.set("projectId", params.projectId);
  if (params?.limit) qs.set("limit", String(params.limit));
  const q = qs.toString();
  return request(`${BASE}/herald/calls${q ? `?${q}` : ""}`);
}

export function getHeraldProjectSettings(projectId: string): Promise<HeraldProjectSettings> {
  return request(`${BASE}/herald/settings/${projectId}`);
}

export function putHeraldProjectSettings(projectId: string, input: { providerId: string | null; modelId: string | null; fallbackModelIds: string[] }): Promise<HeraldProjectSettings> {
  return request(`${BASE}/herald/settings/${projectId}`, { method: "PUT", body: JSON.stringify({ providerId: input.providerId, modelId: input.modelId, fallbackModelIds: input.fallbackModelIds }) });
}

export function createHeraldTask(input: {
  slug: string;
  documentType: "task" | "wiki";
  documentId: string;
  prompt: string;
  agentId: string;
  skillId: string;
  selection?: string;
  attachments?: { storageKey: string; mimeType: string; name: string }[];
}): Promise<HearthTask> {
  return request(`${BASE}/herald/tasks`, { method: "POST", body: JSON.stringify(input) });
}

export function cancelHeraldTask(id: string): Promise<{ ok: boolean }> {
  return request(`${BASE}/herald/tasks/${id}/cancel`, { method: "POST" });
}

export function resetHeraldThread(documentType: "task" | "wiki", documentId: string): Promise<void> {
  return request(`${BASE}/herald/threads/${documentType}/${documentId}`, { method: "DELETE" });
}

// One decision per approval (herald-write-approvals.html): the response's
// terminal status is authoritative for that chip alone. 409s surface as
// thrown errors with code APPROVAL_EXPIRED / APPROVAL_ALREADY_DECIDED
// (details.status carries the pre-existing decision).
export interface HeraldApprovalDecision {
  approvalId: string;
  batchId: string;
  status: string;
  remaining: number;
}

export function decideHeraldApproval(approvalId: string, verdict: "approve" | "reject"): Promise<HeraldApprovalDecision> {
  return request(`${BASE}/herald/approvals/${approvalId}/decide`, { method: "POST", body: JSON.stringify({ verdict }) });
}

export function getHeraldChat(chatId: string): Promise<HeraldChatTranscript> {
  return request(`${BASE}/herald/chat/${chatId}`);
}

// Thread summary for the History dropdown (pinned-first then updated_at
// DESC, cap 100). Title is null until the server derives it from the first
// send; null renders as "New chat". snippet is a short window around the
// first ?q= match (null for title-only matches or unfiltered lists).
export interface HeraldChatThreadSummary {
  chatId: string;
  title: string | null;
  pinned: boolean;
  snippet?: string | null;
  createdAt: string;
  updatedAt: string;
}

export function listHeraldChats(projectId: string, q?: string): Promise<{ data: HeraldChatThreadSummary[] }> {
  const qs = q && q.trim() ? `?q=${encodeURIComponent(q.trim())}` : "";
  return request(`${BASE}/herald/chats/${projectId}${qs}`);
}

export function updateHeraldChatMeta(
  chatId: string,
  patch: { title?: string; pinned?: boolean }
): Promise<{ chatId: string; title?: string; pinned?: boolean }> {
  return request(`${BASE}/herald/chat/${chatId}`, { method: "PATCH", body: JSON.stringify(patch) });
}

export function renameHeraldChat(chatId: string, title: string): Promise<{ chatId: string; title?: string }> {
  return updateHeraldChatMeta(chatId, { title });
}

// Markdown attachment download (GET /herald/chat/:chatId/export →
// text/markdown). Frontend-only: blob → programmatic <a download> click.
// Filename prefers the Content-Disposition header, falls back to chatId.
export async function exportHeraldChat(chatId: string): Promise<void> {
  const res = await fetch(`${BASE}/herald/chat/${chatId}/export`);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
    const err = new Error(body.error?.message ?? `HTTP ${res.status}`) as Error & { code?: string };
    err.code = body.error?.code;
    throw err;
  }
  const blob = await res.blob();
  const dispo = res.headers.get("Content-Disposition") ?? "";
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(dispo);
  const name = match ? decodeURIComponent(match[1].trim()) : `herald-chat-${chatId}.md`;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function resetHeraldChat(chatId: string): Promise<void> {
  return request(`${BASE}/herald/chat/${chatId}`, { method: "DELETE" });
}

export function listHeraldMemory(projectId: string): Promise<{ data: HeraldMemoryEntry[] }> {
  return request(`${BASE}/herald/memory/${projectId}`);
}

export function addHeraldMemory(projectId: string, content: string): Promise<HeraldMemoryEntry> {
  return request(`${BASE}/herald/memory/${projectId}`, { method: "POST", body: JSON.stringify({ content }) });
}

export function removeHeraldMemory(projectId: string, memoryId: string): Promise<void> {
  return request(`${BASE}/herald/memory/${projectId}/${memoryId}`, { method: "DELETE" });
}

// ── Attachments ──

export interface AttachmentMutationResult {
  data: Attachment;
  activity: ActivityEvent[];
}

export function listTaskAttachments(slug: string, taskId: string): Promise<{ data: Attachment[] }> {
  return request(`${BASE}/projects/${slug}/tasks/${taskId}/attachments`);
}

export function listWikiAttachments(slug: string, pageSlug: string): Promise<{ data: Attachment[] }> {
  return request(`${BASE}/projects/${slug}/wiki/pages/${pageSlug}/attachments`);
}

// Plain fetch upload (no progress) — used by editor paste/drop embeds.
export async function uploadTaskAttachment(slug: string, taskId: string, file: File): Promise<AttachmentMutationResult> {
  const form = new FormData();
  form.append("file", file);
  return request(`${BASE}/projects/${slug}/tasks/${taskId}/attachments`, { method: "POST", body: form });
}

export async function uploadWikiAttachment(slug: string, pageSlug: string, file: File): Promise<{ data: Attachment }> {
  const form = new FormData();
  form.append("file", file);
  return request(`${BASE}/projects/${slug}/wiki/pages/${pageSlug}/attachments`, { method: "POST", body: form });
}

export function deleteAttachment(id: string): Promise<void> {
  return request(`${BASE}/attachments/${id}`, { method: "DELETE" });
}

// XHR upload — fetch has no upload progress and no in-flight abort, both of
// which the panel's uploading row needs (determinate bar + cancel). Client-
// only: uploads never run during SSR. Resolves with the raw envelope so the
// task path's activity rows survive (dedupe hits arrive with activity: []).
export interface UploadHandle {
  promise: Promise<{ data: Attachment; activity?: ActivityEvent[] }>;
  abort: () => void;
}

type UploadScope = { kind: "task"; taskId: string } | { kind: "wiki"; pageSlug: string };

export function uploadAttachmentWithProgress(
  slug: string,
  scope: UploadScope,
  file: File,
  onProgress?: (percent: number) => void
): UploadHandle {
  const path = scope.kind === "task"
    ? `${BASE}/projects/${slug}/tasks/${scope.taskId}/attachments`
    : `${BASE}/projects/${slug}/wiki/pages/${scope.pageSlug}/attachments`;
  const form = new FormData();
  form.append("file", file);
  const xhr = new XMLHttpRequest();
  const promise = new Promise<{ data: Attachment; activity?: ActivityEvent[] }>((resolve, reject) => {
    xhr.open("POST", path);
    xhr.responseType = "json";
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve((xhr.response ?? {}) as { data: Attachment; activity?: ActivityEvent[] });
        return;
      }
      const body = (xhr.response ?? {}) as { error?: { code?: string; message?: string; details?: unknown } };
      const err = new Error(body.error?.message ?? `HTTP ${xhr.status}`) as Error & { code?: string; details?: unknown };
      err.code = body.error?.code;
      err.details = body.error?.details;
      reject(err);
    };
    xhr.onerror = () => reject(new Error("Network error during upload"));
    xhr.onabort = () => {
      const err = new Error("Upload cancelled") as Error & { code?: string };
      err.code = "UPLOAD_CANCELLED";
      reject(err);
    };
    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
      };
    }
    xhr.send(form);
  });
  return { promise, abort: () => xhr.abort() };
}
