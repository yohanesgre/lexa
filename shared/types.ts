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
