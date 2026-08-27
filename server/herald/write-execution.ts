import { Effect } from "effect";
import { InvalidArgs, TaskNotFound, WikiPageNotFound, errorCodeMap } from "../api/errors";
import type { HeraldPendingWriteRow } from "../repos/herald-pending-writes.repo";
import type { HeraldWriteToolName } from "./write-tools";
import type { TipTapDoc, Actor } from "../../shared/types";
import type { Sqlite } from "../db/database";
import type { TaskRepo } from "../repos/task.repo";
import type { WikiRepo } from "../repos/wiki.repo";
import type { HeraldPendingWritesRepo } from "../repos/herald-pending-writes.repo";
import type { TaskService } from "../services/task.service";
import type { CommentService } from "../services/comment.service";
import type { WikiService } from "../services/wiki.service";
import type { MilestoneService } from "../services/milestone.service";
import type { SwimlaneService } from "../services/swimlane.service";
import type { AuthorizationService } from "../services/authorization.service";

export type HeraldWriteExecutionCtx = {
  db: Sqlite;
  taskService: TaskService;
  commentService: CommentService;
  wikiService: WikiService;
  milestoneService: MilestoneService;
  swimlaneService: SwimlaneService;
  authz: AuthorizationService;
  pendingWritesRepo: HeraldPendingWritesRepo;
  taskRepo: TaskRepo;
  wikiRepo: WikiRepo;
};

const heraldActor = (ownerUserId: string): Actor => ({ kind: "agent", label: "herald", userId: ownerUserId });
const str = (v: unknown): string => String(v);

export const executeHeraldWrite = (row: HeraldPendingWriteRow, ctx: HeraldWriteExecutionCtx) =>
  Effect.gen(function* () {
    const access = yield* ctx.authz.projectAccess(row.owner_user_id, row.project_id);
    if (access === null) {
      const message = "FORBIDDEN: Write denied: insufficient permissions.";
      yield* ctx.pendingWritesRepo.markExecutionError(row.id, message);
      return { approvalId: row.id, ok: false as const, error: message };
    }
    const actor = heraldActor(row.owner_user_id);
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(row.args) as Record<string, unknown>;
    } catch {
      args = {};
    }
    const resolveTaskRefRow = (ref: string) =>
      ctx.taskRepo.findById(ref).pipe(Effect.orElse(() => ctx.taskRepo.findByKey(ref)), Effect.catchTag("RowNotFound", () => new TaskNotFound({ id: ref })));
    const applied = yield* Effect.gen(function* () {
      switch (row.tool_name as HeraldWriteToolName) {
        case "create_task": {
          const first = (ctx.db as unknown as { prepare(sql: string): { get(...a: unknown[]): unknown } }).prepare(
            `SELECT id FROM columns WHERE project_id = ? ORDER BY position ASC LIMIT 1`
          ).get(row.project_id) as { id: string } | undefined;
          if (!first) return yield* new InvalidArgs({ reason: "project has no columns" });
          return yield* (ctx.taskService as unknown as { create(a: Actor, b: unknown, c: unknown): Effect.Effect<unknown, unknown> }).create(
            actor,
            {
              projectId: row.project_id,
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
            { viaHerald: true }
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
            { viaHerald: true }
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
            { viaHerald: true }
          );
        }
        case "archive_task": {
          const t = yield* resolveTaskRefRow(str(args.ref ?? ""));
          return yield* (ctx.taskService as unknown as { archive(a: Actor, b: string, c: unknown): Effect.Effect<unknown, unknown> }).archive(actor, (t as unknown as { id: string }).id, { viaHerald: true });
        }
        case "restore_task": {
          const t = yield* resolveTaskRefRow(str(args.ref ?? ""));
          return yield* (ctx.taskService as unknown as { restore(a: Actor, b: string, c: unknown): Effect.Effect<unknown, unknown> }).restore(actor, (t as unknown as { id: string }).id, { viaHerald: true });
        }
        case "add_comment": {
          const t = yield* resolveTaskRefRow(str(args.ref ?? ""));
          return yield* (ctx.commentService as unknown as { create(a: string, b: Actor, c: TipTapDoc, d: unknown): Effect.Effect<unknown, unknown> }).create((t as unknown as { id: string }).id, actor, args.body as TipTapDoc, { viaHerald: true });
        }
        case "create_wiki_page":
          return yield* (ctx.wikiService as unknown as { create(a: string, b: unknown): Effect.Effect<unknown, unknown> }).create(row.project_id, {
            title: str(args.title ?? ""),
            ...(args.slug !== undefined ? { slug: str(args.slug) } : {}),
            ...(args.content !== undefined ? { content: args.content as TipTapDoc } : {}),
            ...(args.parentId !== undefined ? { parentId: str(args.parentId) } : {}),
          });
        case "edit_wiki_page": {
          const page = yield* ctx.wikiRepo.findBySlug(row.project_id, str(args.slug ?? "")).pipe(Effect.catchTag("RowNotFound", () => new WikiPageNotFound({ id: str(args.slug ?? "") })));
          return yield* (ctx.wikiService as unknown as { update(a: string, b: unknown): Effect.Effect<unknown, unknown> }).update((page as unknown as { id: string }).id, {
            ...(args.title !== undefined ? { title: str(args.title) } : {}),
            ...(args.content !== undefined ? { content: JSON.stringify(args.content) } : {}),
          });
        }
        case "create_milestone":
          return yield* (ctx.milestoneService as unknown as { create(a: unknown): Effect.Effect<unknown, unknown> }).create({ projectId: row.project_id, name: str(args.name ?? ""), ...(args.dueAt !== undefined ? { dueAt: args.dueAt as string | null } : {}) });
        case "update_milestone":
          return yield* (ctx.milestoneService as unknown as { update(a: string, b: unknown): Effect.Effect<unknown, unknown> }).update(str(args.milestoneId ?? ""), { ...(args.name !== undefined ? { name: str(args.name) } : {}), ...(args.dueAt !== undefined ? { dueAt: args.dueAt as string | null } : {}) });
        case "archive_milestone":
          return yield* (ctx.milestoneService as unknown as { archive(a: Actor, b: string, c: unknown): Effect.Effect<unknown, unknown> }).archive(actor, str(args.milestoneId ?? ""), { viaHerald: true });
        case "create_sprint":
          return yield* (ctx.swimlaneService as unknown as { create(a: unknown): Effect.Effect<unknown, unknown> }).create({ projectId: row.project_id, name: str(args.name ?? ""), ...(args.startAt !== undefined ? { startAt: args.startAt as string | null } : {}), ...(args.dueAt !== undefined ? { dueAt: args.dueAt as string | null } : {}), ...(args.milestoneId !== undefined ? { milestoneId: str(args.milestoneId) } : {}) });
        case "update_sprint":
          return yield* (ctx.swimlaneService as unknown as { update(a: string, b: unknown): Effect.Effect<unknown, unknown> }).update(str(args.swimlaneId ?? ""), { ...(args.name !== undefined ? { name: str(args.name) } : {}), ...(args.startAt !== undefined ? { startAt: args.startAt as string | null } : {}), ...(args.dueAt !== undefined ? { dueAt: args.dueAt as string | null } : {}) });
      }
    }).pipe(Effect.either);
    if (applied._tag === "Left") {
      const err = applied.left as { _tag?: string; message?: string };
      const code = errorCodeMap[err._tag ?? ""] ?? "HERALD_WRITE_FAILED";
      const message = `${code}: ${str(err.message ?? "write failed")}`.slice(0, 2000);
      yield* ctx.pendingWritesRepo.markExecutionError(row.id, message);
      return { approvalId: row.id, ok: false as const, error: message };
    }
    return { approvalId: row.id, ok: true as const };
  });
