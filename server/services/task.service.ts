import { Effect } from "effect";
import { TaskRepo, TaskFilters } from "../repos/task.repo";
import { ProjectRepo } from "../repos/project.repo";
import { ColumnRepo } from "../repos/column.repo";
import { SwimlaneRepo } from "../repos/swimlane.repo";
import { FieldConfigRepo } from "../repos/field-config.repo";
import { ConstraintViolation, DbError, RowNotFound, Sqlite, withTx } from "../db/database";
import { keyAfter } from "../../shared/positions";
import { keyBetween } from "../../shared/positions";
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
} from "../api/errors";
import type { Task, Column, Swimlane, TipTapDoc } from "../../shared/types";

function isEmptyDoc(doc: TipTapDoc): boolean {
  const hasText = (node: Record<string, unknown>): boolean => {
    if (node.type === "text") return (typeof node.text === "string" ? node.text : "").trim().length > 0;
    if (node.content && Array.isArray(node.content)) return (node.content as Record<string, unknown>[]).some(hasText);
    return false;
  };
  return !hasText(doc as unknown as Record<string, unknown>);
}

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
    if (empty) return Effect.fail(new RequiredFieldMissing({ field, column: column.name }));
  }
  return Effect.void;
}

export class TaskService extends Effect.Service<TaskService>()("Lexa/TaskService", {
  dependencies: [TaskRepo.Default, ProjectRepo.Default, ColumnRepo.Default, SwimlaneRepo.Default, FieldConfigRepo.Default],
  effect: Effect.gen(function* () {
    const taskRepo = yield* TaskRepo;
    const projectRepo = yield* ProjectRepo;
    const columnRepo = yield* ColumnRepo;
    const swimlaneRepo = yield* SwimlaneRepo;
    const fieldConfigRepo = yield* FieldConfigRepo;
    const db = yield* Sqlite;

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

    return {
      create: (input: {
        projectId: string;
        columnId: string;
        swimlaneId: string;
        title: string;
        description?: TipTapDoc;
        priority?: string;
        type?: string;
        assignees?: string[];
        parentId?: string;            // create as subtask of this task
      }): Effect.Effect<Task, ProjectNotFound | ColumnNotFound | SwimlaneNotFound | TaskNotFound | RequiredFieldMissing | InvalidOption | ConstraintViolation | DbError | RowNotFound> =>
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

          if (swimlaneId) {
            const lane = yield* swimlaneRepo.findById(swimlaneId).pipe(
              Effect.catchTag("RowNotFound", () => new SwimlaneNotFound({ id: swimlaneId }))
            );
            if (lane.projectId !== project.id) {
              return yield* new SwimlaneNotFound({ id: swimlaneId });
            }
          }
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
            yield* taskRepo.create({
              id: taskId,
              projectId: input.projectId,
              columnId,
              swimlaneId,
              title: input.title,
              description: JSON.stringify(desc),
              priority,
              type,
              assignees: input.assignees ?? [],
              position,
            });
            if (parent) {
              yield* taskRepo.createSubtaskLink(input.projectId, taskId, parent.id);
            }
            return yield* taskRepo.findById(taskId).pipe(
              Effect.catchTag("RowNotFound", () => new ProjectNotFound({ identifier: input.projectId }))
            );
          });

          const task = yield* withTx(
            db,
            doInsert.pipe(
              Effect.catchIf(
                (e) => e instanceof ConstraintViolation && e.isPositionConflict,
                () => doInsert
              )
            )
          );
          yield* Effect.logInfo(`[Task] Created ${task.id} in column ${task.columnId} project ${task.projectId}`);
          return task;
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
        id: string,
        input: {
          title?: string;
          description?: TipTapDoc;
          priority?: string;
          type?: string;
          assignees?: string[];
        }
      ): Effect.Effect<Task, TaskNotFound | ColumnNotFound | RequiredFieldMissing | InvalidOption | ConstraintViolation | DbError | RowNotFound> =>
        Effect.gen(function* () {
          const task = yield* taskRepo.findById(id).pipe(
            Effect.catchTag("RowNotFound", () => new TaskNotFound({ id }))
          );
          const column = yield* columnRepo.findById(task.columnId).pipe(
            Effect.catchTag("RowNotFound", () => new ColumnNotFound({ id: task.columnId }))
          );
          const priority = input.priority !== undefined ? input.priority : task.priority;
          const type = input.type !== undefined ? input.type : task.type;
          if (input.priority !== undefined) yield* validateOption(task.projectId, "priority", input.priority);
          if (input.type !== undefined) yield* validateOption(task.projectId, "type", input.type);
          const merged = {
            title: input.title ?? task.title,
            description: input.description ?? task.description,
            priority,
            type,
            assignees: input.assignees !== undefined ? input.assignees : task.assignees,
          };
          yield* validateRequiredFields(merged as Record<string, unknown>, column);
          const updated = yield* taskRepo.update(id, {
            title: input.title,
            description: input.description !== undefined ? JSON.stringify(input.description) : undefined,
            priority: input.priority,
            type: input.type,
            assignees: input.assignees,
          }).pipe(
            Effect.catchTag("RowNotFound", () => new TaskNotFound({ id }))
          );
          yield* Effect.logInfo(`[Task] Updated ${updated.id}`);
          return updated;
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

          if (
            task.columnId === target.columnId &&
            (target.swimlaneId === undefined || target.swimlaneId === task.swimlaneId) &&
            !target.beforeTaskId &&
            !target.afterTaskId
          )
            return task;

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

          const doMove = Effect.gen(function* () {
            const position = yield* computePosition;
            const resolvedSwimlane = target.swimlaneId !== undefined ? target.swimlaneId : task.swimlaneId;
            const result = yield* taskRepo.move(taskId, {
              columnId: target.columnId,
              swimlaneId: resolvedSwimlane,
              position,
              projectId: task.projectId,
            }, { bypassWip: opts?.bypassGuards });
            if (result.changes === 0) {
              const count = yield* taskRepo.countByColumn(task.projectId, target.columnId);
              return yield* new WipLimitExceeded({ column: column.name, limit: column.wipLimit ?? 0, current: count });
            }
            return result.task;
          });

          // Cascade: when a parent moves, its subtasks follow (same column,
          // appended after the parent's new position). One retry closure for
          // the WHOLE move — anchors and child list are re-read inside it,
          // so a position conflict retries the parent AND its children.
          const doMoveWithCascade = Effect.gen(function* () {
            const m = yield* doMove;
            if (m.columnId !== task.columnId || m.swimlaneId !== task.swimlaneId) {
              const children = yield* taskRepo.findSubtasks(taskId);
              let childPos = m.position;
              for (const child of children) {
                childPos = keyAfter(childPos);
                yield* taskRepo.move(child.id, {
                  columnId: m.columnId,
                  swimlaneId: m.swimlaneId,
                  position: childPos,
                  projectId: task.projectId,
                }, { bypassWip: true });
              }
            }
            return m;
          });

          const moved = yield* withTx(
            db,
            doMoveWithCascade.pipe(
              Effect.catchIf(
                (e) => e instanceof ConstraintViolation && e.isPositionConflict,
                () => doMoveWithCascade
              )
            )
          );

          yield* Effect.logInfo(`[Task] Moved ${moved.id} column=${moved.columnId} swimlane=${moved.swimlaneId} pos=${moved.position}`);
          return moved;
        }),

      moveFromWebhook: (issueId: string, columnId: string, syncedState: "open" | "closed"): Effect.Effect<Task, TaskNotFound | ColumnNotFound | DbError | ConstraintViolation | RowNotFound> =>
        Effect.gen(function* () {
          const task = yield* taskRepo.findByGithubIssue(issueId).pipe(
            Effect.catchTag("RowNotFound", () => new TaskNotFound({ id: issueId }))
          );
          if (task.archivedAt) return task;
          yield* columnRepo.findById(columnId).pipe(
            Effect.catchTag("RowNotFound", () => new ColumnNotFound({ id: columnId }))
          );
          const last = yield* taskRepo.findLastInColumn(task.projectId, columnId).pipe(
            Effect.catchTag("RowNotFound", () => Effect.succeed(null))
          );
          const position = keyAfter(last?.position ?? null);
          const webhookMoved = yield* taskRepo.moveFromWebhook(task.id, issueId, {
            columnId,
            swimlaneId: task.swimlaneId,
            position,
          }, syncedState);
          yield* Effect.logInfo(`[Task] Webhook-moved ${webhookMoved.id} column=${webhookMoved.columnId}`);
          return webhookMoved;
        }),

      delete: (id: string): Effect.Effect<void, TaskNotFound | TaskHasChildren | DbError> =>
        Effect.gen(function* () {
          yield* taskRepo.findById(id).pipe(Effect.catchTag("RowNotFound", () => new TaskNotFound({ id })));
          yield* taskRepo.delete(id).pipe(
            Effect.catchTag("ConstraintViolation", () => new TaskHasChildren({ taskId: id }))
          );
          yield* Effect.logInfo(`[Task] Deleted ${id}`);
          return undefined;
        }),

      archive: (id: string): Effect.Effect<Task, TaskNotFound | RowNotFound | DbError | ConstraintViolation> =>
        Effect.gen(function* () {
          const task = yield* taskRepo.findById(id).pipe(
            Effect.catchTag("RowNotFound", () => new TaskNotFound({ id }))
          );
          if (task.archivedAt) return task;
          const archived = yield* taskRepo.setArchived(id, new Date().toISOString());
          yield* Effect.logInfo(`[Task] Archived ${archived.id}`);
          return archived;
        }),

      restore: (id: string): Effect.Effect<Task, TaskNotFound | RowNotFound | DbError | ConstraintViolation> =>
        Effect.gen(function* () {
          const task = yield* taskRepo.findById(id).pipe(
            Effect.catchTag("RowNotFound", () => new TaskNotFound({ id }))
          );
          if (!task.archivedAt) return task;
          const restored = yield* taskRepo.setArchived(id, null);
          yield* Effect.logInfo(`[Task] Restored ${restored.id}`);
          return restored;
        }),
    };
  }),
}) {}

interface MoveTarget {
  columnId: string;
  swimlaneId: string;
  beforeTaskId?: string;
  afterTaskId?: string;
}
