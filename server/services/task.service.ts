import { Effect } from "effect";
import { TaskRepo, TaskFilters } from "../repos/task.repo";
import { ProjectRepo } from "../repos/project.repo";
import { ColumnRepo } from "../repos/column.repo";
import { SwimlaneRepo } from "../repos/swimlane.repo";
import { FieldConfigRepo } from "../repos/field-config.repo";
import { ConstraintViolation, DbError, RowNotFound, Sqlite, withTx, queryFirst } from "../db/database";
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
  DeadlineAfterLane,
} from "../api/errors";
import { ActivityService } from "./activity.service";
import * as msg from "../activity-messages";
import type { Task, Column, Swimlane, TipTapDoc, Actor, ActivityEvent, ActivityType } from "../../shared/types";

export function isEmptyDoc(doc: TipTapDoc): boolean {
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
    if (empty) return Effect.fail(new RequiredFieldMissing({ field, columnName: column.name }));
  }
  return Effect.void;
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
      }): Effect.Effect<{ task: Task; activity: ActivityEvent[] }, ProjectNotFound | ColumnNotFound | SwimlaneNotFound | TaskNotFound | RequiredFieldMissing | InvalidOption | DeadlineAfterLane | ConstraintViolation | DbError | RowNotFound> =>
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
            const counter = yield* queryFirst<{ next_task_number: number }>(
              db,
              `UPDATE projects SET next_task_number = next_task_number + 1 WHERE id = ? RETURNING next_task_number`,
              input.projectId
            );
            const number = counter.next_task_number;
            const key = `${project.key}-${number}`;
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
              dueAt: input.dueAt ?? null,
              number,
              key,
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
            Effect.gen(function* () {
              const t = yield* doInsert.pipe(
                Effect.catchIf(
                  (e) => e instanceof ConstraintViolation && e.isPositionConflict,
                  () => doInsert
                )
              );
              const ev = yield* activityService.append(t.id, actor, "created", msg.created(actor.label));
              return { task: t, activity: [ev] };
            })
          );
          yield* Effect.logInfo(`[Task] Created ${task.task.id} in column ${task.task.columnId} project ${task.task.projectId}`);
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
        actor: Actor,
        id: string,
        input: {
          title?: string;
          description?: TipTapDoc;
          priority?: string;
          type?: string;
          assignees?: string[];
          dueAt?: string | null;
        }
      ): Effect.Effect<{ task: Task; activity: ActivityEvent[] }, TaskNotFound | ColumnNotFound | SwimlaneNotFound | RequiredFieldMissing | InvalidOption | DeadlineAfterLane | ConstraintViolation | DbError | RowNotFound> =>
        Effect.gen(function* () {
          const task = yield* taskRepo.findById(id).pipe(
            Effect.catchTag("RowNotFound", () => new TaskNotFound({ id }))
          );
          const column = yield* columnRepo.findById(task.columnId).pipe(
            Effect.catchTag("RowNotFound", () => new ColumnNotFound({ id: task.columnId }))
          );
          if (input.dueAt !== undefined && input.dueAt !== null) {
            const lane = yield* swimlaneRepo.findById(task.swimlaneId).pipe(
              Effect.catchTag("RowNotFound", () => new SwimlaneNotFound({ id: task.swimlaneId }))
            );
            if (lane.dueAt && input.dueAt > lane.dueAt)
              return yield* new DeadlineAfterLane({ date: lane.dueAt });
          }
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

          // Diff against the pre-update row — only real changes emit rows
          // (messages are frozen at write time with option LABELS, not ids).
          const rows: { type: ActivityType; message: string }[] = [];
          if (input.title !== undefined && input.title !== task.title) {
            rows.push({ type: "field_changed", message: msg.titleChanged(actor.label) });
          }
          if (input.description !== undefined && JSON.stringify(input.description) !== JSON.stringify(task.description)) {
            rows.push({ type: "field_changed", message: msg.descriptionUpdated(actor.label) });
          }
          if (input.priority !== undefined && input.priority !== task.priority) {
            const opts = yield* fieldConfigRepo.findPrioritiesByProject(task.projectId);
            const label = (optionId: string) => opts.find((o) => o.id === optionId)?.label ?? optionId;
            rows.push({ type: "field_changed", message: msg.priorityChanged(label(task.priority), label(input.priority)) });
          }
          if (input.type !== undefined && input.type !== task.type) {
            const opts = yield* fieldConfigRepo.findTypesByProject(task.projectId);
            const label = (optionId: string) => opts.find((o) => o.id === optionId)?.label ?? optionId;
            rows.push({ type: "field_changed", message: msg.typeChanged(label(task.type), label(input.type)) });
          }
          if (input.assignees !== undefined && [...input.assignees].sort().join("\u0000") !== [...task.assignees].sort().join("\u0000")) {
            rows.push({ type: "field_changed", message: msg.assigneesUpdated(actor.label) });
          }
          if (input.dueAt !== undefined && input.dueAt !== task.dueAt) {
            rows.push({ type: "field_changed", message: msg.dueDateChanged(task.dueAt ?? null, input.dueAt ?? null) });
          }

          const updated = yield* withTx(db, Effect.gen(function* () {
            const u = yield* taskRepo.update(id, {
              title: input.title,
              description: input.description !== undefined ? JSON.stringify(input.description) : undefined,
              priority: input.priority,
              type: input.type,
              assignees: input.assignees,
              dueAt: input.dueAt,
            }).pipe(
              Effect.catchTag("RowNotFound", () => new TaskNotFound({ id }))
            );
            const activity: ActivityEvent[] = [];
            for (const r of rows) {
              activity.push(yield* activityService.append(id, actor, r.type, r.message));
            }
            return { task: u, activity };
          }));
          yield* Effect.logInfo(`[Task] Updated ${updated.task.id}`);
          return updated;
        }),

      move: (actor: Actor, taskId: string, target: MoveTarget, opts?: { bypassGuards?: boolean }): Effect.Effect<{ task: Task; activity: ActivityEvent[] }, TaskNotFound | ColumnNotFound | SwimlaneNotFound | RequiredFieldMissing | WipLimitExceeded | NeighborNotInColumn | DeadlineAfterLane | DbError | ConstraintViolation | RowNotFound> =>
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
            return { task, activity: [] };

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
              clearDueAt: target.clearDueAt ?? false,
            }, { bypassWip: opts?.bypassGuards });
            if (result.changes === 0) {
              const count = yield* taskRepo.countByColumn(task.projectId, target.columnId);
              return yield* new WipLimitExceeded({ columnName: column.name, limit: column.wipLimit ?? 0, current: count });
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

          // Old/new names for the moved message — captured before the move
          // (frozen at write time).
          const oldCol = yield* columnRepo.findById(task.columnId).pipe(
            Effect.catchTag("RowNotFound", () => Effect.succeed({ name: task.columnId } as Column))
          );
          const oldLane = task.swimlaneId
            ? yield* swimlaneRepo.findById(task.swimlaneId).pipe(
                Effect.catchTag("RowNotFound", () => Effect.succeed(null))
              )
            : null;
          const resolvedSwimlane = target.swimlaneId !== undefined ? target.swimlaneId : task.swimlaneId;
          const newLane = resolvedSwimlane === task.swimlaneId
            ? oldLane
            : yield* swimlaneRepo.findById(resolvedSwimlane).pipe(
                Effect.catchTag("RowNotFound", () => Effect.succeed(null))
              );

          const moved = yield* withTx(
            db,
            Effect.gen(function* () {
              const m = yield* doMoveWithCascade.pipe(
                Effect.catchIf(
                  (e) => e instanceof ConstraintViolation && e.isPositionConflict,
                  () => doMoveWithCascade
                )
              );
              // Column OR lane change emits; position-only reorders don't.
              if (m.columnId !== task.columnId || m.swimlaneId !== task.swimlaneId) {
                const ev = yield* activityService.append(taskId, actor, "moved", msg.moved(
                  actor.label, oldCol.name, column.name, oldLane?.name ?? null, newLane?.name ?? null
                ));
                return { task: m, activity: [ev] };
              }
              return { task: m, activity: [] as ActivityEvent[] };
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
          const last = yield* taskRepo.findLastInColumn(task.projectId, columnId).pipe(
            Effect.catchTag("RowNotFound", () => Effect.succeed(null))
          );
          const position = keyAfter(last?.position ?? null);
          // Webhook moves bypass guards; the move + synced-state write run as
          // one transaction (repo batch joins this withTx), then the
          // github_synced activity row lands in the SAME transaction.
          const webhookMoved = yield* withTx(db, Effect.gen(function* () {
            const moved = yield* taskRepo.moveFromWebhook(task.id, issueId, {
              columnId,
              swimlaneId: task.swimlaneId,
              position,
            }, syncedState);
            const issue = task.githubs.find((g) => g.issueId === issueId);
            if (issue) {
              yield* activityService.append(task.id, WEBHOOK_ACTOR, "github_synced",
                msg.githubSynced(issue.issueNumber, syncedState, column.name));
            }
            return moved;
          }));
          yield* Effect.logInfo(`[Task] Webhook-moved ${webhookMoved.id} column=${webhookMoved.columnId}`);
          return webhookMoved;
        }),

      delete: (actor: Actor, id: string): Effect.Effect<void, TaskNotFound | TaskHasChildren | DbError | ConstraintViolation> =>
        Effect.gen(function* () {
          yield* taskRepo.findById(id).pipe(Effect.catchTag("RowNotFound", () => new TaskNotFound({ id })));
          // deleted row lands in the same tx as the delete — if the delete
          // fails (children), the rollback removes the activity row too.
          yield* withTx(db, Effect.gen(function* () {
            yield* activityService.append(id, actor, "deleted", msg.deletedTask(actor.label));
            yield* taskRepo.delete(id).pipe(
              Effect.catchTag("ConstraintViolation", () => new TaskHasChildren({ taskId: id }))
            );
          }));
          yield* Effect.logInfo(`[Task] Deleted ${id}`);
          return undefined;
        }),

      archive: (actor: Actor, id: string): Effect.Effect<{ task: Task; activity: ActivityEvent[] }, TaskNotFound | RowNotFound | DbError | ConstraintViolation> =>
        Effect.gen(function* () {
          const task = yield* taskRepo.findById(id).pipe(
            Effect.catchTag("RowNotFound", () => new TaskNotFound({ id }))
          );
          if (task.archivedAt) return { task, activity: [] };
          const archived = yield* withTx(db, Effect.gen(function* () {
            const a = yield* taskRepo.setArchived(id, new Date().toISOString());
            const ev = yield* activityService.append(id, actor, "archived", msg.archived(actor.label));
            return { task: a, activity: [ev] };
          }));
          yield* Effect.logInfo(`[Task] Archived ${archived.task.id}`);
          return archived;
        }),

      restore: (actor: Actor, id: string): Effect.Effect<{ task: Task; activity: ActivityEvent[] }, TaskNotFound | RowNotFound | DbError | ConstraintViolation> =>
        Effect.gen(function* () {
          const task = yield* taskRepo.findById(id).pipe(
            Effect.catchTag("RowNotFound", () => new TaskNotFound({ id }))
          );
          if (!task.archivedAt) return { task, activity: [] };
          const restored = yield* withTx(db, Effect.gen(function* () {
            const r = yield* taskRepo.setArchived(id, null);
            const ev = yield* activityService.append(id, actor, "restored", msg.restored(actor.label));
            return { task: r, activity: [ev] };
          }));
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
          yield* withTx(db, Effect.gen(function* () {
            yield* taskRepo.unlinkGithubIssue(taskId, issueId);
            if (issue) {
              yield* activityService.append(taskId, actor, "github_unlinked", msg.githubUnlinked(issue.repo, issue.issueNumber));
            }
          }));
          yield* Effect.logInfo(`[Task] Unlinked GitHub issue ${issueId} from ${taskId}`);
          return { unlinked: true };
        }),
    };
  }),
}) {}

interface MoveTarget {
  columnId: string;
  swimlaneId: string;
  beforeTaskId?: string;
  afterTaskId?: string;
  clearDueAt?: boolean;
}

// Webhook moves attribute to the system, not to any key/user.
const WEBHOOK_ACTOR: Actor = { kind: "system", label: "github" };
