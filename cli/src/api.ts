// lx REST client — thin fetch wrapper over the Lexa API.
//   All calls need a base URL + Bearer API key (from config or env).
//
// Effect boundary: every call returns Effect.Effect<T, ApiError, never>.
// JSON payloads are cast at the boundary (project rule); network-level
// failures (fetch rejections) are normalized into ApiError(status 0).
import { Effect, Data } from "effect";
import type { CliConfig } from "./config";

// Per-request deadline. Without it a hung server leaves `lx` waiting forever
// on a bare fetch.
const REQUEST_TIMEOUT_MS = 30_000;

export class ApiError extends Data.TaggedError("ApiError")<{
  status: number;
  code?: string | undefined;
  details?: unknown | undefined;
  serverMessage?: string | undefined;
}> {
  override get message(): string {
    return this.serverMessage ?? `HTTP ${this.status}`;
  }
}

export interface ColumnInfo {
  id: string;
  projectId: string;
  name: string;
  wipLimit: number | null;
  requiredFields: string[] | null;
  color: string | null;
  position: number;
  githubState: "open" | "closed" | null;
  isDone: boolean;
}

export interface SwimlaneInfo {
  id: string;
  projectId: string;
  name: string;
  description: string;
  position: number;
  dueAt: string | null;
  archivedAt: string | null;
  startAt: string | null;
  kind: "backlog" | "sprint";
  milestoneId: string | null;
}

export interface MilestoneInfo {
  id: string;
  projectId: string;
  name: string;
  description: string;
  position: number;
  dueAt: string | null;
  archivedAt: string | null;
  sprintCount: number;
  archivedSprintCount: number;
}

export interface TaskInfo {
  id: string;
  key: string;
  title: string;
  priority: string | null;
  type: string | null;
  columnId: string;
  swimlaneId: string;
  assignees: string[] | null;
  description?: unknown;
  githubs?: Array<{
    issueId: string;
    issueNumber: number;
    repo: string;
    syncedState: "open" | "closed" | null;
    url: string;
    outOfSync: boolean;
  }>;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectInfo {
  id: string;
  slug: string;
  name: string;
  description: string | null;
}

export interface FieldOptionInfo {
  id: string;
  label: string;
  color: string;
  position: number;
}

export interface FieldConfigInfo {
  priorities: FieldOptionInfo[];
  types: FieldOptionInfo[];
}

export interface FieldOptionInput {
  id?: string;
  label: string;
  color?: string;
  position?: number;
}

export interface FieldConfigInput {
  priorities: FieldOptionInput[];
  types: FieldOptionInput[];
}

export interface RateLimitInfo {
  max: number;
  windowMs: number;
  envOverride: boolean;
}

export interface ApiKeyInfo {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  ownerEmail?: string;
  ownerName?: string;
}

// Server-side GitHub sync settings. The server's settings DB is the single
// source of truth; `source` tells where the effective values came from
// (e.g. "db" after bootstrap, "env" before first boot).
export interface GithubSettingsInfo {
  appId: string;
  privateKeySet: boolean;
  webhookSecretSet: boolean;
  source: string;
}

export interface WikiPageMetaInfo {
  id: string;
  title: string;
  slug: string;
  position: number;
  hasChildren: boolean;
}

export interface WikiPageInfo {
  id: string;
  projectId: string;
  title: string;
  slug: string;
  content: unknown;
  contentText?: string;
  parentId: string | null;
  position: number;
  updatedBy: string | null;
  updatedByName: string | null;
  createdAt: string;
  updatedAt: string;
}

export class LexaClient {
  constructor(private config: CliConfig) {}

  private request<T>(path: string, init?: RequestInit): Effect.Effect<T, ApiError, never> {
    return Effect.tryPromise({
      try: async () => {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
          ...(init?.headers as Record<string, string> | undefined),
        };
        const res = await fetch(`${this.config.url}${path}`, { ...init, headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
        const contentType = res.headers.get("content-type") ?? "";
        if (contentType.includes("text/html")) {
          // A proxy answered with an HTML page (login page or error) — the
          // host is reachable but the API path returned non-JSON.
          throw new ApiError({ status: res.status, serverMessage: "Server returned an HTML page — is the host behind a proxy or serving the wrong app?" });
        }
        if (!res.ok) {
          let code: string | undefined;
          let details: unknown;
          let serverMessage: string | undefined;
          try {
            const body = (await res.json()) as { error?: { code?: string; message?: string; details?: unknown } };
            code = body.error?.code;
            details = body.error?.details;
            serverMessage = body.error?.message;
          } catch { /* non-JSON error body */ }
          throw new ApiError({ status: res.status, code, details, serverMessage });
        }
        if (res.status === 204) return undefined as T;
        return (await res.json()) as T;
      },
      catch: (e) => (e instanceof ApiError ? e : new ApiError({ status: 0, serverMessage: (e as Error).message ?? String(e) })),
    });
  }

  // ── Health / auth probe ──
  // /api/health is unauthenticated. A login is validated by calling it (server
  // reachable) then a real authed call (listProjects) to confirm the key works.
  health(): Effect.Effect<{ ok: boolean }, ApiError, never> {
    return this.request<{ ok: boolean }>("/api/health");
  }

  // ── Projects ──
  listProjects(): Effect.Effect<ProjectInfo[], ApiError, never> {
    return Effect.map(this.request<{ data: ProjectInfo[] }>("/api/projects"), (r) => r.data);
  }

  // ── Columns / swimlanes (for name-based lookup) ──
  listColumns(slug: string): Effect.Effect<ColumnInfo[], ApiError, never> {
    return Effect.map(this.request<{ data: ColumnInfo[] }>(`/api/projects/${slug}/columns`), (r) => r.data);
  }

  listSwimlanes(slug: string): Effect.Effect<SwimlaneInfo[], ApiError, never> {
    return Effect.map(this.request<{ data: SwimlaneInfo[] }>(`/api/projects/${slug}/swimlanes`), (r) => r.data);
  }

  // ── Milestones ──
  // list unwraps the { data } envelope; create/update return the milestone
  // directly (no envelope) — 201 | 200 | 403 | 404.
  listMilestones(slug: string): Effect.Effect<MilestoneInfo[], ApiError, never> {
    return Effect.map(this.request<{ data: MilestoneInfo[] }>(`/api/projects/${slug}/milestones`), (r) => r.data);
  }

  createMilestone(slug: string, input: { name: string; description?: string; dueAt?: string | null; position?: number }): Effect.Effect<MilestoneInfo, ApiError, never> {
    return this.request<MilestoneInfo>(`/api/projects/${slug}/milestones`, { method: "POST", body: JSON.stringify(input) });
  }

  updateMilestone(slug: string, ref: string, input: { name?: string; description?: string; dueAt?: string | null; position?: number }): Effect.Effect<MilestoneInfo, ApiError, never> {
    return this.request<MilestoneInfo>(`/api/projects/${slug}/milestones/${ref}`, { method: "PATCH", body: JSON.stringify(input) });
  }

  // ── Tasks ──
  listTasks(slug: string, limit = 20): Effect.Effect<TaskInfo[], ApiError, never> {
    return Effect.map(this.request<{ data: TaskInfo[] }>(`/api/projects/${slug}/tasks?limit=${limit}`), (r) => r.data);
  }

  getTask(slug: string, id: string): Effect.Effect<TaskInfo, ApiError, never> {
    return this.request<TaskInfo>(`/api/projects/${slug}/tasks/${id}`);
  }

  // Task mutations respond with a { data, activity } envelope (activity is
  // the appended timeline rows) — unwrap to the task so callers get a TaskInfo.
  createTask(slug: string, input: { columnId: string; swimlaneId: string; title: string; description?: unknown; priority?: string; type?: string }): Effect.Effect<TaskInfo, ApiError, never> {
    return Effect.map(
      this.request<{ data: TaskInfo }>(`/api/projects/${slug}/tasks`, { method: "POST", body: JSON.stringify(input) }),
      (r) => r.data
    );
  }

  updateTask(slug: string, id: string, input: { title?: string; description?: unknown; priority?: string; type?: string; assignees?: string[]; dueAt?: string | null }): Effect.Effect<TaskInfo, ApiError, never> {
    return Effect.map(
      this.request<{ data: TaskInfo }>(`/api/projects/${slug}/tasks/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
      (r) => r.data
    );
  }

  // 204 | 404 | 409 TASK_HAS_CHILDREN (defensive — subtask links cascade).
  deleteTask(slug: string, id: string): Effect.Effect<void, ApiError, never> {
    return this.request<void>(`/api/projects/${slug}/tasks/${id}`, { method: "DELETE" });
  }

  moveTask(slug: string, id: string, target: { columnId: string; swimlaneId: string; beforeTaskId?: string; afterTaskId?: string; clearDueAt?: boolean }): Effect.Effect<TaskInfo, ApiError, never> {
    return Effect.map(
      this.request<{ data: TaskInfo }>(`/api/projects/${slug}/tasks/${id}/move`, { method: "POST", body: JSON.stringify(target) }),
      (r) => r.data
    );
  }

  // GitHub sync: create a GitHub issue from the task and link it.
  // 200 { data: Task (githubs populated), activity } | 404 | 409 ALREADY_LINKED | 502 GITHUB_API_ERROR
  linkGithubIssue(slug: string, id: string, repo: string): Effect.Effect<TaskInfo, ApiError, never> {
    return Effect.map(
      this.request<{ data: TaskInfo }>(`/api/projects/${slug}/tasks/${id}/github-link`, {
        method: "POST",
        body: JSON.stringify({ repo }),
      }),
      (r) => r.data
    );
  }

  // GitHub sync: link an EXISTING GitHub issue to the task (no issue created).
  // 200 { data: Task (githubs populated), activity } | 404 | 409 ALREADY_LINKED | 502 GITHUB_API_ERROR
  linkExistingGithubIssue(slug: string, id: string, repo: string, issueNumber: number): Effect.Effect<TaskInfo, ApiError, never> {
    return Effect.map(
      this.request<{ data: TaskInfo }>(`/api/projects/${slug}/tasks/${id}/github-link-existing`, {
        method: "POST",
        body: JSON.stringify({ repo, issueNumber }),
      }),
      (r) => r.data
    );
  }

  // Unlink a specific GitHub issue (issueId = GitHub node_id). Idempotent:
  // unknown issueId is a no-op. 200 { data: Task, activity } | 404 TASK_NOT_FOUND
  unlinkGithubIssue(slug: string, id: string, issueId: string): Effect.Effect<TaskInfo, ApiError, never> {
    return Effect.map(
      this.request<{ data: TaskInfo }>(`/api/projects/${slug}/tasks/${id}/github-link/${encodeURIComponent(issueId)}`, { method: "DELETE" }),
      (r) => r.data
    );
  }

  // ── Settings (GitHub sync) ──
  getGithubSettings(): Effect.Effect<GithubSettingsInfo, ApiError, never> {
    return this.request<GithubSettingsInfo>("/api/settings/github");
  }

  updateGithubSettings(input: { appId: string; privateKey?: string; webhookSecret?: string }): Effect.Effect<GithubSettingsInfo, ApiError, never> {
    return this.request<GithubSettingsInfo>("/api/settings/github", { method: "PUT", body: JSON.stringify(input) });
  }

  // ── Wiki ──
  listWikiPages(slug: string): Effect.Effect<WikiPageMetaInfo[], ApiError, never> {
    return Effect.map(this.request<{ data: WikiPageMetaInfo[] }>(`/api/projects/${slug}/wiki`), (r) => r.data);
  }

  getWikiPage(slug: string, pageSlug: string): Effect.Effect<{ id: string; title: string; slug: string; content: unknown }, ApiError, never> {
    return this.request<{ id: string; title: string; slug: string; content: unknown }>(`/api/projects/${slug}/wiki/${pageSlug}`);
  }

  // Wiki create/update return the page directly (no { data } envelope):
  // 201 WikiPage | 404 PROJECT_NOT_FOUND | 409 SLUG_TAKEN. Server slugifies
  // the title when `slug` is omitted.
  createWikiPage(slug: string, input: { title: string; slug?: string; content?: unknown; parentId?: string }): Effect.Effect<WikiPageInfo, ApiError, never> {
    return this.request<WikiPageInfo>(`/api/projects/${slug}/wiki`, { method: "POST", body: JSON.stringify(input) });
  }

  // 200 WikiPage | 404 | 409 SLUG_TAKEN | 422 INVALID_PARENT
  updateWikiPage(slug: string, pageSlug: string, input: { title?: string; slug?: string; content?: unknown; parentId?: string | null; position?: number }): Effect.Effect<WikiPageInfo, ApiError, never> {
    return this.request<WikiPageInfo>(`/api/projects/${slug}/wiki/${pageSlug}`, { method: "PATCH", body: JSON.stringify(input) });
  }

  // 204 | 404 | 409 HAS_CHILDREN { count }
  deleteWikiPage(slug: string, pageSlug: string): Effect.Effect<void, ApiError, never> {
    return this.request<void>(`/api/projects/${slug}/wiki/${pageSlug}`, { method: "DELETE" });
  }

  // ── Device login (CLI pairing) ──
  // No API key exists yet — create + poll are API-key exempt; the poll
  // credential is the pairing token (x-device-token), the same 256-bit hex
  // embedded in verifyUrl. Errors surface as ApiError with code so callers
  // branch on DEVICE_LOGIN_DENIED / EXPIRED / NOT_FOUND.
  createDeviceLoginRequest(clientName: string): Effect.Effect<DeviceLoginRequestInfo, ApiError, never> {
    return this.request<DeviceLoginRequestInfo>("/api/device-login/requests", {
      method: "POST",
      body: JSON.stringify({ clientName }),
    });
  }

  pollDeviceLoginRequest(id: string, token: string): Effect.Effect<DeviceLoginPollResult, ApiError, never> {
    return this.request<DeviceLoginPollResult>(`/api/device-login/requests/${encodeURIComponent(id)}`, {
      headers: { "x-device-token": token },
    });
  }

  // ── Project admin (admin-gated: superadmin session OR bare/server key; a
  // member-bound key → 403 FORBIDDEN "Admin role required") ──
  // create/update return the project directly (no envelope); 201 | 200 |
  // 403 | 404 TEAM_NOT_FOUND | 409 SLUG_TAKEN.
  createProject(input: { name: string; slug?: string; description?: string; teamId?: string | null }): Effect.Effect<ProjectInfo, ApiError, never> {
    return this.request<ProjectInfo>("/api/projects", { method: "POST", body: JSON.stringify(input) });
  }

  updateProject(slug: string, input: { name?: string; description?: string }): Effect.Effect<ProjectInfo, ApiError, never> {
    return this.request<ProjectInfo>(`/api/projects/${slug}`, { method: "PATCH", body: JSON.stringify(input) });
  }

  // 204 | 403 | 404 | 409 SLUG_TAKEN (constraint fallback).
  deleteProject(slug: string): Effect.Effect<void, ApiError, never> {
    return this.request<void>(`/api/projects/${slug}`, { method: "DELETE" });
  }

  // ── Column admin ──
  // create/update return the column directly; 201 | 200 | 403 | 404.
  createColumn(slug: string, input: { name: string; position?: number; color?: string; wipLimit?: number | null; requiredFields?: string[]; githubState?: "open" | "closed" | null }): Effect.Effect<ColumnInfo, ApiError, never> {
    return this.request<ColumnInfo>(`/api/projects/${slug}/columns`, { method: "POST", body: JSON.stringify(input) });
  }

  updateColumn(slug: string, id: string, input: { name?: string; position?: number; color?: string; wipLimit?: number | null; requiredFields?: string[]; githubState?: "open" | "closed" | null; isDone?: boolean }): Effect.Effect<ColumnInfo, ApiError, never> {
    return this.request<ColumnInfo>(`/api/projects/${slug}/columns/${id}`, { method: "PATCH", body: JSON.stringify(input) });
  }

  // 204 | 403 | 409 HAS_CHILDREN { count } (tasks must be migrated first).
  deleteColumn(slug: string, id: string): Effect.Effect<void, ApiError, never> {
    return this.request<void>(`/api/projects/${slug}/columns/${id}`, { method: "DELETE" });
  }

  // ── Swimlane admin ──
  createSwimlane(slug: string, input: { name: string; description?: string; position?: number; dueAt?: string | null; startAt?: string | null; milestoneId?: string | null }): Effect.Effect<SwimlaneInfo, ApiError, never> {
    return this.request<SwimlaneInfo>(`/api/projects/${slug}/swimlanes`, { method: "POST", body: JSON.stringify(input) });
  }

  updateSwimlane(slug: string, id: string, input: { name?: string; description?: string; position?: number; dueAt?: string | null; startAt?: string | null; milestoneId?: string | null }): Effect.Effect<SwimlaneInfo, ApiError, never> {
    return this.request<SwimlaneInfo>(`/api/projects/${slug}/swimlanes/${id}`, { method: "PATCH", body: JSON.stringify(input) });
  }

  // 204 | 403 | 409 HAS_CHILDREN { count } | 409 BACKLOG_PROTECTED.
  deleteSwimlane(slug: string, id: string): Effect.Effect<void, ApiError, never> {
    return this.request<void>(`/api/projects/${slug}/swimlanes/${id}`, { method: "DELETE" });
  }

  // ── Field config (priorities & types, per project) ──
  getFieldConfig(slug: string): Effect.Effect<FieldConfigInfo, ApiError, never> {
    return this.request<FieldConfigInfo>(`/api/projects/${slug}/field-config`);
  }

  // Wholesale { priorities, types } — no client-side option validation.
  putFieldConfig(slug: string, input: FieldConfigInput): Effect.Effect<FieldConfigInfo, ApiError, never> {
    return this.request<FieldConfigInfo>(`/api/projects/${slug}/field-config`, { method: "PUT", body: JSON.stringify(input) });
  }

  // ── Settings: rate limit ──
  getRateLimit(): Effect.Effect<RateLimitInfo, ApiError, never> {
    return this.request<RateLimitInfo>("/api/settings/rate-limit");
  }

  // 200 | 403 | 422 INVALID_RATE_LIMIT.
  putRateLimit(input: { max: number; windowMs: number }): Effect.Effect<RateLimitInfo, ApiError, never> {
    return this.request<RateLimitInfo>("/api/settings/rate-limit", { method: "PUT", body: JSON.stringify(input) });
  }

  // ── Settings: admin API keys ──
  // list unwraps { data }; the payload never carries rawKey (masked).
  listSettingsApiKeys(): Effect.Effect<ApiKeyInfo[], ApiError, never> {
    return Effect.map(this.request<{ data: ApiKeyInfo[] }>("/api/settings/api-keys"), (r) => r.data);
  }

  // 201 { key, rawKey } (rawKey shown once) | 403 FORBIDDEN | 403 NO_USER_CONTEXT
  // (bare/server key has no user to bind the key to).
  createSettingsApiKey(input: { name: string }): Effect.Effect<{ key: ApiKeyInfo; rawKey: string }, ApiError, never> {
    return this.request<{ key: ApiKeyInfo; rawKey: string }>("/api/settings/api-keys", { method: "POST", body: JSON.stringify(input) });
  }

  // 204 | 403 | 404.
  revokeSettingsApiKey(id: string): Effect.Effect<void, ApiError, never> {
    return this.request<void>(`/api/settings/api-keys/${encodeURIComponent(id)}`, { method: "DELETE" });
  }
}

export interface DeviceLoginRequestInfo {
  id: string;
  code: string;
  clientName: string;
  status: "pending" | "approved" | "denied";
  expiresMs: number;
  verifyUrl: string;
}

export type DeviceLoginPollResult =
  | { status: "pending"; clientName: string; code: string; expiresAt: string }
  | { status: "approved"; rawKey: string; keyName: string; approverName: string | null };
