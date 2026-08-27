import { toolDefinition } from "@tanstack/ai";
import { z } from "zod";
import { extractText } from "../../shared/tiptap-text";
import type { TipTapDoc } from "../../shared/types";
import type { HeraldWriteDiff } from "../../shared/herald";

// Max write proposals per stream turn — further proposals in the same turn
// return a tool error result instead of persisting.
export const MAX_WRITES_PER_TURN = 8;

// Approval TTL (herald_pending_writes.expires_at) — lazy sweep only.
export const APPROVAL_TTL_HOURS = 24;

const DIFF_TEXT_CAP = 2000;
const COMMENT_BODYTEXT_CAP = 2000;
const COMMENT_BODY_BYTES = 64 * 1024;

export const HERALD_WRITE_TOOL_NAMES = [
  "create_task",
  "update_task",
  "move_task",
  "archive_task",
  "restore_task",
  "add_comment",
  "create_wiki_page",
  "edit_wiki_page",
  "create_milestone",
  "update_milestone",
  "archive_milestone",
  "create_sprint",
  "update_sprint",
] as const;

export type HeraldWriteToolName = (typeof HERALD_WRITE_TOOL_NAMES)[number];

export function isHeraldWriteTool(name: string): name is HeraldWriteToolName {
  return (HERALD_WRITE_TOOL_NAMES as readonly string[]).includes(name);
}

// Parse herald_settings.write_tools (comma-separated names). Unknown names
// are dropped silently; duplicates collapse.
export function parseWriteTools(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const name = part.trim();
    if (name !== "" && isHeraldWriteTool(name) && !out.includes(name)) out.push(name);
  }
  return out;
}

const cap = (s: string, n = DIFF_TEXT_CAP): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const docText = (doc: TipTapDoc | undefined | null): string => cap(extractText(doc ?? ({ type: "doc", content: [] } as TipTapDoc)));

// ── Diff builders (pure — unit-tested directly) ──

export function buildTaskCreateDiff(input: {
  title: string;
  description?: TipTapDoc | undefined;
  priority?: string | undefined;
  type?: string | undefined;
  dueAt?: string | undefined;
  assigneeIds?: string[] | undefined;
  parentTitle?: string | null | undefined;
}): Extract<HeraldWriteDiff, { type: "task_create" }> {
  const fields: Record<string, string | null> = {};
  if (input.description !== undefined) fields.description = docText(input.description);
  if (input.priority !== undefined) fields.priority = input.priority;
  if (input.type !== undefined) fields.type = input.type;
  if (input.dueAt !== undefined) fields.dueAt = input.dueAt;
  if (input.assigneeIds !== undefined) fields.assignees = input.assigneeIds.join(", ");
  if (input.parentTitle) fields.parent = input.parentTitle;
  return { type: "task_create", title: input.title, fields };
}

export interface WriteTaskSnapshot {
  id: string;
  key: string;
  title: string;
  columnName: string;
  priority: string;
  type: string;
  dueAt: string | null;
  assignees: string[];
  descriptionText: string;
  archivedAt: string | null;
}

type TaskUpdateChange = Extract<HeraldWriteDiff, { type: "task_update" }>["changes"][number];

export function buildTaskUpdateDiff(
  task: WriteTaskSnapshot,
  changes: Array<Pick<TaskUpdateChange, "field" | "after">>
): Extract<HeraldWriteDiff, { type: "task_update" }> {
  const beforeOf = (field: TaskUpdateChange["field"]): string | null => {
    switch (field) {
      case "title": return task.title;
      case "description": return task.descriptionText || null;
      case "priority": return task.priority;
      case "type": return task.type;
      case "dueAt": return task.dueAt;
      case "assignees": return task.assignees.length > 0 ? task.assignees.join(", ") : null;
    }
  };
  return {
    type: "task_update",
    taskRef: task.key,
    taskTitle: task.title,
    changes: changes.map((c) => ({
      field: c.field,
      before: beforeOf(c.field),
      after: c.after === "" ? null : c.after,
    })),
  };
}

export function buildWikiEditDiff(page: { slug: string; title: string; text: string }, next: { title?: string | undefined; content: TipTapDoc }): Extract<HeraldWriteDiff, { type: "wiki_edit" }> {
  return {
    type: "wiki_edit",
    slug: page.slug,
    title: next.title ?? page.title,
    beforeText: cap(page.text),
    afterText: cap(extractText(next.content)),
  };
}

// Archived tasks keep column_id, so the snapshot's columnName IS the
// pre-archive column the restore returns to (herald-write-approvals.html:
// "back to <column>").
export function buildTaskRestoreDiff(task: WriteTaskSnapshot): Extract<HeraldWriteDiff, { type: "task_restore" }> {
  return { type: "task_restore", taskRef: task.key, taskTitle: task.title, toColumn: task.columnName };
}

export function buildMilestoneCreateDiff(input: { name: string; dueAt?: string | undefined }): Extract<HeraldWriteDiff, { type: "milestone_create" }> {
  return { type: "milestone_create", name: input.name, ...(input.dueAt !== undefined ? { dueAt: input.dueAt } : {}) };
}

// sprintsAffected omitted when the milestone has no live sprints — the chip
// confirm line reads naturally without a "0 sprints" row.
export function buildMilestoneArchiveDiff(input: { name: string; sprintsAffected?: number }): Extract<HeraldWriteDiff, { type: "milestone_archive" }> {
  return {
    type: "milestone_archive",
    name: input.name,
    ...(input.sprintsAffected !== undefined && input.sprintsAffected > 0 ? { sprintsAffected: input.sprintsAffected } : {}),
  };
}

export function buildSprintCreateDiff(input: { name: string; startAt?: string | undefined; dueAt?: string | undefined }): Extract<HeraldWriteDiff, { type: "sprint_create" }> {
  return {
    type: "sprint_create",
    name: input.name,
    ...(input.startAt !== undefined ? { startAt: input.startAt } : {}),
    ...(input.dueAt !== undefined ? { dueAt: input.dueAt } : {}),
  };
}

function change(field: string, before: string | null, after: string | null) {
  return { field, before: before === "" ? null : before, after: after === "" ? null : after };
}

// ── Tool deps ──

export interface WriteMilestoneSnapshot {
  id: string;
  name: string;
  dueAt: string | null;
  archivedAt: string | null;
}

export interface WriteSwimlaneSnapshot {
  id: string;
  name: string;
  kind: "backlog" | "milestone" | "sprint";
}

export interface RecordedProposal {
  approvalId: string;
  batchId: string;
  seq: number;
}

// Side-channel entry pairing a persisted pending-write row with its stream
// toolCallId. The queue drains sequentially in the TOOL_CALL_RESULT handler
// (locked-in pairing decision) and feeds the transcript's pendingBatch meta.
export interface QueuedProposal extends RecordedProposal {
  name: HeraldWriteToolName;
  detail?: string;
  diff: HeraldWriteDiff;
  args: unknown;
}

export interface WriteRecorderInsertRow {
  id: string;
  projectId: string;
  documentType: "task" | "wiki" | "chat";
  documentId: string;
  ownerUserId: string;
  batchId: string;
  seq: number;
  toolName: string;
  args: string;
  diff: string;
  expiresAt: string;
}

// Per-turn proposal recorder: mints batchId/seq, enforces the per-turn write
// budget, persists each row via the injected insert callback (SQL-format
// expires_at so lazy sweeps compare correctly against datetime('now')), and
// queues the proposal for the stream's sequential drain.
export function createWriteRecorder(
  turn: { projectId: string; documentType: "task" | "wiki" | "chat"; documentId: string; ownerUserId: string },
  insert: (row: WriteRecorderInsertRow) => Promise<void>
) {
  const batchId = crypto.randomUUID();
  let seq = 0;
  const queue: QueuedProposal[] = [];
  return {
    batchId,
    record: async (
      proposal: { name: HeraldWriteToolName; args: unknown; diff: HeraldWriteDiff; detail?: string }
    ): Promise<RecordedProposal | { error: string }> => {
      if (queue.length >= MAX_WRITES_PER_TURN) {
        return { error: `write budget exceeded — at most ${MAX_WRITES_PER_TURN} proposals per turn` };
      }
      const approvalId = crypto.randomUUID();
      const rowSeq = seq++;
      const expiresAt = new Date(Date.now() + APPROVAL_TTL_HOURS * 3_600_000)
        .toISOString()
        .slice(0, 19)
        .replace("T", " ");
      await insert({
        id: approvalId,
        projectId: turn.projectId,
        documentType: turn.documentType,
        documentId: turn.documentId,
        ownerUserId: turn.ownerUserId,
        batchId,
        seq: rowSeq,
        toolName: proposal.name,
        args: JSON.stringify(proposal.args),
        diff: JSON.stringify(proposal.diff),
        expiresAt,
      });
      queue.push({
        approvalId,
        batchId,
        seq: rowSeq,
        name: proposal.name,
        ...(proposal.detail !== undefined ? { detail: proposal.detail } : {}),
        diff: proposal.diff,
        args: proposal.args,
      });
      return { approvalId, batchId, seq: rowSeq };
    },
    drain: (): QueuedProposal[] => queue.splice(0, queue.length),
  };
}

export interface HeraldWriteToolDeps {
  projectId: string;
  findTaskByRef: (ref: string) => Promise<WriteTaskSnapshot | null>;
  findColumn: (id: string) => Promise<{ id: string; name: string } | null>;
  findWikiPageBySlug: (slug: string) => Promise<{ slug: string; title: string; text: string } | null>;
  findMilestone: (id: string) => Promise<WriteMilestoneSnapshot | null>;
  // Live (non-archived) sprint count under a milestone — feeds the
  // milestone_archive diff's sprintsAffected field.
  countSprints: (milestoneId: string) => Promise<number>;
  findSwimlane: (id: string) => Promise<WriteSwimlaneSnapshot | null>;
  // Persist the pending row + register it on the turn's side-channel.
  // Budget enforcement lives here; over-budget calls yield an error result.
  record: (proposal: { name: HeraldWriteToolName; args: unknown; diff: HeraldWriteDiff; detail?: string }) => Promise<RecordedProposal | { error: string }>;
}

const err = (error: string): { proposed: false; error: string } => ({ proposed: false, error });

type Step<T> = { ok: true; value: T } | { ok: false; error: string };

async function resolveOrError<T>(p: Promise<T | null>, message: string): Promise<Step<T>> {
  const v = await p.catch(() => null);
  return v === null ? { ok: false, error: message } : { ok: true, value: v };
}

async function record(deps: HeraldWriteToolDeps, proposal: { name: HeraldWriteToolName; args: unknown; diff: HeraldWriteDiff; detail?: string }): Promise<Step<RecordedProposal>> {
  const r = await deps.record(proposal);
  if ("error" in r) return { ok: false, error: r.error };
  return { ok: true, value: r };
}

const tipTapDoc = z.custom<TipTapDoc>((v) => typeof v === "object" && v !== null && (v as { type?: unknown }).type === "doc");

export function buildHeraldWriteTools(deps: HeraldWriteToolDeps) {
  const tools = [];

  tools.push(
    toolDefinition({
      name: "create_task",
      description:
        "Propose creating a task in this project. The write is NOT applied until the user approves it. The task lands in the project's first column (or the given sprint/parent).",
      inputSchema: z.object({
        title: z.string().min(1).max(300),
        description: tipTapDoc.optional(),
        priorityId: z.string().optional(),
        typeId: z.string().optional(),
        dueAt: z.string().optional(),
        assigneeIds: z.array(z.string()).optional(),
        parentId: z.string().optional(),
        milestoneId: z.string().optional(),
        sprintId: z.string().optional(),
      }),
      outputSchema: z.object({ proposed: z.boolean(), approvalId: z.string().optional(), error: z.string().optional() }),
    }).server(async (args) => {
      let parentTitle: string | null = null;
      if (args.parentId) {
        const parent = await resolveOrError(deps.findTaskByRef(args.parentId), `parent task '${args.parentId}' not found`);
        if (!parent.ok) return { proposed: false, error: parent.error };
        parentTitle = parent.value.title;
      }
      if (args.sprintId) {
        const lane = await resolveOrError(deps.findSwimlane(args.sprintId), `sprint '${args.sprintId}' not found`);
        if (!lane.ok) return { proposed: false, error: lane.error };
      }
      if (args.milestoneId) {
        const m = await resolveOrError(deps.findMilestone(args.milestoneId), `milestone '${args.milestoneId}' not found`);
        if (!m.ok) return { proposed: false, error: m.error };
      }
      const diff = buildTaskCreateDiff({ title: args.title, ...(args.description !== undefined ? { description: args.description } : {}), ...(args.priorityId !== undefined ? { priority: args.priorityId } : {}), ...(args.typeId !== undefined ? { type: args.typeId } : {}), ...(args.dueAt !== undefined ? { dueAt: args.dueAt } : {}), ...(args.assigneeIds !== undefined ? { assigneeIds: args.assigneeIds } : {}), parentTitle });
      const r = await record(deps, {
        name: "create_task",
        args,
        diff,
        detail: `Create task "${cap(args.title, 60)}"`,
      });
      if (!r.ok) return { proposed: false, error: r.error };
      return { proposed: true, approvalId: r.value.approvalId };
    })
  );

  tools.push(
    toolDefinition({
      name: "update_task",
      description:
        "Propose updating a task's title/description/priority/type/due date/assignees. Only provided fields change. Requires user approval.",
      inputSchema: z.object({
        ref: z.string().min(1).describe("Task id or PREFIX-n key"),
        title: z.string().min(1).max(300).optional(),
        description: tipTapDoc.optional(),
        priorityId: z.string().optional(),
        typeId: z.string().optional(),
        dueAt: z.string().nullable().optional(),
        assigneeIds: z.array(z.string()).optional(),
      }),
      outputSchema: z.object({ proposed: z.boolean(), approvalId: z.string().optional(), error: z.string().optional() }),
    }).server(async (args) => {
      const task = await resolveOrError(deps.findTaskByRef(args.ref), `task '${args.ref}' not found`);
      if (!task.ok) return { proposed: false, error: task.error };
      const changes: Array<Pick<TaskUpdateChange, "field" | "after">> = [];
      if (args.title !== undefined) changes.push({ field: "title", after: args.title });
      if (args.description !== undefined) changes.push({ field: "description", after: docText(args.description) });
      if (args.priorityId !== undefined) changes.push({ field: "priority", after: args.priorityId });
      if (args.typeId !== undefined) changes.push({ field: "type", after: args.typeId });
      if (args.dueAt !== undefined) changes.push({ field: "dueAt", after: args.dueAt });
      if (args.assigneeIds !== undefined) changes.push({ field: "assignees", after: args.assigneeIds.join(", ") });
      if (changes.length === 0) return { proposed: false, error: "no fields to update" };
      const diff = buildTaskUpdateDiff(task.value, changes);
      const r = await record(deps, {
        name: "update_task",
        args,
        diff,
        detail: `Update ${task.value.key} "${cap(task.value.title, 40)}"`,
      });
      if (!r.ok) return { proposed: false, error: r.error };
      return { proposed: true, approvalId: r.value.approvalId };
    })
  );

  tools.push(
    toolDefinition({
      name: "move_task",
      description:
        "Propose moving a task to another column (optionally another swimlane, optionally before/after a neighbor in the target column). Requires user approval.",
      inputSchema: z.object({
        ref: z.string().min(1).describe("Task id or PREFIX-n key"),
        toColumnId: z.string().min(1),
        toSwimlaneId: z.string().optional(),
        beforeTaskId: z.string().optional(),
        afterTaskId: z.string().optional(),
      }),
      outputSchema: z.object({ proposed: z.boolean(), approvalId: z.string().optional(), error: z.string().optional() }),
    }).server(async (args) => {
      const task = await resolveOrError(deps.findTaskByRef(args.ref), `task '${args.ref}' not found`);
      if (!task.ok) return { proposed: false, error: task.error };
      const column = await resolveOrError(deps.findColumn(args.toColumnId), `column '${args.toColumnId}' not found`);
      if (!column.ok) return { proposed: false, error: column.error };
      if (args.toSwimlaneId) {
        const lane = await resolveOrError(deps.findSwimlane(args.toSwimlaneId), `swimlane '${args.toSwimlaneId}' not found`);
        if (!lane.ok) return { proposed: false, error: lane.error };
      }
      for (const n of [args.beforeTaskId, args.afterTaskId]) {
        if (!n) continue;
        const neighbor = await resolveOrError(deps.findTaskByRef(n), `neighbor task '${n}' not found`);
        if (!neighbor.ok) return { proposed: false, error: neighbor.error };
      }
      const diff: HeraldWriteDiff = {
        type: "task_move",
        taskRef: task.value.key,
        taskTitle: task.value.title,
        fromColumn: task.value.columnName,
        toColumn: column.value.name,
      };
      const r = await record(deps, {
        name: "move_task",
        args,
        diff,
        detail: `Move ${task.value.key} → ${column.value.name}`,
      });
      if (!r.ok) return { proposed: false, error: r.error };
      return { proposed: true, approvalId: r.value.approvalId };
    })
  );

  for (const [name, verb] of [["archive_task", "Archive"], ["restore_task", "Restore"]] as const) {
    tools.push(
      toolDefinition({
        name,
        description: `Propose ${verb.toLowerCase()}ing a task. Requires user approval.`,
        inputSchema: z.object({ ref: z.string().min(1).describe("Task id or PREFIX-n key") }),
        outputSchema: z.object({ proposed: z.boolean(), approvalId: z.string().optional(), error: z.string().optional() }),
      }).server(async (args: { ref: string }) => {
        const task = await resolveOrError(deps.findTaskByRef(args.ref), `task '${args.ref}' not found`);
        if (!task.ok) return { proposed: false, error: task.error };
        const diff: HeraldWriteDiff =
          name === "archive_task"
            ? { type: "task_archive", taskRef: task.value.key, taskTitle: task.value.title }
            : buildTaskRestoreDiff(task.value);
        const r = await record(deps, { name, args, diff, detail: `${verb} ${task.value.key}` });
        if (!r.ok) return { proposed: false, error: r.error };
        return { proposed: true, approvalId: r.value.approvalId };
      })
    );
  }

  tools.push(
    toolDefinition({
      name: "add_comment",
      description: "Propose adding a comment to a task. Body is a TipTap doc (≤64KB). Requires user approval.",
      inputSchema: z.object({
        ref: z.string().min(1).describe("Task id or PREFIX-n key"),
        body: tipTapDoc,
      }),
      outputSchema: z.object({ proposed: z.boolean(), approvalId: z.string().optional(), error: z.string().optional() }),
    }).server(async (args) => {
      const task = await resolveOrError(deps.findTaskByRef(args.ref), `task '${args.ref}' not found`);
      if (!task.ok) return { proposed: false, error: task.error };
      if (JSON.stringify(args.body).length > COMMENT_BODY_BYTES) {
        return err("comment body exceeds 64KB");
      }
      const diff: HeraldWriteDiff = {
        type: "comment",
        taskRef: task.value.key,
        taskTitle: task.value.title,
        bodyText: cap(extractText(args.body), COMMENT_BODYTEXT_CAP),
      };
      const r = await record(deps, {
        name: "add_comment",
        args,
        diff,
        detail: `Comment on ${task.value.key}`,
      });
      if (!r.ok) return { proposed: false, error: r.error };
      return { proposed: true, approvalId: r.value.approvalId };
    })
  );

  tools.push(
    toolDefinition({
      name: "create_wiki_page",
      description: "Propose creating a wiki page (slug must be free). Content is a TipTap doc. Requires user approval.",
      inputSchema: z.object({
        slug: z.string().min(1).max(80).regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "lowercase kebab-case slug"),
        title: z.string().min(1).max(300),
        content: tipTapDoc,
        parentId: z.string().optional(),
      }),
      outputSchema: z.object({ proposed: z.boolean(), approvalId: z.string().optional(), error: z.string().optional() }),
    }).server(async (args) => {
      const existing = await deps.findWikiPageBySlug(args.slug).catch(() => null);
      if (existing) return { proposed: false, error: `slug '${args.slug}' is already taken` };
      const diff: HeraldWriteDiff = {
        type: "wiki_create",
        slug: args.slug,
        title: args.title,
        bodyText: cap(extractText(args.content)),
      };
      const r = await record(deps, { name: "create_wiki_page", args, diff, detail: `Create page "${cap(args.title, 60)}"` });
      if (!r.ok) return { proposed: false, error: r.error };
      return { proposed: true, approvalId: r.value.approvalId };
    })
  );

  tools.push(
    toolDefinition({
      name: "edit_wiki_page",
      description: "Propose editing a wiki page's title and/or content. Requires user approval.",
      inputSchema: z.object({
        slug: z.string().min(1),
        title: z.string().min(1).max(300).optional(),
        content: tipTapDoc,
      }),
      outputSchema: z.object({ proposed: z.boolean(), approvalId: z.string().optional(), error: z.string().optional() }),
    }).server(async (args) => {
      const page = await resolveOrError(deps.findWikiPageBySlug(args.slug), `wiki page '${args.slug}' not found`);
      if (!page.ok) return { proposed: false, error: page.error };
      const diff = buildWikiEditDiff(page.value, { title: args.title, content: args.content });
      const r = await record(deps, { name: "edit_wiki_page", args, diff, detail: `Edit page "${cap(diff.title, 60)}"` });
      if (!r.ok) return { proposed: false, error: r.error };
      return { proposed: true, approvalId: r.value.approvalId };
    })
  );

  tools.push(
    toolDefinition({
      name: "create_milestone",
      description: "Propose creating a milestone. Requires user approval.",
      inputSchema: z.object({ name: z.string().min(1).max(200), dueAt: z.string().optional() }),
      outputSchema: z.object({ proposed: z.boolean(), approvalId: z.string().optional(), error: z.string().optional() }),
    }).server(async (args) => {
      const diff = buildMilestoneCreateDiff(args);
      const r = await record(deps, { name: "create_milestone", args, diff, detail: `Create milestone "${cap(args.name, 60)}"` });
      if (!r.ok) return { proposed: false, error: r.error };
      return { proposed: true, approvalId: r.value.approvalId };
    })
  );

  tools.push(
    toolDefinition({
      name: "update_milestone",
      description: "Propose updating a milestone's name and/or due date. Requires user approval.",
      inputSchema: z.object({
        milestoneId: z.string().min(1),
        name: z.string().min(1).max(200).optional(),
        dueAt: z.string().nullable().optional(),
      }),
      outputSchema: z.object({ proposed: z.boolean(), approvalId: z.string().optional(), error: z.string().optional() }),
    }).server(async (args) => {
      const m = await resolveOrError(deps.findMilestone(args.milestoneId), `milestone '${args.milestoneId}' not found`);
      if (!m.ok) return { proposed: false, error: m.error };
      const changes: Array<{ field: string; before: string | null; after: string | null }> = [];
      if (args.name !== undefined) changes.push(change("name", m.value.name, args.name));
      if (args.dueAt !== undefined) changes.push(change("dueAt", m.value.dueAt, args.dueAt));
      if (changes.length === 0) return { proposed: false, error: "no fields to update" };
      const diff: HeraldWriteDiff = { type: "milestone_update", name: args.name ?? m.value.name, changes };
      const r = await record(deps, { name: "update_milestone", args, diff, detail: `Update milestone "${cap(m.value.name, 60)}"` });
      if (!r.ok) return { proposed: false, error: r.error };
      return { proposed: true, approvalId: r.value.approvalId };
    })
  );

  tools.push(
    toolDefinition({
      name: "archive_milestone",
      description: "Propose archiving a milestone (its sprints archive with it). Requires user approval.",
      inputSchema: z.object({ milestoneId: z.string().min(1) }),
      outputSchema: z.object({ proposed: z.boolean(), approvalId: z.string().optional(), error: z.string().optional() }),
    }).server(async (args) => {
      const m = await resolveOrError(deps.findMilestone(args.milestoneId), `milestone '${args.milestoneId}' not found`);
      if (!m.ok) return { proposed: false, error: m.error };
      const sprintsAffected = await deps.countSprints(args.milestoneId).catch(() => undefined);
      const diff = buildMilestoneArchiveDiff({ name: m.value.name, ...(sprintsAffected !== undefined ? { sprintsAffected } : {}) });
      const r = await record(deps, { name: "archive_milestone", args, diff, detail: `Archive milestone "${cap(m.value.name, 60)}"` });
      if (!r.ok) return { proposed: false, error: r.error };
      return { proposed: true, approvalId: r.value.approvalId };
    })
  );

  tools.push(
    toolDefinition({
      name: "create_sprint",
      description: "Propose creating a sprint lane (optionally under a milestone). Requires user approval.",
      inputSchema: z.object({
        milestoneId: z.string().optional(),
        name: z.string().min(1).max(200),
        startAt: z.string().optional(),
        dueAt: z.string().optional(),
      }),
      outputSchema: z.object({ proposed: z.boolean(), approvalId: z.string().optional(), error: z.string().optional() }),
    }).server(async (args) => {
      if (args.milestoneId) {
        const m = await resolveOrError(deps.findMilestone(args.milestoneId), `milestone '${args.milestoneId}' not found`);
        if (!m.ok) return { proposed: false, error: m.error };
      }
      const diff = buildSprintCreateDiff({ name: args.name, ...(args.startAt !== undefined ? { startAt: args.startAt } : {}), ...(args.dueAt !== undefined ? { dueAt: args.dueAt } : {}) });
      const r = await record(deps, { name: "create_sprint", args, diff, detail: `Create sprint "${cap(args.name, 60)}"` });
      if (!r.ok) return { proposed: false, error: r.error };
      return { proposed: true, approvalId: r.value.approvalId };
    })
  );

  tools.push(
    toolDefinition({
      name: "update_sprint",
      description: "Propose updating a sprint lane's name and/or dates. Requires user approval.",
      inputSchema: z.object({
        swimlaneId: z.string().min(1),
        name: z.string().min(1).max(200).optional(),
        startAt: z.string().nullable().optional(),
        dueAt: z.string().nullable().optional(),
      }),
      outputSchema: z.object({ proposed: z.boolean(), approvalId: z.string().optional(), error: z.string().optional() }),
    }).server(async (args) => {
      const lane = await resolveOrError(deps.findSwimlane(args.swimlaneId), `sprint '${args.swimlaneId}' not found`);
      if (!lane.ok) return { proposed: false, error: lane.error };
      if (lane.value.kind !== "sprint") return { proposed: false, error: `'${lane.value.name}' is not a sprint` };
      const changes: Array<{ field: string; before: string | null; after: string | null }> = [];
      if (args.name !== undefined) changes.push(change("name", lane.value.name, args.name));
      if (args.startAt !== undefined) changes.push(change("startAt", null, args.startAt));
      if (args.dueAt !== undefined) changes.push(change("dueAt", null, args.dueAt));
      if (changes.length === 0) return { proposed: false, error: "no fields to update" };
      const diff: HeraldWriteDiff = { type: "sprint_update", name: args.name ?? lane.value.name, changes };
      const r = await record(deps, { name: "update_sprint", args, diff, detail: `Update sprint "${cap(lane.value.name, 60)}"` });
      if (!r.ok) return { proposed: false, error: r.error };
      return { proposed: true, approvalId: r.value.approvalId };
    })
  );

  return tools;
}
