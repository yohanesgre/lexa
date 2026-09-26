// Database row types — mirror SQL column names exactly (snake_case).
// Used by server repos/services only. Frontend never imports this file.

import type { TipTapDoc, ISODate, ActorKind, ActivityType, ActivityEvent, TaskComment, Swimlane, Milestone, DomainProject } from "./types";
import { parseTipTapDoc } from "./types";

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
  key: string;
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
    key: row.key,
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
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

export function rowToWikiPageMeta(row: WikiPageRow): {
  id: string; projectId: string; title: string; slug: string; parentId: string | null; position: number; updatedBy: string | null; updatedByName: string | null; updatedAt: ISODate;
} {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    slug: row.slug,
    parentId: row.parent_id,
    position: row.position,
    updatedBy: row.updated_by ?? null,
    updatedByName: null,
    updatedAt: row.updated_at,
  };
}

export function rowToWikiPage(row: WikiPageRow): {
  id: string; projectId: string; title: string; slug: string; parentId: string | null; position: number; updatedBy: string | null; updatedByName: string | null; updatedAt: ISODate; content: TipTapDoc; createdAt: ISODate;
} {
  return {
    ...rowToWikiPageMeta(row),
    content: parseTipTapDoc(row.content),
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
    content: parseTipTapDoc(row.content),
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
  key: string;
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
  id: string; key: string; projectId: string; columnId: string; swimlaneId: string; title: string; description: TipTapDoc; priority: string; type: string; assignees: string[]; position: string; dueAt: string | null; githubs: { issueId: string; issueNumber: number; repo: string; title: string | null; syncedState: "open" | "closed" | null; url: string; outOfSync: boolean; pushFailed: boolean }[]; archivedAt: ISODate | null; createdAt: ISODate; updatedAt: ISODate;
} {
  return taskFromRow(row, columnGithubState, parseTipTapDoc(row.description));
}

// Slim rows (board/list paths select no description) map to an empty doc —
// the key stays in the response shape, the blob never ships.
export function rowToTaskSlim(row: Omit<TaskRow, "description">, columnGithubState?: "open" | "closed" | null): {
  id: string; key: string; projectId: string; columnId: string; swimlaneId: string; title: string; description: TipTapDoc; priority: string; type: string; assignees: string[]; position: string; dueAt: string | null; githubs: { issueId: string; issueNumber: number; repo: string; title: string | null; syncedState: "open" | "closed" | null; url: string; outOfSync: boolean; pushFailed: boolean }[]; archivedAt: ISODate | null; createdAt: ISODate; updatedAt: ISODate;
} {
  return taskFromRow(row as TaskRow, columnGithubState, { type: "doc", content: [] });
}

interface ParsedGithubIssue {
  issueId: string;
  issueNumber: number;
  repo: string;
  title: string | null;
  syncedState: "open" | "closed" | null;
  pushFailed: boolean;
}

// The SQL aggregate emits a JSON array; the delimiter fallback keeps rows
// produced before that aggregate ships readable.
function parseGithubIssues(raw: string): ParsedGithubIssue[] {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        const out: ParsedGithubIssue[] = [];
        const seen = new Set<string>();
        for (const entry of parsed) {
          if (entry === null || typeof entry !== "object") continue;
          const r = entry as Record<string, unknown>;
          const issueId = typeof r.issueId === "string" ? r.issueId : "";
          const issueNumber = typeof r.issueNumber === "number" && Number.isFinite(r.issueNumber) ? r.issueNumber : null;
          const repo = typeof r.repo === "string" ? r.repo : "";
          if (!issueId || issueNumber === null || !repo || seen.has(issueId)) continue;
          seen.add(issueId);
          out.push({
            issueId,
            issueNumber,
            repo,
            title: typeof r.title === "string" && r.title.length > 0 ? r.title : null,
            syncedState: r.syncedState === "open" || r.syncedState === "closed" ? r.syncedState : null,
            pushFailed: r.pushFailed === 1 || r.pushFailed === true,
          });
        }
        return out;
      }
    } catch {}
  }
  const out: ParsedGithubIssue[] = [];
  const seen = new Set<string>();
  for (const part of raw.split("||")) {
    const [issueId, issueNumberStr, repo, syncedState, pushFailed, ...titleParts] = part.split(",");
    if (!issueId || !issueNumberStr || !repo || seen.has(issueId)) continue;
    seen.add(issueId);
    const issueTitle = titleParts.join(",");
    out.push({
      issueId,
      issueNumber: Number(issueNumberStr),
      repo,
      title: issueTitle.length > 0 ? issueTitle : null,
      syncedState: (syncedState || null) as "open" | "closed" | null,
      pushFailed: pushFailed === "1",
    });
  }
  return out;
}

function taskFromRow(row: TaskRow, columnGithubState: "open" | "closed" | null | undefined, description: TipTapDoc): {
  id: string; key: string; projectId: string; columnId: string; swimlaneId: string; title: string; description: TipTapDoc; priority: string; type: string; assignees: string[]; position: string; dueAt: string | null; githubs: { issueId: string; issueNumber: number; repo: string; title: string | null; syncedState: "open" | "closed" | null; url: string; outOfSync: boolean; pushFailed: boolean }[]; archivedAt: ISODate | null; createdAt: ISODate; updatedAt: ISODate;
} {
  const colState = columnGithubState ?? row.column_github_state ?? null;
  const githubs: { issueId: string; issueNumber: number; repo: string; title: string | null; syncedState: "open" | "closed" | null; url: string; outOfSync: boolean; pushFailed: boolean }[] = [];
  if (row.github_issues_raw) {
    for (const gi of parseGithubIssues(row.github_issues_raw)) {
      const outOfSync = !!(gi.syncedState && colState && gi.syncedState !== colState);
      githubs.push({
        ...gi,
        url: `https://github.com/${gi.repo}/issues/${gi.issueNumber}`,
        outOfSync,
      });
    }
  }
  return {
    id: row.id,
    key: row.key,
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

export interface AssistantTaskRow {
  id: string;
  project_id: string;
  document_type: "task" | "wiki";
  document_id: string;
  document_title?: string | null;
  key?: string | null;
  agent_id: string;
  skill_id: string;
  agent_name?: string | null;
  skill_name?: string | null;
  extra_prompt: string;
  selection: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  result: string | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export function rowToAssistantTask(row: AssistantTaskRow): {
  id: string; key: string; projectId: string; documentType: "task" | "wiki"; documentId: string; documentTitle: string; agentId: string; skillId: string; agentName: string; skillName: string; extraPrompt: string; selection: string; status: "queued" | "running" | "completed" | "failed" | "cancelled"; result: string | null; error: string | null; createdAt: string; startedAt: string | null; finishedAt: string | null;
} {
  return {
    id: row.id,
    key: row.key ?? "",
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
    status: row.status,
    result: row.result,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}


export interface LexaAgentRow {
  id: string;
  name: string;
  description: string;
  instructions: string;
  is_builtin: number;
  created_at: string;
  updated_at: string;
}

export function rowToLexaAgent(row: LexaAgentRow, skillIds: string[]): {
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

export interface LexaSkillRow {
  id: string;
  name: string;
  description: string;
  instructions: string;
  is_builtin: number;
  created_at: string;
  updated_at: string;
}

export function rowToLexaSkill(row: LexaSkillRow): {
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
  via_assistant: number;
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
    viaAssistant: r.via_assistant === 1,
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
  via_assistant: number;
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
    body: parseTipTapDoc(r.body),
    viaAssistant: r.via_assistant === 1,
    editedAt: r.edited_at,
    deletedAt: r.deleted_at,
    createdAt: r.created_at,
  };
}
