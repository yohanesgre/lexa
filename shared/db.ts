// Database row types — mirror SQL column names exactly (snake_case).
// Used by server repos/services only. Frontend never imports this file.

import type { TipTapDoc, ISODate } from "./types";

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
  github_repo: string | null;
  created_at: string;
  updated_at: string;
}

export function rowToProject(row: ProjectRow): {
  id: string; name: string; slug: string; description: string; githubRepo: string | null; createdAt: ISODate; updatedAt: ISODate;
} {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    githubRepo: row.github_repo,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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
}

export function rowToColumn(row: ColumnRow): {
  id: string; projectId: string; name: string; position: number; color: string; wipLimit: number | null; requiredFields: string[]; githubState: "open" | "closed" | null;
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
  };
}

export interface SwimlaneRow {
  id: string;
  project_id: string;
  name: string;
  description: string;
  position: number;
}

export function rowToSwimlane(row: SwimlaneRow): {
  id: string; projectId: string; name: string; description: string; position: number;
} {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    description: row.description,
    position: row.position,
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
  created_at: string;
  updated_at: string;
  column_github_state?: "open" | "closed" | null;
  github_issues_raw?: string | null;
}

export function rowToTask(row: TaskRow, columnGithubState?: "open" | "closed" | null): {
  id: string; projectId: string; columnId: string; swimlaneId: string; title: string; description: TipTapDoc; priority: string; type: string; assignees: string[]; position: string; githubs: { issueId: string; issueNumber: number; repo: string; syncedState: "open" | "closed" | null; url: string; outOfSync: boolean }[]; archivedAt: ISODate | null; createdAt: ISODate; updatedAt: ISODate;
} {
  const colState = columnGithubState ?? row.column_github_state ?? null;
  const githubs: { issueId: string; issueNumber: number; repo: string; syncedState: "open" | "closed" | null; url: string; outOfSync: boolean }[] = [];
  const seen = new Set<string>();
  if (row.github_issues_raw) {
    for (const part of row.github_issues_raw.split("||")) {
      const [issueId, issueNumberStr, repo, syncedState] = part.split(",");
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
      });
    }
  }
  return {
    id: row.id,
    projectId: row.project_id,
    columnId: row.column_id,
    swimlaneId: row.swimlane_id,
    title: row.title,
    description: JSON.parse(row.description) as TipTapDoc,
    priority: row.priority,
    type: row.type,
    assignees: row.assignees ? row.assignees.split(",").filter(Boolean) : [],
    position: row.position,
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
  status: "online" | "offline";
  hostname: string;
  last_seen: string | null;
  created_at: string;
}

export function rowToRuntime(row: RuntimeRow): {
  id: string; name: string; provider: "opencode" | "hermes" | "command-code"; status: "online" | "offline"; hostname: string; lastSeen: string | null; createdAt: string;
} {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    status: row.status,
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
  action: "continue" | "rewrite" | "summarize" | "expand" | "grammar";
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
  id: string; runtimeId: string | null; projectId: string; documentType: "task" | "wiki"; documentId: string; action: "continue" | "rewrite" | "summarize" | "expand" | "grammar"; selection: string; docContext: string; status: "queued" | "running" | "completed" | "failed" | "cancelled"; result: string | null; error: string | null; createdAt: string; startedAt: string | null; finishedAt: string | null;
} {
  return {
    id: row.id,
    runtimeId: row.runtime_id,
    projectId: row.project_id,
    documentType: row.document_type,
    documentId: row.document_id,
    action: row.action,
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
