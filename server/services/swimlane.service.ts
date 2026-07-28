import { Effect } from "effect";
import { SwimlaneRepo } from "../repos/swimlane.repo";
import { ProjectRepo } from "../repos/project.repo";
import { DbError, D1, queryAll } from "../db/d1";
import { ProjectNotFound, SwimlaneNotFound, HasChildren } from "../api/errors";
import type { Swimlane } from "../../shared/types";

export class SwimlaneService extends Effect.Service<SwimlaneService>()("Lexa/SwimlaneService", {
  dependencies: [SwimlaneRepo.Default, ProjectRepo.Default],
  effect: Effect.gen(function* () {
    const repo = yield* SwimlaneRepo;
    const projectRepo = yield* ProjectRepo;
    const db = yield* D1;

    return {
      create: (input: { projectId: string; name: string; description?: string }): Effect.Effect<Swimlane, ProjectNotFound | DbError> =>
        Effect.gen(function* () {
          yield* projectRepo.findById(input.projectId).pipe(
            Effect.catchTag("RowNotFound", () => new ProjectNotFound({ identifier: input.projectId }))
          );
          const maxPos = yield* repo.maxPosition(input.projectId);
          const id = crypto.randomUUID();
          return yield* repo.create({ id, projectId: input.projectId, name: input.name, description: input.description, position: maxPos + 1 }).pipe(
            Effect.catchTags({
              ConstraintViolation: (e) => new DbError({ message: e.message, cause: e }),
              RowNotFound: (e) => new DbError({ message: e.message, cause: e }),
            })
          );
        }),

      findByProject: (projectId: string): Effect.Effect<Swimlane[], ProjectNotFound | DbError> =>
        Effect.gen(function* () {
          yield* projectRepo.findById(projectId).pipe(
            Effect.catchTag("RowNotFound", () => new ProjectNotFound({ identifier: projectId }))
          );
          return yield* repo.findByProject(projectId);
        }),

      getById: (id: string): Effect.Effect<Swimlane, SwimlaneNotFound | DbError> =>
        repo.findById(id).pipe(Effect.catchTag("RowNotFound", () => new SwimlaneNotFound({ id }))),

      update: (id: string, input: { name?: string; description?: string; position?: number }): Effect.Effect<Swimlane, SwimlaneNotFound | DbError> =>
        repo.update(id, input).pipe(
          Effect.catchTags({
            RowNotFound: () => new SwimlaneNotFound({ id }),
            ConstraintViolation: (e) => new DbError({ message: e.message, cause: e }),
          })
        ),

      delete: (id: string): Effect.Effect<void, SwimlaneNotFound | HasChildren | DbError> =>
        Effect.gen(function* () {
          yield* repo.findById(id).pipe(Effect.catchTag("RowNotFound", () => new SwimlaneNotFound({ id })));
          const rows = yield* queryAll<{ c: number }>(db, `SELECT COUNT(*) as c FROM tasks WHERE swimlane_id = ?`, id);
          const count = rows[0]?.c ?? 0;
          if (count > 0) return yield* new HasChildren({ count });
          return yield* repo.delete(id).pipe(
            Effect.catchTag("ConstraintViolation", (e) => new DbError({ message: e.message, cause: e }))
          );
        }),
    };
  }),
}) {}
