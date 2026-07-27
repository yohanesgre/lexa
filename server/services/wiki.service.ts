import { Effect } from "effect";
import { WikiRepo } from "../repos/wiki.repo";
import { ProjectRepo } from "../repos/project.repo";
import { ConstraintViolation, DbError, RowNotFound } from "../db/d1";
import { ProjectNotFound, WikiPageNotFound, SlugTaken, HasChildren } from "../api/errors";
import type { WikiPage, WikiPageMeta, TipTapDoc } from "../../shared/types";

export class WikiService extends Effect.Service<WikiService>()("Lexa/WikiService", {
  dependencies: [WikiRepo.Default, ProjectRepo.Default],
  effect: Effect.gen(function* () {
    const repo = yield* WikiRepo;
    const projectRepo = yield* ProjectRepo;

    const slugify = (title: string): string =>
      title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "page";

    const validateProject = (projectId: string) =>
      projectRepo.findById(projectId).pipe(
        Effect.catchTag("RowNotFound", () => new ProjectNotFound({ identifier: projectId }))
      );

    return {
      create: (
        projectId: string,
        input: {
          title: string;
          slug?: string;
          content?: TipTapDoc;
          contentText?: string;
          parentId?: string;
        }
      ): Effect.Effect<WikiPage, ProjectNotFound | SlugTaken | DbError | RowNotFound> =>
        Effect.gen(function* () {
          yield* validateProject(projectId);
          const slug = input.slug || slugify(input.title);
          const position = yield* repo.maxPosition(projectId, input.parentId ?? null);
          const id = crypto.randomUUID();
          const contentJson = JSON.stringify(input.content ?? { type: "doc", content: [] });
          const contentText = input.contentText ?? "";
          return yield* repo
            .create({
              id,
              projectId,
              title: input.title,
              slug,
              content: contentJson,
              contentText,
              parentId: input.parentId ?? null,
              position: position + 1,
            })
            .pipe(Effect.catchTag("ConstraintViolation", () => new SlugTaken({ slug })));
        }),

      findByProject: (projectId: string): Effect.Effect<WikiPageMeta[], ProjectNotFound | DbError> =>
        Effect.gen(function* () {
          yield* validateProject(projectId);
          return yield* repo.findByProject(projectId);
        }),

      findBySlug: (
        projectId: string,
        slug: string
      ): Effect.Effect<WikiPage, ProjectNotFound | WikiPageNotFound | DbError> =>
        Effect.gen(function* () {
          yield* validateProject(projectId);
          return yield* repo.findBySlug(projectId, slug).pipe(
            Effect.catchTag("RowNotFound", () => new WikiPageNotFound({ id: slug }))
          );
        }),

      findChildren: (
        projectId: string,
        parentId: string
      ): Effect.Effect<WikiPageMeta[], ProjectNotFound | DbError> =>
        Effect.gen(function* () {
          yield* validateProject(projectId);
          return yield* repo.findChildren(projectId, parentId);
        }),

      search: (
        projectId: string,
        query: string,
        limit?: number
      ): Effect.Effect<(WikiPage & { snippet: string })[], ProjectNotFound | DbError> =>
        Effect.gen(function* () {
          yield* validateProject(projectId);
          return yield* repo.search(projectId, query, limit);
        }),

      update: (
        id: string,
        input: {
          title?: string;
          slug?: string;
          content?: string;
          contentText?: string;
          parentId?: string | null;
          position?: number;
        }
      ): Effect.Effect<WikiPage, WikiPageNotFound | DbError | ConstraintViolation> =>
        repo.update(id, input).pipe(
          Effect.catchTag("RowNotFound", () => new WikiPageNotFound({ id }))
        ),

      getById: (id: string): Effect.Effect<WikiPage, WikiPageNotFound | DbError> =>
        repo.findById(id).pipe(
          Effect.catchTag("RowNotFound", () => new WikiPageNotFound({ id }))
        ),

      delete: (id: string): Effect.Effect<void, WikiPageNotFound | HasChildren | DbError> =>
        Effect.gen(function* () {
          yield* repo.findById(id).pipe(
            Effect.catchTag("RowNotFound", () => new WikiPageNotFound({ id }))
          );
          const count = yield* repo.countChildren(id);
          if (count > 0) return yield* new HasChildren({ count });
          return yield* repo.delete(id).pipe(
            Effect.catchTag("ConstraintViolation", () => new HasChildren({ count: -1 }))
          );
        }),
    };
  }),
}) {}
