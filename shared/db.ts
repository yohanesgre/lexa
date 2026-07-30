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
  swimlane_id: string;
  title: string;
  description: string;
  priority: Priority;
  type: TaskType;
  assignees: string;
  position: string;
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
  id: string; projectId: string; columnId: string; swimlaneId: string; title: string; description: TipTapDoc; priority: Priority; type: TaskType; assignees: string[]; position: string; githubs: { issueId: string; issueNumber: number; repo: string; syncedState: "open" | "closed" | null; url: string; outOfSync: boolean }[]; createdAt: ISODate; updatedAt: ISODate;
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
