import { Effect } from "effect";
import { TaskRepo, TaskFilters } from "../repos/task.repo";
import { ProjectRepo } from "../repos/project.repo";
import { ColumnRepo } from "../repos/column.repo";
import { SwimlaneRepo } from "../repos/swimlane.repo";
import { ConstraintViolation, DbError, RowNotFound } from "../db/d1";
import { keyAfter } from "../../shared/positions";
import { keyBetween } from "../../shared/positions";
import type { TaskRow } from "../../shared/types";
import {
  TaskNotFound,
  ProjectNotFound,
  ColumnNotFound,
  SwimlaneNotFound,
  RequiredFieldMissing,
  WipLimitExceeded,
  NeighborNotInColumn,
} from "../api/errors";
import type { Task, Column, Swimlane } from "../../shared/types";

function isEmptyDoc(json: string): boolean {
  try {
    const doc = JSON.parse(json) as Record<string, unknown>;
    const hasText = (node: Record<string, unknown>): boolean => {
      if (node.type === "text") return (typeof node.text === "string" ? node.text : "").trim().length > 0;
      if (node.content && Array.isArray(node.content)) return (node.content as Record<string, unknown>[]).some(hasText);
      return false;
    };
    return !hasText(doc);
  } catch {
    return true;
  }
}

function validateRequiredFields(
  taskLike: Record<string, unknown>,
  column: Column
): Effect.Effect<void, RequiredFieldMissing> {
  for (const field of column.requiredFields) {
    let empty = false;
    if (field === "description") {
      empty = isEmptyDoc(typeof taskLike.description === "string" ? taskLike.description : "{}");
    } else if (field === "assignee") {
      empty = !taskLike.assignee;
    } else {
      empty = !taskLike[field];
    }
    if (empty) return Effect.fail(new RequiredFieldMissing({ field, column: column.name }));
  }
  return Effect.void;
}

export class TaskService extends Effect.Service<TaskService>()("Lexa/TaskService", {
  dependencies: [TaskRepo.Default, ProjectRepo.Default, ColumnRepo.Default, SwimlaneRepo.Default],
  effect: Effect.gen(function* () {
    const taskRepo = yield* TaskRepo;
    const projectRepo = yield* ProjectRepo;
    const columnRepo = yield* ColumnRepo;
    const swimlaneRepo = yield* SwimlaneRepo;

    return {
      create: (input: {
        projectId: string;
        columnId: string;
        swimlaneId?: string | null;
        title: string;
        description?: string;
        priority?: "urgent" | "high" | "medium" | "low";
        type?: "feature" | "bug" | "task" | "asset";
        assignee?: string | null;
      }): Effect.Effect<Task, ProjectNotFound | ColumnNotFound | SwimlaneNotFound | RequiredFieldMissing | ConstraintViolation | DbError | RowNotFound> =>
        Effect.gen(function* () {
          const project = yield* projectRepo.findById(input.projectId).pipe(
            Effect.catchTag("RowNotFound", () => new ProjectNotFound({ identifier: input.projectId }))
          );

          const column = yield* columnRepo.findById(input.columnId).pipe(
            Effect.catchTag("RowNotFound", () => new ColumnNotFound({ id: input.columnId }))
          );
          if (column.projectId !== project.id) {
            return yield* new ColumnNotFound({ id: input.columnId });
          }

          if (input.swimlaneId) {
            const lane = yield* swimlaneRepo.findById(input.swimlaneId!).pipe(
              Effect.catchTag("RowNotFound", () => new SwimlaneNotFound({ id: input.swimlaneId! }))
            );
            if (lane.projectId !== project.id) {
              return yield* new SwimlaneNotFound({ id: input.swimlaneId });
            }
          }

          const taskLike = {
            title: input.title,
            description: input.description ?? "{}",
            priority: input.priority ?? "medium",
            type: input.type ?? "task",
            assignee: input.assignee ?? null,
          };
          yield* validateRequiredFields(taskLike as Record<string, unknown>, column);

          const doInsert = Effect.gen(function* () {
            const lastRow = yield* taskRepo.findLastInColumn(input.projectId, input.columnId).pipe(
              Effect.catchTag("RowNotFound", () => Effect.succeed(null))
            );
            const last = lastRow as TaskRow | null;
            const position = keyAfter(last?.position ?? null);
            return yield* taskRepo.create({
              id: crypto.randomUUID(),
              projectId: input.projectId,
              columnId: input.columnId,
              swimlaneId: input.swimlaneId ?? null,
              title: input.title,
              description: input.description ?? "{}",
              priority: input.priority ?? "medium",
              type: input.type ?? "task",
              assignee: input.assignee ?? null,
              position,
            }).pipe(
              Effect.catchTag("RowNotFound", () => new ProjectNotFound({ identifier: input.projectId }))
            );
          });

          return yield* doInsert.pipe(
            Effect.catchIf(
              (e) => e instanceof ConstraintViolation && e.isPositionConflict,
              () => doInsert
            )
          );
        }),

      getById: (id: string): Effect.Effect<Task, TaskNotFound | DbError> =>
        taskRepo.findById(id).pipe(Effect.catchTag("RowNotFound", () => new TaskNotFound({ id }))),

      findByProject: (
        projectId: string,
        filters?: { columnId?: string; swimlaneId?: string; assignee?: string; type?: "feature" | "bug" | "task" | "asset" },
        limit?: number,
        cursor?: string
      ): Effect.Effect<{ tasks: Task[]; hasMore: boolean }, ProjectNotFound | DbError> =>
        Effect.gen(function* () {
          yield* projectRepo.findById(projectId).pipe(
            Effect.catchTag("RowNotFound", () => new ProjectNotFound({ identifier: projectId }))
          );
          return yield* taskRepo.findByProject(projectId, filters, limit, cursor);
        }),

      update: (
        id: string,
        input: {
          title?: string;
          description?: string;
          priority?: "urgent" | "high" | "medium" | "low";
          type?: "feature" | "bug" | "task" | "asset";
          assignee?: string | null;
        }
      ): Effect.Effect<Task, TaskNotFound | ColumnNotFound | RequiredFieldMissing | ConstraintViolation | DbError | RowNotFound> =>
        Effect.gen(function* () {
          const task = yield* taskRepo.findById(id).pipe(
            Effect.catchTag("RowNotFound", () => new TaskNotFound({ id }))
          );
          const column = yield* columnRepo.findById(task.columnId).pipe(
            Effect.catchTag("RowNotFound", () => new ColumnNotFound({ id: task.columnId }))
          );
          const merged = {
            title: input.title ?? task.title,
            description: input.description ?? JSON.stringify(task.description),
            priority: input.priority ?? task.priority,
            type: input.type ?? task.type,
            assignee: input.assignee !== undefined ? input.assignee : task.assignee,
          };
          yield* validateRequiredFields(merged as Record<string, unknown>, column);
          return yield* taskRepo.update(id, input).pipe(
            Effect.catchTag("RowNotFound", () => new TaskNotFound({ id }))
          );
        }),

      move: (taskId: string, target: MoveTarget, opts?: { bypassGuards?: boolean }): Effect.Effect<Task, TaskNotFound | ColumnNotFound | SwimlaneNotFound | RequiredFieldMissing | WipLimitExceeded | NeighborNotInColumn | DbError | ConstraintViolation | RowNotFound> =>
        Effect.gen(function* () {
          const task = yield* taskRepo.findById(taskId).pipe(
            Effect.catchTag("RowNotFound", () => new TaskNotFound({ id: taskId }))
          );
          const column = yield* columnRepo.findById(target.columnId).pipe(
            Effect.catchTag("RowNotFound", () => new ColumnNotFound({ id: target.columnId }))
          );
          if (column.projectId !== task.projectId)
            return yield* new ColumnNotFound({ id: target.columnId });
          if (target.swimlaneId) {
            const lane = yield* swimlaneRepo.findById(target.swimlaneId).pipe(
              Effect.catchTag("RowNotFound", () => new SwimlaneNotFound({ id: target.swimlaneId! }))
            );
            if (lane.projectId !== task.projectId)
              return yield* new SwimlaneNotFound({ id: target.swimlaneId! });
          }

          if (task.columnId === target.columnId && !target.beforeTaskId && !target.afterTaskId)
            return task;

          if (!opts?.bypassGuards)
            yield* validateRequiredFields({ description: JSON.stringify(task.description), assignee: task.assignee } as Record<string, unknown>, column);

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

          const doMove = Effect.gen(function* () {
            const position = yield* computePosition;
            const resolvedSwimlane = target.swimlaneId !== undefined ? target.swimlaneId : task.swimlaneId;
            const result = yield* taskRepo.move(taskId, {
              columnId: target.columnId,
              swimlaneId: resolvedSwimlane,
              position,
              projectId: task.projectId,
            }, { bypassWip: opts?.bypassGuards });
            if (result.changes === 0)
              return yield* new WipLimitExceeded({ column: column.name, limit: column.wipLimit ?? 0 });
            return result.task;
          });

          return yield* doMove.pipe(
            Effect.catchIf(
              (e) => e instanceof ConstraintViolation && e.isPositionConflict,
              () => doMove
            )
          );
        }),

      moveFromWebhook: (taskId: string, columnId: string, syncedState: "open" | "closed"): Effect.Effect<Task, TaskNotFound | ColumnNotFound | DbError | ConstraintViolation | RowNotFound> =>
        Effect.gen(function* () {
          const task = yield* taskRepo.findById(taskId).pipe(
            Effect.catchTag("RowNotFound", () => new TaskNotFound({ id: taskId }))
          );
          yield* columnRepo.findById(columnId).pipe(
            Effect.catchTag("RowNotFound", () => new ColumnNotFound({ id: columnId }))
          );
          const last = yield* taskRepo.findLastInColumn(task.projectId, columnId).pipe(
            Effect.catchTag("RowNotFound", () => Effect.succeed(null))
          );
          const position = keyAfter(last?.position ?? null);
          yield* taskRepo.move(taskId, {
            columnId,
            swimlaneId: task.swimlaneId,
            position,
            projectId: task.projectId,
          }, { bypassWip: true });
          yield* taskRepo.setGithubSyncedState(taskId, syncedState);
          return yield* taskRepo.findById(taskId).pipe(
            Effect.catchTag("RowNotFound", () => new TaskNotFound({ id: taskId }))
          );
        }),

      delete: (id: string): Effect.Effect<void, TaskNotFound | DbError> =>
        Effect.gen(function* () {
          yield* taskRepo.findById(id).pipe(Effect.catchTag("RowNotFound", () => new TaskNotFound({ id })));
          yield* taskRepo.delete(id).pipe(
            Effect.catchTag("ConstraintViolation", () => new TaskNotFound({ id }))
          );
          return undefined;
        }),
    };
  }),
}) {}

interface MoveTarget {
  columnId: string;
  swimlaneId?: string | null;
  beforeTaskId?: string;
  afterTaskId?: string;
}
