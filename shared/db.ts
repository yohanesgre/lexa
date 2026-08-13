// Database row types — mirror SQL column names exactly (snake_case).
// Used by server repos/services only. Frontend never imports this file.

import type { TipTapDoc, ISODate, RuntimeAgent, RuntimeModel, ActorKind, ActivityType, ActivityEvent, TaskComment, Swimlane, Milestone, DomainProject, Runtime } from "./types";

// Runtime with the owning team exposed (wire-only — the shared Runtime type
// stays team-free per the contract; the FE reads teamId off the wire).
export interface RuntimeWithTeam extends Runtime {
  teamId: string | null;
}

export interface PriorityOptionRow {
  id: string;
  project_id: string;
  label: string;
  color: string;
  position: number;
}

export interface TypeOptionRow {
  id: string;
  project_id: string;
  label: string;
  color: string;
  position: number;
}

export function rowToFieldOption(row: PriorityOptionRow | TypeOptionRow): {
  id: string; label: string; color: string; position: number;
} {
  return {
    id: row.id,
    label: row.label,
    color: row.color,
    position: row.position,
  };
}

export interface ProjectRow {
  id: string;
  name: string;
  slug: string;
  description: string;
  created_at: string;
  updated_at: string;
  team_id: string | null;
}

export function rowToProject(row: ProjectRow): DomainProject & { teamId: string | null } {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    teamId: row.team_id ?? null,
  };
}

export interface ProjectRepoRow {
  id: string;
  project_id: string;
  repo: string;
  source_role: number;
  workspace_role: number;
  created_at: string;
}

export function rowToProjectRepo(row: ProjectRepoRow): { repo: string; sourceRole: boolean; workspaceRole: boolean } {
  return {
    repo: row.repo,
    sourceRole: row.source_role === 1,
    workspaceRole: row.workspace_role === 1,
  };
}

export interface ColumnRow {
  id: string;
  project_id: string;
  name: string;
  position: number;
  color: string;
  wip_limit: number | null;
  required_fields: string;
  github_state: "open" | "closed" | null;
  is_done?: number;
}

export function rowToColumn(row: ColumnRow): {
  id: string; projectId: string; name: string; position: number; color: string; wipLimit: number | null; requiredFields: string[]; githubState: "open" | "closed" | null; isDone: boolean;
} {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    position: row.position,
    color: row.color,
    wipLimit: row.wip_limit,
    requiredFields: JSON.parse(row.required_fields) as string[],
    githubState: row.github_state,
    isDone: (row.is_done ?? 0) === 1,
  };
}

export interface SwimlaneRow {
  id: string;
  project_id: string;
  name: string;
  description: string;
  position: number;
  due_at: string | null;
  archived_at: string | null;
  start_at: string | null;
  kind?: "backlog" | "sprint";
  milestone_id: string | null;
}

export function rowToSwimlane(row: SwimlaneRow): Swimlane {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    description: row.description,
    position: row.position,
    dueAt: row.due_at ?? null,
    archivedAt: row.archived_at ?? null,
    startAt: row.start_at ?? null,
    kind: (row.kind ?? "sprint") as Swimlane["kind"],
    milestoneId: row.milestone_id ?? null,
  };
}

export interface MilestoneRow {
  id: string;
  project_id: string;
  name: string;
  description: string;
  position: number;
  due_at: string | null;
  archived_at: string | null;
  sprint_count?: number;
  archived_sprint_count?: number;
}

export function rowToMilestone(row: MilestoneRow): Milestone {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    description: row.description,
    position: row.position,
    dueAt: row.due_at ?? null,
    archivedAt: row.archived_at ?? null,
    sprintCount: row.sprint_count ?? 0,
    archivedSprintCount: row.archived_sprint_count ?? 0,
  };
}

export interface WikiPageRow {
  id: string;
  project_id: string;
  title: string;
  slug: string;
  content: string;
  content_text: string;
  parent_id: string | null;
  position: number;
  created_at: string;
  updated_at: string;
}

export function rowToWikiPageMeta(row: WikiPageRow): {
  id: string; projectId: string; title: string; slug: string; parentId: string | null; position: number; updatedAt: ISODate;
} {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    slug: row.slug,
    parentId: row.parent_id,
    position: row.position,
    updatedAt: row.updated_at,
  };
}

export function rowToWikiPage(row: WikiPageRow): {
  id: string; projectId: string; title: string; slug: string; parentId: string | null; position: number; updatedAt: ISODate; content: TipTapDoc; createdAt: ISODate;
} {
  return {
    ...rowToWikiPageMeta(row),
    content: JSON.parse(row.content) as TipTapDoc,
    createdAt: row.created_at,
  };
}

export interface WikiPageRevisionRow {
  id: string;
  page_id: string;
  title: string;
  slug: string;
  content: string;
  content_text: string;
  save_type: "autosave" | "manual";
  created_at: string;
}

export function rowToWikiPageRevision(row: WikiPageRevisionRow): {
  id: string; pageId: string; title: string; slug: string; content: TipTapDoc; contentText: string; saveType: "autosave" | "manual"; createdAt: string;
} {
  return {
    id: row.id,
    pageId: row.page_id,
    title: row.title,
    slug: row.slug,
    content: JSON.parse(row.content) as TipTapDoc,
    contentText: row.content_text,
    saveType: row.save_type,
    createdAt: row.created_at,
  };
}

export function rowToWikiPageRevisionSummary(row: WikiPageRevisionRow): {
  id: string; title: string; saveType: "autosave" | "manual"; createdAt: string;
} {
  return {
    id: row.id,
    title: row.title,
    saveType: row.save_type,
    createdAt: row.created_at,
  };
}

export interface UserProjectRoleRow {
  user_id: string;
  role: "admin" | "member";
  project_id: string;
}

export interface UserRow {
  id: string;
  email: string;
  name: string;
  role: "admin" | "member";
  created_at: string;
  last_seen: string | null;
}

export interface ApiKeyRow {
  id: string;
  name: string;
  key_hash: string;
  user_id: string | null;
  created_at: string;
  last_used_at: string | null;
}

export interface TaskRow {
  id: string;
  project_id: string;
  column_id: string;
  swimlane_id: string;
  title: string;
  description: string;
  priority: string;           // priority_options.id
  type: string;               // type_options.id
  assignees: string;
  position: string;
  archived_at: string | null;
  github_issue_id: string | null;
  github_issue_number: number | null;
  github_repo: string | null;
  github_synced_state: "open" | "closed" | null;
  due_at: string | null;
  created_at: string;
  updated_at: string;
  column_github_state?: "open" | "closed" | null;
  github_issues_raw?: string | null;
}

export function rowToTask(row: TaskRow, columnGithubState?: "open" | "closed" | null): {
  id: string; projectId: string; columnId: string; swimlaneId: string; title: string; description: TipTapDoc; priority: string; type: string; assignees: string[]; position: string; dueAt: string | null; githubs: { issueId: string; issueNumber: number; repo: string; syncedState: "open" | "closed" | null; url: string; outOfSync: boolean; pushFailed: boolean }[]; archivedAt: ISODate | null; createdAt: ISODate; updatedAt: ISODate;
} {
  return taskFromRow(row, columnGithubState, JSON.parse(row.description) as TipTapDoc);
}

// Slim rows (board/list paths select no description) map to an empty doc —
// the key stays in the response shape, the blob never ships.
export function rowToTaskSlim(row: Omit<TaskRow, "description">, columnGithubState?: "open" | "closed" | null): {
  id: string; projectId: string; columnId: string; swimlaneId: string; title: string; description: TipTapDoc; priority: string; type: string; assignees: string[]; position: string; dueAt: string | null; githubs: { issueId: string; issueNumber: number; repo: string; syncedState: "open" | "closed" | null; url: string; outOfSync: boolean; pushFailed: boolean }[]; archivedAt: ISODate | null; createdAt: ISODate; updatedAt: ISODate;
} {
  return taskFromRow(row as TaskRow, columnGithubState, { type: "doc", content: [] });
}

function taskFromRow(row: TaskRow, columnGithubState: "open" | "closed" | null | undefined, description: TipTapDoc): {
  id: string; projectId: string; columnId: string; swimlaneId: string; title: string; description: TipTapDoc; priority: string; type: string; assignees: string[]; position: string; dueAt: string | null; githubs: { issueId: string; issueNumber: number; repo: string; syncedState: "open" | "closed" | null; url: string; outOfSync: boolean; pushFailed: boolean }[]; archivedAt: ISODate | null; createdAt: ISODate; updatedAt: ISODate;
} {
  const colState = columnGithubState ?? row.column_github_state ?? null;
  const githubs: { issueId: string; issueNumber: number; repo: string; syncedState: "open" | "closed" | null; url: string; outOfSync: boolean; pushFailed: boolean }[] = [];
  const seen = new Set<string>();
  if (row.github_issues_raw) {
    for (const part of row.github_issues_raw.split("||")) {
      const [issueId, issueNumberStr, repo, syncedState, pushFailed] = part.split(",");
      if (!issueId || !issueNumberStr || !repo || seen.has(issueId)) continue;
      seen.add(issueId);
      const outOfSync = !!(syncedState && colState && syncedState !== colState);
      githubs.push({
        issueId,
        issueNumber: Number(issueNumberStr),
        repo,
        syncedState: (syncedState || null) as "open" | "closed" | null,
        url: `https://github.com/${repo}/issues/${issueNumberStr}`,
        outOfSync,
        pushFailed: pushFailed === "1",
      });
    }
  }
  return {
    id: row.id,
    projectId: row.project_id,
    columnId: row.column_id,
    swimlaneId: row.swimlane_id,
    title: row.title,
    description,
    priority: row.priority,
    type: row.type,
    assignees: row.assignees ? row.assignees.split("||").filter(Boolean) : [],
    position: row.position,
    dueAt: row.due_at ?? null,
    githubs,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface RuntimeRow {
  id: string;
  name: string;
  provider: "opencode" | "hermes" | "command-code";
  machine_id: string | null;
  team_id: string | null;
  agent: string;
  model: string;
  print_logs: number;
  log_level: string;
  extra_args: string;
  models_catalog: string;
  agents_catalog: string;
  status: "online" | "offline";
  mcp_connected: number;
  last_error: string | null;
  hostname: string;
  last_seen: string | null;
  created_at: string;
}

function parseArgs(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((a): a is string => typeof a === "string") : [];
  } catch {
    return [];
  }
}

function parseModelsCatalog(raw: string | null): { id: string; provider: string; name: string }[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((m): m is { id: string; provider: string; name: string } =>
          typeof m?.id === "string" && typeof m?.provider === "string" && typeof m?.name === "string"
        )
      : [];
  } catch {
    return [];
  }
}

function parseAgentsCatalog(raw: string | null): RuntimeAgent[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((agent): agent is RuntimeAgent =>
          typeof agent?.id === "string" && typeof agent?.name === "string"
        )
      : [];
  } catch {
    return [];
  }
}

export function rowToRuntime(row: RuntimeRow): RuntimeWithTeam {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    machineId: row.machine_id ?? null,
    teamId: row.team_id ?? null,
    agent: row.agent ?? "",
    model: row.model,
    printLogs: (row.print_logs ?? 0) === 1,
    logLevel: (row.log_level as "" | "DEBUG" | "INFO" | "WARN" | "ERROR") ?? "",
    extraArgs: parseArgs(row.extra_args),
    modelsCatalog: parseModelsCatalog(row.models_catalog),
    agentsCatalog: parseAgentsCatalog(row.agents_catalog),
    status: row.status,
    mcpConnected: row.mcp_connected === 1,
    lastError: row.last_error ?? null,
    hostname: row.hostname,
    lastSeen: row.last_seen,
    createdAt: row.created_at,
  };
}

export interface ForgeTaskRow {
  id: string;
  runtime_id: string | null;
  project_id: string;
  document_type: "task" | "wiki";
  document_id: string;
  document_title?: string | null;
  agent_id: string;
  skill_id: string;
  agent_name?: string | null;
  skill_name?: string | null;
  extra_prompt: string;
  selection: string;
  doc_context: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  result: string | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export function rowToForgeTask(row: ForgeTaskRow): {
  id: string; runtimeId: string | null; projectId: string; documentType: "task" | "wiki"; documentId: string; documentTitle: string; agentId: string; skillId: string; agentName: string; skillName: string; extraPrompt: string; selection: string; docContext: string; status: "queued" | "running" | "completed" | "failed" | "cancelled"; result: string | null; error: string | null; createdAt: string; startedAt: string | null; finishedAt: string | null;
} {
  return {
    id: row.id,
    runtimeId: row.runtime_id,
    projectId: row.project_id,
    documentType: row.document_type,
    documentId: row.document_id,
    documentTitle: row.document_title ?? "",
    agentId: row.agent_id,
    skillId: row.skill_id,
    agentName: row.agent_name ?? "",
    skillName: row.skill_name ?? "",
    extraPrompt: row.extra_prompt,
    selection: row.selection,
    docContext: row.doc_context,
    status: row.status,
    result: row.result,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export interface ForgeAgentRow {
  id: string;
  name: string;
  description: string;
  instructions: string;
  is_builtin: number;
  created_at: string;
  updated_at: string;
}

export function rowToForgeAgent(row: ForgeAgentRow, skillIds: string[]): {
  id: string; name: string; description: string; instructions: string; isBuiltin: boolean; skillIds: string[]; createdAt: string; updatedAt: string;
} {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    isBuiltin: row.is_builtin === 1,
    skillIds,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface ForgeSkillRow {
  id: string;
  name: string;
  description: string;
  instructions: string;
  is_builtin: number;
  created_at: string;
  updated_at: string;
}

export function rowToForgeSkill(row: ForgeSkillRow): {
  id: string; name: string; description: string; instructions: string; isBuiltin: boolean; createdAt: string; updatedAt: string;
} {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    isBuiltin: row.is_builtin === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface ForgeSessionRow {
  document_type: "task" | "wiki";
  document_id: string;
  runtime_id: string;
  runtime_session_id: string;
  provider: "opencode" | "hermes" | "command-code";
  agent_id: string;
  skill_id: string;
  created_at: string;
  updated_at: string;
}

export function rowToForgeSession(row: ForgeSessionRow): {
  documentType: "task" | "wiki";
  documentId: string;
  runtimeId: string;
  runtimeSessionId: string;
  provider: "opencode" | "hermes" | "command-code";
  agentId: string;
  skillId: string;
  createdAt: string;
  updatedAt: string;
} {
  return {
    documentType: row.document_type,
    documentId: row.document_id,
    runtimeId: row.runtime_id,
    runtimeSessionId: row.runtime_session_id,
    provider: row.provider,
    agentId: row.agent_id,
    skillId: row.skill_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface ForgeTaskLogRow {
  id: string;
  task_id: string;
  message: string;
  stream: "out" | "err";
  level: "info" | "warn" | "error";
  created_at: string;
}

export function rowToForgeTaskLog(row: ForgeTaskLogRow): {
  id: string;
  taskId: string;
  message: string;
  stream: "out" | "err";
  level: "info" | "warn" | "error";
  createdAt: string;
} {
  return {
    id: row.id,
    taskId: row.task_id,
    message: row.message,
    stream: row.stream,
    level: row.level,
    createdAt: row.created_at,
  };
}

export interface DocumentSourceRow {
  id: string;
  project_id: string;
  document_type: "task" | "wiki";
  document_id: string;
  kind: "wiki" | "external";
  title: string;
  ref: string;
  created_at: string;
}

export function rowToDocumentSource(row: DocumentSourceRow): {
  id: string; projectId: string; documentType: "task" | "wiki"; documentId: string; kind: "wiki" | "external"; title: string; ref: string; createdAt: string;
} {
  return {
    id: row.id,
    projectId: row.project_id,
    documentType: row.document_type,
    documentId: row.document_id,
    kind: row.kind,
    title: row.title,
    ref: row.ref,
    createdAt: row.created_at,
  };
}

export interface TaskLinkRow {
  id: string;
  project_id: string;
  from_task_id: string;
  to_task_id: string;
  relation: "subtask_of" | "blocked_by" | "related_to";
  created_at: string;
}

export function rowToTaskLink(row: TaskLinkRow): {
  id: string; projectId: string; fromTaskId: string; toTaskId: string; relation: "subtask_of" | "blocked_by" | "related_to"; createdAt: string;
} {
  return {
    id: row.id,
    projectId: row.project_id,
    fromTaskId: row.from_task_id,
    toTaskId: row.to_task_id,
    relation: row.relation,
    createdAt: row.created_at,
  };
}

export interface ActivityRow {
  id: number;
  task_id: string;
  actor_kind: ActorKind;
  actor_label: string;
  actor_user_id: string | null;
  type: ActivityType;
  message: string;
  created_at: string;
}

export function rowToActivityEvent(r: ActivityRow): ActivityEvent {
  return {
    id: r.id,
    taskId: r.task_id,
    actorKind: r.actor_kind,
    actorLabel: r.actor_label,
    actorUserId: r.actor_user_id,
    type: r.type,
    message: r.message,
    createdAt: r.created_at,
  };
}

export interface CommentRow {
  id: number;
  task_id: string;
  author_id: string | null;
  author_kind: ActorKind;
  author_label: string;
  body: string;
  edited_at: string | null;
  deleted_at: string | null;
  created_at: string;
}

export function rowToComment(r: CommentRow): TaskComment {
  return {
    id: r.id,
    taskId: r.task_id,
    authorId: r.author_id,
    authorKind: r.author_kind,
    authorLabel: r.author_label,
    body: JSON.parse(r.body) as TipTapDoc,
    editedAt: r.edited_at,
    deletedAt: r.deleted_at,
    createdAt: r.created_at,
  };
}
