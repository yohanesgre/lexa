import { Effect } from "effect";
import { ProjectRepo } from "../repos/project.repo";
import { ColumnRepo } from "../repos/column.repo";
import { SwimlaneRepo } from "../repos/swimlane.repo";
import { FieldConfigRepo } from "../repos/field-config.repo";
import { ConstraintViolation, DbError, RowNotFound } from "../db/database";
import { ProjectNotFound, SlugTaken } from "../api/errors";
import type { Project } from "../../shared/types";

const DEFAULT_COLUMNS = [
  { name: "Todo", color: "#6b7280", position: 1 },
  { name: "In Progress", color: "#3b82f6", position: 2 },
  { name: "Review", color: "#f59e0b", position: 3 },
  { name: "Done", color: "#10b981", position: 4 },
  { name: "Blocked", color: "#ef4444", position: 5 },
];

export class ProjectService extends Effect.Service<ProjectService>()("Lexa/ProjectService", {
  dependencies: [ProjectRepo.Default, ColumnRepo.Default, SwimlaneRepo.Default, FieldConfigRepo.Default],
  effect: Effect.gen(function* () {
    const repo = yield* ProjectRepo;
    const columnRepo = yield* ColumnRepo;
    const swimlaneRepo = yield* SwimlaneRepo;
    const fieldConfigRepo = yield* FieldConfigRepo;

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
            Effect.tap((project) =>
              Effect.all([
                ...DEFAULT_COLUMNS.map((col) =>
                  columnRepo.create({
                    id: crypto.randomUUID(),
                    projectId: project.id,
                    name: col.name,
                    position: col.position,
                    color: col.color,
                  })
                ),
                swimlaneRepo.create({
                  id: crypto.randomUUID(),
                  projectId: project.id,
                  name: "Default",
                  position: 0,
                }),
                fieldConfigRepo.seedDefaults(project.id),
              ])
            ),
            Effect.tap((project) => Effect.logInfo(`[Project] Created ${project.id} slug=${project.slug}`)),
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
          yield* repo.delete(project.id).pipe(
            Effect.catchTag("ConstraintViolation", () => new ProjectNotFound({ identifier: slug }))
          );
          yield* Effect.logInfo(`[Project] Deleted ${project.id}`);
          return;
        }),
    };
  }),
}) {}
