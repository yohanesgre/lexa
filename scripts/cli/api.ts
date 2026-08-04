// lexa-cli REST client — thin fetch wrapper over the Lexa API.
//   All calls need a base URL + Bearer API key (from config or env).
import type { CliConfig } from "./config";

export class ApiError extends Error {
  status: number;
  code?: string;
  details?: unknown;
  constructor(status: number, message: string, code?: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface ColumnInfo {
  id: string;
  name: string;
  wipLimit: number | null;
  requiredFields: string[] | null;
  color: string | null;
  position: number;
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

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.config.apiKey}`,
      ...(init?.headers as Record<string, string> | undefined),
    };
    const res = await fetch(`${this.config.url}${path}`, { ...init, headers });
    if (!res.ok) {
      let code: string | undefined;
      let details: unknown;
      let message = `HTTP ${res.status}`;
      try {
        const body = (await res.json()) as { error?: { code?: string; message?: string; details?: unknown } };
        code = body.error?.code;
        details = body.error?.details;
        message = body.error?.message ?? message;
      } catch { /* non-JSON error body */ }
      throw new ApiError(res.status, message, code, details);
    }
    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  }

  // ── Health / auth probe ──
  // /api/health is unauthenticated. A login is validated by calling it (server
  // reachable) then a real authed call (listProjects) to confirm the key works.
  async health(): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>("/api/health");
  }

  // ── Projects ──
  async listProjects(): Promise<ProjectInfo[]> {
    const r = await this.request<{ data: ProjectInfo[] }>("/api/projects");
    return r.data;
  }

  // ── Columns / swimlanes (for name-based lookup) ──
  async listColumns(slug: string): Promise<ColumnInfo[]> {
    const r = await this.request<{ data: ColumnInfo[] }>(`/api/projects/${slug}/columns`);
    return r.data;
  }

  async listSwimlanes(slug: string): Promise<SwimlaneInfo[]> {
    const r = await this.request<{ data: SwimlaneInfo[] }>(`/api/projects/${slug}/swimlanes`);
    return r.data;
  }

  // ── Tasks ──
  async listTasks(slug: string, limit = 20): Promise<TaskInfo[]> {
    const r = await this.request<{ data: TaskInfo[] }>(`/api/projects/${slug}/tasks?limit=${limit}`);
    return r.data;
  }

  async getTask(slug: string, id: string): Promise<TaskInfo> {
    return this.request<TaskInfo>(`/api/projects/${slug}/tasks/${id}`);
  }

  async createTask(slug: string, input: { columnId: string; swimlaneId: string; title: string; description?: unknown; priority?: string; type?: string }): Promise<TaskInfo> {
    return this.request<TaskInfo>(`/api/projects/${slug}/tasks`, { method: "POST", body: JSON.stringify(input) });
  }

  async updateTask(slug: string, id: string, input: { title?: string; priority?: string; type?: string }): Promise<TaskInfo> {
    return this.request<TaskInfo>(`/api/projects/${slug}/tasks/${id}`, { method: "PATCH", body: JSON.stringify(input) });
  }

  async moveTask(slug: string, id: string, target: { columnId: string; swimlaneId: string }): Promise<TaskInfo> {
    return this.request<TaskInfo>(`/api/projects/${slug}/tasks/${id}/move`, { method: "POST", body: JSON.stringify(target) });
  }

  // ── Wiki ──
  async listWikiPages(slug: string): Promise<WikiPageMetaInfo[]> {
    const r = await this.request<{ data: WikiPageMetaInfo[] }>(`/api/projects/${slug}/wiki`);
    return r.data;
  }

  async getWikiPage(slug: string, pageSlug: string): Promise<{ id: string; title: string; slug: string; content: unknown }> {
    return this.request<{ id: string; title: string; slug: string; content: unknown }>(`/api/projects/${slug}/wiki/${pageSlug}`);
  }

  // ── Forge runtimes ──
  async listRuntimes(): Promise<RuntimeInfo[]> {
    const r = await this.request<{ data: RuntimeInfo[] }>("/api/forge/runtimes");
    return r.data;
  }

  async deleteRuntime(id: string): Promise<void> {
    await this.request<void>(`/api/forge/runtimes/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  async listMachines(): Promise<MachineInfo[]> {
    const r = await this.request<{ data: MachineInfo[] }>("/api/forge/machines");
    return r.data;
  }

  async registerMachine(input: { id: string; hostname: string }): Promise<MachineInfo> {
    return this.request<MachineInfo>("/api/forge/machines/register", { method: "POST", body: JSON.stringify(input) });
  }

  async deleteMachine(id: string): Promise<void> {
    await this.request<void>(`/api/forge/machines/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  // ── Runtime setup events (web wizard → listener) ──
  async claimRuntimeEvent(machineId: string): Promise<{ event: RuntimeEventInfo; rawKey: string | null } | null> {
    return this.request<{ event: RuntimeEventInfo; rawKey: string | null } | null>("/api/forge/runtime-events/claim", {
      method: "POST",
      body: JSON.stringify({ machineId }),
    });
  }

  async completeRuntimeEvent(id: string): Promise<RuntimeEventInfo> {
    return this.request<RuntimeEventInfo>(`/api/forge/runtime-events/${id}/complete`, { method: "POST" });
  }

  async failRuntimeEvent(id: string, error: string): Promise<RuntimeEventInfo> {
    return this.request<RuntimeEventInfo>(`/api/forge/runtime-events/${id}/fail`, { method: "POST", body: JSON.stringify({ error }) });
  }

  // Presence heartbeat and runtime catalogs — machine identity is stable across
  // listener restarts and catalog discovery stays in this CLI process.
  async machineHeartbeat(input: {
    id: string;
    hostname: string;
    runtimes?: RuntimeCatalogInfo[];
    clis?: Array<{ provider: "opencode" | "hermes" | "command-code"; version: string }>;
    daemonErrors?: Array<{ runtimeId: string; error: string }>;
  }): Promise<MachineHeartbeatInfo> {
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
