import { Effect } from "effect";
import { ProjectRepo } from "../repos/project.repo";
import { ProjectReposRepo } from "../repos/project-repos.repo";
import { ColumnRepo } from "../repos/column.repo";
import { SwimlaneRepo } from "../repos/swimlane.repo";
import { FieldConfigRepo } from "../repos/field-config.repo";
import { ConstraintViolation, DbError, RowNotFound, Sqlite, withTx } from "../db/database";
import { ProjectNotFound, SlugTaken } from "../api/errors";
import { generateTaskKey } from "../task-key";
import type { DomainProject, ProjectRepo as ProjectRepoType } from "../../shared/types";

const DEFAULT_COLUMNS = [
  { name: "Todo", color: "#6b7280", position: 1 },
  { name: "In Progress", color: "#3b82f6", position: 2 },
  { name: "Review", color: "#f59e0b", position: 3 },
  { name: "Done", color: "#10b981", position: 4 },
  { name: "Blocked", color: "#ef4444", position: 5 },
];

export class ProjectService extends Effect.Service<ProjectService>()("Lexa/ProjectService", {
  dependencies: [ProjectRepo.Default, ProjectReposRepo.Default, ColumnRepo.Default, SwimlaneRepo.Default, FieldConfigRepo.Default],
  effect: Effect.gen(function* () {
    const repo = yield* ProjectRepo;
    const reposRepo = yield* ProjectReposRepo;
    const columnRepo = yield* ColumnRepo;
    const swimlaneRepo = yield* SwimlaneRepo;
    const fieldConfigRepo = yield* FieldConfigRepo;
    const db = yield* Sqlite;

    const slugify = (name: string): string =>
      name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "project";

    return {
      create: (input: { name: string; slug?: string; description?: string; teamId?: string | null }): Effect.Effect<DomainProject, SlugTaken | DbError | RowNotFound> => {
        const slug = input.slug || slugify(input.name);
        const id = crypto.randomUUID();
        const doCreate = Effect.gen(function* () {
          const taken = new Set((yield* repo.listKeys()).map((k) => k));
          const key = generateTaskKey(slug, (c) => taken.has(c));
          return yield* repo
            .create({ id, name: input.name, slug, key, description: input.description ?? "", teamId: input.teamId ?? null })
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
                    name: "Backlog",
                    position: 0,
                    kind: "backlog",
                  }),
                  fieldConfigRepo.seedDefaults(project.id),
                ])
              )
            );
        });
        return withTx(db, doCreate).pipe(
          // Key collision race — regenerate once (slug collisions fall through
          // to SlugTaken below).
          Effect.catchIf(
            (e) => e instanceof ConstraintViolation,
            () => withTx(db, doCreate)
          ),
          Effect.tap((project) => Effect.logInfo(`[Project] Created ${project.id} slug=${project.slug}`)),
          Effect.catchTag("ConstraintViolation", () => new SlugTaken({ slug })),
          Effect.catchTag("RowNotFound", () => new SlugTaken({ slug }))
        );
      },

      findBySlug: (slug: string): Effect.Effect<DomainProject, ProjectNotFound | DbError> =>
        repo.findBySlug(slug).pipe(Effect.catchTag("RowNotFound", () => new ProjectNotFound({ identifier: slug }))),

      findById: (id: string): Effect.Effect<DomainProject, ProjectNotFound | DbError> =>
        repo.findById(id).pipe(Effect.catchTag("RowNotFound", () => new ProjectNotFound({ identifier: id }))),

      list: (): Effect.Effect<DomainProject[], DbError> => repo.list(),

      update: (slug: string, input: { name?: string; description?: string }): Effect.Effect<DomainProject, ProjectNotFound | SlugTaken | DbError> =>
        Effect.gen(function* () {
          const project = yield* repo.findBySlug(slug).pipe(
            Effect.catchTag("RowNotFound", () => new ProjectNotFound({ identifier: slug }))
          );
          return yield* repo.update(project.id, input).pipe(
            Effect.catchTag("RowNotFound", () => new ProjectNotFound({ identifier: slug })),
            Effect.catchTag("ConstraintViolation", () => new SlugTaken({ slug }))
          );
        }),

      // Team assignment (superadmin any team / team admin own team; null =
      // unassigned). The gate lives in the API layer — this is the data op.
      setTeam: (projectId: string, teamId: string | null): Effect.Effect<DomainProject, ProjectNotFound | DbError | ConstraintViolation> =>
        repo.update(projectId, { teamId }).pipe(
          Effect.catchTag("RowNotFound", () => new ProjectNotFound({ identifier: projectId }))
        ),

      listRepos: (slug: string): Effect.Effect<ProjectRepoType[], ProjectNotFound | DbError> =>
        Effect.gen(function* () {
          const project = yield* repo.findBySlug(slug).pipe(
            Effect.catchTag("RowNotFound", () => new ProjectNotFound({ identifier: slug }))
          );
          return yield* reposRepo.listByProject(project.id);
        }),

      replaceRepos: (slug: string, repos: { repo: string; sourceRole: boolean; workspaceRole: boolean }[]): Effect.Effect<ProjectRepoType[], ProjectNotFound | ConstraintViolation | DbError> =>
        Effect.gen(function* () {
          const project = yield* repo.findBySlug(slug).pipe(
            Effect.catchTag("RowNotFound", () => new ProjectNotFound({ identifier: slug }))
          );
          yield* reposRepo.replace(project.id, repos);
          return yield* reposRepo.listByProject(project.id);
        }),

      delete: (slug: string): Effect.Effect<void, ProjectNotFound | SlugTaken | DbError> =>
        Effect.gen(function* () {
          const project = yield* repo.findBySlug(slug).pipe(
            Effect.catchTag("RowNotFound", () => new ProjectNotFound({ identifier: slug }))
          );
          yield* repo.delete(project.id).pipe(
            Effect.catchTag("ConstraintViolation", () => new SlugTaken({ slug }))
          );
          yield* Effect.logInfo(`[Project] Deleted ${project.id}`);
          return;
        }),
    };
  }),
}) {}
