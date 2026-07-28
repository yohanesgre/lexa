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
  tasks: Task[];
}

export type Priority = "urgent" | "high" | "medium" | "low";
export type TaskType = "feature" | "bug" | "task" | "asset";

export interface Task {
  id: ID;
  projectId: ID;
  columnId: ID;
  swimlaneId: ID | null;
  title: string;
  description: TipTapDoc;
  priority: Priority;
  type: TaskType;
  assignee: string | null;
  position: string;
  github: {
    issueId: string;
    issueNumber: number;
    repo: string;
    url: string;
    syncedState: "open" | "closed" | null;
    outOfSync: boolean;
  } | null;
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

export interface ProjectRow {
  id: string;
  name: string;
  slug: string;
  description: string;
  github_repo: string | null;
  created_at: string;
  updated_at: string;
}

export function rowToProject(row: ProjectRow): Project {
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

export function rowToColumn(row: ColumnRow): Column {
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

export function rowToSwimlane(row: SwimlaneRow): Swimlane {
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

export function rowToWikiPageMeta(row: WikiPageRow): WikiPageMeta {
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

export function rowToWikiPage(row: WikiPageRow): WikiPage {
  return {
    ...rowToWikiPageMeta(row),
    content: JSON.parse(row.content) as TipTapDoc,
    createdAt: row.created_at,
  };
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

export function rowToTask(row: TaskRow, columnGithubState?: "open" | "closed" | null): Task {
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
