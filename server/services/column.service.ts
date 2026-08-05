import { Effect } from "effect";
import { ColumnRepo } from "../repos/column.repo";
import { ProjectRepo } from "../repos/project.repo";
import { DbError, RowNotFound, ConstraintViolation } from "../db/database";
import { ProjectNotFound, ColumnNotFound, HasChildren } from "../api/errors";
import type { Column } from "../../shared/types";

export class ColumnService extends Effect.Service<ColumnService>()("Lexa/ColumnService", {
  dependencies: [ColumnRepo.Default, ProjectRepo.Default],
  effect: Effect.gen(function* () {
    const repo = yield* ColumnRepo;
    const projectRepo = yield* ProjectRepo;

    return {
      create: (input: {
        projectId: string;
        name: string;
        wipLimit?: number | null;
        requiredFields?: string[];
        color?: string;
        githubState?: "open" | "closed" | null;
      }): Effect.Effect<Column, ProjectNotFound | DbError | ConstraintViolation | RowNotFound> =>
        Effect.gen(function* () {
          yield* projectRepo.findById(input.projectId).pipe(
            Effect.catchTag("RowNotFound", () => new ProjectNotFound({ identifier: input.projectId }))
          );
          const maxPos = yield* repo.maxPosition(input.projectId);
          const id = crypto.randomUUID();
          const col = yield* repo.create({
            id,
            projectId: input.projectId,
            name: input.name,
            position: maxPos + 1,
            wipLimit: input.wipLimit,
            requiredFields: input.requiredFields,
            color: input.color,
            githubState: input.githubState,
          });
          yield* Effect.logInfo(`[Column] Created ${col.id} in project ${col.projectId}`);
          return col;
        }),

      findByProject: (projectId: string): Effect.Effect<Column[], ProjectNotFound | DbError> =>
        Effect.gen(function* () {
          yield* projectRepo.findById(projectId).pipe(
            Effect.catchTag("RowNotFound", () => new ProjectNotFound({ identifier: projectId }))
          );
          return yield* repo.findByProject(projectId);
        }),

      getById: (id: string): Effect.Effect<Column, ColumnNotFound | DbError> =>
        repo.findById(id).pipe(Effect.catchTag("RowNotFound", () => new ColumnNotFound({ id }))),

      update: (
        id: string,
        input: {
          name?: string;
          wipLimit?: number | null;
          requiredFields?: string[];
          color?: string;
          position?: number;
          githubState?: "open" | "closed" | null;
        }
      ): Effect.Effect<Column, ColumnNotFound | DbError | ConstraintViolation> =>
        repo.update(id, input).pipe(
          Effect.catchTag("RowNotFound", () => new ColumnNotFound({ id })),
          Effect.tap((col) => Effect.logInfo(`[Column] Updated ${col.id}`))
        ),

      delete: (id: string): Effect.Effect<void, ColumnNotFound | HasChildren | DbError> =>
        Effect.gen(function* () {
          yield* repo.findById(id).pipe(
            Effect.catchTag("RowNotFound", () => new ColumnNotFound({ id }))
          );
          const count = yield* repo.countTasks(id);
          if (count > 0) return yield* new HasChildren({ count });
          yield* repo.delete(id).pipe(
            Effect.catchTag("ConstraintViolation", () => new HasChildren({ count: -1 }))
          );
          yield* Effect.logInfo(`[Column] Deleted ${id}`);
          return;
        }),
    };
  }),
}) {}
