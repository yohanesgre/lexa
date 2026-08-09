import { Effect } from "effect";
import { SwimlaneRepo } from "../repos/swimlane.repo";
import { ProjectRepo } from "../repos/project.repo";
import { TaskRepo } from "../repos/task.repo";
import { ActivityService } from "./activity.service";
import { DbError, ConstraintViolation, withTx, Sqlite } from "../db/database";
import { ProjectNotFound, SwimlaneNotFound, HasChildren, BacklogProtected, DeadlineAfterLane, TaskNotFound } from "../api/errors";
import * as msg from "../activity-messages";
import type { Swimlane, Actor, ActivityEvent } from "../../shared/types";

export class SwimlaneService extends Effect.Service<SwimlaneService>()("Lexa/SwimlaneService", {
  dependencies: [SwimlaneRepo.Default, ProjectRepo.Default, TaskRepo.Default, ActivityService.Default],
  effect: Effect.gen(function* () {
    const repo = yield* SwimlaneRepo;
    const projectRepo = yield* ProjectRepo;
    const taskRepo = yield* TaskRepo;
    const activityService = yield* ActivityService;
    const db = yield* Sqlite;

    return {
      create: (input: { projectId: string; name: string; description?: string; dueAt?: string | null }): Effect.Effect<Swimlane, ProjectNotFound | DbError> =>
        Effect.gen(function* () {
          yield* projectRepo.findById(input.projectId).pipe(
            Effect.catchTag("RowNotFound", () => new ProjectNotFound({ identifier: input.projectId }))
          );
          const maxPos = yield* repo.maxPosition(input.projectId);
          const id = crypto.randomUUID();
          const lane = yield* repo.create({ id, projectId: input.projectId, name: input.name, description: input.description, position: maxPos + 1, kind: "milestone", dueAt: input.dueAt ?? null }).pipe(
            Effect.catchTags({
              ConstraintViolation: (e) => new DbError({ message: "Database error", cause: e }),
              RowNotFound: (e) => new DbError({ message: "Database error", cause: e }),
            })
          );
          yield* Effect.logInfo(`[Swimlane] Created ${lane.id} in project ${lane.projectId}`);
          return lane;
        }),

      findByProject: (projectId: string, opts?: { includeArchived?: boolean }): Effect.Effect<Swimlane[], ProjectNotFound | DbError> =>
        Effect.gen(function* () {
          yield* projectRepo.findById(projectId).pipe(
            Effect.catchTag("RowNotFound", () => new ProjectNotFound({ identifier: projectId }))
          );
          const lanes = yield* repo.findByProject(projectId);
          return opts?.includeArchived ? lanes : lanes.filter((l) => !l.archivedAt);
        }),

      getById: (id: string): Effect.Effect<Swimlane, SwimlaneNotFound | DbError> =>
        repo.findById(id).pipe(Effect.catchTag("RowNotFound", () => new SwimlaneNotFound({ id }))),

      update: (id: string, input: { name?: string; description?: string; position?: number; dueAt?: string | null }): Effect.Effect<Swimlane, SwimlaneNotFound | BacklogProtected | DeadlineAfterLane | DbError> =>
        Effect.gen(function* () {
          const lane = yield* repo.findById(id).pipe(Effect.catchTag("RowNotFound", () => new SwimlaneNotFound({ id })));
          if (lane.kind === "backlog" && input.dueAt !== undefined)
            return yield* new BacklogProtected({ action: "deadline" });
          if (input.dueAt !== undefined && input.dueAt !== null) {
            const overage = yield* repo.countDueAfter(id, input.dueAt);
            if (overage > 0) {
              const first = yield* repo.findFirstDueAfter(id, input.dueAt);
              return yield* new DeadlineAfterLane({
                date: input.dueAt,
                taskId: first?.id,
                taskTitle: first?.title,
              });
            }
          }
          return yield* repo.update(id, input).pipe(
            Effect.catchTags({
              RowNotFound: () => new SwimlaneNotFound({ id }),
              ConstraintViolation: (e) => new DbError({ message: "Database error", cause: e }),
            }),
            Effect.tap((lane) => Effect.logInfo(`[Swimlane] Updated ${lane.id}`))
          );
        }),

      delete: (id: string): Effect.Effect<void, SwimlaneNotFound | HasChildren | DbError> =>
        Effect.gen(function* () {
          yield* repo.findById(id).pipe(Effect.catchTag("RowNotFound", () => new SwimlaneNotFound({ id })));
          const count = yield* repo.countTasks(id);
          if (count > 0) return yield* new HasChildren({ count });
          yield* repo.delete(id).pipe(
            Effect.catchTag("ConstraintViolation", (e) => new DbError({ message: "Database error", cause: e }))
          );
          yield* Effect.logInfo(`[Swimlane] Deleted ${id}`);
          return;
        }),

      archive: (actor: Actor, id: string): Effect.Effect<{ lane: Swimlane; activity: ActivityEvent[] },
        SwimlaneNotFound | BacklogProtected | TaskNotFound | DbError | ConstraintViolation> =>
        Effect.gen(function* () {
          const lane = yield* repo.findById(id).pipe(Effect.catchTag("RowNotFound", () => new SwimlaneNotFound({ id })));
          if (lane.kind === "backlog") return yield* new BacklogProtected({ action: "archive" });
          if (lane.archivedAt) return { lane, activity: [] };   // idempotent
          const done = yield* withTx(db, Effect.gen(function* () {
            const a = yield* repo.setArchived(id, new Date().toISOString()).pipe(
              Effect.catchTag("RowNotFound", (e) => new DbError({ message: "Database error", cause: e }))
            );
            const tasks = yield* taskRepo.findBySwimlane(id);   // live tasks in lane
            const events: ActivityEvent[] = [];
            for (const t of tasks) {
              yield* taskRepo.setArchived(t.id, a.archivedAt ?? new Date().toISOString()).pipe(
                Effect.catchTag("RowNotFound", (e) => new DbError({ message: "Database error", cause: e }))
              );
              events.push(yield* activityService.append(t.id, actor, "archived", msg.archived(actor.label)));
            }
            return { lane: a, activity: events };
          }));
          yield* Effect.logInfo(`[Swimlane] Archived ${done.lane.id} with ${done.activity.length} tasks`);
          return done;
        }),

      restore: (actor: Actor, id: string): Effect.Effect<{ lane: Swimlane; activity: ActivityEvent[] },
        SwimlaneNotFound | DbError> =>
        Effect.gen(function* () {
          const lane = yield* repo.findById(id).pipe(Effect.catchTag("RowNotFound", () => new SwimlaneNotFound({ id })));
          if (!lane.archivedAt) return { lane, activity: [] };   // idempotent
          const restored = yield* withTx(db, Effect.gen(function* () {
            const r = yield* repo.setArchived(id, null).pipe(
              Effect.catchTag("RowNotFound", () => new SwimlaneNotFound({ id }))
            );
            return { lane: r, activity: [] as ActivityEvent[] };
          }));
          yield* Effect.logInfo(`[Swimlane] Restored ${restored.lane.id}`);
          return restored;
        }),
    };
  }),
}) {}
