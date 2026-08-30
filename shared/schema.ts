import { Schema } from "effect";
import type { Board, Column, FieldConfig, FieldOption, GithubIssue, Milestone, Project, ProjectRepo, Swimlane, Task, TaskLink, TipTapDoc, TipTapMark, TipTapNode } from "./types";

export const TipTapMarkSchema = Schema.Struct({
  type: Schema.String,
  attrs: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
}) as unknown as Schema.Schema<TipTapMark>;

export const TipTapNodeSchema: Schema.Schema<TipTapNode> = Schema.suspend(() =>
  Schema.Struct({
    type: Schema.String,
    attrs: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
    content: Schema.optional(Schema.Array(TipTapNodeSchema)),
    text: Schema.optional(Schema.String),
    marks: Schema.optional(Schema.Array(TipTapMarkSchema)),
  }),
) as unknown as Schema.Schema<TipTapNode>;

export const TipTapDocSchema = Schema.Struct({
  type: Schema.Literal("doc"),
  content: Schema.Array(TipTapNodeSchema),
}) as unknown as Schema.Schema<TipTapDoc>;

export function isTipTapEmpty(doc: TipTapDoc): boolean {
  function hasText(nodes: TipTapNode[]): boolean {
    for (const n of nodes) {
      if (typeof n.text === "string" && n.text.trim().length > 0) return true;
      if (n.content && n.content.length > 0 && hasText(n.content)) return true;
    }
    return false;
  }
  if (!doc.content || doc.content.length === 0) return true;
  return !hasText(doc.content);
}

const ProjectRepoSchema = Schema.Struct({
  repo: Schema.String,
  sourceRole: Schema.Boolean,
  workspaceRole: Schema.Boolean,
}) as unknown as Schema.Schema<ProjectRepo>;

export const ProjectSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  slug: Schema.String,
  key: Schema.String,
  description: Schema.String,
  repos: Schema.Array(ProjectRepoSchema),
  createdAt: Schema.String,
  updatedAt: Schema.String,
}) as unknown as Schema.Schema<Project>;

const ColumnSchema = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  name: Schema.String,
  position: Schema.Number,
  color: Schema.String,
  wipLimit: Schema.NullOr(Schema.Number),
  requiredFields: Schema.Array(Schema.String),
  githubState: Schema.NullOr(Schema.Literal("open", "closed")),
  isDone: Schema.Boolean,
}) as unknown as Schema.Schema<Column>;

const SwimlaneSchema = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  name: Schema.String,
  description: Schema.String,
  position: Schema.Number,
  dueAt: Schema.NullOr(Schema.String),
  archivedAt: Schema.NullOr(Schema.String),
  startAt: Schema.NullOr(Schema.String),
  kind: Schema.Literal("backlog", "sprint"),
  milestoneId: Schema.NullOr(Schema.String),
}) as unknown as Schema.Schema<Swimlane>;

const MilestoneSchema = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  name: Schema.String,
  description: Schema.String,
  position: Schema.Number,
  dueAt: Schema.NullOr(Schema.String),
  archivedAt: Schema.NullOr(Schema.String),
  sprintCount: Schema.Number,
  archivedSprintCount: Schema.Number,
}) as unknown as Schema.Schema<Milestone>;

const FieldOptionSchema = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  color: Schema.String,
  position: Schema.Number,
}) as unknown as Schema.Schema<FieldOption>;

const FieldConfigSchema = Schema.Struct({
  priorities: Schema.Array(FieldOptionSchema),
  types: Schema.Array(FieldOptionSchema),
}) as unknown as Schema.Schema<FieldConfig>;

const GithubIssueSchema = Schema.Struct({
  issueId: Schema.String,
  issueNumber: Schema.Number,
  repo: Schema.String,
  syncedState: Schema.NullOr(Schema.Literal("open", "closed")),
  url: Schema.String,
  outOfSync: Schema.Boolean,
  pushFailed: Schema.Boolean,
}) as unknown as Schema.Schema<GithubIssue>;

const TaskLinkSchema = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  fromTaskId: Schema.String,
  toTaskId: Schema.String,
  relation: Schema.Literal("subtask_of", "blocked_by", "related_to"),
  createdAt: Schema.String,
}) as unknown as Schema.Schema<TaskLink>;

export const TaskSchema = Schema.Struct({
  id: Schema.String,
  key: Schema.String,
  projectId: Schema.String,
  columnId: Schema.String,
  swimlaneId: Schema.String,
  title: Schema.String,
  description: TipTapDocSchema,
  priority: Schema.String,
  type: Schema.String,
  assignees: Schema.Array(Schema.String),
  position: Schema.String,
  githubs: Schema.Array(GithubIssueSchema),
  dueAt: Schema.NullOr(Schema.String),
  archivedAt: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
}) as unknown as Schema.Schema<Task>;

export const BoardSchema = Schema.Struct({
  project: ProjectSchema,
  columns: Schema.Array(ColumnSchema),
  swimlanes: Schema.Array(SwimlaneSchema),
  milestones: Schema.Array(MilestoneSchema),
  fieldConfig: FieldConfigSchema,
  links: Schema.Array(TaskLinkSchema),
  tasks: Schema.Array(TaskSchema),
}) as unknown as Schema.Schema<Board>;

export const decodeBoard = Schema.decodeUnknownSync(BoardSchema);
export const decodeTask = Schema.decodeUnknownSync(TaskSchema);
