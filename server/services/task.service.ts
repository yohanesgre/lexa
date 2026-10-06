import { Effect } from "effect";
import { TaskRepo, TaskFilters } from "../repos/task.repo";
import { ProjectRepo } from "../repos/project.repo";
import { ColumnRepo } from "../repos/column.repo";
import { SwimlaneRepo } from "../repos/swimlane.repo";
import { FieldConfigRepo } from "../repos/field-config.repo";
import { ConstraintViolation, DbError, RowNotFound, Db, withTx, run, batch, type BatchStmt } from "../db/db";
import { keyAfter } from "../../shared/positions";
import { keyBetween } from "../../shared/positions";
import { isEmptyDoc } from "../../shared/tiptap-text";
import {
  TaskNotFound,
  TaskHasChildren,
  ProjectNotFound,
  ColumnNotFound,
  SwimlaneNotFound,
  RequiredFieldMissing,
  WipLimitExceeded,
  NeighborNotInColumn,
  InvalidOption,
  DeadlineAfterLane,
  InvalidArgs,
  errorCodeMap,
  errorMessage,
} from "../api/errors";
import { ActivityService } from "./activity.service";
import * as msg from "../activity-messages";
import {
  buildActivityStmts,
  buildPlainMoveStmts,
  buildTaskArchiveBatch,
  buildTaskCreateBatch,
  buildTaskDeleteBatch,
  buildTaskUpdateBatch,
  buildUnlinkBatch,
  buildWebhookMoveAndEmitBatch,
  buildWipMoveStmt,
  type ActivityInput,
} from "../repos/task-batch";
import type { Task, Column, Swimlane, TipTapDoc, Actor, ActivityEvent, ActivityType, FieldOption } from "../../shared/types";

// Re-exported for callers that historically imported it from this module; the
// single implementation lives in shared (invariant 10 parity).
export { isEmptyDoc };

// Hard request cap for POST /projects/:slug/tasks/bulk — an oversized batch is
// refused with InvalidArgs (422) before any write.
export const BULK_TASK_ID_CAP = 100;

function validateRequiredFields(
  taskLike: Record<string, unknown>,
  column: Column
): Effect.Effect<void, RequiredFieldMissing> {
  for (const field of column.requiredFields) {
    let empty = false;
    if (field === "description") {
      empty = isEmptyDoc(taskLike.description as TipTapDoc);
    } else if (field === "assignee") {
      empty = !taskLike.assignees || (taskLike.assignees as string[]).length === 0;
    } else {
      empty = !taskLike[field];
    }
    if (empty) return Effect.fail(new RequiredFieldMissing({ field, columnName: column.name }));
  }
  return Effect.void;
}

function asInput(actor: Actor, type: string, message: string, viaAssistant: boolean): ActivityInput {
  return {
    actorKind: actor.kind,
    actorLabel: actor.label,
    actorUserId: actor.userId ?? null,
    type,
    message,
    viaAssistant,
  };
}

// Per-request lookups shared by the single-task methods (empty caches) and the
// bulk loop (project columns/lanes prefetched once, option lists memoized).
// Repos stay thin — the batching logic lives in the service.
interface TaskCtx {
  task: Task;
  columns: Map<string, Column> | undefined;
  lanes: Map<string, Swimlane> | undefined;
  priorities: () => Effect.Effect<FieldOption[], DbError>;
  types: () => Effect.Effect<FieldOption[], DbError>;
}

export class TaskService extends Effect.Service<TaskService>()("Lexa/TaskService", {
  dependencies: [TaskRepo.Default, ProjectRepo.Default, ColumnRepo.Default, SwimlaneRepo.Default, FieldConfigRepo.Default, ActivityService.Default],
  effect: Effect.gen(function* () {
    const taskRepo = yield* TaskRepo;
    const projectRepo = yield* ProjectRepo;
    const columnRepo = yield* ColumnRepo;
    const swimlaneRepo = yield* SwimlaneRepo;
    const fieldConfigRepo = yield* FieldConfigRepo;
    const activityService = yield* ActivityService;
    const db = yield* Db;

    const resolveOption = (
      projectId: string,
      kind: "priority" | "type",
      value?: string
    ): Effect.Effect<string, InvalidOption | DbError> =>
      Effect.gen(function* () {
        if (value !== undefined && value !== "") return value;
        const first = kind === "priority"
          ? yield* fieldConfigRepo.findFirstPriority(projectId)
          : yield* fieldConfigRepo.findTypesByProject(projectId).pipe(
              Effect.map((opts) => opts[0] ?? null)
            );
        if (!first) return yield* new InvalidOption({ message: `project has no ${kind} options configured` });
        return first.id;
      });

    const validateOption = (
      projectId: string,
      kind: "priority" | "type",
      value: string
    ): Effect.Effect<void, InvalidOption | DbError> =>
      Effect.gen(function* () {
        const options = kind === "priority"
          ? yield* fieldConfigRepo.findPrioritiesByProject(projectId)
          : yield* fieldConfigRepo.findTypesByProject(projectId);
        if (!options.some((o) => o.id === value)) {
          return yield* new InvalidOption({ optionId: value, message: `unknown ${kind} option for this project` });
        }
      });

    const memoOptions = (
      fetch: () => Effect.Effect<FieldOption[], DbError>
    ): (() => Effect.Effect<FieldOption[], DbError>) => {
      let cached: FieldOption[] | null = null;
      return () => {
        if (cached !== null) return Effect.succeed(cached);
        return fetch().pipe(Effect.map((rows) => { cached = rows; return rows; }));
      };
    };

    const ctxColumn = (ctx: TaskCtx, id: string): Effect.Effect<Column, RowNotFound | DbError> => {
      const cached = ctx.columns?.get(id);
      return cached !== undefined ? Effect.succeed(cached) : columnRepo.findById(id);
    };

    const ctxLane = (ctx: TaskCtx, id: string): Effect.Effect<Swimlane, RowNotFound | DbError> => {
      const cached = ctx.lanes?.get(id);
      return cached !== undefined ? Effect.succeed(cached) : swimlaneRepo.findById(id);
    };

    const singleCtx = (task: Task): TaskCtx => ({
      task,
      columns: undefined,
      lanes: undefined,
      priorities: () => fieldConfigRepo.findPrioritiesByProject(task.projectId),
      types: () => fieldConfigRepo.findTypesByProject(task.projectId),
    });

    // Update plan: validations + the diff-derived activity rows + the write
    // statements. Shared verbatim by the single-task update (empty cache,
    // read-back after) and the bulk loop (prefetched task/lookups, no read-back).
    const planUpdate = (
      ctx: TaskCtx,
      actor: Actor,
      input: {
        title?: string;
        description?: TipTapDoc;
        priority?: string;
        type?: string;
        assignees?: string[];
        dueAt?: string | null;
      },
      viaAssistant: boolean
    ): Effect.Effect<
      { stmts: BatchStmt[]; activityCount: number },
      ColumnNotFound | SwimlaneNotFound | RequiredFieldMissing | InvalidOption | DeadlineAfterLane | DbError | RowNotFound
    > =>
      Effect.gen(function* () {
        const task = ctx.task;
        const column = yield* ctxColumn(ctx, task.columnId).pipe(
          Effect.catchTag("RowNotFound", () => new ColumnNotFound({ id: task.columnId }))
        );
        if (input.dueAt !== undefined && input.dueAt !== null) {
          const lane = yield* ctxLane(ctx, task.swimlaneId).pipe(
            Effect.catchTag("RowNotFound", () => new SwimlaneNotFound({ id: task.swimlaneId }))
          );
          if (lane.dueAt && input.dueAt > lane.dueAt)
            return yield* new DeadlineAfterLane({ date: lane.dueAt });
        }
        const priority = input.priority !== undefined ? input.priority : task.priority;
        const type = input.type !== undefined ? input.type : task.type;
        if (input.priority !== undefined) {
          const options = yield* ctx.priorities();
          if (!options.some((o) => o.id === input.priority)) {
            return yield* new InvalidOption({ optionId: input.priority, message: `unknown priority option for this project` });
          }
        }
        if (input.type !== undefined) {
          const options = yield* ctx.types();
          if (!options.some((o) => o.id === input.type)) {
            return yield* new InvalidOption({ optionId: input.type, message: `unknown type option for this project` });
          }
        }
        const merged = {
          title: input.title ?? task.title,
          description: input.description ?? task.description,
          priority,
          type,
          assignees: input.assignees !== undefined ? input.assignees : task.assignees,
        };
        yield* validateRequiredFields(merged as Record<string, unknown>, column);

        // Diff against the pre-update row — only real changes emit rows
        // (messages are frozen at write time with option LABELS, not ids).
        const rows: ActivityInput[] = [];
        if (input.title !== undefined && input.title !== task.title) {
          rows.push(asInput(actor, "field_changed", msg.titleChanged(actor.label), viaAssistant));
        }
        if (input.description !== undefined && JSON.stringify(input.description) !== JSON.stringify(task.description)) {
          rows.push(asInput(actor, "field_changed", msg.descriptionUpdated(actor.label), viaAssistant));
        }
        if (input.priority !== undefined && input.priority !== task.priority) {
          const opts = yield* ctx.priorities();
          const label = (optionId: string) => opts.find((o) => o.id === optionId)?.label ?? optionId;
          rows.push(asInput(actor, "field_changed", msg.priorityChanged(label(task.priority), label(input.priority)), viaAssistant));
        }
        if (input.type !== undefined && input.type !== task.type) {
          const opts = yield* ctx.types();
          const label = (optionId: string) => opts.find((o) => o.id === optionId)?.label ?? optionId;
          rows.push(asInput(actor, "field_changed", msg.typeChanged(label(task.type), label(input.type)), viaAssistant));
        }
        if (input.assignees !== undefined && input.assignees.toSorted().join("\u0000") !== task.assignees.toSorted().join("\u0000")) {
          rows.push(asInput(actor, "field_changed", msg.assigneesUpdated(actor.label), viaAssistant));
        }
        if (input.dueAt !== undefined && input.dueAt !== task.dueAt) {
          rows.push(asInput(actor, "field_changed", msg.dueDateChanged(task.dueAt ?? null, input.dueAt ?? null), viaAssistant));
        }
        const stmts: BatchStmt[] = buildTaskUpdateBatch({
          id: task.id,
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.description !== undefined ? { description: JSON.stringify(input.description) } : {}),
          ...(input.priority !== undefined ? { priority: input.priority } : {}),
          ...(input.type !== undefined ? { type: input.type } : {}),
          ...(input.assignees !== undefined ? { replaceAssignees: input.assignees } : {}),
          ...(input.dueAt !== undefined ? { dueAt: input.dueAt } : {}),
          activity: rows,
        });
        return { stmts, activityCount: rows.length };
      });

    // Move core: all the writes for one task (WIP conditional UPDATE, subtask
    // cascade, emission rows) with the retry-once-on-position-conflict
    // semantics (invariant #4) — but NO response read-back. The single-task
    // move wraps it in withTx + read-back + activity read; the bulk loop wraps
    // it in a per-item withTx only. `ctx` supplies the task row and the
    // prefetched column/lane lookups so neither path re-reads per id.
    const runMoveCore = (
      ctx: TaskCtx,
      actor: Actor,
      target: MoveTarget,
      opts?: { bypassGuards?: boolean; viaAssistant?: boolean }
    ): Effect.Effect<
      { activityCount: number; noop: boolean },
      ColumnNotFound | SwimlaneNotFound | RequiredFieldMissing | WipLimitExceeded | NeighborNotInColumn | DeadlineAfterLane | DbError | ConstraintViolation | RowNotFound
    > =>
      Effect.gen(function* () {
        const task = ctx.task;
        const taskId = task.id;
        const column = yield* ctxColumn(ctx, target.columnId).pipe(
          Effect.catchTag("RowNotFound", () => new ColumnNotFound({ id: target.columnId }))
        );
        if (column.projectId !== task.projectId)
          return yield* new ColumnNotFound({ id: target.columnId });
        if (target.swimlaneId) {
          const lane = yield* ctxLane(ctx, target.swimlaneId).pipe(
            Effect.catchTag("RowNotFound", () => new SwimlaneNotFound({ id: target.swimlaneId! }))
          );
          if (lane.projectId !== task.projectId)
            return yield* new SwimlaneNotFound({ id: target.swimlaneId! });
          if (lane.archivedAt)
            return yield* new SwimlaneNotFound({ id: target.swimlaneId!, availableSwimlanes: [] });
          if (task.dueAt && lane.dueAt && task.dueAt > lane.dueAt && !target.clearDueAt)
            return yield* new DeadlineAfterLane({ date: lane.dueAt });
        }

        if (
          task.columnId === target.columnId &&
          (target.swimlaneId === undefined || target.swimlaneId === task.swimlaneId) &&
          !target.beforeTaskId &&
          !target.afterTaskId &&
          !target.clearDueAt
        )
          return { activityCount: 0, noop: true };

        if (!opts?.bypassGuards) {
          const taskLike = {
            title: task.title,
            description: task.description,
            priority: task.priority,
            type: task.type,
            assignees: task.assignees,
          };
          yield* validateRequiredFields(taskLike as Record<string, unknown>, column);
        }

        const computePosition = Effect.gen(function* () {
          if (target.beforeTaskId || target.afterTaskId) {
            const [before, after] = yield* Effect.all([
              target.beforeTaskId ? taskRepo.findById(target.beforeTaskId) : Effect.succeed(null),
              target.afterTaskId ? taskRepo.findById(target.afterTaskId) : Effect.succeed(null),
            ]);
            for (const n of [before, after])
              if (n && n.columnId !== target.columnId)
                return yield* new NeighborNotInColumn({ taskId: n.id });
            return keyBetween(before?.position ?? null, after?.position ?? null);
          }
          const last = yield* taskRepo.findLastInColumn(task.projectId, target.columnId).pipe(
            Effect.catchTag("RowNotFound", () => Effect.succeed(null))
          );
          return keyAfter(last?.position ?? null);
        });

        const bypassWip = opts?.bypassGuards ?? false;

        // Old/new names for the moved message — captured before the move
        // (frozen at write time). Served from the prefetched maps in bulk.
        const oldCol = yield* ctxColumn(ctx, task.columnId).pipe(
          Effect.catchTag("RowNotFound", () => Effect.succeed({ name: task.columnId } as Column))
        );
        const oldLane = task.swimlaneId
          ? yield* ctxLane(ctx, task.swimlaneId).pipe(
              Effect.catchTag("RowNotFound", () => Effect.succeed(null))
            )
          : null;
        const resolvedSwimlane = target.swimlaneId !== undefined ? target.swimlaneId : task.swimlaneId;
        const newLane = resolvedSwimlane === task.swimlaneId
          ? oldLane
          : yield* ctxLane(ctx, resolvedSwimlane).pipe(
              Effect.catchTag("RowNotFound", () => Effect.succeed(null))
            );

        const movedActivity = () => asInput(actor, "moved", msg.moved(
          actor.label, oldCol.name, column.name, oldLane?.name ?? null, newLane?.name ?? null
        ), opts?.viaAssistant === true);

        const doMoveWithCascade = Effect.gen(function* () {
          const position = yield* computePosition;
          const moveStmt = bypassWip
            ? buildPlainMoveStmts([{
                taskId,
                columnId: target.columnId,
                swimlaneId: resolvedSwimlane,
                position,
                clearDueAt: target.clearDueAt ?? false,
              }])[0]!
            : buildWipMoveStmt({
                taskId,
                projectId: task.projectId,
                columnId: target.columnId,
                swimlaneId: resolvedSwimlane,
                position,
                clearDueAt: target.clearDueAt ?? false,
              });
          const changes = yield* run(db, moveStmt.sql, ...moveStmt.params);
          if (changes === 0) {
            const count = yield* taskRepo.countByColumn(task.projectId, target.columnId);
            return yield* new WipLimitExceeded({ columnName: column.name, limit: column.wipLimit ?? 0, current: count });
          }
          // Cascade: when a parent moves, its subtasks follow (same column,
          // appended after the parent's new position). Child positions are
          // chained in JS — no reads — so they join the same batch.
          const columnChanged = target.columnId !== task.columnId;
          const laneChanged = resolvedSwimlane !== task.swimlaneId;
          const childMoves: { taskId: string; columnId: string; swimlaneId: string; position: string }[] = [];
          if (columnChanged || laneChanged) {
            const children = yield* taskRepo.findSubtasks(taskId);
            let childPos = position;
            for (const child of children) {
              childPos = keyAfter(childPos);
              childMoves.push({
                taskId: child.id,
                columnId: target.columnId,
                swimlaneId: resolvedSwimlane,
                position: childPos,
              });
            }
          }
          // Column OR lane change emits; position-only reorders don't. A
          // clearDueAt that actually clears a due date also emits.
          const emitMoved = columnChanged || laneChanged;
          const dueCleared = (target.clearDueAt ?? false) && task.dueAt !== null;
          const rows: ActivityInput[] = [];
          if (emitMoved) rows.push(movedActivity());
          if (dueCleared) rows.push(asInput(actor, "field_changed", msg.dueDateChanged(task.dueAt, null), opts?.viaAssistant === true));
          const rest = [
            ...buildPlainMoveStmts(childMoves),
            ...buildActivityStmts(taskId, rows),
          ];
          if (rest.length > 0) yield* batch(db, rest);
          return { activityCount: rows.length, noop: false };
        });

        // One retry closure for the WHOLE move — anchors and child list are
        // re-read inside it, so a position conflict retries the parent AND
        // its children (invariant #4).
        return yield* doMoveWithCascade.pipe(
          Effect.catchIf(
            (e) => e instanceof ConstraintViolation && e.isPositionConflict,
            () => doMoveWithCascade
          )
        );
      });

    const service = {
      create: (actor: Actor, input: {
        projectId: string;
        columnId: string;
        swimlaneId?: string | null;
        title: string;
        description?: TipTapDoc;
        priority?: string;
        type?: string;
        assignees?: string[];
        parentId?: string;            // create as subtask of this task
        dueAt?: string | null;
      }, opts?: { viaAssistant?: boolean }): Effect.Effect<{ task: Task; activity: ActivityEvent[] }, ProjectNotFound | ColumnNotFound | SwimlaneNotFound | TaskNotFound | RequiredFieldMissing | InvalidOption | DeadlineAfterLane | ConstraintViolation | DbError | RowNotFound> =>
        Effect.gen(function* () {
          const project = yield* projectRepo.findById(input.projectId).pipe(
            Effect.catchTag("RowNotFound", () => new ProjectNotFound({ identifier: input.projectId }))
          );

          // Subtask: inherit the parent's column/swimlane.
          let parent: Task | null = null;
          let columnId = input.columnId;
          let swimlaneId = input.swimlaneId;
          if (input.parentId) {
            const parentId = input.parentId;
            parent = yield* taskRepo.findById(parentId).pipe(
              Effect.catchTag("RowNotFound", () => new TaskNotFound({ id: parentId }))
            );
            if (parent.projectId !== project.id) {
              return yield* new TaskNotFound({ id: parentId });
            }
            columnId = parent.columnId;
            swimlaneId = parent.swimlaneId;
          }

          const column = yield* columnRepo.findById(columnId).pipe(
            Effect.catchTag("RowNotFound", () => new ColumnNotFound({ id: columnId }))
          );
          if (column.projectId !== project.id) {
            return yield* new ColumnNotFound({ id: columnId });
          }

          const lane = swimlaneId
            ? yield* swimlaneRepo.findById(swimlaneId).pipe(
                Effect.catchTag("RowNotFound", () => new SwimlaneNotFound({ id: swimlaneId! }))
              )
            : yield* swimlaneRepo.findBacklog(project.id).pipe(
                Effect.catchTag("RowNotFound", () => new SwimlaneNotFound({ id: "backlog", availableSwimlanes: [] }))
              );
          if (lane.projectId !== project.id) {
            return yield* new SwimlaneNotFound({ id: swimlaneId ?? "backlog" });
          }
          if (lane.archivedAt) {
            return yield* new SwimlaneNotFound({ id: lane.id, availableSwimlanes: [] });
          }
          if (input.dueAt && lane.dueAt && input.dueAt > lane.dueAt)
            return yield* new DeadlineAfterLane({ date: lane.dueAt });
          swimlaneId = lane.id;
          const desc = input.description ?? { type: "doc" as const, content: [] as unknown[] };
          const priority = yield* resolveOption(project.id, "priority", input.priority);
          const type = yield* resolveOption(project.id, "type", input.type);
          yield* validateOption(project.id, "priority", priority);
          yield* validateOption(project.id, "type", type);
          const taskLike = {
            title: input.title,
            description: desc,
            priority,
            type,
            assignees: input.assignees ?? [],
          };
          yield* validateRequiredFields(taskLike as Record<string, unknown>, column);

          const doInsert = Effect.gen(function* () {
            const last = yield* taskRepo.findLastInColumn(input.projectId, columnId).pipe(
              Effect.catchTag("RowNotFound", () => Effect.succeed(null))
            );
            const position = keyAfter(last?.position ?? null);
            const taskId = crypto.randomUUID();
            yield* batch(db, buildTaskCreateBatch({
              id: taskId,
              projectId: input.projectId,
              columnId,
              swimlaneId,
              title: input.title,
              description: JSON.stringify(desc),
              priority,
              type,
              position,
              dueAt: input.dueAt ?? null,
              projectKey: project.key,
              assignees: input.assignees ?? [],
              ...(parent ? { subtaskOfParentId: parent.id } : {}),
              activity: [asInput(actor, "created", msg.created(actor.label), opts?.viaAssistant === true)],
            }));
            return yield* taskRepo.findById(taskId).pipe(
              Effect.catchTag("RowNotFound", () => new ProjectNotFound({ identifier: input.projectId }))
            );
          });

          const task = yield* doInsert.pipe(
            Effect.catchIf(
              (e) => e instanceof ConstraintViolation && e.isPositionConflict,
              () => doInsert
            )
          );
          // The activity read-back runs AFTER the batch commits: on Bun a
          // read-back failure no longer rolls back the create (D1 always
          // behaved this way — no request-level transaction).
          const activity = yield* activityService.listLatest(task.id, 1);
          yield* Effect.logInfo(`[Task] Created ${task.id} in column ${task.columnId} project ${task.projectId}`);
          return { task, activity };
        }),

      getById: (id: string): Effect.Effect<Task, TaskNotFound | DbError> =>
        taskRepo.findById(id).pipe(Effect.catchTag("RowNotFound", () => new TaskNotFound({ id }))),

      findByProject: (
        projectId: string,
        filters?: { columnId?: string; swimlaneId?: string; assignee?: string; type?: string; includeArchived?: boolean },
        limit?: number,
        cursor?: string
      ): Effect.Effect<{ tasks: Task[]; hasMore: boolean }, ProjectNotFound | DbError> =>
        Effect.gen(function* () {
          yield* projectRepo.findById(projectId).pipe(
            Effect.catchTag("RowNotFound", () => new ProjectNotFound({ identifier: projectId }))
          );
          return yield* taskRepo.findByProject(projectId, filters, limit, cursor);
        }),

      findAllByProject: (
        projectId: string,
        filters?: { columnId?: string; swimlaneId?: string; assignee?: string; type?: string; includeArchived?: boolean }
      ): Effect.Effect<Task[], ProjectNotFound | DbError> =>
        Effect.gen(function* () {
          yield* projectRepo.findById(projectId).pipe(
            Effect.catchTag("RowNotFound", () => new ProjectNotFound({ identifier: projectId }))
          );
          return yield* taskRepo.findAllByProject(projectId, filters);
        }),

      update: (
        actor: Actor,
        id: string,
        input: {
          title?: string;
          description?: TipTapDoc;
          priority?: string;
          type?: string;
          assignees?: string[];
          dueAt?: string | null;
        },
        opts?: { viaAssistant?: boolean }
      ): Effect.Effect<{ task: Task; activity: ActivityEvent[] }, TaskNotFound | ColumnNotFound | SwimlaneNotFound | RequiredFieldMissing | InvalidOption | DeadlineAfterLane | ConstraintViolation | DbError | RowNotFound> =>
        Effect.gen(function* () {
          const task = yield* taskRepo.findById(id).pipe(
            Effect.catchTag("RowNotFound", () => new TaskNotFound({ id }))
          );
          const plan = yield* planUpdate(singleCtx(task), actor, input, opts?.viaAssistant === true);
          if (plan.stmts.length > 0) yield* batch(db, plan.stmts);
          const updated = yield* taskRepo.findById(id).pipe(
            Effect.catchTag("RowNotFound", () => new TaskNotFound({ id }))
          );
          const activity = plan.activityCount === 0 ? [] : yield* activityService.listLatest(id, plan.activityCount);
          yield* Effect.logInfo(`[Task] Updated ${updated.id}`);
          return { task: updated, activity };
        }),

      move: (actor: Actor, taskId: string, target: MoveTarget, opts?: { bypassGuards?: boolean; viaAssistant?: boolean }): Effect.Effect<{ task: Task; activity: ActivityEvent[] }, TaskNotFound | ColumnNotFound | SwimlaneNotFound | RequiredFieldMissing | WipLimitExceeded | NeighborNotInColumn | DeadlineAfterLane | DbError | ConstraintViolation | RowNotFound> =>
        Effect.gen(function* () {
          const task = yield* taskRepo.findById(taskId).pipe(
            Effect.catchTag("RowNotFound", () => new TaskNotFound({ id: taskId }))
          );
          const moved = yield* withTx(
            db,
            Effect.gen(function* () {
              const r = yield* runMoveCore(singleCtx(task), actor, target, opts);
              if (r.noop) return { task, activity: [] as ActivityEvent[] };
              const m = yield* taskRepo.findById(taskId).pipe(
                Effect.catchTag("RowNotFound", () => new TaskNotFound({ id: taskId }))
              );
              const activity = r.activityCount > 0 ? yield* activityService.listLatest(taskId, r.activityCount) : [] as ActivityEvent[];
              return { task: m, activity };
            })
          );

          yield* Effect.logInfo(`[Task] Moved ${moved.task.id} column=${moved.task.columnId} swimlane=${moved.task.swimlaneId} pos=${moved.task.position}`);
          return moved;
        }),

      moveFromWebhook: (issueId: string, columnId: string, syncedState: "open" | "closed"): Effect.Effect<Task, TaskNotFound | ColumnNotFound | DbError | ConstraintViolation | RowNotFound> =>
        Effect.gen(function* () {
          const task = yield* taskRepo.findByGithubIssue(issueId).pipe(
            Effect.catchTag("RowNotFound", () => new TaskNotFound({ id: issueId }))
          );
          if (task.archivedAt) return task;
          const column = yield* columnRepo.findById(columnId).pipe(
            Effect.catchTag("RowNotFound", () => new ColumnNotFound({ id: columnId }))
          );
          // Webhook moves bypass guards; the move + synced-state write +
          // github_synced activity row run as ONE pre-computed batch —
          // atomic on both drivers (invariant #2/#3). Neighborless moves
          // append to end (invariant #4); retry-once re-reads the anchor.
          const doWebhookMove = Effect.gen(function* () {
            const last = yield* taskRepo.findLastInColumn(task.projectId, columnId).pipe(
              Effect.catchTag("RowNotFound", () => Effect.succeed(null))
            );
            const position = keyAfter(last?.position ?? null);
            const issue = task.githubs.find((g) => g.issueId === issueId);
            yield* batch(db, buildWebhookMoveAndEmitBatch({
              taskId: task.id,
              issueId,
              columnId,
              swimlaneId: task.swimlaneId,
              position,
              syncedState,
              activity: issue
                ? asInput(WEBHOOK_ACTOR, "github_synced", msg.githubSynced(issue.issueNumber, syncedState, column.name), false)
                : null,
            }));
            return yield* taskRepo.findById(task.id).pipe(
              Effect.catchTag("RowNotFound", () => new TaskNotFound({ id: issueId }))
            );
          });
          const webhookMoved = yield* withTx(db, doWebhookMove.pipe(
            Effect.catchIf(
              (e) => e instanceof ConstraintViolation && e.isPositionConflict,
              () => doWebhookMove
            )
          ));
          yield* Effect.logInfo(`[Task] Webhook-moved ${webhookMoved.id} column=${webhookMoved.columnId}`);
          return webhookMoved;
        }),

      delete: (actor: Actor, id: string): Effect.Effect<void, TaskNotFound | TaskHasChildren | DbError | ConstraintViolation> =>
        Effect.gen(function* () {
          yield* taskRepo.findById(id).pipe(Effect.catchTag("RowNotFound", () => new TaskNotFound({ id })));
          // The batch is a single DELETE: task_activity rows cascade with the
          // task (FK ON DELETE CASCADE), so a failing delete (children) leaves
          // nothing removed — the batch is atomic on both drivers.
          yield* batch(db, buildTaskDeleteBatch({
            taskId: id,
          })).pipe(
            Effect.catchTag("ConstraintViolation", () => new TaskHasChildren({ taskId: id }))
          );
          yield* Effect.logInfo(`[Task] Deleted ${id}`);
          return undefined;
        }),

      archive: (actor: Actor, id: string, opts?: { viaAssistant?: boolean }): Effect.Effect<{ task: Task; activity: ActivityEvent[] }, TaskNotFound | RowNotFound | DbError | ConstraintViolation> =>
        Effect.gen(function* () {
          const task = yield* taskRepo.findById(id).pipe(
            Effect.catchTag("RowNotFound", () => new TaskNotFound({ id }))
          );
          if (task.archivedAt) return { task, activity: [] };
          const archivedAt = new Date().toISOString();
          const archived = yield* Effect.gen(function* () {
            yield* batch(db, buildTaskArchiveBatch({
              taskId: id,
              archivedAt,
              activity: asInput(actor, "archived", msg.archived(actor.label), opts?.viaAssistant === true),
            }));
            const a = yield* taskRepo.findById(id).pipe(
              Effect.catchTag("RowNotFound", () => new TaskNotFound({ id }))
            );
            return { task: a, activity: yield* activityService.listLatest(id, 1) };
          });
          yield* Effect.logInfo(`[Task] Archived ${archived.task.id}`);
          return archived;
        }),

      restore: (actor: Actor, id: string, opts?: { viaAssistant?: boolean }): Effect.Effect<{ task: Task; activity: ActivityEvent[] }, TaskNotFound | RowNotFound | DbError | ConstraintViolation> =>
        Effect.gen(function* () {
          const task = yield* taskRepo.findById(id).pipe(
            Effect.catchTag("RowNotFound", () => new TaskNotFound({ id }))
          );
          if (!task.archivedAt) return { task, activity: [] };
          const restored = yield* Effect.gen(function* () {
            yield* batch(db, buildTaskArchiveBatch({
              taskId: id,
              archivedAt: null,
              activity: asInput(actor, "restored", msg.restored(actor.label), opts?.viaAssistant === true),
            }));
            const r = yield* taskRepo.findById(id).pipe(
              Effect.catchTag("RowNotFound", () => new TaskNotFound({ id }))
            );
            return { task: r, activity: yield* activityService.listLatest(id, 1) };
          });
          yield* Effect.logInfo(`[Task] Restored ${restored.task.id}`);
          return restored;
        }),

      // Unlink a GitHub issue from a task (does not close/delete the GitHub
      // issue). Idempotent: an unknown issueId is a no-op. The github_unlinked
      // activity row lands in the SAME transaction as the unlink.
      unlinkGithubIssue: (actor: Actor, taskId: string, issueId: string): Effect.Effect<{ unlinked: boolean }, TaskNotFound | DbError | ConstraintViolation> =>
        Effect.gen(function* () {
          const task = yield* taskRepo.findById(taskId).pipe(
            Effect.catchTag("RowNotFound", () => new TaskNotFound({ id: taskId }))
          );
          const issue = task.githubs.find((g) => g.issueId === issueId);
          yield* batch(db, buildUnlinkBatch({
            taskId,
            issueId,
            activity: issue ? asInput(actor, "github_unlinked", msg.githubUnlinked(issue.repo, issue.issueNumber), false) : null,
          }));
          yield* Effect.logInfo(`[Task] Unlinked GitHub issue ${issueId} from ${taskId}`);
          return { unlinked: true };
        }),
    };

    // ── Bulk actions (POST /projects/:slug/tasks/bulk) ───────────────────
    // Same per-task semantics as the single-task methods, but the task rows
    // are prefetched in ONE query and the per-request lookups (project
    // columns/lanes, field options) are resolved once, so the loop issues no
    // per-id task re-reads. Each item's writes are still ONE atomic `batch()`
    // (mutation + activity): the API contract (docs/API.md) has NO
    // request-level transaction, so a later item's infrastructure failure
    // must not roll back earlier items (regression-tested in
    // http-tasks-bulk.test.ts). WIP stays a per-id conditional UPDATE
    // (invariant #5); emission rows stay in the item's batch (invariant #12).
    const bulkFail = (id: string, e: { _tag: string }): BulkTaskFailure => ({
      id,
      code: errorCodeMap[e._tag] ?? "INTERNAL",
      message: errorMessage(e as unknown as { _tag: string } & Record<string, unknown>),
    });

    const applyOneBulk = (
      ctx: TaskCtx,
      actor: Actor,
      input: BulkTaskInput,
      viaAssistant: boolean
    ): Effect.Effect<
      void,
      TaskNotFound | ColumnNotFound | SwimlaneNotFound | RequiredFieldMissing | WipLimitExceeded | NeighborNotInColumn | InvalidOption | DeadlineAfterLane | ConstraintViolation | DbError | RowNotFound
    > =>
      Effect.gen(function* () {
        const task = ctx.task;
        switch (input.action) {
          case "move":
            yield* withTx(db, runMoveCore(ctx, actor, {
              columnId: input.columnId ?? task.columnId,
              swimlaneId: input.swimlaneId ?? task.swimlaneId,
            }, { viaAssistant }));
            return;
          case "update": {
            const plan = yield* planUpdate(ctx, actor, {
              ...(input.priority !== undefined ? { priority: input.priority } : {}),
              ...(input.type !== undefined ? { type: input.type } : {}),
              ...(input.assignees !== undefined ? { assignees: input.assignees } : {}),
              ...(input.dueAt !== undefined ? { dueAt: input.dueAt } : {}),
            }, viaAssistant);
            if (plan.stmts.length > 0) yield* batch(db, plan.stmts);
            return;
          }
          case "archive":
            if (task.archivedAt) return;
            yield* batch(db, buildTaskArchiveBatch({
              taskId: task.id,
              archivedAt: new Date().toISOString(),
              activity: asInput(actor, "archived", msg.archived(actor.label), viaAssistant),
            }));
            return;
          case "restore":
            if (!task.archivedAt) return;
            yield* batch(db, buildTaskArchiveBatch({
              taskId: task.id,
              archivedAt: null,
              activity: asInput(actor, "restored", msg.restored(actor.label), viaAssistant),
            }));
            return;
        }
      });

    const bulk = (
      actor: Actor,
      projectId: string,
      input: BulkTaskInput,
      opts?: { viaAssistant?: boolean }
    ): Effect.Effect<BulkTaskResult, InvalidArgs | ConstraintViolation | DbError | RowNotFound> =>
      Effect.gen(function* () {
        if (input.action === "move" && input.columnId === undefined && input.swimlaneId === undefined) {
          return yield* new InvalidArgs({ reason: "move requires columnId or swimlaneId" });
        }
        // De-dupe first-seen so `applied` never echoes a repeated id, then
        // cap the request at BULK_TASK_ID_CAP tasks — both are request-level
        // rejections (InvalidArgs) raised before any write.
        const ids = [...new Set(input.ids)];
        if (ids.length > BULK_TASK_ID_CAP) {
          return yield* new InvalidArgs({ reason: `bulk accepts at most ${BULK_TASK_ID_CAP} ids` });
        }
        const viaAssistant = opts?.viaAssistant === true;
        // Prefetch every requested row in ONE project-scoped query; a missing
        // id (or one from another project) is absent → TASK_NOT_FOUND per task.
        const rows = yield* taskRepo.findByIdsForProject(projectId, ids);
        const byId = new Map(rows.map((t) => [t.id, t] as const));
        // Column/lane lookups are needed only when the loop reads a task's
        // current placement (update) or a move target (move).
        let columns: Map<string, Column> | undefined;
        let lanes: Map<string, Swimlane> | undefined;
        if (input.action === "update" || input.action === "move") {
          columns = new Map((yield* columnRepo.findByProject(projectId)).map((c) => [c.id, c] as const));
          lanes = new Map((yield* swimlaneRepo.findByProject(projectId)).map((l) => [l.id, l] as const));
        }
        const priorities = memoOptions(() => fieldConfigRepo.findPrioritiesByProject(projectId));
        const types = memoOptions(() => fieldConfigRepo.findTypesByProject(projectId));
        const applied: string[] = [];
        const failed: BulkTaskFailure[] = [];
        for (const id of ids) {
          const task = byId.get(id);
          if (!task) {
            failed.push(bulkFail(id, new TaskNotFound({ id })));
            continue;
          }
          // Every domain error caught below is raised BEFORE that task's
          // first write (existence/ownership, option ids, required_fields,
          // lane deadline, column/lane ownership all run ahead of the batch;
          // the WIP guard is a conditional UPDATE that changes 0 rows when it
          // rejects), and the item's writes are one atomic `batch()`. So a
          // `failed` entry never leaves a partial write behind.
          const outcome = yield* applyOneBulk({ task, columns, lanes, priorities, types }, actor, input, viaAssistant).pipe(
            Effect.as({ ok: true as const }),
            Effect.catchTags({
              TaskNotFound: (e) => Effect.succeed({ ok: false as const, failure: bulkFail(id, e) }),
              ColumnNotFound: (e) => Effect.succeed({ ok: false as const, failure: bulkFail(id, e) }),
              SwimlaneNotFound: (e) => Effect.succeed({ ok: false as const, failure: bulkFail(id, e) }),
              RequiredFieldMissing: (e) => Effect.succeed({ ok: false as const, failure: bulkFail(id, e) }),
              WipLimitExceeded: (e) => Effect.succeed({ ok: false as const, failure: bulkFail(id, e) }),
              NeighborNotInColumn: (e) => Effect.succeed({ ok: false as const, failure: bulkFail(id, e) }),
              InvalidOption: (e) => Effect.succeed({ ok: false as const, failure: bulkFail(id, e) }),
              DeadlineAfterLane: (e) => Effect.succeed({ ok: false as const, failure: bulkFail(id, e) }),
            })
          );
          if (outcome.ok) applied.push(id);
          else failed.push(outcome.failure);
        }
        return { applied, failed };
      });

    return { ...service, bulk };
  }),
}) {}

export interface BulkTaskInput {
  ids: string[];
  action: "move" | "update" | "archive" | "restore";
  columnId?: string;
  swimlaneId?: string;
  priority?: string;
  type?: string;
  assignees?: string[];
  dueAt?: string | null;
}

export interface BulkTaskFailure {
  id: string;
  code: string;
  message: string;
}

export interface BulkTaskResult {
  applied: string[];
  failed: BulkTaskFailure[];
}

interface MoveTarget {
  columnId: string;
  swimlaneId: string;
  beforeTaskId?: string;
  afterTaskId?: string;
  clearDueAt?: boolean;
}

// Webhook moves attribute to the system, not to any key/user.
const WEBHOOK_ACTOR: Actor = { kind: "system", label: "github" };
