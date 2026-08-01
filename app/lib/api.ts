import type { Project, Column, Swimlane, Task, Board, WikiPageMeta, WikiPage, WikiPageRevision, WikiPageRevisionSummary, TipTapDoc, ApiKey, ApiKeyCreateResult, Dashboard, FieldConfig } from "../../shared/types";

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

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...init?.headers as Record<string, string> };
  const key = clientApiKey();
  if (key) {
    headers["Authorization"] = `Bearer ${key}`;
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

export function createSwimlane(slug: string, input: { name: string; description?: string }): Promise<Swimlane> {
  return request(`${BASE}/projects/${slug}/swimlanes`, { method: "POST", body: JSON.stringify(input) });
}

export function updateSwimlane(slug: string, id: string, input: { name?: string; position?: number; description?: string }): Promise<Swimlane> {
  return request(`${BASE}/projects/${slug}/swimlanes/${id}`, { method: "PATCH", body: JSON.stringify(input) });
}

export function deleteSwimlane(slug: string, id: string): Promise<void> {
  return request(`${BASE}/projects/${slug}/swimlanes/${id}`, { method: "DELETE" });
}

export function listTasks(slug: string, params?: { columnId?: string; swimlaneId?: string; assignee?: string; type?: string; limit?: number; cursor?: string }): Promise<{ data: Task[]; nextCursor: string | null }> {
  const qs = new URLSearchParams();
  if (params) Object.entries(params).forEach(([k, v]) => { if (v !== undefined) qs.set(k, String(v)); });
  const query = qs.toString();
  return request(`${BASE}/projects/${slug}/tasks${query ? "?" + query : ""}`);
}

export function createTask(slug: string, input: { columnId: string; swimlaneId: string; title: string; description?: TipTapDoc; priority?: string; type?: string; assignees?: string[] }): Promise<Task> {
  return request(`${BASE}/projects/${slug}/tasks`, { method: "POST", body: JSON.stringify(input) });
}

export function getTask(slug: string, id: string): Promise<Task> {
  return request(`${BASE}/projects/${slug}/tasks/${id}`);
}

export function updateTask(slug: string, id: string, input: { title?: string; description?: TipTapDoc; priority?: string; type?: string; assignees?: string[] }): Promise<Task> {
  return request(`${BASE}/projects/${slug}/tasks/${id}`, { method: "PATCH", body: JSON.stringify(input) });
}

export function moveTask(slug: string, id: string, target: { columnId: string; swimlaneId: string; beforeTaskId?: string; afterTaskId?: string }): Promise<Task> {
  return request(`${BASE}/projects/${slug}/tasks/${id}/move`, { method: "POST", body: JSON.stringify(target) });
}

export function deleteTask(slug: string, id: string): Promise<void> {
  return request(`${BASE}/projects/${slug}/tasks/${id}`, { method: "DELETE" });
}

export function archiveTask(slug: string, id: string): Promise<Task> {
  return request(`${BASE}/projects/${slug}/tasks/${id}/archive`, { method: "POST" });
}

export function restoreTask(slug: string, id: string): Promise<Task> {
  return request(`${BASE}/projects/${slug}/tasks/${id}/restore`, { method: "POST" });
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

export function listWikiChildren(slug: string, pageSlug: string): Promise<{ data: WikiPageMeta[] }> {
  return request(`${BASE}/projects/${slug}/wiki/${pageSlug}/children`);
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

export function getRevision(slug: string, pageSlug: string, revisionId: string): Promise<{ revision: WikiPageRevision }> {
  return request(`${BASE}/projects/${slug}/wiki/${pageSlug}/revisions/${revisionId}`);
}

export function restoreRevision(slug: string, pageSlug: string, revisionId: string): Promise<WikiPage> {
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

export function listProjectMembers(slug: string): Promise<{ data: ApiUser[] }> {
  return request(`${BASE}/projects/${slug}/members`);
}

export function addProjectMember(userId: string, projectId: string): Promise<{ projectId: string; projectSlug: string; role: string }> {
  return request(`${BASE}/admin/users/${userId}/projects`, { method: "PUT", body: JSON.stringify({ projectId, role: "member" }) });
}

export function removeProjectMember(userId: string, projectId: string): Promise<void> {
  return request(`${BASE}/admin/users/${userId}/projects/${projectId}`, { method: "DELETE" });
}
