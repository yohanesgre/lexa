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
  name: string;
  wipLimit: number | null;
  requiredFields: string[] | null;
  color: string | null;
  position: number;
  githubState: "open" | "closed" | null;
}

export interface SwimlaneInfo {
  id: string;
  name: string;
  position: number;
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

  moveTask(slug: string, id: string, target: { columnId: string; swimlaneId: string }): Effect.Effect<TaskInfo, ApiError, never> {
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
