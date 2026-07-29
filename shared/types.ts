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
