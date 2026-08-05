import { Effect } from "effect";
import { WikiRepo } from "../repos/wiki.repo";
import { ProjectRepo } from "../repos/project.repo";
import { ConstraintViolation, DbError, RowNotFound, Sqlite, run, withTx } from "../db/database";
import { ProjectNotFound, WikiPageNotFound, SlugTaken, HasChildren, SearchError } from "../api/errors";
import type { WikiPage, WikiPageMeta, WikiPageRevision, WikiPageRevisionSummary } from "../../shared/types";
import type { TipTapDoc } from "../../shared/types";
import { extractText } from "../../shared/tiptap-text";

export class WikiService extends Effect.Service<WikiService>()("Lexa/WikiService", {
  dependencies: [WikiRepo.Default, ProjectRepo.Default],
  effect: Effect.gen(function* () {
    const repo = yield* WikiRepo;
    const projectRepo = yield* ProjectRepo;
    const db = yield* Sqlite;

    const slugify = (title: string): string =>
      title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "page";

    const validateProject = (projectId: string) =>
      projectRepo.findById(projectId).pipe(
        Effect.catchTag("RowNotFound", () => Effect.fail(new ProjectNotFound({ identifier: projectId })))
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
          const page = yield* repo
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
          yield* Effect.logInfo(`[Wiki] Created page ${page.id} in project ${page.projectId}`);
          return page;
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
      ): Effect.Effect<(WikiPage & { snippet: string })[], ProjectNotFound | DbError | SearchError> =>
        Effect.gen(function* () {
          yield* validateProject(projectId);
          // FTS5 operator syntax (quotes, NEAR/, unbalanced parens) makes
          // SQLite throw — map to a generic 422 instead of leaking a 500.
          return yield* Effect.catchTag(
            repo.search(projectId, query, limit),
            "DbError",
            () => Effect.fail(new SearchError())
          );
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
        },
        saveType: "autosave" | "manual" = "autosave"
      ): Effect.Effect<WikiPage, WikiPageNotFound | DbError | ConstraintViolation> =>
        Effect.gen(function* () {
          const current = yield* repo.findById(id).pipe(
            Effect.catchTag("RowNotFound", () => new WikiPageNotFound({ id }))
          );
          const updated = yield* withTx(
            db,
            Effect.gen(function* () {
              yield* repo.createRevision(
                current.id,
                current.title,
                current.slug,
                JSON.stringify(current.content),
                extractText(current.content),
                saveType
              );
              // Prune: keep the newest 100 revisions per page (same tx as
              // the insert — no unbounded revision growth).
              yield* run(
                db,
                `DELETE FROM wiki_page_revisions WHERE page_id = ? AND id NOT IN
                   (SELECT id FROM wiki_page_revisions WHERE page_id = ?
                    ORDER BY created_at DESC, id DESC LIMIT 100)`,
                current.id,
                current.id
              );
              return yield* repo.update(id, input).pipe(
                Effect.catchTag("RowNotFound", () => new WikiPageNotFound({ id }))
              );
            })
          );
          yield* Effect.logInfo(`[Wiki] Updated page ${updated.id}`);
          return updated;
        }),

      saveRevision: (
        pageId: string,
        saveType: "autosave" | "manual"
      ): Effect.Effect<WikiPageRevision, WikiPageNotFound | DbError | ConstraintViolation> =>
        Effect.gen(function* () {
          const page = yield* repo.findById(pageId).pipe(
            Effect.catchTag("RowNotFound", () => new WikiPageNotFound({ id: pageId }))
          );
          const revision = yield* repo.createRevision(
            page.id,
            page.title,
            page.slug,
            JSON.stringify(page.content),
            extractText(page.content),
            saveType
          );
          yield* Effect.logInfo(`[Wiki] Saved revision for page ${page.id}`);
          return revision;
        }),

      listRevisions: (
        pageSlug: string,
        projectId: string,
        limit?: number
      ): Effect.Effect<WikiPageRevisionSummary[], ProjectNotFound | WikiPageNotFound | DbError> =>
        Effect.gen(function* () {
          yield* validateProject(projectId);
          const page = yield* repo.findBySlug(projectId, pageSlug).pipe(
            Effect.catchTag("RowNotFound", () => new WikiPageNotFound({ id: pageSlug }))
          );
          return yield* repo.listRevisions(page.id, limit);
        }),

      restoreRevision: (
        revisionId: string,
        pageSlug: string,
        projectId: string
      ): Effect.Effect<WikiPage, ProjectNotFound | WikiPageNotFound | DbError | ConstraintViolation> =>
        Effect.gen(function* () {
          yield* validateProject(projectId);
          const page = yield* repo.findBySlug(projectId, pageSlug).pipe(
            Effect.catchTag("RowNotFound", () => new WikiPageNotFound({ id: pageSlug }))
          );
          const revision = yield* repo.getRevision(revisionId).pipe(
            Effect.catchTag("RowNotFound", () => new WikiPageNotFound({ id: revisionId }))
          );
          if (revision.pageId !== page.id) {
            return yield* new WikiPageNotFound({ id: revisionId });
          }
          yield* Effect.logInfo(`[Wiki] Restored revision ${revisionId} for page ${page.id}`);
          return yield* withTx(
            db,
            Effect.gen(function* () {
              yield* repo.update(page.id, {
                title: revision.title,
                slug: revision.slug,
                content: JSON.stringify(revision.content),
                contentText: revision.contentText,
              }).pipe(
                Effect.catchTag("RowNotFound", () => new WikiPageNotFound({ id: page.id }))
              );
              yield* repo.createRevision(
                page.id,
                revision.title,
                revision.slug,
                JSON.stringify(revision.content),
                revision.contentText,
                "manual"
              );
              return yield* repo.findById(page.id).pipe(
                Effect.catchTag("RowNotFound", () => new WikiPageNotFound({ id: page.id }))
              );
            })
          );
        }),

      getById: (id: string): Effect.Effect<WikiPage, WikiPageNotFound | DbError> =>
        repo.findById(id).pipe(
          Effect.catchTag("RowNotFound", () => new WikiPageNotFound({ id }))
        ),

      getRevision: (id: string): Effect.Effect<WikiPageRevision, WikiPageNotFound | DbError> =>
        repo.getRevision(id).pipe(
          Effect.catchTag("RowNotFound", () => new WikiPageNotFound({ id }))
        ),

      delete: (id: string): Effect.Effect<void, WikiPageNotFound | HasChildren | DbError> =>
        Effect.gen(function* () {
          yield* repo.findById(id).pipe(
            Effect.catchTag("RowNotFound", () => new WikiPageNotFound({ id }))
          );
          const count = yield* repo.countChildren(id);
          if (count > 0) return yield* new HasChildren({ count });
          yield* repo.delete(id).pipe(
            Effect.catchTag("ConstraintViolation", () => new HasChildren({ count: -1 }))
          );
          yield* Effect.logInfo(`[Wiki] Deleted page ${id}`);
          return;
        }),
    };
  }),
}) {}
