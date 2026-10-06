export type ID = string;
export type ISODate = string;
export type JSONValue = string | number | boolean | null | JSONValue[] | { [key: string]: JSONValue };
export type TipTapMark = { type: string; attrs?: Record<string, JSONValue> | Record<string, unknown> | undefined };
export type TipTapNode = {
  type: string;
  attrs?: Record<string, JSONValue> | Record<string, unknown> | undefined;
  content?: TipTapNode[] | undefined;
  text?: string | undefined;
  marks?: TipTapMark[] | undefined;
};
export type TipTapDoc = { type: "doc"; content: TipTapNode[] };

export function parseTipTapDoc(json: string): TipTapDoc {
  const parsed: unknown = JSON.parse(json);
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    (parsed as { type?: unknown }).type === "doc" &&
    Array.isArray((parsed as { content?: unknown }).content)
  ) {
    return parsed as TipTapDoc;
  }
  throw new Error("Invalid TipTapDoc");
}

export function isTipTapDoc(value: unknown): value is TipTapDoc {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "doc" &&
    Array.isArray((value as { content?: unknown }).content)
  );
}

export interface ProjectRepo {
  repo: string;
  sourceRole: boolean;
  workspaceRole: boolean;
}

export interface Project {
  id: ID;
  name: string;
  slug: string;
  key: string;            // ticket prefix, e.g. "EMB"
  description: string;
  repos: ProjectRepo[];
  createdAt: ISODate;
  updatedAt: ISODate;
}

// Domain shape returned by the repo/service layer (project_repos live in their
// own table and are attached at the API boundary — see withRepos in http.ts).
export type DomainProject = Omit<Project, "repos">;

// ── Auth, teams & sessions ──

export interface LexaUser {
  id: ID;
  email: string;
  name: string;
  role: "superadmin" | "member";
  createdAt: ISODate;
  lastSeen: ISODate | null;
}

// A team = a Better Auth organization (organization table; slug unique).
// Team-admin authority comes from the org member role (owner/admin), never
// from users.role.
export interface Team {
  id: ID;
  name: string;
  slug: string;
  createdAt: string;
}

export type TeamMemberRole = "owner" | "admin" | "member";

export interface TeamMember {
  userId: ID;
  name: string;
  email: string;
  role: TeamMemberRole;
  createdAt: string;
}

// Superadmin-issued app-member invite (link-based, no email transport).
// tokenHint = short prefix of the link secret for display; the full token is
// never stored in the payload.
export interface WorkspaceInvite {
  id: ID;
  email: string;
  tokenHint: string;
  expiresAt: string;
  acceptedAt: string | null;
}

export interface SessionInfo {
  id: ID;
  ipAddress: string | null;
  userAgent: string | null;
  expiresAt: string;
  createdAt: string;
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
  isDone: boolean;            // done marker — independent of githubState mapping
}

export interface Swimlane {
  id: ID;
  projectId: ID;
  name: string;
  description: string;
  position: number;
  dueAt: string | null;
  archivedAt: string | null;
  startAt: string | null;     // YYYY-MM-DD sprint start
  kind: "backlog" | "sprint"; // Backlog = system lane (permanent); sprint = time-boxed lane
  milestoneId: string | null; // owning milestone; null = loose sprint
  tasksDone: number;          // done = archived task OR task in a done column (invariant 14)
  tasksTotal: number;         // every task in the lane, archived included
}

// Goal wrapper above sprints (e.g. "v1.0 launch"). A milestone holds one or
// more sprints; deleting it loosens them (ON DELETE SET NULL).
export interface Milestone {
  id: ID;
  projectId: ID;
  name: string;
  description: string;
  position: number;
  dueAt: string | null;          // YYYY-MM-DD target date; null = no deadline
  archivedAt: string | null;     // null = live; set = archived (cascades to its sprints)
  sprintCount: number;           // total sprints (incl. archived) in this milestone
  archivedSprintCount: number;   // archived sprints
  tasksDone: number;             // done tasks across the milestone's sprints
  tasksTotal: number;            // all tasks across the milestone's sprints
}

export interface Board {
  project: Project;
  columns: Column[];
  swimlanes: Swimlane[];
  milestones: Milestone[];
  fieldConfig: FieldConfig;
  links: TaskLink[];
  tasks: BoardTask[];
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
  title: string | null;       // last-known upstream title; NULL = unknown
  syncedState: "open" | "closed" | null;
  url: string;
  outOfSync: boolean;
  pushFailed: boolean;
}

export interface GithubIssueSummary {
  number: number;
  title: string;
  state: "open" | "closed";
}

export interface Task {
  id: ID;
  key: string;            // "EMB-12" — stable ticket identifier
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
  dueAt: string | null;
  archivedAt: ISODate | null;
  createdAt: ISODate;
  updatedAt: ISODate;
}

// Board list rows omit the TipTap `description` payload; the detail query
// carries it. Hydrate the empty doc when a board row must render before the
// detail response resolves.
export type BoardTask = Omit<Task, "description">;

export function boardTaskToTask(task: BoardTask): Task {
  return { ...task, description: { type: "doc", content: [] } };
}

export interface WikiPageMeta {
  id: ID;
  projectId: ID;
  title: string;
  slug: string;
  parentId: ID | null;
  position: number;
  updatedBy: string | null;        // users.id of the last save; null = legacy/unknown
  updatedByName: string | null;    // resolved on single-page payloads; list/tree/search emit null
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
  ownerEmail?: string;         // present only for user-bound keys
  ownerName?: string;
}

export interface DeviceLoginRequestInfo {
  id: ID;
  code: string;                // 8-char display code (display-only, no oracle)
  clientName: string;
  status: "pending" | "approved" | "denied";
  expiresMs: number;           // absolute epoch ms
  verifyUrl: string;
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

// ── Assistant task queue (document Generate, assistant lane) ──

export type AssistantTaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface AssistantTask {
  id: ID;
  projectId: ID;
  documentType: "task" | "wiki";
  documentId: string;
  key: string;
  documentTitle: string;
  agentId: ID;
  skillId: ID | null;
  agentName: string;
  skillName: string;
  extraPrompt: string;
  selection: string;
  status: AssistantTaskStatus;
  result: string | null;
  error: string | null;
  createdAt: ISODate;
  startedAt: ISODate | null;
  finishedAt: ISODate | null;
}

export type SourceKind = "wiki" | "external";

// A named rule bundle defined in Lexa. Its instructions are written into the
// run dir as AGENTS.md at claim time.
export interface LexaAgent {
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
export interface LexaSkill {
  id: ID;
  name: string;
  description: string;
  instructions: string;
  isBuiltin: boolean;
  createdAt: ISODate;
  updatedAt: ISODate;
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

// ── Activity timeline + comments ──

export type ActorKind = "user" | "agent" | "system";

export type ActivityType =
  | "created" | "moved" | "field_changed" | "archived" | "restored" | "deleted"
  | "link_added" | "link_removed" | "source_added" | "source_removed"
  | "github_linked" | "github_unlinked" | "github_synced"
  | "assistant_completed" | "assistant_failed" | "assistant_cancelled"
  | "runtime_completed" | "runtime_failed" | "runtime_cancelled"
  | "commented" | "comment_deleted"
  | "attachment_added" | "attachment_removed";

export interface Actor {
  kind: ActorKind;
  label: string;
  userId?: string | null;
}

// Attachment row as served by the API. uploadedByLabel is resolved
// server-side (users.name) so the UI shows a name without extra fetches.
export interface Attachment {
  id: ID;
  projectId: ID;
  taskId: ID | null;      // exactly one of taskId / wikiPageId
  wikiPageId: ID | null;
  filename: string;       // sanitized (basename, control chars stripped, ≤255)
  mimeType: string;       // SERVER-SNIFFED at upload — client mime never stored
  sizeBytes: number;
  sha256: string;         // hex; dedupe key per project — UNIQUE(project_id, sha256)
  uploadedBy: ID | null;  // session user or key owner; NULL = unbound key
  uploadedByLabel: string | null;
  createdAt: ISODate;
}

export interface ActivityEvent {
  id: number;
  taskId: string;
  actorKind: ActorKind;
  actorLabel: string;
  actorUserId: string | null;
  type: ActivityType;
  message: string;
  viaAssistant: boolean;
  createdAt: string;
}

export interface TaskComment {
  id: number;
  taskId: string;
  authorId: string | null;
  authorKind: ActorKind;
  authorLabel: string;
  body: TipTapDoc;
  viaAssistant: boolean;
  editedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
}

export type ActivityItem =
  | ({ kind: "event" } & ActivityEvent)
  | ({ kind: "comment" } & TaskComment);
