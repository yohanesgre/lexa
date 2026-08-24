import { Effect } from "effect";
import { MilestoneRepo } from "../repos/milestone.repo";
import { SwimlaneRepo } from "../repos/swimlane.repo";
import { TaskRepo } from "../repos/task.repo";
import { ProjectRepo } from "../repos/project.repo";
import { ActivityService } from "./activity.service";
import { DbError, ConstraintViolation, withTx, Sqlite } from "../db/database";
import { ProjectNotFound, MilestoneNotFound, HasChildren, TaskNotFound } from "../api/errors";
import * as msg from "../activity-messages";
import type { Milestone, Actor, ActivityEvent } from "../../shared/types";

export class MilestoneService extends Effect.Service<MilestoneService>()("Lexa/MilestoneService", {
  dependencies: [MilestoneRepo.Default, SwimlaneRepo.Default, TaskRepo.Default, ProjectRepo.Default, ActivityService.Default],
  effect: Effect.gen(function* () {
    const repo = yield* MilestoneRepo;
    const swimlaneRepo = yield* SwimlaneRepo;
    const taskRepo = yield* TaskRepo;
    const projectRepo = yield* ProjectRepo;
    const activityService = yield* ActivityService;
    const db = yield* Sqlite;

    return {
      create: (input: { projectId: string; name: string; description?: string; dueAt?: string | null }): Effect.Effect<Milestone, ProjectNotFound | DbError> =>
        Effect.gen(function* () {
          yield* projectRepo.findById(input.projectId).pipe(
            Effect.catchTag("RowNotFound", () => new ProjectNotFound({ identifier: input.projectId }))
          );
          const maxPos = yield* repo.maxPosition(input.projectId);
          const id = crypto.randomUUID();
          const milestone = yield* repo.create({ id, projectId: input.projectId, name: input.name, description: input.description, position: maxPos + 1, dueAt: input.dueAt ?? null }).pipe(
            Effect.catchTags({
              ConstraintViolation: (e) => new DbError({ message: "Database error", cause: e }),
              RowNotFound: (e) => new DbError({ message: "Database error", cause: e }),
            })
          );
          yield* Effect.logInfo(`[Milestone] Created ${milestone.id} in project ${milestone.projectId}`);
          return milestone;
        }),

      findByProject: (projectId: string, opts?: { includeArchived?: boolean }): Effect.Effect<Milestone[], ProjectNotFound | DbError> =>
        Effect.gen(function* () {
          yield* projectRepo.findById(projectId).pipe(
            Effect.catchTag("RowNotFound", () => new ProjectNotFound({ identifier: projectId }))
          );
          const milestones = yield* repo.findByProject(projectId);
          return opts?.includeArchived ? milestones : milestones.filter((m) => !m.archivedAt);
        }),

      getById: (id: string): Effect.Effect<Milestone, MilestoneNotFound | DbError> =>
        repo.findById(id).pipe(Effect.catchTag("RowNotFound", () => new MilestoneNotFound({ id }))),

      update: (id: string, input: { name?: string; description?: string; position?: number; dueAt?: string | null }): Effect.Effect<Milestone, MilestoneNotFound | DbError | ConstraintViolation> =>
        repo.update(id, input).pipe(
          Effect.catchTag("RowNotFound", () => new MilestoneNotFound({ id })),
          Effect.tap((m) => Effect.logInfo(`[Milestone] Updated ${m.id}`))
        ),

      delete: (id: string): Effect.Effect<void, MilestoneNotFound | HasChildren | DbError> =>
        Effect.gen(function* () {
          yield* repo.findById(id).pipe(Effect.catchTag("RowNotFound", () => new MilestoneNotFound({ id })));
          const count = yield* repo.countSprints(id);
          if (count > 0) return yield* new HasChildren({ count });
          yield* repo.delete(id).pipe(
            Effect.catchTag("ConstraintViolation", (e) => new DbError({ message: "Database error", cause: e }))
          );
          yield* Effect.logInfo(`[Milestone] Deleted ${id}`);
        }),

      archive: (actor: Actor, id: string, opts?: { viaHerald?: boolean }): Effect.Effect<{ milestone: Milestone; activity: ActivityEvent[] },
        MilestoneNotFound | TaskNotFound | DbError | ConstraintViolation> =>
        Effect.gen(function* () {
          const milestone = yield* repo.findById(id).pipe(Effect.catchTag("RowNotFound", () => new MilestoneNotFound({ id })));
          if (milestone.archivedAt) return { milestone, activity: [] };   // idempotent
          const done = yield* withTx(db, Effect.gen(function* () {
            const a = yield* repo.setArchived(id, new Date().toISOString()).pipe(
              Effect.catchTag("RowNotFound", (e) => new DbError({ message: "Database error", cause: e }))
            );
            const sprints = yield* repo.findByMilestone(id);
            const events: ActivityEvent[] = [];
            for (const s of sprints) {
              yield* swimlaneRepo.setArchived(s.id, a.archivedAt ?? new Date().toISOString()).pipe(
                Effect.catchTag("RowNotFound", (e) => new DbError({ message: "Database error", cause: e }))
              );
              const tasks = yield* taskRepo.findBySwimlane(s.id);   // live tasks only
              for (const t of tasks) {
                yield* taskRepo.setArchived(t.id, a.archivedAt ?? new Date().toISOString()).pipe(
                  Effect.catchTag("RowNotFound", (e) => new DbError({ message: "Database error", cause: e }))
                );
                // task_activity.task_id has an FK to tasks(id) — activity rows
                // are emitted per task only (deviation from design doc §5.2's
                // per-sprint/per-milestone rows, which the FK forbids).
                events.push(yield* activityService.append(t.id, actor, "archived", msg.archived(actor.label), { viaHerald: opts?.viaHerald === true }));
              }
            }
            return { milestone: a, activity: events };
          }));
          yield* Effect.logInfo(`[Milestone] Archived ${done.milestone.id} (${done.activity.length} activity rows)`);
          return done;
        }),

      restore: (actor: Actor, id: string): Effect.Effect<{ milestone: Milestone; activity: ActivityEvent[] },
        MilestoneNotFound | DbError> =>
        Effect.gen(function* () {
          const milestone = yield* repo.findById(id).pipe(Effect.catchTag("RowNotFound", () => new MilestoneNotFound({ id })));
          if (!milestone.archivedAt) return { milestone, activity: [] };   // idempotent
          const restored = yield* withTx(db, Effect.gen(function* () {
            const r = yield* repo.setArchived(id, null).pipe(
              Effect.catchTag("RowNotFound", () => new MilestoneNotFound({ id }))
            );
            return { milestone: r, activity: [] as ActivityEvent[] };
          }));
          yield* Effect.logInfo(`[Milestone] Restored ${restored.milestone.id}`);
          return restored;
        }),
    };
  }),
}) {}
