import { Schema } from "effect";
import type { Project, ProjectRepo, Column, Swimlane, Task, Board, Milestone, WikiPageMeta, WikiPage, WikiPageRevision, WikiPageRevisionSummary, TipTapDoc, ApiKey, ApiKeyCreateResult, Dashboard, FieldConfig, AssistantTask, LexaAgent, LexaSkill, DocumentSource, TaskLink, TaskLinkSuggestion, ActivityEvent, ActivityItem, TaskComment, GithubIssueSummary, Team, TeamMember, TeamMemberRole, WorkspaceInvite, SessionInfo, LexaUser, Attachment } from "../../shared/types";
import type { AssistantSettingsMasked, AssistantSettingsInput, AssistantChatTranscript, ModelListResult, AssistantProvider, AssistantProviderModel, AssistantUsage, AssistantCall, AssistantJevMasked, AssistantJevProjectPublic } from "../../shared/assistant";

const BASE = "/api";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  // FormData bodies must reach the browser untouched — it supplies the
  // multipart boundary via Content-Type; a JSON override breaks the upload.
  const isForm = typeof FormData !== "undefined" && init?.body instanceof FormData;
  const headers: Record<string, string> = { ...(isForm ? {} : { "Content-Type": "application/json" }), ...init?.headers as Record<string, string> };
  const res = await fetch(url, { credentials: "include", ...init, headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: { code?: string | undefined; message?: string | undefined; details?: unknown } };
    const err = new Error(body.error?.message ?? `HTTP ${res.status}`) as Error & { code?: string | undefined; details?: unknown };
    err.code = body.error?.code;
    err.details = body.error?.details;
    throw err;
  }
  if (res.status === 204) return undefined as T;
  const raw = (await res.json()) as unknown;
  const decoded = Schema.decodeUnknownSync(Schema.Unknown)(raw);
  return decoded as T;
}

export function listProjects(): Promise<{ data: Project[]; nextCursor: string | null }> {
  return request(`${BASE}/projects`);
}

// ── Setup wizard (first-run bootstrap) ──
export interface SetupStatus {
  configured: boolean;
  needsAdmin: boolean;
  hasProjects: boolean;
  hasUsers: boolean;
}

export function getSetupStatus(): Promise<SetupStatus> {
  return request(`${BASE}/setup/status`);
}

export function setSetupAdmin(email: string, password: string): Promise<{ ok: boolean }> {
  return request(`${BASE}/setup/admin`, { method: "POST", body: JSON.stringify({ email, password }) });
}

export type SeedFlavor = "minimal" | "full";

export function seedSampleData(flavor: SeedFlavor): Promise<{ seeded: boolean }> {
  return request(`${BASE}/setup/seed`, { method: "POST", body: JSON.stringify({ flavor }) });
}

export function completeSetup(): Promise<{ ok: boolean }> {
  return request(`${BASE}/setup/complete`, { method: "POST" });
}

export function getDashboard(): Promise<Dashboard> {
  return request(`${BASE}/dashboard`);
}

export function createProject(input: { name: string; slug?: string | undefined; description?: string | undefined; teamId?: string | null }): Promise<Project> {
  return request(`${BASE}/projects`, { method: "POST", body: JSON.stringify(input) });
}

export function getProject(slug: string): Promise<Project> {
  return request(`${BASE}/projects/${slug}`);
}

export function deleteProject(slug: string): Promise<void> {
  return request(`${BASE}/projects/${slug}`, { method: "DELETE" });
}

export function updateProject(slug: string, input: { name?: string | undefined; description?: string }): Promise<Project> {
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

export function createColumn(slug: string, input: { name: string; wipLimit?: number | null | undefined; requiredFields?: string[] | undefined; color?: string | undefined; githubState?: "open" | "closed" | null | undefined; isDone?: boolean }): Promise<Column> {
  return request(`${BASE}/projects/${slug}/columns`, { method: "POST", body: JSON.stringify(input) });
}

export function updateColumn(slug: string, id: string, input: { name?: string | undefined; wipLimit?: number | null | undefined; requiredFields?: string[] | undefined; color?: string | undefined; position?: number | undefined; githubState?: "open" | "closed" | null | undefined; isDone?: boolean }): Promise<Column> {
  return request(`${BASE}/projects/${slug}/columns/${id}`, { method: "PATCH", body: JSON.stringify(input) });
}

export function deleteColumn(slug: string, id: string): Promise<void> {
  return request(`${BASE}/projects/${slug}/columns/${id}`, { method: "DELETE" });
}

export function listSwimlanes(slug: string): Promise<{ data: Swimlane[] }> {
  return request(`${BASE}/projects/${slug}/swimlanes`);
}

export function createSwimlane(slug: string, input: { name: string; description?: string | undefined; dueAt?: string | null | undefined; startAt?: string | null | undefined; milestoneId?: string | null }): Promise<Swimlane> {
  return request(`${BASE}/projects/${slug}/swimlanes`, { method: "POST", body: JSON.stringify(input) });
}

export function updateSwimlane(slug: string, id: string, input: { name?: string | undefined; position?: number | undefined; description?: string | undefined; dueAt?: string | null | undefined; startAt?: string | null | undefined; milestoneId?: string | null }): Promise<Swimlane> {
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

export function createMilestone(slug: string, input: { name: string; description?: string | undefined; position?: number | undefined; dueAt?: string | null }): Promise<Milestone> {
  return request(`${BASE}/projects/${slug}/milestones`, { method: "POST", body: JSON.stringify(input) });
}

export function updateMilestone(slug: string, id: string, input: { name?: string | undefined; description?: string | undefined; position?: number | undefined; dueAt?: string | null }): Promise<Milestone> {
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

export function createTask(slug: string, input: { columnId: string; swimlaneId?: string | undefined; title: string; description?: TipTapDoc | undefined; priority?: string | undefined; type?: string | undefined; parentId?: string | undefined; assignees?: string[] | undefined; dueAt?: string | null }): Promise<TaskMutationResult> {
  return request(`${BASE}/projects/${slug}/tasks`, { method: "POST", body: JSON.stringify(input) });
}


export function updateTask(slug: string, id: string, input: { title?: string | undefined; description?: TipTapDoc | undefined; priority?: string | undefined; type?: string | undefined; assignees?: string[] | undefined; dueAt?: string | null }): Promise<TaskMutationResult> {
  return request(`${BASE}/projects/${slug}/tasks/${id}`, { method: "PATCH", body: JSON.stringify(input) });
}

export function moveTask(slug: string, id: string, target: { columnId: string; swimlaneId: string; beforeTaskId?: string | undefined; afterTaskId?: string | undefined; clearDueAt?: boolean }): Promise<TaskMutationResult> {
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

// ── Capability discovery (ADR-0003 §F.2) ──
// One honest signal per flavor, served before boot without a DB read.
// `tasksBulk` is the LX-4 kill switch (LXK_DISABLE_TASKS_BULK=1 → false);
// absent on older builds, which the UI treats as enabled.
export interface Capabilities {
  assistant: boolean;
  flavor: "bun" | "workers";
  tasksBulk?: boolean | undefined;
  // LX-2 kill switch (LXK_DISABLE_CHAT_ATTACHMENTS=1 → false); absent on older
  // builds, which the UI treats as enabled.
  chatAttachments?: boolean | undefined;
}

export function getCapabilities(): Promise<Capabilities> {
  return request(`${BASE}/capabilities`);
}

// ── Bulk task actions (LX-4) ──
// One transaction over many ids; per-task domain failures (WIP limit,
// required_fields, not-found) come back named in `failed` while permitted
// tasks apply.
export interface BulkTaskActionInput {
  ids: string[];
  action: "move" | "update" | "archive" | "restore";
  columnId?: string | undefined;
  swimlaneId?: string | undefined;
  priority?: string | undefined;
  type?: string | undefined;
  assignees?: string[] | undefined;
  dueAt?: string | undefined;
}

export interface BulkTaskActionFailure {
  id: string;
  code: string;
  message: string;
}

export interface BulkTaskActionResponse {
  applied: string[];
  failed: BulkTaskActionFailure[];
}

export function bulkTaskAction(slug: string, input: BulkTaskActionInput): Promise<BulkTaskActionResponse> {
  return request(`${BASE}/projects/${slug}/tasks/bulk`, { method: "POST", body: JSON.stringify(input) });
}

// ── Field config (per-project priority/type options) ──

export function getFieldConfig(slug: string): Promise<FieldConfig> {
  return request(`${BASE}/projects/${slug}/field-config`);
}

export function updateFieldConfig(slug: string, input: { priorities: { id?: string | undefined; label: string; color?: string | undefined; position?: number }[]; types: { id?: string | undefined; label: string; color?: string | undefined; position?: number }[] }): Promise<FieldConfig> {
  return request(`${BASE}/projects/${slug}/field-config`, { method: "PUT", body: JSON.stringify(input) });
}

export function listWikiPages(slug: string): Promise<{ data: WikiPageMeta[] }> {
  return request(`${BASE}/projects/${slug}/wiki`);
}

export function createWikiPage(slug: string, input: { parentId?: string | null | undefined; title: string; slug?: string | undefined; content?: TipTapDoc }): Promise<WikiPage> {
  return request(`${BASE}/projects/${slug}/wiki`, { method: "POST", body: JSON.stringify(input) });
}

export function searchWikiPages(slug: string, query: string): Promise<{ data: (WikiPage & { snippet: string })[] }> {
  return request(`${BASE}/projects/${slug}/wiki/search?q=${encodeURIComponent(query)}`);
}

export function getWikiPage(slug: string, pageSlug: string): Promise<WikiPage> {
  return request(`${BASE}/projects/${slug}/wiki/${pageSlug}`);
}


export function updateWikiPage(slug: string, pageSlug: string, input: { title?: string | undefined; slug?: string | undefined; content?: TipTapDoc; parentId?: string | null | undefined; position?: number | undefined; saveType?: "autosave" | "manual" }): Promise<WikiPage> {
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

// ── Personal API keys (own only — user-bound; any signed-in user) ──

export function listMyApiKeys(): Promise<{ data: ApiKey[] }> {
  return request(`${BASE}/me/api-keys`);
}

export function createMyApiKey(name: string): Promise<ApiKeyCreateResult> {
  return request(`${BASE}/me/api-keys`, { method: "POST", body: JSON.stringify({ name }) });
}

export function deleteMyApiKey(id: string): Promise<void> {
  return request(`${BASE}/me/api-keys/${id}`, { method: "DELETE" });
}

// ── Device login (CLI pairing) ──
// The poll credential is the pairing token carried by x-device-token — this
// surface is API-key exempt; never send a Bearer header here.

export type DeviceLoginPollResult =
  | { status: "pending"; clientName: string; code: string; expiresAt: string }
  | { status: "approved"; rawKey: string; keyName: string; approverName: string | null };

export type DeviceLoginActionResult = { status: "approved" | "denied"; clientName: string };

export function getDeviceLoginRequest(id: string, token: string): Promise<DeviceLoginPollResult> {
  return request(`${BASE}/device-login/requests/${encodeURIComponent(id)}`, { headers: { "x-device-token": token } });
}

export function approveDeviceLogin(id: string, token: string): Promise<DeviceLoginActionResult> {
  return request(`${BASE}/device-login/requests/${encodeURIComponent(id)}/approve`, { method: "POST", body: JSON.stringify({ token }) });
}

export function denyDeviceLogin(id: string, token: string): Promise<DeviceLoginActionResult> {
  return request(`${BASE}/device-login/requests/${encodeURIComponent(id)}/deny`, { method: "POST", body: JSON.stringify({ token }) });
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
  appSlug: string;
  privateKeySet: boolean;
  webhookSecretSet: boolean;
  source: "settings" | "none";
}

// Manifest-connect contract: `manifest` is posted to `url` as a form field by
// the browser; `state` is the single-use CSRF value the callback echoes back.
export interface GithubAppManifestResponse {
  url: string;
  state: string;
  manifest: unknown;
}

export function getGithubSettings(): Promise<GithubSettings> {
  return request(`${BASE}/settings/github`);
}

export function updateGithubSettings(input: { appId: string; appSlug?: string | undefined; privateKey?: string | undefined; webhookSecret?: string }): Promise<GithubSettings> {
  return request(`${BASE}/settings/github`, { method: "PUT", body: JSON.stringify(input) });
}

export function createGithubManifest(): Promise<GithubAppManifestResponse> {
  return request(`${BASE}/settings/github/manifest`, { method: "POST" });
}

export function completeGithubSetup(input: { code?: string | undefined; state: string }): Promise<GithubSettings> {
  return request(`${BASE}/settings/github/setup`, { method: "POST", body: JSON.stringify(input) });
}

// ---- teams (Better Auth organizations) ----

export function listTeams(): Promise<{ data: Team[] }> {
  return request(`${BASE}/teams`);
}

export function createTeam(input: { name: string; slug?: string }): Promise<Team> {
  return request(`${BASE}/teams`, { method: "POST", body: JSON.stringify(input) });
}

export function updateTeam(teamId: string, input: { name: string }): Promise<Team> {
  return request(`${BASE}/teams/${teamId}`, { method: "PATCH", body: JSON.stringify(input) });
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

// Pre-flight peek for the invite page (LX-10). Keyless/session-less — the
// token is the auth. Domain outcomes are 200: valid carries the email, a
// spent/unknown token carries a reason. A thrown error means the peek itself
// failed (network/404) and the page must not render the form.
export type InvitePeekResult =
  | { valid: true; email: string }
  | { valid: false; reason: "used" | "expired" | "unknown" };

export function peekInvite(token: string): Promise<InvitePeekResult> {
  return request(`${BASE}/auth/invite/peek`, { method: "POST", body: JSON.stringify({ token }) });
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

// ── Lexa Agents & Skills (global rule bundles used by the Assistant) ──

export function listAgents(): Promise<{ data: LexaAgent[] }> {
  return request(`${BASE}/agents`);
}

export function createAgent(input: { name: string; description?: string | undefined; instructions: string }): Promise<LexaAgent> {
  return request(`${BASE}/agents`, { method: "POST", body: JSON.stringify(input) });
}

export function updateAgent(id: string, patch: { name?: string | undefined; description?: string | undefined; instructions?: string }): Promise<LexaAgent> {
  return request(`${BASE}/agents/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
}

export function deleteAgent(id: string): Promise<void> {
  return request(`${BASE}/agents/${id}`, { method: "DELETE" });
}

export function replaceAgentSkills(id: string, skillIds: string[]): Promise<LexaAgent> {
  return request(`${BASE}/agents/${id}/skills`, { method: "PUT", body: JSON.stringify({ skillIds }) });
}

export function resetAgent(id: string): Promise<LexaAgent> {
  return request(`${BASE}/agents/${id}/reset`, { method: "POST" });
}

export function listSkills(): Promise<{ data: LexaSkill[] }> {
  return request(`${BASE}/skills`);
}

export function createSkill(input: { name: string; description?: string | undefined; instructions: string }): Promise<LexaSkill> {
  return request(`${BASE}/skills`, { method: "POST", body: JSON.stringify(input) });
}

export function updateSkill(id: string, patch: { name?: string | undefined; description?: string | undefined; instructions?: string }): Promise<LexaSkill> {
  return request(`${BASE}/skills/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
}

export function deleteSkill(id: string): Promise<void> {
  return request(`${BASE}/skills/${id}`, { method: "DELETE" });
}

export function resetSkill(id: string): Promise<LexaSkill> {
  return request(`${BASE}/skills/${id}/reset`, { method: "POST" });
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

// ── Assistant (server-side assistant tier) ──

export interface AssistantMemoryEntry {
  id: string;
  projectId: string;
  content: string;
  source: "manual" | "assistant";
  createdAt: string;
  updatedAt: string;
}

export function getAssistantSettings(projectId: string): Promise<AssistantSettingsMasked> {
  return request(`${BASE}/assistant/settings/${projectId}`);
}

export function putAssistantSettings(projectId: string, input: AssistantSettingsInput): Promise<AssistantSettingsMasked> {
  return request(`${BASE}/assistant/settings/${projectId}`, { method: "PUT", body: JSON.stringify(input) });
}

export async function testAssistantSettings(
  projectId: string,
  input: AssistantSettingsInput,
  opts?: { signal?: AbortSignal }
): Promise<{ ok: boolean; latencyMs: number }> {
  try {
    return await request<{ ok: boolean; latencyMs: number }>(`${BASE}/assistant/settings/${projectId}/test`, {
      method: "POST",
      body: JSON.stringify(input),
      signal: opts?.signal ?? AbortSignal.timeout(35_000),
    });
  } catch (e) {
    const err = e as { code?: string | undefined; name?: string | undefined; message?: string };
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

export function listAssistantModels(projectId: string, input: AssistantSettingsInput): Promise<ModelListResult> {
  return request(`${BASE}/assistant/settings/${projectId}/models`, { method: "POST", body: JSON.stringify(input) });
}

// The list body carries `secretsEnabled` — the server's real capability for
// managed provider keys (a master key is configured) — so the flag and the rows
// always describe the same read.
export function listAssistantProviders(): Promise<{ data: AssistantProvider[]; secretsEnabled: boolean }> {
  return request(`${BASE}/admin/assistant/providers`);
}

export function createAssistantProvider(input: { label: string; baseUrl: string; apiKey: string }): Promise<AssistantProvider> {
  return request(`${BASE}/admin/assistant/providers`, { method: "POST", body: JSON.stringify({ label: input.label, baseUrl: input.baseUrl, apiKey: input.apiKey }) });
}

export function updateAssistantProvider(id: string, input: { label?: string | undefined; baseUrl?: string | undefined; apiKey?: string | undefined; clearKey?: boolean | undefined }): Promise<AssistantProvider> {
  const body: Record<string, string | boolean> = {};
  if (input.label !== undefined) body.label = input.label;
  if (input.baseUrl !== undefined) body.baseUrl = input.baseUrl;
  if (input.apiKey !== undefined) body.apiKey = input.apiKey;
  if (input.clearKey !== undefined) body.clearKey = input.clearKey;
  return request(`${BASE}/admin/assistant/providers/${id}`, { method: "PATCH", body: JSON.stringify(body) });
}

export function deleteAssistantProvider(id: string): Promise<void> {
  return request(`${BASE}/admin/assistant/providers/${id}`, { method: "DELETE" });
}

export function testAssistantProvider(id: string): Promise<{ ok: boolean; latencyMs: number }> {
  return request(`${BASE}/admin/assistant/providers/${id}/test`, { method: "POST" });
}

export interface AssistantProviderHealth {
  providerId: string;
  circuitState: "open" | "closed" | "half-open";
  failureCount: number;
  openedAt: string | null;
  lastProbeAt: string | null;
  consecutiveFailures: number;
  latencyMs: number | null;
  retryAfterSeconds: number | null;
  lastFailureCode: string | null;
  lastFailureAt: string | null;
  lastCheckedAt: string | null;
}

export function getAssistantProviderHealth(id: string): Promise<AssistantProviderHealth> {
  return request(`${BASE}/admin/assistant/providers/${encodeURIComponent(id)}/health`);
}

export function probeAssistantProvider(id: string): Promise<AssistantProviderHealth> {
  return request(`${BASE}/admin/assistant/providers/${encodeURIComponent(id)}/probe`, { method: "POST" });
}

export function fetchAssistantProviderModels(id: string): Promise<{ data: AssistantProviderModel[] }> {
  return request(`${BASE}/admin/assistant/providers/${encodeURIComponent(id)}/models`, { method: "POST" });
}

export function updateAssistantProviderModel(id: string, modelId: string, patch: { enabled?: boolean | undefined; priority?: number }): Promise<AssistantProviderModel> {
  return request(`${BASE}/admin/assistant/providers/${id}/models/${encodeURIComponent(modelId)}`, { method: "PATCH", body: JSON.stringify(patch) });
}

export function reorderAssistantProviderModels(id: string, orderedIds: string[]): Promise<{ data: AssistantProviderModel[] }> {
  return request(`${BASE}/admin/assistant/providers/${id}/models/reorder`, { method: "POST", body: JSON.stringify({ orderedIds }) });
}

// ── MCP client registry (assistant MCP clients) ──
// Remote HTTP/SSE clients only. The `stdio` member of McpTransportType and the
// `command`/`args` fields are retained for API/TS compatibility with the legacy
// columns; the server rejects stdio (MCP_INVALID_TRANSPORT_CONFIG) and
// migration 0010 removed every stored stdio row.
export type McpTransportType = "http" | "sse" | "stdio";

// A stored client authenticates with an envelope-encrypted managed token or
// with nothing at all; "none" is a legal, deliberately secret-less client.
export type McpSecretSource = "managed" | "none";

export interface McpServer {
  id: string;
  label: string;
  transportType: McpTransportType;
  url: string | null;
  // Compat only: `command`/`args` mirror the legacy stdio columns and are never
  // read by the app — remote HTTP/SSE is the only supported transport.
  command: string | null;
  args: string[];
  hasSecret: boolean;
  secretSource: McpSecretSource;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface McpServerInput {
  label: string;
  transportType: McpTransportType;
  url?: string | null;
  // Compat with the legacy stdio columns — never sent by the MCP form.
  command?: string | null;
  args?: string[];
  // Write-only. Omitted or empty means "keep the stored token" — a blank
  // value is NEVER a removal, so there is no null form here.
  secret?: string | null;
  enabled?: boolean;
}

// Update carries the one explicit removal route; it deletes the stored
// ciphertext row server-side.
export type McpServerPatch = Partial<McpServerInput> & { clearSecret?: boolean };

export interface McpTestResult {
  ok: boolean;
  toolCount: number;
  readOnlyToolCount: number;
  latencyMs: number;
  error: { code: string; message: string } | null;
}

export interface McpProjectServer {
  projectId: string;
  serverId: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

// `managedSecretsEnabled` is the SERVER's real capability for managed tokens (a
// master key is configured), reported alongside the rows. The UI renders the
// managed branch from it instead of assuming the feature exists — a build that
// hardcoded it on would offer a save the API refuses.
export function listMcpServers(): Promise<{ data: McpServer[]; managedSecretsEnabled: boolean }> {
  return request(`${BASE}/assistant/mcp-servers`);
}

export function createMcpServer(input: McpServerInput): Promise<McpServer> {
  return request(`${BASE}/assistant/mcp-servers`, { method: "POST", body: JSON.stringify(input) });
}

export function updateMcpServer(id: string, input: McpServerPatch): Promise<McpServer> {
  return request(`${BASE}/assistant/mcp-servers/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(input) });
}

export function deleteMcpServer(id: string): Promise<void> {
  return request(`${BASE}/assistant/mcp-servers/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function testMcpServer(id: string): Promise<McpTestResult> {
  return request(`${BASE}/assistant/mcp-servers/${encodeURIComponent(id)}/test`, { method: "POST" });
}

export function listProjectMcpServers(projectId: string): Promise<{ data: McpProjectServer[] }> {
  return request(`${BASE}/projects/${encodeURIComponent(projectId)}/assistant/mcp-servers`);
}

export function putProjectMcpServers(projectId: string, entries: Array<{ serverId: string; enabled: boolean }>): Promise<{ data: McpProjectServer[] }> {
  return request(`${BASE}/projects/${encodeURIComponent(projectId)}/assistant/mcp-servers`, { method: "PUT", body: JSON.stringify({ entries }) });
}

// ── Jev advisory registry (Typesafe System 1) ──
// Jev is a direct REST advisory backend, not an MCP client. The config row is
// workspace-wide and superadmin-gated; per-project opt-in lives in
// AssistantProjectJevSection. `secret` is write-only by construction and never
// appears on a response.
export type AssistantJevConfig = { config: AssistantJevMasked; secretsEnabled: boolean };

export interface AssistantJevPatch {
  baseUrl?: string;
  model?: string;
  enabled?: boolean;
  // Write-only. Omitted or empty means "keep the stored key" — a blank value is
  // NEVER a removal, so there is no null form here.
  secret?: string;
  // The one explicit removal route; deletes the stored ciphertext row server-side.
  clearSecret?: boolean;
}

export interface AssistantJevTestResult {
  ok: true;
  latencyMs: number;
  models: string[];
}

export function getAssistantJevConfig(): Promise<AssistantJevConfig> {
  return request(`${BASE}/assistant/jev`);
}

export function updateAssistantJevConfig(input: AssistantJevPatch): Promise<AssistantJevConfig> {
  return request(`${BASE}/assistant/jev`, { method: "PATCH", body: JSON.stringify(input) });
}

export function testAssistantJev(): Promise<AssistantJevTestResult> {
  return request(`${BASE}/assistant/jev/test`, { method: "POST" });
}

export function getProjectJev(projectId: string): Promise<AssistantJevProjectPublic> {
  return request(`${BASE}/projects/${encodeURIComponent(projectId)}/assistant/jev`);
}

export function putProjectJev(projectId: string, input: { enabled: boolean }): Promise<AssistantJevProjectPublic> {
  return request(`${BASE}/projects/${encodeURIComponent(projectId)}/assistant/jev`, { method: "PUT", body: JSON.stringify(input) });
}

export function getAssistantUsage(): Promise<AssistantUsage> {
  return request(`${BASE}/admin/assistant/usage`);
}

export function listAssistantCalls(params?: { projectId?: string | undefined; limit?: number }): Promise<{ data: AssistantCall[] }> {
  const qs = new URLSearchParams();
  if (params?.projectId) qs.set("projectId", params.projectId);
  if (params?.limit) qs.set("limit", String(params.limit));
  const q = qs.toString();
  return request(`${BASE}/admin/assistant/calls${q ? `?${q}` : ""}`);
}

export type AssistantRunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface AssistantRunRow {
  id: string;
  key: string;
  projectId: string;
  kind: "chat_run" | "document" | "schedule";
  documentType: "task" | "wiki" | null;
  documentId: string;
  documentTitle: string;
  agentId: string;
  skillId: string;
  agentName: string;
  skillName: string;
  threadKey: string | null;
  status: AssistantRunStatus;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface AssistantRunsResponse {
  data: AssistantRunRow[];
  nextCursor: string | null;
  counts: Record<AssistantRunStatus, number>;
}

export interface AssistantBindingRow {
  projectId: string;
  projectName: string;
  projectSlug: string;
  providerId: string | null;
  providerLabel: string | null;
  modelId: string | null;
  modelLabel: string | null;
  fallbackCount: number;
  writeToolsCount: number;
  memoryCount: number;
  hasSearchKey: boolean;
  reasoningEffort: "minimal" | "low" | "medium" | "high" | null;
  updatedAt: string | null;
}

export interface AssistantPriceSyncResult {
  synced: number;
  data: {
    model: string;
    prompt_price: number;
    completion_price: number;
    cached_read_price: number;
    cached_write_price: number;
    updated_at: string;
  }[];
}

export function listAssistantRuns(params?: {
  status?: string | undefined;
  projectId?: string | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
}): Promise<AssistantRunsResponse> {
  const qs = new URLSearchParams();
  if (params?.status) qs.set("status", params.status);
  if (params?.projectId) qs.set("projectId", params.projectId);
  if (params?.limit) qs.set("limit", String(params.limit));
  if (params?.cursor) qs.set("cursor", params.cursor);
  const q = qs.toString();
  return request(`${BASE}/admin/assistant/runs${q ? `?${q}` : ""}`);
}

// Delegated run row (ADR-0004 §3) — the durable `assistant_runs` row behind one
// run card. Distinct from the admin `AssistantRunRow` union (document fields).
export interface AssistantDelegatedRun {
  id: string;
  projectId: string;
  threadKey: string;
  parentRunId: string | null;
  kind: "chat_run" | "document" | "schedule";
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  goal: string;
  result: string | null;
  error: string | null;
  budgetMs: number | null;
  stepsUsed: number;
  createdBy: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export function getAssistantRun(runId: string): Promise<AssistantDelegatedRun> {
  return request(`${BASE}/assistant/runs/${encodeURIComponent(runId)}`);
}

export function abortAssistantRun(runId: string): Promise<{ ok: boolean }> {
  return request(`${BASE}/assistant/runs/${encodeURIComponent(runId)}/abort`, { method: "POST" });
}

export function listAssistantBindings(): Promise<{ data: AssistantBindingRow[] }> {
  return request(`${BASE}/admin/assistant/bindings`);
}

export function syncAssistantPrices(): Promise<AssistantPriceSyncResult> {
  return request(`${BASE}/admin/assistant/prices/sync`, { method: "POST" });
}

export function createAssistantTask(input: {
  slug: string;
  documentType: "task" | "wiki";
  documentId: string;
  prompt: string;
  agentId: string;
  // Auto mode omits the key: the assistant picks suitable skill(s) itself.
  skillId?: string | undefined;
  selection?: string | undefined;
  attachments?: { storageKey: string; mimeType: string; name: string }[];
}): Promise<AssistantTask> {
  return request(`${BASE}/assistant/tasks`, { method: "POST", body: JSON.stringify(input) });
}

export function getAssistantTask(id: string): Promise<AssistantTask> {
  return request(`${BASE}/assistant/tasks/${id}`);
}

export function cancelAssistantTask(id: string): Promise<{ ok: boolean }> {
  return request(`${BASE}/assistant/tasks/${id}/cancel`, { method: "POST" });
}

export function resetAssistantThread(documentType: "task" | "wiki", documentId: string): Promise<void> {
  return request(`${BASE}/assistant/threads/${documentType}/${documentId}`, { method: "DELETE" });
}

// One decision per approval (assistant-write-approvals.html): the response's
// terminal status is authoritative for that chip alone. 409s surface as
// thrown errors with code APPROVAL_EXPIRED / APPROVAL_ALREADY_DECIDED
// (details.status carries the pre-existing decision).
export interface AssistantApprovalDecision {
  approvalId: string;
  batchId: string;
  status: string;
  remaining: number;
}

export function decideAssistantApproval(approvalId: string, verdict: "approve" | "reject"): Promise<AssistantApprovalDecision> {
  return request(`${BASE}/assistant/approvals/${approvalId}/decide`, { method: "POST", body: JSON.stringify({ verdict }) });
}

export function getAssistantChat(chatId: string): Promise<AssistantChatTranscript> {
  return request(`${BASE}/assistant/chat/${chatId}`);
}

// Thread summary for the History dropdown (pinned-first then updated_at
// DESC, cap 100). Title is null until the server derives it from the first
// send; null renders as "New chat". snippet is a short window around the
// first ?q= match (null for title-only matches or unfiltered lists).
export interface AssistantChatThreadSummary {
  chatId: string;
  title: string | null;
  pinned: boolean;
  snippet?: string | null | undefined;
  createdAt: string;
  updatedAt: string;
}

export function listAssistantChats(projectId: string, q?: string): Promise<{ data: AssistantChatThreadSummary[] }> {
  const qs = q && q.trim() ? `?q=${encodeURIComponent(q.trim())}` : "";
  return request(`${BASE}/assistant/chats/${projectId}${qs}`);
}

export function updateAssistantChatMeta(
  chatId: string,
  patch: { title?: string | undefined; pinned?: boolean }
): Promise<{ chatId: string; title?: string | undefined; pinned?: boolean }> {
  return request(`${BASE}/assistant/chat/${chatId}`, { method: "PATCH", body: JSON.stringify(patch) });
}

export function renameAssistantChat(chatId: string, title: string): Promise<{ chatId: string; title?: string | undefined }> {
  return updateAssistantChatMeta(chatId, { title });
}

// Markdown attachment download (GET /assistant/chat/:chatId/export →
// text/markdown). Frontend-only: blob → programmatic <a download> click.
// Filename prefers the Content-Disposition header, falls back to chatId.
export async function exportAssistantChat(chatId: string): Promise<void> {
  const res = await fetch(`${BASE}/assistant/chat/${chatId}/export`, { credentials: "include" });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: { code?: string | undefined; message?: string } };
    const err = new Error(body.error?.message ?? `HTTP ${res.status}`) as Error & { code?: string | undefined };
    if (body.error?.code !== undefined) err.code = body.error.code;
    throw err;
  }
  const blob = await res.blob();
  const dispo = res.headers.get("Content-Disposition") ?? "";
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(dispo);
  const name = match?.[1] ? decodeURIComponent(match[1]!.trim()) : `assistant-chat-${chatId}.md`;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function resetAssistantChat(chatId: string): Promise<void> {
  return request(`${BASE}/assistant/chat/${chatId}`, { method: "DELETE" });
}

export function listAssistantMemory(projectId: string): Promise<{ data: AssistantMemoryEntry[] }> {
  return request(`${BASE}/assistant/memory/${projectId}`);
}

export function addAssistantMemory(projectId: string, content: string): Promise<AssistantMemoryEntry> {
  return request(`${BASE}/assistant/memory/${projectId}`, { method: "POST", body: JSON.stringify({ content }) });
}

export function removeAssistantMemory(projectId: string, memoryId: string): Promise<void> {
  return request(`${BASE}/assistant/memory/${projectId}/${memoryId}`, { method: "DELETE" });
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
    xhr.withCredentials = true;
    xhr.responseType = "json";
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve((xhr.response ?? {}) as { data: Attachment; activity?: ActivityEvent[] });
        return;
      }
      const body = (xhr.response ?? {}) as { error?: { code?: string | undefined; message?: string | undefined; details?: unknown } };
      const err = new Error(body.error?.message ?? `HTTP ${xhr.status}`) as Error & { code?: string | undefined; details?: unknown };
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

// ── Chat attachments (LX-2, thread-scoped conversation context) ──

// `ChatAttachment` = the upload/list row. A send references these by
// `storageKey` (see AssistantChatAttachment in shared/assistant.ts).
export interface ChatAttachment {
  id: string;
  projectId: string;
  chatId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  storageKey: string;
  uploadedBy: string | null;
  uploadedByLabel: string | null;
  createdAt: string;
}

export function listChatAttachments(slug: string, chatId: string): Promise<{ data: ChatAttachment[] }> {
  return request(`${BASE}/projects/${encodeURIComponent(slug)}/assistant/chat/${encodeURIComponent(chatId)}/attachments`);
}

// Binary serve URL — never fetched through `request` (images render straight
// from this in an <img src>). The session cookie is sent by the browser.
export function chatAttachmentUrl(id: string): string {
  return `${BASE}/chat-attachments/${encodeURIComponent(id)}`;
}

// Chat uploads resolve a ChatAttachment (not a task/wiki Attachment), so they
// need their own handle type.
export interface ChatUploadHandle {
  promise: Promise<{ data: ChatAttachment }>;
  abort: () => void;
}

// XHR upload with determinate progress + in-flight abort (same shape as the
// task/wiki upload helper).
export function uploadChatAttachmentWithProgress(
  slug: string,
  chatId: string,
  file: File,
  onProgress?: (percent: number) => void
): ChatUploadHandle {
  const path = `${BASE}/projects/${encodeURIComponent(slug)}/assistant/chat/${encodeURIComponent(chatId)}/attachments`;
  const form = new FormData();
  form.append("file", file);
  const xhr = new XMLHttpRequest();
  const promise = new Promise<{ data: ChatAttachment }>((resolve, reject) => {
    xhr.open("POST", path);
    xhr.withCredentials = true;
    xhr.responseType = "json";
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve((xhr.response ?? {}) as { data: ChatAttachment });
        return;
      }
      const body = (xhr.response ?? {}) as { error?: { code?: string | undefined; message?: string | undefined; details?: unknown } };
      const err = new Error(body.error?.message ?? `HTTP ${xhr.status}`) as Error & { code?: string | undefined; details?: unknown };
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
