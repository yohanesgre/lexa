import { Effect } from "effect";
import { ProjectRepo } from "../repos/project.repo";
import { ConstraintViolation, DbError, RowNotFound } from "../db/d1";
import { ProjectNotFound, SlugTaken } from "../api/errors";
import type { Project } from "../../shared/types";

export class ProjectService extends Effect.Service<ProjectService>()("Lexa/ProjectService", {
  dependencies: [ProjectRepo.Default],
  effect: Effect.gen(function* () {
    const repo = yield* ProjectRepo;

    const slugify = (name: string): string =>
      name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "project";

    return {
      create: (input: { name: string; slug?: string; description?: string; githubRepo?: string | null }): Effect.Effect<Project, SlugTaken | DbError | RowNotFound> => {
        const slug = input.slug || slugify(input.name);
        const id = crypto.randomUUID();
        return repo
          .create({ id, name: input.name, slug, description: input.description ?? "", githubRepo: input.githubRepo ?? null })
          .pipe(
            Effect.flatMap(() => repo.findBySlug(slug)),
            Effect.catchTag("ConstraintViolation", () => new SlugTaken({ slug })),
            Effect.catchTag("RowNotFound", () => new SlugTaken({ slug }))
          );
      },

      findBySlug: (slug: string): Effect.Effect<Project, ProjectNotFound | DbError> =>
        repo.findBySlug(slug).pipe(Effect.catchTag("RowNotFound", () => new ProjectNotFound({ identifier: slug }))),

      findById: (id: string): Effect.Effect<Project, ProjectNotFound | DbError> =>
        repo.findById(id).pipe(Effect.catchTag("RowNotFound", () => new ProjectNotFound({ identifier: id }))),

      list: (): Effect.Effect<Project[], DbError> => repo.list(),

      update: (slug: string, input: { name?: string; description?: string; githubRepo?: string | null }): Effect.Effect<Project, ProjectNotFound | DbError> =>
        Effect.gen(function* () {
          const project = yield* repo.findBySlug(slug).pipe(
            Effect.catchTag("RowNotFound", () => new ProjectNotFound({ identifier: slug }))
          );
          return yield* repo.update(project.id, input).pipe(
            Effect.catchTag("RowNotFound", () => new ProjectNotFound({ identifier: slug })),
            Effect.catchTag("ConstraintViolation", () => new ProjectNotFound({ identifier: slug }))
          );
        }),

      delete: (slug: string): Effect.Effect<void, ProjectNotFound | DbError> =>
        Effect.gen(function* () {
          const project = yield* repo.findBySlug(slug).pipe(
            Effect.catchTag("RowNotFound", () => new ProjectNotFound({ identifier: slug }))
          );
          return yield* repo.delete(project.id).pipe(
            Effect.catchTag("ConstraintViolation", () => new ProjectNotFound({ identifier: slug }))
          );
        }),
    };
  }),
}) {}
