// Database row types — mirror SQL column names exactly (snake_case).
// Used by server repos/services only. Frontend never imports this file.

import type { TipTapDoc, Priority, TaskType, ISODate } from "./types";

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
  swimlane_id: string | null;
  title: string;
  description: string;
  priority: Priority;
  type: TaskType;
  assignee: string | null;
  position: string;
  github_issue_id: string | null;
  github_issue_number: number | null;
  github_repo: string | null;
  github_synced_state: "open" | "closed" | null;
  created_at: string;
  updated_at: string;
  column_github_state?: "open" | "closed" | null;
}

export function rowToTask(row: TaskRow, columnGithubState?: "open" | "closed" | null): {
  id: string; projectId: string; columnId: string; swimlaneId: string | null; title: string; description: TipTapDoc; priority: Priority; type: TaskType; assignee: string | null; position: string; github: { issueId: string; issueNumber: number; repo: string; url: string; syncedState: "open" | "closed" | null; outOfSync: boolean } | null; createdAt: ISODate; updatedAt: ISODate;
} {
  const githubState = columnGithubState ?? row.column_github_state ?? null;
  const hasLink = row.github_issue_id && row.github_issue_number && row.github_repo;
  return {
    id: row.id,
    projectId: row.project_id,
    columnId: row.column_id,
    swimlaneId: row.swimlane_id,
    title: row.title,
    description: JSON.parse(row.description) as TipTapDoc,
    priority: row.priority,
    type: row.type,
    assignee: row.assignee,
    position: row.position,
    github: hasLink
      ? {
          issueId: row.github_issue_id!,
          issueNumber: row.github_issue_number!,
          repo: row.github_repo!,
          url: `https://github.com/${row.github_repo}/issues/${row.github_issue_number}`,
          syncedState: row.github_synced_state,
          outOfSync: githubState !== null && row.github_synced_state !== githubState,
        }
      : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
