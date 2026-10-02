import { Effect } from "effect";
import { InvalidArgs, TaskNotFound, WikiPageNotFound, Forbidden, errorCodeMap } from "../api/errors";
import type { AssistantPendingWriteRow } from "../repos/assistant-pending-writes.repo";
import type { AssistantWriteToolName } from "./write-tools";
import type { TipTapDoc, Actor } from "../../shared/types";
import type { DbDriver } from "../db/db";
import type { TaskRepo } from "../repos/task.repo";
import type { WikiRepo } from "../repos/wiki.repo";
import type { AssistantPendingWritesRepo } from "../repos/assistant-pending-writes.repo";
import type { TaskService } from "../services/task.service";
import type { CommentService } from "../services/comment.service";
import type { WikiService } from "../services/wiki.service";
import type { MilestoneService } from "../services/milestone.service";
import type { SwimlaneService } from "../services/swimlane.service";
import type { AuthorizationService } from "../services/authorization.service";

export type AssistantWriteExecutionCtx = {
  db: DbDriver;
  taskService: TaskService;
  commentService: CommentService;
  wikiService: WikiService;
  milestoneService: MilestoneService;
  swimlaneService: SwimlaneService;
  authz: AuthorizationService;
  pendingWritesRepo: AssistantPendingWritesRepo;
  taskRepo: TaskRepo;
  wikiRepo: WikiRepo;
};

const assistantActor = (ownerUserId: string): Actor => ({ kind: "agent", label: "assistant", userId: ownerUserId });
const str = (v: unknown): string => String(v);

// Persisted args may carry `ref` (legacy single) or `refs` (bulk). Both are
// accepted forever — pending rows created before bulk support must still run.
// Trimmed and deduped (first-seen order) so a repeated ref can neither inflate
// the summary nor run twice.
const taskRefsFromArgs = (args: Record<string, unknown>): string[] => {
  const refs = args["refs"];
  const raw = Array.isArray(refs) ? refs : [args["ref"]];
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

// The row-free core: the same authz + domain switch the approved-write path
// runs, without a pending row to mark. The ask path wraps this (below) and
// records failures on its row; the auto path (`internal-routes.ts`
// `/write-execute`) applies it directly. Args are the already-validated tool
// input; `projectId`/`ownerUserId` come from the verified identity, never the
// model.
export interface AssistantWriteApplyInput {
  toolName: AssistantWriteToolName;
  args: Record<string, unknown>;
  projectId: string;
  ownerUserId: string;
}

// `pendingWritesRepo` is a row concern, not an apply concern — the auto path
// has no row. `executeAssistantWrite` passes the full ctx (structurally
// compatible) so the ask path is unchanged.
export type AssistantWriteApplyCtx = Omit<AssistantWriteExecutionCtx, "pendingWritesRepo">;

export const applyAssistantWrite = (input: AssistantWriteApplyInput, ctx: AssistantWriteApplyCtx) =>
  Effect.gen(function* () {
    const access = yield* ctx.authz.projectAccess(input.ownerUserId, input.projectId);
    if (access === null) {
      return yield* Effect.fail(new Forbidden({ message: "Write denied: insufficient permissions." }));
    }
    const actor = assistantActor(input.ownerUserId);
    const args = input.args;
    const resolveTaskRefRow = (ref: string) =>
      ctx.taskRepo.findById(ref).pipe(
        Effect.orElse(() => ctx.taskRepo.findByKey(ref)),
        Effect.catchTag("RowNotFound", () => new TaskNotFound({ id: ref })),
        // Proposal-time resolution scopes the ref to the write's project;
        // re-check at execution time (the args are untrusted here).
        Effect.flatMap((t) =>
          t.projectId !== input.projectId
            ? Effect.fail(new Forbidden({ message: "Write denied: task is outside the approved project." }))
            : Effect.succeed(t)
        )
      );
    // Bulk variant: run the per-item op for every ref, keeping the per-item
    // semantics (a subtask guard on one task must not abort the rest). Partial
    // success is allowed; zero applied fails the whole write so the row is
    // recorded as an error.
    const runBulkTaskOp = (refs: string[], op: (id: string) => Effect.Effect<unknown, unknown>) =>
      Effect.gen(function* () {
        const appliedRefs: string[] = [];
        const failed: Array<{ ref: string; error: string }> = [];
        let firstError: { _tag?: string; message?: string } | undefined;
        for (const ref of refs) {
          const outcome = yield* Effect.gen(function* () {
            const t = yield* resolveTaskRefRow(ref);
            yield* op((t as unknown as { id: string }).id);
            return ref;
          }).pipe(Effect.either);
          if (outcome._tag === "Right") {
            appliedRefs.push(outcome.right);
          } else {
            const e = outcome.left as { _tag?: string; message?: string };
            if (firstError === undefined) firstError = e;
            failed.push({ ref, error: `${errorCodeMap[e._tag ?? ""] ?? "ASSISTANT_WRITE_FAILED"}: ${str(e.message ?? "write failed")}` });
          }
        }
        if (appliedRefs.length === 0) {
          return yield* Effect.fail((firstError ?? { _tag: "InvalidArgs", message: "write failed" }) as never);
        }
        // `partial` flags a batch with at least one failure so the resume note
        // and approval_result frame report the real counts, never a bare
        // "applied".
        return { applied: appliedRefs, failed, ...(failed.length > 0 ? { partial: true as const } : {}) };
      });
    const applied = yield* Effect.gen(function* () {
      switch (input.toolName) {
        case "create_task": {
          const first = yield* Effect.promise(() =>
            ctx.db.prepare(`SELECT id FROM columns WHERE project_id = ? ORDER BY position ASC LIMIT 1`).first<{ id: string }>(input.projectId)
          );
          if (!first) return yield* new InvalidArgs({ reason: "project has no columns" });
          return yield* (ctx.taskService as unknown as { create(a: Actor, b: unknown, c: unknown): Effect.Effect<unknown, unknown> }).create(
            actor,
            {
              projectId: input.projectId,
              columnId: first.id,
              title: str(args.title ?? ""),
              ...(args.description !== undefined ? { description: args.description as TipTapDoc } : {}),
              ...(args.priorityId !== undefined ? { priority: str(args.priorityId) } : {}),
              ...(args.typeId !== undefined ? { type: str(args.typeId) } : {}),
              ...(args.dueAt !== undefined ? { dueAt: args.dueAt as string | null } : {}),
              ...(args.assigneeIds !== undefined ? { assignees: args.assigneeIds as string[] } : {}),
              ...(args.parentId !== undefined ? { parentId: str(args.parentId) } : {}),
              ...(args.sprintId !== undefined ? { swimlaneId: str(args.sprintId) } : {}),
            },
            { viaAssistant: true }
          );
        }
        case "update_task": {
          const t = yield* resolveTaskRefRow(str(args.ref ?? ""));
          return yield* (ctx.taskService as unknown as { update(a: Actor, b: string, c: unknown, d: unknown): Effect.Effect<unknown, unknown> }).update(
            actor,
            (t as unknown as { id: string }).id,
            {
              ...(args.title !== undefined ? { title: str(args.title) } : {}),
              ...(args.description !== undefined ? { description: args.description as TipTapDoc } : {}),
              ...(args.priorityId !== undefined ? { priority: str(args.priorityId) } : {}),
              ...(args.typeId !== undefined ? { type: str(args.typeId) } : {}),
              ...(args.dueAt !== undefined ? { dueAt: args.dueAt as string | null } : {}),
              ...(args.assigneeIds !== undefined ? { assignees: args.assigneeIds as string[] } : {}),
            },
            { viaAssistant: true }
          );
        }
        case "move_task": {
          const t = yield* resolveTaskRefRow(str(args.ref ?? ""));
          return yield* (ctx.taskService as unknown as { move(a: Actor, b: string, c: unknown, d: unknown): Effect.Effect<unknown, unknown> }).move(
            actor,
            (t as unknown as { id: string }).id,
            {
              columnId: str(args.toColumnId ?? ""),
              swimlaneId: args.toSwimlaneId !== undefined ? str(args.toSwimlaneId) : (t as unknown as { swimlaneId: string }).swimlaneId,
              ...(args.beforeTaskId !== undefined ? { beforeTaskId: str(args.beforeTaskId) } : {}),
              ...(args.afterTaskId !== undefined ? { afterTaskId: str(args.afterTaskId) } : {}),
            },
            { viaAssistant: true }
          );
        }
        case "archive_task": {
          const refs = taskRefsFromArgs(args);
          if (refs.length <= 1) {
            const t = yield* resolveTaskRefRow(refs[0] ?? "");
            return yield* (ctx.taskService as unknown as { archive(a: Actor, b: string, c: unknown): Effect.Effect<unknown, unknown> }).archive(actor, (t as unknown as { id: string }).id, { viaAssistant: true });
          }
          return yield* runBulkTaskOp(refs, (id) => (ctx.taskService as unknown as { archive(a: Actor, b: string, c: unknown): Effect.Effect<unknown, unknown> }).archive(actor, id, { viaAssistant: true }));
        }
        case "restore_task": {
          const refs = taskRefsFromArgs(args);
          if (refs.length <= 1) {
            const t = yield* resolveTaskRefRow(refs[0] ?? "");
            return yield* (ctx.taskService as unknown as { restore(a: Actor, b: string, c: unknown): Effect.Effect<unknown, unknown> }).restore(actor, (t as unknown as { id: string }).id, { viaAssistant: true });
          }
          return yield* runBulkTaskOp(refs, (id) => (ctx.taskService as unknown as { restore(a: Actor, b: string, c: unknown): Effect.Effect<unknown, unknown> }).restore(actor, id, { viaAssistant: true }));
        }
        case "add_comment": {
          const t = yield* resolveTaskRefRow(str(args.ref ?? ""));
          return yield* (ctx.commentService as unknown as { create(a: string, b: Actor, c: TipTapDoc, d: unknown): Effect.Effect<unknown, unknown> }).create((t as unknown as { id: string }).id, actor, args.body as TipTapDoc, { viaAssistant: true });
        }
        case "create_wiki_page":
          return yield* (ctx.wikiService as unknown as { create(a: string, b: unknown): Effect.Effect<unknown, unknown> }).create(input.projectId, {
            title: str(args.title ?? ""),
            ...(args.slug !== undefined ? { slug: str(args.slug) } : {}),
            ...(args.content !== undefined ? { content: args.content as TipTapDoc } : {}),
            ...(args.parentId !== undefined ? { parentId: str(args.parentId) } : {}),
          });
        case "edit_wiki_page": {
          const page = yield* ctx.wikiRepo.findBySlug(input.projectId, str(args.slug ?? "")).pipe(Effect.catchTag("RowNotFound", () => new WikiPageNotFound({ id: str(args.slug ?? "") })));
          return yield* (ctx.wikiService as unknown as { update(a: string, b: unknown): Effect.Effect<unknown, unknown> }).update((page as unknown as { id: string }).id, {
            ...(args.title !== undefined ? { title: str(args.title) } : {}),
            ...(args.content !== undefined ? { content: JSON.stringify(args.content) } : {}),
          });
        }
        case "create_milestone":
          return yield* (ctx.milestoneService as unknown as { create(a: unknown): Effect.Effect<unknown, unknown> }).create({ projectId: input.projectId, name: str(args.name ?? ""), ...(args.dueAt !== undefined ? { dueAt: args.dueAt as string | null } : {}) });
        case "update_milestone":
          return yield* (ctx.milestoneService as unknown as { update(a: string, b: unknown): Effect.Effect<unknown, unknown> }).update(str(args.milestoneId ?? ""), { ...(args.name !== undefined ? { name: str(args.name) } : {}), ...(args.dueAt !== undefined ? { dueAt: args.dueAt as string | null } : {}) });
        case "archive_milestone":
          return yield* (ctx.milestoneService as unknown as { archive(a: Actor, b: string, c: unknown): Effect.Effect<unknown, unknown> }).archive(actor, str(args.milestoneId ?? ""), { viaAssistant: true });
        case "delete_milestone":
          return yield* (ctx.milestoneService as unknown as { delete(a: string): Effect.Effect<unknown, unknown> }).delete(str(args.milestoneId ?? ""));
        case "create_sprint":
          return yield* (ctx.swimlaneService as unknown as { create(a: unknown): Effect.Effect<unknown, unknown> }).create({ projectId: input.projectId, name: str(args.name ?? ""), ...(args.startAt !== undefined ? { startAt: args.startAt as string | null } : {}), ...(args.dueAt !== undefined ? { dueAt: args.dueAt as string | null } : {}), ...(args.milestoneId !== undefined ? { milestoneId: str(args.milestoneId) } : {}) });
        case "update_sprint":
          return yield* (ctx.swimlaneService as unknown as { update(a: string, b: unknown): Effect.Effect<unknown, unknown> }).update(str(args.swimlaneId ?? ""), { ...(args.name !== undefined ? { name: str(args.name) } : {}), ...(args.startAt !== undefined ? { startAt: args.startAt as string | null } : {}), ...(args.dueAt !== undefined ? { dueAt: args.dueAt as string | null } : {}) });
        case "archive_sprint":
          return yield* (ctx.swimlaneService as unknown as { archive(a: Actor, b: string): Effect.Effect<unknown, unknown> }).archive(actor, str(args.swimlaneId ?? ""));
        case "delete_sprint":
          return yield* (ctx.swimlaneService as unknown as { delete(a: string): Effect.Effect<unknown, unknown> }).delete(str(args.swimlaneId ?? ""));
        case "delete_wiki_page": {
          const page = yield* ctx.wikiRepo.findBySlug(input.projectId, str(args.slug ?? "")).pipe(Effect.catchTag("RowNotFound", () => new WikiPageNotFound({ id: str(args.slug ?? "") })));
          return yield* (ctx.wikiService as unknown as { delete(a: string): Effect.Effect<unknown, unknown> }).delete((page as unknown as { id: string }).id);
        }
        case "move_swimlane": {
          const swimlaneId = str(args.swimlaneId ?? "");
          const rawMilestone = args.milestoneId as string | null | undefined;
          const milestoneId = rawMilestone === null || rawMilestone === undefined ? null : str(rawMilestone);
          const svc = ctx.swimlaneService as unknown as { update(a: string, b: unknown): Effect.Effect<unknown, unknown>; move?: (a: string, b: string | null) => Effect.Effect<unknown, unknown> };
          if (svc.move) return yield* svc.move(swimlaneId, milestoneId);
          if (svc.update) return yield* svc.update(swimlaneId, { milestoneId });
          yield* Effect.promise(() => ctx.db.prepare(`UPDATE swimlanes SET milestone_id = ?, updated_at = datetime('now') WHERE id = ?`).run(milestoneId, swimlaneId));
          return undefined as unknown as never;
        }
        case "delete_task": {
          const refs = taskRefsFromArgs(args);
          if (refs.length <= 1) {
            const t = yield* resolveTaskRefRow(refs[0] ?? "");
            return yield* (ctx.taskService as unknown as { delete(a: Actor, b: string): Effect.Effect<unknown, unknown> }).delete(actor, (t as unknown as { id: string }).id);
          }
          return yield* runBulkTaskOp(refs, (id) => (ctx.taskService as unknown as { delete(a: Actor, b: string): Effect.Effect<unknown, unknown> }).delete(actor, id));
        }
      }
    });
    return applied;
  });

// Ask-path wrapper (unchanged behavior): parse the persisted args, run the
// shared apply, and record a failure on the pending row. The `FORBIDDEN`
// authz refusal still maps through `errorCodeMap` to the same string the
// baseline produced.
export const executeAssistantWrite = (row: AssistantPendingWriteRow, ctx: AssistantWriteExecutionCtx) =>
  Effect.gen(function* () {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(row.args) as Record<string, unknown>;
    } catch {
      args = {};
    }
    const outcome = yield* applyAssistantWrite(
      {
        toolName: row.tool_name as AssistantWriteToolName,
        args,
        projectId: row.project_id,
        ownerUserId: row.owner_user_id,
      },
      ctx
    ).pipe(Effect.either);
    if (outcome._tag === "Left") {
      const err = outcome.left as { _tag?: string; message?: string };
      const code = errorCodeMap[err._tag ?? ""] ?? "ASSISTANT_WRITE_FAILED";
      const message = `${code}: ${str(err.message ?? "write failed")}`.slice(0, 2000);
      yield* ctx.pendingWritesRepo.markExecutionError(row.id, message);
      return { approvalId: row.id, ok: false as const, error: message };
    }
    return { approvalId: row.id, ok: true as const, result: outcome.right };
  });
