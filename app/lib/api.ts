import type { Project, ProjectRepo, Column, Swimlane, Task, Board, Milestone, WikiPageMeta, WikiPage, WikiPageRevision, WikiPageRevisionSummary, TipTapDoc, ApiKey, ApiKeyCreateResult, Dashboard, FieldConfig, ForgeTask, ForgeTaskLog, ForgeTaskStatus, ForgeAgent, ForgeSkill, ForgeProvider, ForgeSession, DocumentSource, Runtime, RuntimeEvent, Machine, TaskLink, TaskLinkSuggestion, ActivityEvent, ActivityItem, TaskComment, GithubIssueSummary, Team, TeamMember, TeamMemberRole, WorkspaceInvite, SessionInfo, LexaUser } from "../../shared/types";

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
  const headers: Record<string, string> = { "Content-Type": "application/json", ...init?.headers as Record<string, string> };
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

// ── Forge (AI writing assistant) ──

export function createForgeTask(input: {
  slug: string;
  documentType: "task" | "wiki";
  documentId: string;
  agentId: string;
  skillId: string;
  extraPrompt?: string;
  selection?: string;
  runtimeId?: string;
}): Promise<ForgeTask> {
  return request(`${BASE}/forge/tasks`, { method: "POST", body: JSON.stringify(input) });
}

export function getForgeTask(id: string): Promise<ForgeTask> {
  return request(`${BASE}/forge/tasks/${id}`);
}

export function cancelForgeTask(id: string): Promise<ForgeTask> {
  return request(`${BASE}/forge/tasks/${id}/cancel`, { method: "POST" });
}

export function listForgeTaskLogs(id: string): Promise<{ data: ForgeTaskLog[] }> {
  return request(`${BASE}/forge/tasks/${id}/logs`);
}

export function listForgeTasks(slug: string, documentType: "task" | "wiki", documentId: string): Promise<{ data: ForgeTask[] }> {
  return request(`${BASE}/forge/tasks?slug=${encodeURIComponent(slug)}&documentType=${documentType}&documentId=${encodeURIComponent(documentId)}`);
}

export interface RecentForgeTask extends ForgeTask {
  projectName: string;
}

export function listRecentForgeTasks(): Promise<{ data: RecentForgeTask[] }> {
  return request(`${BASE}/forge/tasks/recent`);
}

export interface ForgeHistoryPage {
  data: RecentForgeTask[];
  nextCursor: string | null;
  summary: Record<ForgeTaskStatus, number>;
}

// Full Forge task history (control panel): optional filters + keyset cursor.
export function listForgeTaskHistory(filters: {
  slug?: string;
  status?: ForgeTaskStatus;
  skillId?: string;
  documentType?: "task" | "wiki";
  limit?: number;
  cursor?: string;
}): Promise<ForgeHistoryPage> {
  const q = new URLSearchParams();
  if (filters.slug) q.set("slug", filters.slug);
  if (filters.status) q.set("status", filters.status);
  if (filters.skillId) q.set("skillId", filters.skillId);
  if (filters.documentType) q.set("documentType", filters.documentType);
  if (filters.limit) q.set("limit", String(filters.limit));
  if (filters.cursor) q.set("cursor", filters.cursor);
  const qs = q.toString();
  return request(`${BASE}/forge/tasks/history${qs ? `?${qs}` : ""}`);
}

// ── Forge sessions (warm opencode serve conversation mappings) ──

export function listForgeSessions(documentType: "task" | "wiki", documentId: string): Promise<{ data: ForgeSession[] }> {
  return request(`${BASE}/forge/sessions?documentType=${documentType}&documentId=${encodeURIComponent(documentId)}`);
}

// Drops the session mapping so the next Generate mints a fresh session.
// Returns 409 (FORGE_SESSION_ACTIVE) while a task for the document runs on
// that runtime — surfaced as an error toast by the caller.
export function resetForgeSession(input: { documentType: "task" | "wiki"; documentId: string; runtimeId: string }): Promise<void> {
  return request(`${BASE}/forge/sessions/reset`, { method: "POST", body: JSON.stringify(input) });
}

// ── Forge agents & skills (global rule bundles) ──

export function listForgeAgents(): Promise<{ data: ForgeAgent[] }> {
  return request(`${BASE}/forge/agents`);
}

export function createForgeAgent(input: { name: string; description?: string; instructions: string }): Promise<ForgeAgent> {
  return request(`${BASE}/forge/agents`, { method: "POST", body: JSON.stringify(input) });
}

export function updateForgeAgent(id: string, patch: { name?: string; description?: string; instructions?: string }): Promise<ForgeAgent> {
  return request(`${BASE}/forge/agents/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
}

export function deleteForgeAgent(id: string): Promise<void> {
  return request(`${BASE}/forge/agents/${id}`, { method: "DELETE" });
}

export function replaceAgentSkills(id: string, skillIds: string[]): Promise<ForgeAgent> {
  return request(`${BASE}/forge/agents/${id}/skills`, { method: "PUT", body: JSON.stringify({ skillIds }) });
}

export function resetForgeAgent(id: string): Promise<ForgeAgent> {
  return request(`${BASE}/forge/agents/${id}/reset`, { method: "POST" });
}

export function listForgeSkills(): Promise<{ data: ForgeSkill[] }> {
  return request(`${BASE}/forge/skills`);
}

export function createForgeSkill(input: { name: string; description?: string; instructions: string }): Promise<ForgeSkill> {
  return request(`${BASE}/forge/skills`, { method: "POST", body: JSON.stringify(input) });
}

export function updateForgeSkill(id: string, patch: { name?: string; description?: string; instructions?: string }): Promise<ForgeSkill> {
  return request(`${BASE}/forge/skills/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
}

export function deleteForgeSkill(id: string): Promise<void> {
  return request(`${BASE}/forge/skills/${id}`, { method: "DELETE" });
}

export function resetForgeSkill(id: string): Promise<ForgeSkill> {
  return request(`${BASE}/forge/skills/${id}/reset`, { method: "POST" });
}

export function listRuntimes(teamId?: string): Promise<{ data: Runtime[] }> {
  const qs = teamId ? `?teamId=${encodeURIComponent(teamId)}` : "";
  return request(`${BASE}/forge/runtimes${qs}`);
}

export function updateRuntime(id: string, patch: { name?: string; provider?: "opencode" | "hermes" | "command-code"; agent?: string; model?: string; printLogs?: boolean; logLevel?: "" | "DEBUG" | "INFO" | "WARN" | "ERROR"; extraArgs?: string[] }): Promise<Runtime> {
  return request(`${BASE}/forge/runtimes/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
}

export function removeRuntime(id: string): Promise<void> {
  return request(`${BASE}/forge/runtimes/${id}`, { method: "DELETE" });
}

export function removeMachine(id: string): Promise<void> {
  return request(`${BASE}/forge/machines/${id}`, { method: "DELETE" });
}

// ── Runtime setup events (web wizard → machine CLI listener) ──

export function createRuntimeEvent(input: {
  machineId: string;
  action: "install" | "update";
  agentCli: "opencode" | "hermes" | "command-code";
  apiKeyId?: string;
  rawKey?: string;
}): Promise<RuntimeEvent> {
  return request(`${BASE}/forge/runtime-events`, { method: "POST", body: JSON.stringify(input) });
}

export function getRuntimeEvent(id: string): Promise<RuntimeEvent> {
  return request(`${BASE}/forge/runtime-events/${id}`);
}

export function listMachines(): Promise<{ data: Machine[] }> {
  return request(`${BASE}/forge/machines`);
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
