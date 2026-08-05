import { Effect } from "effect";
import { TaskLinkRepo } from "../repos/task-link.repo";
import { TaskRepo } from "../repos/task.repo";
import { ProjectRepo } from "../repos/project.repo";
import { DbError, RowNotFound, ConstraintViolation, Sqlite, withTx } from "../db/database";
import { ProjectNotFound, TaskNotFound, TaskLinkNotFound, TaskLinkCycle, InvalidTaskLink } from "../api/errors";
import { keyAfter } from "../../shared/positions";
import type { TaskLink, TaskLinkRelation, TaskLinkSuggestion } from "../../shared/types";

export class TaskLinkService extends Effect.Service<TaskLinkService>()("Lexa/TaskLinkService", {
  dependencies: [TaskLinkRepo.Default, TaskRepo.Default, ProjectRepo.Default],
  effect: Effect.gen(function* () {
    const repo = yield* TaskLinkRepo;
    const taskRepo = yield* TaskRepo;
    const projectRepo = yield* ProjectRepo;
    const db = yield* Sqlite;

    // Walk the subtask_of parent chain from a task; return the ancestor ids.
    const ancestorIds = (taskId: string): Effect.Effect<Set<string>, DbError> =>
      Effect.gen(function* () {
        const seen = new Set<string>();
        let current = taskId;
        for (let i = 0; i < 50; i++) {
          const parents = yield* repo.findParents(current);
          if (parents.length === 0) break;
          const parent = parents[0];
          if (seen.has(parent.toTaskId)) break; // safety
          seen.add(parent.toTaskId);
          current = parent.toTaskId;
        }
        return seen;
      });

    return {
      findByTask: (projectId: string, taskId: string): Effect.Effect<TaskLink[], ProjectNotFound | TaskNotFound | DbError> =>
        Effect.gen(function* () {
          yield* projectRepo.findById(projectId).pipe(
            Effect.catchTag("RowNotFound", () => new ProjectNotFound({ identifier: projectId }))
          );
          yield* taskRepo.findById(taskId).pipe(
            Effect.catchTag("RowNotFound", () => new TaskNotFound({ id: taskId }))
          );
          return yield* repo.findByTask(taskId);
        }),

      add: (input: {
        projectId: string;
        fromTaskId: string;
        toTaskId: string;
        relation: TaskLinkRelation;
      }): Effect.Effect<TaskLink, ProjectNotFound | TaskNotFound | TaskLinkCycle | InvalidTaskLink | ConstraintViolation | DbError | RowNotFound> =>
        Effect.gen(function* () {
          yield* projectRepo.findById(input.projectId).pipe(
            Effect.catchTag("RowNotFound", () => new ProjectNotFound({ identifier: input.projectId }))
          );
          const from = yield* taskRepo.findById(input.fromTaskId).pipe(
            Effect.catchTag("RowNotFound", () => new TaskNotFound({ id: input.fromTaskId }))
          );
          const to = yield* taskRepo.findById(input.toTaskId).pipe(
            Effect.catchTag("RowNotFound", () => new TaskNotFound({ id: input.toTaskId }))
          );

          if (input.fromTaskId === input.toTaskId) {
            return yield* new InvalidTaskLink({ message: "A task cannot link to itself" });
          }
          if (from.projectId !== input.projectId || to.projectId !== input.projectId) {
            return yield* new InvalidTaskLink({ message: "Both tasks must belong to the same project" });
          }

          // subtask_of cycle guard: the target must not be a descendant of `from`.
          if (input.relation === "subtask_of") {
            const ancestors = yield* ancestorIds(input.toTaskId);
            if (ancestors.has(input.fromTaskId)) {
              return yield* new TaskLinkCycle({ message: "This link would create a subtask cycle" });
            }
          }

          // Child inherits the parent's column (subtask_of: from=child, to=parent).
          return yield* withTx(
            db,
            Effect.gen(function* () {
              if (input.relation === "subtask_of" && from.columnId !== to.columnId) {
                const last = yield* taskRepo.findLastInColumn(input.projectId, to.columnId).pipe(
                  Effect.catchTag("RowNotFound", () => Effect.succeed(null))
                );
                yield* taskRepo.move(input.fromTaskId, {
                  columnId: to.columnId,
                  swimlaneId: to.swimlaneId,
                  position: keyAfter(last?.position ?? null),
                  projectId: input.projectId,
                });
              }
              return yield* repo.create({
                id: crypto.randomUUID(),
                projectId: input.projectId,
                fromTaskId: input.fromTaskId,
                toTaskId: input.toTaskId,
                relation: input.relation,
              });
            })
          );
        }),

      remove: (linkId: string): Effect.Effect<void, TaskLinkNotFound | ConstraintViolation | DbError> =>
        Effect.gen(function* () {
          const n = yield* repo.delete(linkId);
          if (n === 0) return yield* new TaskLinkNotFound({ id: linkId });
        }),

      search: (projectId: string, query: string, excludeTaskId: string): Effect.Effect<TaskLinkSuggestion[], DbError> =>
        repo.search(projectId, query, excludeTaskId, 10).pipe(
          Effect.map((rows) =>
            rows.map((r) => ({
              id: r.id,
              title: r.title,
              columnName: r.column_name,
              type: r.type,
              priority: r.priority,
            }))
          )
        ),
    };
  }),
}) {}
