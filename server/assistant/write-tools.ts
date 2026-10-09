import { toolDefinition } from "@tanstack/ai";
import { z } from "zod";
import { extractText } from "../../shared/tiptap-text";
import type { TipTapDoc } from "../../shared/types";
import type { ApprovalPartial, AssistantWriteDiff } from "../../shared/assistant";

const DIFF_TEXT_CAP = 2000;
const COMMENT_BODYTEXT_CAP = 2000;
const COMMENT_BODY_BYTES = 64 * 1024;

import {
  APPROVAL_TTL_HOURS,
  ASSISTANT_WRITE_TOOL_NAMES,
  MAX_BULK_TASK_REFS,
  MAX_WRITES_PER_TURN,
  type AssistantWriteToolName,
} from "./write-tool-names";

export { APPROVAL_TTL_HOURS, ASSISTANT_WRITE_TOOL_NAMES, MAX_BULK_TASK_REFS, MAX_WRITES_PER_TURN };
export type { AssistantWriteToolName };

export function isAssistantWriteTool(name: string): name is AssistantWriteToolName {
  return (ASSISTANT_WRITE_TOOL_NAMES as readonly string[]).includes(name);
}

// Parse assistant_settings.write_tools (comma-separated names). Unknown names
// are dropped silently; duplicates collapse.
export function parseWriteTools(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const name = part.trim();
    if (name !== "" && isAssistantWriteTool(name) && !seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
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
}): Extract<AssistantWriteDiff, { type: "task_create" }> {
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

type TaskUpdateChange = Extract<AssistantWriteDiff, { type: "task_update" }>["changes"][number];

export function buildTaskUpdateDiff(
  task: WriteTaskSnapshot,
  changes: Array<Pick<TaskUpdateChange, "field" | "after">>
): Extract<AssistantWriteDiff, { type: "task_update" }> {
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

export function buildWikiEditDiff(page: { slug: string; title: string; text: string }, next: { title?: string | undefined; content: TipTapDoc }): Extract<AssistantWriteDiff, { type: "wiki_edit" }> {
  return {
    type: "wiki_edit",
    slug: page.slug,
    title: next.title ?? page.title,
    beforeText: cap(page.text),
    afterText: cap(extractText(next.content)),
  };
}

// Archived tasks keep column_id, so the snapshot's columnName IS the
// pre-archive column the restore returns to (assistant-write-approvals.html:
// "back to <column>").
export function buildTaskRestoreDiff(task: WriteTaskSnapshot): Extract<AssistantWriteDiff, { type: "task_restore" }> {
  return { type: "task_restore", taskRef: task.key, taskTitle: task.title, toColumn: task.columnName };
}

export function buildMilestoneCreateDiff(input: { name: string; dueAt?: string | null | undefined }): Extract<AssistantWriteDiff, { type: "milestone_create" }> {
  return { type: "milestone_create", name: input.name, ...(input.dueAt !== undefined && input.dueAt !== null ? { dueAt: input.dueAt } : {}) };
}

// sprintsAffected omitted when the milestone has no live sprints — the chip
// confirm line reads naturally without a "0 sprints" row.
export function buildMilestoneArchiveDiff(input: { name: string; sprintsAffected?: number }): Extract<AssistantWriteDiff, { type: "milestone_archive" }> {
  return {
    type: "milestone_archive",
    name: input.name,
    ...(input.sprintsAffected !== undefined && input.sprintsAffected > 0 ? { sprintsAffected: input.sprintsAffected } : {}),
  };
}

export function buildSprintCreateDiff(input: { name: string; startAt?: string | undefined; dueAt?: string | undefined }): Extract<AssistantWriteDiff, { type: "sprint_create" }> {
  return {
    type: "sprint_create",
    name: input.name,
    ...(input.startAt !== undefined ? { startAt: input.startAt } : {}),
    ...(input.dueAt !== undefined ? { dueAt: input.dueAt } : {}),
  };
}

export function buildTaskDeleteDiff(task: WriteTaskSnapshot): Extract<AssistantWriteDiff, { type: "task_delete" }> {
  return { type: "task_delete", taskRef: task.key, taskTitle: cap(task.title, 60) };
}

export function buildWikiDeleteDiff(page: { slug: string; title: string }): Extract<AssistantWriteDiff, { type: "wiki_delete" }> {
  return { type: "wiki_delete", slug: page.slug, title: cap(page.title, 60) };
}

export function buildMilestoneDeleteDiff(input: { name: string }): Extract<AssistantWriteDiff, { type: "milestone_delete" }> {
  return { type: "milestone_delete", name: cap(input.name, 60) };
}

export function buildSprintArchiveDiff(input: { name: string }): Extract<AssistantWriteDiff, { type: "sprint_archive" }> {
  return { type: "sprint_archive", name: cap(input.name, 60) };
}

export function buildSprintDeleteDiff(input: { name: string }): Extract<AssistantWriteDiff, { type: "sprint_delete" }> {
  return { type: "sprint_delete", name: cap(input.name, 60) };
}

export function buildSwimlaneMoveDiff(input: {
  swimlaneId: string;
  swimlaneName: string;
  fromMilestone: string | null;
  toMilestone: string | null;
}): Extract<AssistantWriteDiff, { type: "swimlane_move" }> {
  return {
    type: "swimlane_move",
    swimlaneId: input.swimlaneId,
    swimlaneName: cap(input.swimlaneName, 60),
    fromMilestone: input.fromMilestone ? cap(input.fromMilestone, 60) : null,
    toMilestone: input.toMilestone ? cap(input.toMilestone, 60) : null,
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
  archivedAt: string | null;
  milestoneId: string | null;
}

export interface RecordedProposal {
  approvalId: string;
  batchId: string;
  seq: number;
}

// Model-facing output of a write tool. `ask` returns the proposal shape (a
// pending row was recorded); `auto` returns the applied shape (the write ran
// in-loop, no pending row); a failure/refusal returns the error shape. The
// union is what lets one tool definition serve all three permission modes.
export type AssistantWriteToolOutput =
  | { ok: true; applied: true; result?: unknown; partial?: ApprovalPartial }
  | { ok: false; applied: false; error: string; partial?: ApprovalPartial };

// What a mode's `record` hands back: the pending-row identity (ask), a direct
// tool output (auto), or a recoverable error string (any mode).
export type WriteRecordResult = RecordedProposal | { output: AssistantWriteToolOutput };

// Deny-mode local refusal (ADR-0005 §Port P1). Mirrors the DO-side
// `tools-ai.ts` copy verbatim; the model reads it and may suggest a mode switch.
export const WRITE_TOOLS_DENIED_ERROR =
  "Write tools are blocked for this thread (composer mode: Blocked). Reads still work — the user can switch to Ask or Auto.";

// Side-channel entry pairing a persisted pending-write row with its stream
// toolCallId. The queue drains sequentially in the TOOL_CALL_RESULT handler
// (locked-in pairing decision) and feeds the transcript's pendingBatch meta.
export interface QueuedProposal extends RecordedProposal {
  name: AssistantWriteToolName;
  detail?: string;
  diff: AssistantWriteDiff;
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
      proposal: { name: AssistantWriteToolName; args: unknown; diff: AssistantWriteDiff; detail?: string }
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
      try {
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
      } catch (e) {
        return { error: String((e as { message?: string }).message ?? "failed to queue write") };
      }
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

export interface AssistantWriteToolDeps {
  projectId: string;
  findTaskByRef: (ref: string) => Promise<WriteTaskSnapshot | null>;
  findColumn: (id: string) => Promise<{ id: string; name: string } | null>;
  findWikiPageBySlug: (slug: string) => Promise<{ slug: string; title: string; text: string } | null>;
  findMilestone: (id: string) => Promise<WriteMilestoneSnapshot | null>;
  // Live (non-archived) sprint count under a milestone — feeds the
  // milestone_archive diff's sprintsAffected field.
  countSprints: (milestoneId: string) => Promise<number>;
  findSwimlane: (id: string) => Promise<WriteSwimlaneSnapshot | null>;
  // Hand the resolved proposal to the mode's executor. `ask` persists a pending
  // row + registers it on the turn's side-channel and returns its identity;
  // `auto` applies the write in-loop and returns a direct output; `deny`
  // returns a refusal error. Budget enforcement lives in the executor;
  // over-budget calls yield an error result.
  record: (proposal: { name: AssistantWriteToolName; args: unknown; diff: AssistantWriteDiff; detail?: string }) => Promise<WriteRecordResult | { error: string }>;
}

const err = (error: string): { proposed: false; error: string } => ({ proposed: false, error });

type Step<T> = { ok: true; value: T } | { ok: false; error: string };

async function resolveOrError<T>(p: Promise<T | null>, message: string): Promise<Step<T>> {
  const v = await p.catch(() => null);
  return v === null ? { ok: false, error: message } : { ok: true, value: v };
}

async function record(deps: AssistantWriteToolDeps, proposal: { name: AssistantWriteToolName; args: unknown; diff: AssistantWriteDiff; detail?: string }): Promise<Step<WriteRecordResult>> {
  const r = await deps.record(proposal);
  if ("error" in r) return { ok: false, error: r.error };
  return { ok: true, value: r };
}

// Auto-mode executor (ADR-0005 §Port P1): applies the resolved write in-loop via
// the injected `apply` (the service's `applyAssistantWrite` wrapper), no pending
// row, no suspend. A per-turn budget (port of the DO-side
// `createAssistantWriteBudget`) caps executions; one bulk tool call is one slot.
// A refused call returns the same recoverable tool error the constant-copy
// budget produced on the DO path.
export interface AutoWriteRecordDeps {
  apply: (toolName: AssistantWriteToolName, args: Record<string, unknown>) => Promise<{ ok: true; result?: unknown } | { ok: false; error: string }>;
  limit?: number;
}

export function buildAutoWriteRecord(deps: AutoWriteRecordDeps): AssistantWriteToolDeps["record"] {
  const limit = deps.limit ?? MAX_WRITES_PER_TURN;
  let used = 0;
  return async (proposal) => {
    if (used >= limit) return { error: `write budget exceeded — at most ${limit} writes per turn` };
    used += 1;
    const outcome = await deps.apply(proposal.name, proposal.args as Record<string, unknown>);
    if (!outcome.ok) return { error: outcome.error };
    return { output: { ok: true, applied: true, ...(outcome.result !== undefined ? { result: outcome.result } : {}) } };
  };
}

// Deny-mode executor (ADR-0005 §Port P1): never reaches the data layer; every
// write tool returns the same model-readable refusal. Reads are unaffected.
export function buildDenyWriteRecord(): AssistantWriteToolDeps["record"] {
  return async () => ({ error: WRITE_TOOLS_DENIED_ERROR });
}

const tipTapDoc = z
  .looseObject({
    type: z.literal("doc"),
    content: z.array(z.looseObject({ type: z.string() })).optional(),
  }) as unknown as z.ZodType<TipTapDoc, TipTapDoc>;

// Single-task ref in two shapes: exactly one of `ref` (one task, legacy) or
// `refs` (1..MAX_BULK_TASK_REFS tasks in one call). Passing both is rejected —
// the refine message is the clear validation error surfaced to the model.
const taskRefsSchema = z
  .object({
    ref: z.string().min(1).describe("Task id or PREFIX-n key (one task)").optional(),
    refs: z
      .array(z.string().min(1))
      .min(1)
      .max(MAX_BULK_TASK_REFS)
      .describe(`Task ids or PREFIX-n keys — pass many tasks in one call (max ${MAX_BULK_TASK_REFS})`)
      .optional(),
  })
  .refine((v) => (v.ref === undefined) !== (v.refs === undefined), {
    message: "provide exactly one of 'ref' or 'refs'",
  });

type TaskRefArgs = { ref?: string | undefined; refs?: string[] | undefined };

// Bulk diffs reuse the existing diff types; the chip target copy is summary
// text, never a new diff kind.
const bulkRefSummary = (n: number): string => `${n} tasks`;
const bulkTitleSummary = (keys: string[]): string => {
  const head = keys.slice(0, 3).join(", ");
  return keys.length > 3 ? `${head}…` : head;
};

// A repeated/whitespace ref must neither inflate the summary nor run twice
// (double delete yields a spurious TASK_NOT_FOUND). Trimmed + deduped in
// first-seen order.
const taskRefListOf = (args: TaskRefArgs): string[] => {
  const raw = args.refs !== undefined ? args.refs : args.ref !== undefined ? [args.ref] : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of raw) {
    if (typeof r !== "string") continue;
    const ref = r.trim();
    if (ref === "" || seen.has(ref)) continue;
    seen.add(ref);
    out.push(ref);
  }
  return out;
};

// One output schema for every write tool: the union of the ask shape
// (`proposed`/`approvalId`/`error`), the auto shape (`ok`/`applied`/`result`),
// and the failure/refusal shape. TanStack validates tool output against it; the
// fields are optional so a single schema serves all permission modes.
const writeToolOutputSchema = z.object({
  proposed: z.boolean().optional(),
  approvalId: z.string().optional(),
  error: z.string().optional(),
  ok: z.boolean().optional(),
  applied: z.boolean().optional(),
  result: z.unknown().optional(),
  partial: z.unknown().optional(),
});

export function buildAssistantWriteTools(deps: AssistantWriteToolDeps) {
  const tools = [];

  // Resolve every ref; all-or-nothing at proposal time so a bulk proposal can
  // never half-exist. Unknown refs are named in the error.
  const resolveTaskRefs = async (args: TaskRefArgs): Promise<Step<WriteTaskSnapshot[]>> => {
    const tasks: WriteTaskSnapshot[] = [];
    const unknown: string[] = [];
    const refs = taskRefListOf(args);
    if (refs.length === 0) return { ok: false, error: "provide at least one task ref" };
    for (const ref of refs) {
      const t = await resolveOrError(deps.findTaskByRef(ref), `task '${ref}' not found`);
      if (t.ok) tasks.push(t.value);
      else unknown.push(ref);
    }
    if (unknown.length === 1) return { ok: false, error: `task '${unknown[0]}' not found` };
    if (unknown.length > 1) return { ok: false, error: `tasks not found: ${unknown.map((r) => `'${r}'`).join(", ")}` };
    return { ok: true, value: tasks };
  };


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
      outputSchema: writeToolOutputSchema,
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
      if ("output" in r.value) return r.value.output;
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
      outputSchema: writeToolOutputSchema,
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
      if ("output" in r.value) return r.value.output;
      return { proposed: true, approvalId: r.value.approvalId };
    })
  );

  tools.push(
    toolDefinition({
      name: "move_task",
      description:
        "Move task to another column and/or swimlane (fellow column / sprint). Provide toColumnId for column move, toSwimlaneId for swimlane move, both together allowed. Optionally before/after a neighbor in the target column. Requires user approval.",
      inputSchema: z.object({
        ref: z.string().min(1).describe("Task id or PREFIX-n key"),
        toColumnId: z.string().min(1),
        toSwimlaneId: z.string().optional(),
        beforeTaskId: z.string().optional(),
        afterTaskId: z.string().optional(),
      }),
      outputSchema: writeToolOutputSchema,
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
      const diff: AssistantWriteDiff = {
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
      if ("output" in r.value) return r.value.output;
      return { proposed: true, approvalId: r.value.approvalId };
    })
  );

  for (const [name, verb] of [["archive_task", "Archive"], ["restore_task", "Restore"]] as const) {
    tools.push(
      toolDefinition({
        name,
        description: `Propose ${verb.toLowerCase()}ing a task. Pass \`refs\` to act on many tasks in one call (max ${MAX_BULK_TASK_REFS}) — prefer this over repeated calls. Requires user approval.`,
        inputSchema: taskRefsSchema,
        outputSchema: writeToolOutputSchema,
      }).server(async (args: TaskRefArgs) => {
        const resolved = await resolveTaskRefs(args);
        if (!resolved.ok) return { proposed: false, error: resolved.error };
        const tasks = resolved.value;
        const single = tasks.length === 1 ? tasks[0]! : null;
        const diff: AssistantWriteDiff =
          single !== null
            ? name === "archive_task"
              ? { type: "task_archive", taskRef: single.key, taskTitle: single.title }
              : buildTaskRestoreDiff(single)
            : name === "archive_task"
              ? { type: "task_archive", taskRef: bulkRefSummary(tasks.length), taskTitle: bulkTitleSummary(tasks.map((t) => t.key)) }
              : {
                  type: "task_restore",
                  taskRef: bulkRefSummary(tasks.length),
                  taskTitle: bulkTitleSummary(tasks.map((t) => t.key)),
                  toColumn: tasks[0]!.columnName,
                };
        const detail = single !== null ? `${verb} ${single.key}` : `${verb} ${tasks.length} tasks`;
        const r = await record(deps, { name, args, diff, detail });
        if (!r.ok) return { proposed: false, error: r.error };
        if ("output" in r.value) return r.value.output;
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
      outputSchema: writeToolOutputSchema,
    }).server(async (args) => {
      const task = await resolveOrError(deps.findTaskByRef(args.ref), `task '${args.ref}' not found`);
      if (!task.ok) return { proposed: false, error: task.error };
      if (JSON.stringify(args.body).length > COMMENT_BODY_BYTES) {
        return err("comment body exceeds 64KB");
      }
      const diff: AssistantWriteDiff = {
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
      if ("output" in r.value) return r.value.output;
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
      outputSchema: writeToolOutputSchema,
    }).server(async (args) => {
      const existing = await deps.findWikiPageBySlug(args.slug).catch(() => null);
      if (existing) return { proposed: false, error: `slug '${args.slug}' is already taken` };
      const diff: AssistantWriteDiff = {
        type: "wiki_create",
        slug: args.slug,
        title: args.title,
        bodyText: cap(extractText(args.content)),
      };
      const r = await record(deps, { name: "create_wiki_page", args, diff, detail: `Create page "${cap(args.title, 60)}"` });
      if (!r.ok) return { proposed: false, error: r.error };
      if ("output" in r.value) return r.value.output;
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
      outputSchema: writeToolOutputSchema,
    }).server(async (args) => {
      const page = await resolveOrError(deps.findWikiPageBySlug(args.slug), `wiki page '${args.slug}' not found`);
      if (!page.ok) return { proposed: false, error: page.error };
      const diff = buildWikiEditDiff(page.value, { title: args.title, content: args.content });
      const r = await record(deps, { name: "edit_wiki_page", args, diff, detail: `Edit page "${cap(diff.title, 60)}"` });
      if (!r.ok) return { proposed: false, error: r.error };
      if ("output" in r.value) return r.value.output;
      return { proposed: true, approvalId: r.value.approvalId };
    })
  );

  tools.push(
    toolDefinition({
      name: "create_milestone",
      description: "Propose creating a milestone. Omit optional dueAt if not provided; never send \"None\" string. Requires user approval.",
      inputSchema: z.object({ name: z.string().min(1).max(200), dueAt: z.string().optional().nullable() }),
      outputSchema: writeToolOutputSchema,
    }).server(async (args) => {
      const diff = buildMilestoneCreateDiff(args);
      const r = await record(deps, { name: "create_milestone", args, diff, detail: `Create milestone "${cap(args.name, 60)}"` });
      if (!r.ok) return { proposed: false, error: r.error };
      if ("output" in r.value) return r.value.output;
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
      outputSchema: writeToolOutputSchema,
    }).server(async (args) => {
      const m = await resolveOrError(deps.findMilestone(args.milestoneId), `milestone '${args.milestoneId}' not found`);
      if (!m.ok) return { proposed: false, error: m.error };
      const changes: Array<{ field: string; before: string | null; after: string | null }> = [];
      if (args.name !== undefined) changes.push(change("name", m.value.name, args.name));
      if (args.dueAt !== undefined) changes.push(change("dueAt", m.value.dueAt, args.dueAt));
      if (changes.length === 0) return { proposed: false, error: "no fields to update" };
      const diff: AssistantWriteDiff = { type: "milestone_update", name: args.name ?? m.value.name, changes };
      const r = await record(deps, { name: "update_milestone", args, diff, detail: `Update milestone "${cap(m.value.name, 60)}"` });
      if (!r.ok) return { proposed: false, error: r.error };
      if ("output" in r.value) return r.value.output;
      return { proposed: true, approvalId: r.value.approvalId };
    })
  );

  tools.push(
    toolDefinition({
      name: "archive_milestone",
      description: "Propose archiving a milestone (its sprints archive with it). Requires user approval.",
      inputSchema: z.object({ milestoneId: z.string().min(1) }),
      outputSchema: writeToolOutputSchema,
    }).server(async (args) => {
      const m = await resolveOrError(deps.findMilestone(args.milestoneId), `milestone '${args.milestoneId}' not found`);
      if (!m.ok) return { proposed: false, error: m.error };
      const sprintsAffected = await deps.countSprints(args.milestoneId).catch(() => undefined);
      const diff = buildMilestoneArchiveDiff({ name: m.value.name, ...(sprintsAffected !== undefined ? { sprintsAffected } : {}) });
      const r = await record(deps, { name: "archive_milestone", args, diff, detail: `Archive milestone "${cap(m.value.name, 60)}"` });
      if (!r.ok) return { proposed: false, error: r.error };
      if ("output" in r.value) return r.value.output;
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
      outputSchema: writeToolOutputSchema,
    }).server(async (args) => {
      if (args.milestoneId) {
        const m = await resolveOrError(deps.findMilestone(args.milestoneId), `milestone '${args.milestoneId}' not found`);
        if (!m.ok) return { proposed: false, error: m.error };
      }
      const diff = buildSprintCreateDiff({ name: args.name, ...(args.startAt !== undefined ? { startAt: args.startAt } : {}), ...(args.dueAt !== undefined ? { dueAt: args.dueAt } : {}) });
      const r = await record(deps, { name: "create_sprint", args, diff, detail: `Create sprint "${cap(args.name, 60)}"` });
      if (!r.ok) return { proposed: false, error: r.error };
      if ("output" in r.value) return r.value.output;
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
      outputSchema: writeToolOutputSchema,
    }).server(async (args) => {
      const lane = await resolveOrError(deps.findSwimlane(args.swimlaneId), `sprint '${args.swimlaneId}' not found`);
      if (!lane.ok) return { proposed: false, error: lane.error };
      if (lane.value.kind !== "sprint") return { proposed: false, error: `'${lane.value.name}' is not a sprint` };
      const changes: Array<{ field: string; before: string | null; after: string | null }> = [];
      if (args.name !== undefined) changes.push(change("name", lane.value.name, args.name));
      if (args.startAt !== undefined) changes.push(change("startAt", null, args.startAt));
      if (args.dueAt !== undefined) changes.push(change("dueAt", null, args.dueAt));
      if (changes.length === 0) return { proposed: false, error: "no fields to update" };
      const diff: AssistantWriteDiff = { type: "sprint_update", name: args.name ?? lane.value.name, changes };
      const r = await record(deps, { name: "update_sprint", args, diff, detail: `Update sprint "${cap(lane.value.name, 60)}"` });
      if (!r.ok) return { proposed: false, error: r.error };
      if ("output" in r.value) return r.value.output;
      return { proposed: true, approvalId: r.value.approvalId };
    })
  );

  tools.push(
    toolDefinition({
      name: "delete_task",
      description: `Propose deleting a task (hard delete — fails if it has subtasks). Pass \`refs\` to act on many tasks in one call (max ${MAX_BULK_TASK_REFS}) — prefer this over repeated calls. Requires user approval.`,
      inputSchema: taskRefsSchema,
      outputSchema: writeToolOutputSchema,
    }).server(async (args: TaskRefArgs) => {
      const resolved = await resolveTaskRefs(args);
      if (!resolved.ok) return { proposed: false, error: resolved.error };
      const tasks = resolved.value;
      const single = tasks.length === 1 ? tasks[0]! : null;
      const diff: AssistantWriteDiff =
        single !== null
          ? buildTaskDeleteDiff(single)
          : { type: "task_delete", taskRef: bulkRefSummary(tasks.length), taskTitle: bulkTitleSummary(tasks.map((t) => t.key)) };
      const detail = single !== null ? `Delete ${single.key} "${cap(single.title, 40)}"` : `Delete ${tasks.length} tasks`;
      const r = await record(deps, { name: "delete_task", args, diff, detail });
      if (!r.ok) return { proposed: false, error: r.error };
      if ("output" in r.value) return r.value.output;
      return { proposed: true, approvalId: r.value.approvalId };
    })
  );

  tools.push(
    toolDefinition({
      name: "delete_wiki_page",
      description: "Propose deleting a wiki page (fails if it has children). Requires user approval.",
      inputSchema: z.object({ slug: z.string().min(1) }),
      outputSchema: writeToolOutputSchema,
    }).server(async (args) => {
      const page = await resolveOrError(deps.findWikiPageBySlug(args.slug), `wiki page '${args.slug}' not found`);
      if (!page.ok) return { proposed: false, error: page.error };
      const diff = buildWikiDeleteDiff(page.value);
      const r = await record(deps, { name: "delete_wiki_page", args, diff, detail: `Delete page "${cap(page.value.title, 60)}"` });
      if (!r.ok) return { proposed: false, error: r.error };
      if ("output" in r.value) return r.value.output;
      return { proposed: true, approvalId: r.value.approvalId };
    })
  );

  tools.push(
    toolDefinition({
      name: "delete_milestone",
      description: "Propose deleting a milestone (fails if it has sprints). Requires user approval.",
      inputSchema: z.object({ milestoneId: z.string().min(1) }),
      outputSchema: writeToolOutputSchema,
    }).server(async (args) => {
      const m = await resolveOrError(deps.findMilestone(args.milestoneId), `milestone '${args.milestoneId}' not found`);
      if (!m.ok) return { proposed: false, error: m.error };
      const diff = buildMilestoneDeleteDiff({ name: m.value.name });
      const r = await record(deps, { name: "delete_milestone", args, diff, detail: `Delete milestone "${cap(m.value.name, 60)}"` });
      if (!r.ok) return { proposed: false, error: r.error };
      if ("output" in r.value) return r.value.output;
      return { proposed: true, approvalId: r.value.approvalId };
    })
  );

  tools.push(
    toolDefinition({
      name: "archive_sprint",
      description: "Propose archiving a sprint lane (its live tasks archive with it; Backlog cannot be archived). Requires user approval.",
      inputSchema: z.object({ swimlaneId: z.string().min(1) }),
      outputSchema: writeToolOutputSchema,
    }).server(async (args) => {
      const lane = await resolveOrError(deps.findSwimlane(args.swimlaneId), `sprint '${args.swimlaneId}' not found`);
      if (!lane.ok) return { proposed: false, error: lane.error };
      if (lane.value.kind !== "sprint") return { proposed: false, error: `'${lane.value.name}' is not a sprint` };
      const diff = buildSprintArchiveDiff({ name: lane.value.name });
      const r = await record(deps, { name: "archive_sprint", args, diff, detail: `Archive sprint "${cap(lane.value.name, 60)}"` });
      if (!r.ok) return { proposed: false, error: r.error };
      if ("output" in r.value) return r.value.output;
      return { proposed: true, approvalId: r.value.approvalId };
    })
  );

  tools.push(
    toolDefinition({
      name: "delete_sprint",
      description: "Propose deleting a sprint lane (fails if it has tasks; Backlog cannot be deleted). Requires user approval.",
      inputSchema: z.object({ swimlaneId: z.string().min(1) }),
      outputSchema: writeToolOutputSchema,
    }).server(async (args) => {
      const lane = await resolveOrError(deps.findSwimlane(args.swimlaneId), `sprint '${args.swimlaneId}' not found`);
      if (!lane.ok) return { proposed: false, error: lane.error };
      if (lane.value.kind !== "sprint") return { proposed: false, error: `'${lane.value.name}' is not a sprint` };
      const diff = buildSprintDeleteDiff({ name: lane.value.name });
      const r = await record(deps, { name: "delete_sprint", args, diff, detail: `Delete sprint "${cap(lane.value.name, 60)}"` });
      if (!r.ok) return { proposed: false, error: r.error };
      if ("output" in r.value) return r.value.output;
      return { proposed: true, approvalId: r.value.approvalId };
    })
  );

  tools.push(
    toolDefinition({
      name: "move_swimlane",
      description: "Propose moving a swimlane (sprint) to another milestone, or to Backlog/unassigned when milestoneId is null. Requires user approval.",
      inputSchema: z.object({ swimlaneId: z.string().min(1), milestoneId: z.string().nullable() }),
      outputSchema: writeToolOutputSchema,
    }).server(async (args) => {
      const lane = await resolveOrError(deps.findSwimlane(args.swimlaneId), `swimlane '${args.swimlaneId}' not found`);
      if (!lane.ok) return { proposed: false, error: lane.error };
      if (lane.value.kind !== "sprint") return { proposed: false, error: `'${lane.value.name}' is not a sprint` };
      if (lane.value.archivedAt) return { proposed: false, error: `sprint '${lane.value.name}' is archived` };
      let fromMilestone: string | null = null;
      if (lane.value.milestoneId) {
        const from = await deps.findMilestone(lane.value.milestoneId).catch(() => null);
        fromMilestone = from?.name ?? null;
      }
      let toMilestone: string | null = null;
      if (args.milestoneId !== null) {
        const m = await resolveOrError(deps.findMilestone(args.milestoneId), `milestone '${args.milestoneId}' not found`);
        if (!m.ok) return { proposed: false, error: m.error };
        toMilestone = m.value.name;
      }
      const diff = buildSwimlaneMoveDiff({ swimlaneId: lane.value.id, swimlaneName: lane.value.name, fromMilestone, toMilestone });
      const detail = `Move swimlane "${cap(lane.value.name, 60)}" → ${toMilestone ? `"${cap(toMilestone, 60)}"` : "Backlog"}`;
      const r = await record(deps, { name: "move_swimlane", args, diff, detail });
      if (!r.ok) return { proposed: false, error: r.error };
      if ("output" in r.value) return r.value.output;
      return { proposed: true, approvalId: r.value.approvalId };
    })
  );

  return tools;
}
