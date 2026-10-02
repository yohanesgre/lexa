import { Effect } from "effect";
import { WikiRepo } from "../repos/wiki.repo";
import { ProjectRepo } from "../repos/project.repo";
import { UserRepo } from "../repos/user.repo";
import { ConstraintViolation, DbError, RowNotFound, Db, batch, withTx, type BatchStmt } from "../db/db";
import { ProjectNotFound, WikiPageNotFound, SlugTaken, HasChildren, InvalidParent, SearchError } from "../api/errors";
import type { WikiPage, WikiPageMeta, WikiPageRevision, WikiPageRevisionSummary } from "../../shared/types";
import type { TipTapDoc } from "../../shared/types";
import { extractText } from "../../shared/tiptap-text";

export class WikiService extends Effect.Service<WikiService>()("Lexa/WikiService", {
  dependencies: [WikiRepo.Default, ProjectRepo.Default, UserRepo.Default],
  effect: Effect.gen(function* () {
    const repo = yield* WikiRepo;
    const projectRepo = yield* ProjectRepo;
    const userRepo = yield* UserRepo;
    const db = yield* Db;

    // Resolves the last-save author's display name. Legacy rows (updatedBy
    // null) and deleted users resolve to null.
    const withUpdatedByName = <T extends WikiPageMeta>(page: T): Effect.Effect<T, DbError> =>
      page.updatedBy
        ? userRepo.findById(page.updatedBy).pipe(
            Effect.map((u) => ({ ...page, updatedByName: u.name })),
            Effect.catchTag("RowNotFound", () => Effect.succeed({ ...page, updatedByName: null })),
            Effect.catchAll(() => Effect.succeed({ ...page, updatedByName: null }))
          )
        : Effect.succeed({ ...page, updatedByName: null });

    const slugify = (title: string): string =>
      title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "page";

    // wiki_pages has one UNIQUE(project_id, slug) and one parent FK
    // (parent_id REFERENCES wiki_pages(id)) — narrow the two apart so an
    // FK failure is not reported as a slug conflict.
    const isSlugConflict = (e: ConstraintViolation): boolean =>
      /UNIQUE constraint failed: wiki_pages\..*slug/.test(e.message);
    const isForeignKeyFailure = (e: ConstraintViolation): boolean =>
      /FOREIGN KEY constraint failed/i.test(e.message);

    const validateProject = (projectId: string) =>
      projectRepo.findById(projectId).pipe(
        Effect.catchTag("RowNotFound", () => Effect.fail(new ProjectNotFound({ identifier: projectId })))
      );

    return {
      create: (
        projectId: string,
        input: {
          title: string;
          slug?: string | undefined;
          content?: TipTapDoc | undefined;
          contentText?: string | undefined;
          parentId?: string | null | undefined;
          updatedBy?: string | null | undefined;
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
              updatedBy: input.updatedBy ?? null,
            })
            .pipe(Effect.catchTag("ConstraintViolation", () => new SlugTaken({ slug })));
          yield* Effect.logInfo(`[Wiki] Created page ${page.id} in project ${page.projectId}`);
          return yield* withUpdatedByName(page);
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
            Effect.catchTag("RowNotFound", () => new WikiPageNotFound({ id: slug })),
            Effect.flatMap(withUpdatedByName)
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
        saveType: "autosave" | "manual" = "autosave",
        updatedBy: string | null = null
      ): Effect.Effect<WikiPage, WikiPageNotFound | InvalidParent | SlugTaken | DbError | ConstraintViolation> =>
        withTx(db, Effect.gen(function* () {
          // The cycle-check reads, validation and the write set (revision
          // insert + prune + page update) run inside one `withTx`. On Bun
          // `withTx` is a real BEGIN IMMEDIATE, so the check and the batch are
          // serialized against a reciprocal reparent; on D1 `withTx` is a
          // documented no-op and the batch stays atomic, but the
          // check-vs-write window remains the accepted residual.
          const current = yield* repo.findById(id).pipe(
            Effect.catchTag("RowNotFound", () => new WikiPageNotFound({ id }))
          );
          const nextParentId = input.parentId;
          if (nextParentId !== undefined && nextParentId !== current.parentId) {
            if (nextParentId === id) {
              return yield* new InvalidParent({ reason: "self" });
            }
            if (nextParentId !== null) {
              const parent = yield* repo.findById(nextParentId).pipe(
                Effect.catchTag("RowNotFound", () => new WikiPageNotFound({ id: nextParentId }))
              );
              if (parent.projectId !== current.projectId) {
                return yield* new InvalidParent({ reason: "cross-project" });
              }
              const cycle = yield* repo.isDescendant(nextParentId, id);
              if (cycle) {
                return yield* new InvalidParent({ reason: "cycle" });
              }
            }
          }
          const stmts: BatchStmt[] = [
            repo.createRevisionStmt(
              current.id,
              current.title,
              current.slug,
              JSON.stringify(current.content),
              extractText(current.content),
              saveType
            ),
            // Prune: keep the newest 100 revisions per page (same batch as
            // the insert — no unbounded revision growth).
            repo.pruneRevisionsStmt(current.id),
          ];
          const updateStmt = repo.updateStmt(id, { ...input, updatedBy });
          if (updateStmt) stmts.push(updateStmt);
          yield* batch(db, stmts).pipe(
            Effect.catchIf(
              (e) => e instanceof ConstraintViolation && isSlugConflict(e),
              () => new SlugTaken({ slug: input.slug ?? current.slug })
            ),
            Effect.catchIf(
              (e) => e instanceof ConstraintViolation && isForeignKeyFailure(e),
              () => new WikiPageNotFound({ id })
            )
          );
          const updated = yield* repo.findById(id).pipe(
            Effect.catchTag("RowNotFound", () => new WikiPageNotFound({ id }))
          );
          yield* Effect.logInfo(`[Wiki] Updated page ${updated.id}`);
          return yield* withUpdatedByName(updated);
        })),

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
        projectId: string,
        updatedBy: string | null = null
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
          const stmts: BatchStmt[] = [];
          const updateStmt = repo.updateStmt(page.id, {
            title: revision.title,
            slug: revision.slug,
            content: JSON.stringify(revision.content),
            contentText: revision.contentText,
            updatedBy,
          });
          if (updateStmt) stmts.push(updateStmt);
          stmts.push(repo.createRevisionStmt(
            page.id,
            revision.title,
            revision.slug,
            JSON.stringify(revision.content),
            revision.contentText,
            "manual"
          ));
          yield* batch(db, stmts);
          const restored = yield* repo.findById(page.id).pipe(
            Effect.catchTag("RowNotFound", () => new WikiPageNotFound({ id: page.id }))
          );
          return yield* withUpdatedByName(restored);
        }),

      getById: (id: string): Effect.Effect<WikiPage, WikiPageNotFound | DbError> =>
        repo.findById(id).pipe(
          Effect.catchTag("RowNotFound", () => new WikiPageNotFound({ id })),
          Effect.flatMap(withUpdatedByName)
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
