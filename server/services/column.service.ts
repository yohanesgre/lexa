import { Effect } from "effect";
import { ColumnRepo } from "../repos/column.repo";
import { ProjectRepo } from "../repos/project.repo";
import { D1, queryAll, DbError, RowNotFound, ConstraintViolation } from "../db/d1";
import { ProjectNotFound, ColumnNotFound, HasChildren } from "../api/errors";
import type { Column } from "../../shared/types";

export class ColumnService extends Effect.Service<ColumnService>()("Lexa/ColumnService", {
  dependencies: [ColumnRepo.Default, ProjectRepo.Default],
  effect: Effect.gen(function* () {
    const repo = yield* ColumnRepo;
    const projectRepo = yield* ProjectRepo;
    const db = yield* D1;

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
          return yield* repo.create({
            id,
            projectId: input.projectId,
            name: input.name,
            position: maxPos + 1,
            wipLimit: input.wipLimit,
            requiredFields: input.requiredFields,
            color: input.color,
            githubState: input.githubState,
          });
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
        repo.update(id, input).pipe(Effect.catchTag("RowNotFound", () => new ColumnNotFound({ id }))),

      delete: (id: string): Effect.Effect<void, ColumnNotFound | HasChildren | DbError> =>
        Effect.gen(function* () {
          yield* repo.findById(id).pipe(
            Effect.catchTag("RowNotFound", () => new ColumnNotFound({ id }))
          );
          const rows = yield* queryAll<{ c: number }>(
            db,
            `SELECT COUNT(*) as c FROM tasks WHERE column_id = ?`,
            id
          );
          const count = rows[0]?.c ?? 0;
          if (count > 0) return yield* new HasChildren({ count });
          return yield* repo.delete(id).pipe(
            Effect.catchTag("ConstraintViolation", () => new HasChildren({ count: -1 }))
          );
        }),
    };
  }),
}) {}
