// lexa-cli REST client — thin fetch wrapper over the Lexa API.
//   All calls need a base URL + Bearer API key (from config or env).
//
// Effect boundary: every call returns Effect.Effect<T, ApiError, never>.
// JSON payloads are cast at the boundary (project rule); network-level
// failures (fetch rejections) are normalized into ApiError(status 0).
import { Effect, Data } from "effect";
import type { CliConfig } from "./config";

export class ApiError extends Data.TaggedError("ApiError")<{
  status: number;
  code?: string;
  details?: unknown;
  serverMessage?: string;
}> {
  get message(): string {
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
  githubRepo: string | null;
}

export interface WikiPageMetaInfo {
  id: string;
  title: string;
  slug: string;
  position: number;
  hasChildren: boolean;
}

export interface RuntimeInfo {
  id: string;
  name: string;
  provider: string;
  machineId: string | null;
  agent: string;
  model: string;
  status: "online" | "offline";
  mcpConnected: boolean;
  lastError: string | null;
  hostname: string;
  lastSeen: string | null;
}

export interface RuntimeCatalogInfo {
  runtimeId: string;
  agentCli: "opencode" | "hermes" | "command-code";
  models: Array<{ id: string; provider: string; name: string }>;
  agents: Array<{ id: string; name: string }>;
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
        const res = await fetch(`${this.config.url}${path}`, { ...init, headers });
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

  createTask(slug: string, input: { columnId: string; swimlaneId: string; title: string; description?: unknown; priority?: string; type?: string }): Effect.Effect<TaskInfo, ApiError, never> {
    return this.request<TaskInfo>(`/api/projects/${slug}/tasks`, { method: "POST", body: JSON.stringify(input) });
  }

  updateTask(slug: string, id: string, input: { title?: string; priority?: string; type?: string }): Effect.Effect<TaskInfo, ApiError, never> {
    return this.request<TaskInfo>(`/api/projects/${slug}/tasks/${id}`, { method: "PATCH", body: JSON.stringify(input) });
  }

  moveTask(slug: string, id: string, target: { columnId: string; swimlaneId: string }): Effect.Effect<TaskInfo, ApiError, never> {
    return this.request<TaskInfo>(`/api/projects/${slug}/tasks/${id}/move`, { method: "POST", body: JSON.stringify(target) });
  }

  // GitHub sync: create a GitHub issue from the task and link it.
  // 200 Task (with githubs populated) | 404 | 409 ALREADY_LINKED | 502 GITHUB_API_ERROR
  linkGithubIssue(slug: string, id: string, repo: string): Effect.Effect<TaskInfo, ApiError, never> {
    return this.request<TaskInfo>(`/api/projects/${slug}/tasks/${id}/github-link`, {
      method: "POST",
      body: JSON.stringify({ repo }),
    });
  }

  // ── Wiki ──
  listWikiPages(slug: string): Effect.Effect<WikiPageMetaInfo[], ApiError, never> {
    return Effect.map(this.request<{ data: WikiPageMetaInfo[] }>(`/api/projects/${slug}/wiki`), (r) => r.data);
  }

  getWikiPage(slug: string, pageSlug: string): Effect.Effect<{ id: string; title: string; slug: string; content: unknown }, ApiError, never> {
    return this.request<{ id: string; title: string; slug: string; content: unknown }>(`/api/projects/${slug}/wiki/${pageSlug}`);
  }

  // ── Forge runtimes ──
  listRuntimes(): Effect.Effect<RuntimeInfo[], ApiError, never> {
    return Effect.map(this.request<{ data: RuntimeInfo[] }>("/api/forge/runtimes"), (r) => r.data);
  }

  deleteRuntime(id: string): Effect.Effect<void, ApiError, never> {
    return this.request<void>(`/api/forge/runtimes/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  listMachines(): Effect.Effect<MachineInfo[], ApiError, never> {
    return Effect.map(this.request<{ data: MachineInfo[] }>("/api/forge/machines"), (r) => r.data);
  }

  registerMachine(input: { id: string; hostname: string; secret: string }): Effect.Effect<{ machine: MachineInfo; secret: string | null }, ApiError, never> {
    return this.request<{ machine: MachineInfo; secret: string | null }>("/api/forge/machines/register", { method: "POST", body: JSON.stringify(input) });
  }

  deleteMachine(id: string): Effect.Effect<void, ApiError, never> {
    return this.request<void>(`/api/forge/machines/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  // ── Runtime setup events (web wizard → listener) ──
  claimRuntimeEvent(machineId: string, secret: string): Effect.Effect<{ event: RuntimeEventInfo; rawKey: string | null } | null, ApiError, never> {
    return this.request<{ event: RuntimeEventInfo; rawKey: string | null } | null>("/api/forge/runtime-events/claim", {
      method: "POST",
      headers: { "x-machine-secret": secret },
      body: JSON.stringify({ machineId }),
    });
  }

  completeRuntimeEvent(id: string): Effect.Effect<RuntimeEventInfo, ApiError, never> {
    return this.request<RuntimeEventInfo>(`/api/forge/runtime-events/${id}/complete`, { method: "POST" });
  }

  failRuntimeEvent(id: string, error: string): Effect.Effect<RuntimeEventInfo, ApiError, never> {
    return this.request<RuntimeEventInfo>(`/api/forge/runtime-events/${id}/fail`, { method: "POST", body: JSON.stringify({ error }) });
  }

  // Presence heartbeat and runtime catalogs — machine identity is stable across
  // listener restarts and catalog discovery stays in this CLI process.
  machineHeartbeat(input: {
    id: string;
    hostname: string;
    runtimes?: RuntimeCatalogInfo[];
    clis?: Array<{ provider: "opencode" | "hermes" | "command-code"; version: string }>;
    daemonErrors?: Array<{ runtimeId: string; error: string }>;
  }): Effect.Effect<MachineHeartbeatInfo, ApiError, never> {
    return this.request<MachineHeartbeatInfo>("/api/forge/machines/heartbeat", { method: "POST", body: JSON.stringify(input) });
  }
}

export interface MachineInfo {
  id: string;
  hostname: string;
  clis: Array<{ provider: "opencode" | "hermes" | "command-code"; version: string }>;
  lastSeen: string | null;
  createdAt: string;
}

// Heartbeat response extends the machine with the project index (id, name,
// slug, description) — the listener provisions one workspace dir per project
// under ~/.lexa/projects/ from it.
export interface MachineHeartbeatInfo extends MachineInfo {
  projects: Array<{ id: string; name: string; slug: string; description: string }>;
}

export interface RuntimeEventInfo {
  id: string;
  machineId: string;
  action: "install" | "update" | "remove";
  agentCli: "opencode" | "hermes" | "command-code";
  apiKeyId: string | null;
  status: "pending" | "claimed" | "completed" | "failed";
  error: string | null;
  createdAt: string;
  claimedAt: string | null;
  finishedAt: string | null;
}
