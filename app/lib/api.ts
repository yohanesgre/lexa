import type { Project, Column, Swimlane, Task, Board, WikiPageMeta, WikiPage, WikiPageRevision, WikiPageRevisionSummary, TipTapDoc, ApiKey, ApiKeyCreateResult, Dashboard, FieldConfig, ForgeTask, ForgeTaskLog, ForgeTaskStatus, ForgeAgent, ForgeSkill, DocumentSource, Runtime, RuntimeEvent, Machine, TaskLink, TaskLinkSuggestion, ActivityEvent, ActivityItem, TaskComment } from "../../shared/types";

const BASE = "/api";

// Prefer the key injected by the server at request time (dev:server / prod),
// so `bun run setup` rotating the key never leaves the browser with a stale
// build-time baked key. Falls back to the Vite build-time env var.
function clientApiKey(): string | undefined {
  if (typeof document !== "undefined") {
    const meta = document.querySelector('meta[name="lxk-api-key"]') as HTMLMetaElement | null;
    if (meta?.content) return meta.content;
  }
  return import.meta.env.VITE_LXK_API_KEY;
}

// The resolved Cloudflare Access user injected by the server next to the key
// meta. Sent as x-lxk-user so activity rows attribute to the acting user
// (server-side attribution only — the API key still grants the access).
export interface LxkUser {
  email: string;
  name: string;
  role: "admin" | "member";
  createdAt: string;
  lastSeen: string | null;
}

export function clientLxkUser(): LxkUser | null {
  if (typeof document !== "undefined") {
    const meta = document.querySelector('meta[name="lxk-user"]') as HTMLMetaElement | null;
    if (meta?.content) {
      try {
        return JSON.parse(meta.content) as LxkUser;
      } catch {
        /* ignore malformed */
      }
    }
  }
  return null;
}

// Cloudflare Access logout target — only present when LXK_ACCESS_TEAM is set
// server-side. Absent in local dev (no Access session), so the UI hides Sign
// out. The return_to parameter is appended by the caller.
export function clientLxkLogout(): string | null {
  if (typeof document !== "undefined") {
    const meta = document.querySelector('meta[name="lxk-logout"]') as HTMLMetaElement | null;
    return meta?.content ?? null;
  }
  return null;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...init?.headers as Record<string, string> };
  const key = clientApiKey();
  if (key) {
    headers["Authorization"] = `Bearer ${key}`;
  }
  const lxkUser = clientLxkUser();
  if (lxkUser?.email) {
    headers["x-lxk-user"] = lxkUser.email;
  }
  const res = await fetch(url, { ...init, headers });
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

export function createProject(input: { name: string; slug?: string; description?: string; githubRepo?: string | null }): Promise<Project> {
  return request(`${BASE}/projects`, { method: "POST", body: JSON.stringify(input) });
}

export function getProject(slug: string): Promise<Project> {
  return request(`${BASE}/projects/${slug}`);
}

export function deleteProject(slug: string): Promise<void> {
  return request(`${BASE}/projects/${slug}`, { method: "DELETE" });
}

export function updateProject(slug: string, input: { name?: string; description?: string; githubRepo?: string | null }): Promise<Project> {
  return request(`${BASE}/projects/${slug}`, { method: "PATCH", body: JSON.stringify(input) });
}

export function listColumns(slug: string): Promise<{ data: Column[] }> {
  return request(`${BASE}/projects/${slug}/columns`);
}

export function createColumn(slug: string, input: { name: string; wipLimit?: number | null; requiredFields?: string[]; color?: string; githubState?: "open" | "closed" | null }): Promise<Column> {
  return request(`${BASE}/projects/${slug}/columns`, { method: "POST", body: JSON.stringify(input) });
}

export function updateColumn(slug: string, id: string, input: { name?: string; wipLimit?: number | null; requiredFields?: string[]; color?: string; position?: number; githubState?: "open" | "closed" | null }): Promise<Column> {
  return request(`${BASE}/projects/${slug}/columns/${id}`, { method: "PATCH", body: JSON.stringify(input) });
}

export function deleteColumn(slug: string, id: string): Promise<void> {
  return request(`${BASE}/projects/${slug}/columns/${id}`, { method: "DELETE" });
}

export function listSwimlanes(slug: string): Promise<{ data: Swimlane[] }> {
  return request(`${BASE}/projects/${slug}/swimlanes`);
}

export function createSwimlane(slug: string, input: { name: string; description?: string; dueAt?: string | null }): Promise<Swimlane> {
  return request(`${BASE}/projects/${slug}/swimlanes`, { method: "POST", body: JSON.stringify(input) });
}

export function updateSwimlane(slug: string, id: string, input: { name?: string; position?: number; description?: string; dueAt?: string | null }): Promise<Swimlane> {
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

// ---- users & members ----

type ApiUser = { id: string; email: string; name: string; role: "admin" | "member"; createdAt: string; lastSeen: string | null };

export function listUsers(): Promise<{ data: ApiUser[] }> {
  return request(`${BASE}/admin/users`);
}

export function updateUserRole(id: string, role: "admin" | "member"): Promise<ApiUser> {
  return request(`${BASE}/admin/users/${id}`, { method: "PATCH", body: JSON.stringify({ role }) });
}

export function updateMyName(name: string): Promise<ApiUser> {
  return request(`${BASE}/me`, { method: "PATCH", body: JSON.stringify({ name }) });
}

export function listProjectMembers(slug: string): Promise<{ data: ApiUser[] }> {
  return request(`${BASE}/projects/${slug}/members`);
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

export function listRuntimes(): Promise<{ data: Runtime[] }> {
  return request(`${BASE}/forge/runtimes`);
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
