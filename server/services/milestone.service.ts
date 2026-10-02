import { Effect } from "effect";
import { MilestoneRepo } from "../repos/milestone.repo";
import { SwimlaneRepo } from "../repos/swimlane.repo";
import { TaskRepo } from "../repos/task.repo";
import { ProjectRepo } from "../repos/project.repo";
import { ActivityService } from "./activity.service";
import { DbError, ConstraintViolation, batchResults, Db } from "../db/db";
import { ProjectNotFound, MilestoneNotFound, HasChildren, TaskNotFound } from "../api/errors";
import * as msg from "../activity-messages";
import { buildMilestoneArchiveBatch, activityFromBatchResults } from "../repos/cascade-batch";
import type { Milestone, Actor, ActivityEvent } from "../../shared/types";

export class MilestoneService extends Effect.Service<MilestoneService>()("Lexa/MilestoneService", {
  dependencies: [MilestoneRepo.Default, SwimlaneRepo.Default, TaskRepo.Default, ProjectRepo.Default, ActivityService.Default],
  effect: Effect.gen(function* () {
    const repo = yield* MilestoneRepo;
    const projectRepo = yield* ProjectRepo;
    const db = yield* Db;

    return {
      create: (input: { projectId: string; name: string; description?: string; dueAt?: string | null }): Effect.Effect<Milestone, ProjectNotFound | DbError> =>
        Effect.gen(function* () {
          yield* projectRepo.findById(input.projectId).pipe(
            Effect.catchTag("RowNotFound", () => new ProjectNotFound({ identifier: input.projectId }))
          );
          const maxPos = yield* repo.maxPosition(input.projectId);
          const id = crypto.randomUUID();
          const milestone = yield* repo.create({ id, projectId: input.projectId, name: input.name, ...(input.description !== undefined ? { description: input.description } : {}), position: maxPos + 1, dueAt: input.dueAt ?? null }).pipe(
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

      archive: (actor: Actor, id: string, opts?: { viaAssistant?: boolean }): Effect.Effect<{ milestone: Milestone; activity: ActivityEvent[] },
        MilestoneNotFound | TaskNotFound | DbError | ConstraintViolation> =>
        Effect.gen(function* () {
          const milestone = yield* repo.findById(id).pipe(Effect.catchTag("RowNotFound", () => new MilestoneNotFound({ id })));
          if (milestone.archivedAt) return { milestone, activity: [] };   // idempotent
          const archivedAt = new Date().toISOString();
          // One set-based atomic batch: activity rows for every live task in
          // every sprint of the milestone, then the task + sprint + milestone
          // archive updates. Constant statement count.
          const results = yield* batchResults(db, buildMilestoneArchiveBatch({
            milestoneId: id,
            archivedAt,
            actor: {
              actorKind: actor.kind,
              actorLabel: actor.label,
              actorUserId: actor.userId ?? null,
              message: msg.archived(actor.label),
              viaAssistant: opts?.viaAssistant === true,
            },
          }));
          const activity = activityFromBatchResults(results[0]?.results ?? []);
          const updated = yield* repo.findById(id).pipe(
            Effect.catchTag("RowNotFound", (e) => new DbError({ message: "Database error", cause: e }))
          );
          yield* Effect.logInfo(`[Milestone] Archived ${updated.id} (${activity.length} activity rows)`);
          return { milestone: updated, activity };
        }),

      restore: (actor: Actor, id: string): Effect.Effect<{ milestone: Milestone; activity: ActivityEvent[] },
        MilestoneNotFound | DbError> =>
        Effect.gen(function* () {
          const milestone = yield* repo.findById(id).pipe(Effect.catchTag("RowNotFound", () => new MilestoneNotFound({ id })));
          if (!milestone.archivedAt) return { milestone, activity: [] };   // idempotent
          // Single statement — already atomic; no withTx needed.
          const r = yield* repo.setArchived(id, null).pipe(
            Effect.catchTag("RowNotFound", () => new MilestoneNotFound({ id }))
          );
          yield* Effect.logInfo(`[Milestone] Restored ${r.id}`);
          return { milestone: r, activity: [] as ActivityEvent[] };
        }),
    };
  }),
}) {}
