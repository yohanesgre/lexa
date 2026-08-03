export type ID = string;
export type ISODate = string;
export type TipTapDoc = { type: "doc"; content: unknown[] };

export interface Project {
  id: ID;
  name: string;
  slug: string;
  description: string;
  githubRepo: string | null;
  createdAt: ISODate;
  updatedAt: ISODate;
}

export interface Column {
  id: ID;
  projectId: ID;
  name: string;
  position: number;
  color: string;
  wipLimit: number | null;
  requiredFields: string[];
  githubState: "open" | "closed" | null;
}

export interface Swimlane {
  id: ID;
  projectId: ID;
  name: string;
  description: string;
  position: number;
}

export interface Board {
  project: Project;
  columns: Column[];
  swimlanes: Swimlane[];
  fieldConfig: FieldConfig;
  links: TaskLink[];
  tasks: Task[];
}

export interface FieldOption {
  id: ID;
  label: string;
  color: string;
  position: number;
}

export interface FieldConfig {
  priorities: FieldOption[];
  types: FieldOption[];
}

export interface GithubIssue {
  issueId: string;
  issueNumber: number;
  repo: string;
  syncedState: "open" | "closed" | null;
  url: string;
  outOfSync: boolean;
}

export interface Task {
  id: ID;
  projectId: ID;
  columnId: ID;
  swimlaneId: ID;
  title: string;
  description: TipTapDoc;
  priority: ID;               // priority_options.id — resolve via Board.fieldConfig
  type: ID;                   // type_options.id
  assignees: string[];
  position: string;
  githubs: GithubIssue[];
  archivedAt: ISODate | null;
  createdAt: ISODate;
  updatedAt: ISODate;
}

export interface WikiPageMeta {
  id: ID;
  projectId: ID;
  title: string;
  slug: string;
  parentId: ID | null;
  position: number;
  updatedAt: ISODate;
}

export interface WikiPage extends WikiPageMeta {
  content: TipTapDoc;
  createdAt: ISODate;
}

export interface WikiPageRevision {
  id: string;
  pageId: string;
  title: string;
  slug: string;
  content: TipTapDoc;
  contentText: string;
  saveType: "autosave" | "manual";
  createdAt: string;
}

export interface WikiPageRevisionSummary {
  id: string;
  title: string;
  saveType: "autosave" | "manual";
  createdAt: string;
}

export interface ApiKey {
  id: ID;
  name: string;
  createdAt: ISODate;
  lastUsedAt: ISODate | null;
}

export interface ApiKeyCreateResult {
  key: ApiKey;
  rawKey: string;
}

export interface WipSegment {
  state: "ok" | "approaching" | "exceeded" | "empty";
  flex: number;
}

export interface ProjectHealth {
  project: Project;
  taskCount: number;
  columnCount: number;
  urgentCount: number;
  syncCount: number;
  health: "ok" | "approaching" | "exceeded";
  wipSegments: WipSegment[];
}

export interface DashboardStats {
  totalTasks: number;
  activeProjects: number;
  wipExceeded: number;
  outOfSync: number;
}

export interface UrgentTask {
  id: string;
  title: string;
  projectName: string;
  projectSlug: string;
  columnName: string;
  priority: ID;               // first priority option id (position 0)
}

export interface OutOfSyncTask {
  id: string;
  title: string;
  projectName: string;
  projectSlug: string;
  repo: string;
  issueNumber: number;
}

export interface Dashboard {
  projects: ProjectHealth[];
  stats: DashboardStats;
  urgentTasks: UrgentTask[];
  outOfSyncTasks: OutOfSyncTask[];
}

// ── Forge (runtime agent writing assistant) ──

export type ForgeProvider = "opencode" | "hermes" | "command-code";
export type ForgeTaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type SourceKind = "wiki" | "external";

// A named rule bundle defined in Lexa. Its instructions are written into the
// run dir as AGENTS.md at claim time. Distinct from a runtime's CLI agent
// (Runtime.agent — the CLI persona flag).
export interface ForgeAgent {
  id: ID;
  name: string;
  // Display-only — never sent to the runtime agent.
  description: string;
  instructions: string;
  isBuiltin: boolean;
  skillIds: ID[];
  createdAt: ISODate;
  updatedAt: ISODate;
}

// A named operation bundle attached to agents (M2M). Its instructions are
// written into the run dir as .agents/<skill>/SKILL.md at claim time.
export interface ForgeSkill {
  id: ID;
  name: string;
  description: string;
  instructions: string;
  isBuiltin: boolean;
  createdAt: ISODate;
  updatedAt: ISODate;
}

// A model the runtime's agent CLI can spawn, as reported by lexa-cli
// (opencode models --verbose / cmd --list-models). id is the full
// provider/model id — stored verbatim as Runtime.model and passed to --model.
export interface RuntimeModel {
  id: string;
  provider: string;
  name: string;
}

export interface RuntimeAgent {
  id: string;
  name: string;
}

export interface Runtime {
  id: ID;
  name: string;
  provider: ForgeProvider;
  machineId: ID | null;
  // The agent CLI's internal agent/persona flag (opencode --agent build/plan).
  // Empty = the CLI's default agent.
  agent: string;
  model: string;
  // opencode run flags: --print-logs (bool) + --log-level (DEBUG|INFO|WARN|ERROR).
  // Empty logLevel = opencode's default. Only applied for the opencode provider.
  printLogs: boolean;
  logLevel: "" | "DEBUG" | "INFO" | "WARN" | "ERROR";
  extraArgs: string[];
  modelsCatalog: RuntimeModel[];
  agentsCatalog: RuntimeAgent[];
  status: "online" | "offline";
  // Daemon-verified Lexa MCP connectivity (initialize+ping on every
  // heartbeat). Runtimes without it are blocked from Forge tasks.
  mcpConnected: boolean;
  hostname: string;
  lastSeen: ISODate | null;
  createdAt: ISODate;
}

export type RuntimeEventAction = "install" | "update" | "remove";

export interface RuntimeEvent {
  id: ID;
  machineId: ID;
  action: RuntimeEventAction;
  agentCli: ForgeProvider;
  // Null for update/remove events; install delivers a fresh key once.
  apiKeyId: ID | null;
  status: "pending" | "claimed" | "completed" | "failed";
  error: string | null;
  createdAt: ISODate;
  claimedAt: ISODate | null;
  finishedAt: ISODate | null;
}

// A `lexa-cli machine listen` process heartbeating machine presence so the web
// setup wizard can target a listening machine.
export interface Machine {
  id: ID;
  hostname: string;
  lastSeen: ISODate | null;
  createdAt: ISODate;
}

export interface ForgeTask {
  id: ID;
  runtimeId: ID | null;
  projectId: ID;
  documentType: "task" | "wiki";
  documentId: string;
  documentTitle: string;
  agentId: ID;
  skillId: ID;
  agentName: string;
  skillName: string;
  extraPrompt: string;
  selection: string;
  docContext: string;
  status: ForgeTaskStatus;
  result: string | null;
  error: string | null;
  createdAt: ISODate;
  startedAt: ISODate | null;
  finishedAt: ISODate | null;
}

// One line of the live activity feed for a Forge task (append-only).
export interface ForgeTaskLog {
  id: ID;
  taskId: ID;
  message: string;
  createdAt: ISODate;
}

export interface DocumentSource {
  id: ID;
  projectId: ID;
  documentType: "task" | "wiki";
  documentId: string;
  kind: SourceKind;
  title: string;
  ref: string;          // wiki page slug (kind=wiki) or URL (kind=external)
  createdAt: ISODate;
}

// ── Task links (subtask / blocked-by / related) ──

export type TaskLinkRelation = "subtask_of" | "blocked_by" | "related_to";

export interface TaskLink {
  id: ID;
  projectId: ID;
  fromTaskId: ID;       // "this task"
  toTaskId: ID;         // "that task"
  relation: TaskLinkRelation;
  createdAt: ISODate;
}

export interface TaskLinkSuggestion {
  id: ID;
  title: string;
  columnName: string;
  type: string;         // type_options.id — resolve color via fieldConfig
  priority: string;     // priority_options.id
}
