import { Effect } from "effect";
import { Sqlite, queryAll, queryFirst, run, DbError, RowNotFound, ConstraintViolation } from "../db/database";
import { WikiPageRow, rowToWikiPage, rowToWikiPageMeta } from "../../shared/types";
import type { WikiPage, WikiPageMeta } from "../../shared/types";
import type { WikiPageRevisionRow, WikiPageRevision, WikiPageRevisionSummary } from "../../shared/types";
import { rowToWikiPageRevision, rowToWikiPageRevisionSummary } from "../../shared/types";

export class WikiRepo extends Effect.Service<WikiRepo>()("Lexa/WikiRepo", {
  effect: Effect.gen(function* () {
    const db = yield* Sqlite;

    return {
      create: (input: {
        id: string;
        projectId: string;
        title: string;
        slug: string;
        content: string;
        contentText: string;
        parentId?: string | null;
        position?: number;
      }): Effect.Effect<WikiPage, RowNotFound | DbError | ConstraintViolation> =>
        Effect.gen(function* () {
          yield* run(
            db,
            `INSERT INTO wiki_pages (id, project_id, title, slug, content, content_text, parent_id, position)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            input.id,
            input.projectId,
            input.title,
            input.slug,
            input.content,
            input.contentText,
            input.parentId ?? null,
            input.position ?? 0
          );
          return yield* queryFirst<WikiPageRow>(db, `SELECT * FROM wiki_pages WHERE id = ?`, input.id).pipe(
            Effect.map(rowToWikiPage)
          );
        }),

      findById: (id: string): Effect.Effect<WikiPage, RowNotFound | DbError> =>
        queryFirst<WikiPageRow>(db, `SELECT * FROM wiki_pages WHERE id = ?`, id).pipe(
          Effect.map(rowToWikiPage)
        ),

      findBySlug: (projectId: string, slug: string): Effect.Effect<WikiPage, RowNotFound | DbError> =>
        queryFirst<WikiPageRow>(
          db,
          `SELECT * FROM wiki_pages WHERE project_id = ? AND slug = ?`,
          projectId,
          slug
        ).pipe(Effect.map(rowToWikiPage)),

      findByProject: (projectId: string): Effect.Effect<WikiPageMeta[], DbError> =>
        queryAll<WikiPageRow>(
          db,
          `SELECT * FROM wiki_pages WHERE project_id = ? ORDER BY COALESCE(parent_id, '') ASC, position ASC`,
          projectId
        ).pipe(Effect.map((rows) => rows.map(rowToWikiPageMeta))),

      findChildren: (projectId: string, parentId: string): Effect.Effect<WikiPageMeta[], DbError> =>
        queryAll<WikiPageRow>(
          db,
          `SELECT * FROM wiki_pages WHERE project_id = ? AND parent_id = ? ORDER BY position ASC`,
          projectId,
          parentId
        ).pipe(Effect.map((rows) => rows.map(rowToWikiPageMeta))),

      search: (
        projectId: string,
        query: string,
        limit?: number
      ): Effect.Effect<(WikiPage & { snippet: string })[], DbError> => {
        const limitVal = limit ?? 20;
        return queryAll<WikiPageRow & { snippet: string }>(
          db,
          `SELECT wiki_pages.*, snippet(wiki_fts, 1, '**', '**', '…', 32) AS snippet
           FROM wiki_fts
           JOIN wiki_pages ON wiki_pages.rowid = wiki_fts.rowid
           WHERE wiki_fts MATCH ? AND project_id = ?
           LIMIT ?`,
          query,
          projectId,
          limitVal
        ).pipe(
          Effect.map((rows) =>
            rows.map((r) => ({
              ...rowToWikiPage(r),
              snippet: r.snippet,
            }))
          )
        );
      },

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
      ): Effect.Effect<WikiPage, RowNotFound | DbError | ConstraintViolation> => {
        const sets: string[] = [];
        const params: unknown[] = [];
        if (input.title !== undefined) {
          sets.push("title = ?");
          params.push(input.title);
        }
        if (input.slug !== undefined) {
          sets.push("slug = ?");
          params.push(input.slug);
        }
        if (input.content !== undefined) {
          sets.push("content = ?");
          params.push(input.content);
        }
        if (input.contentText !== undefined) {
          sets.push("content_text = ?");
          params.push(input.contentText);
        }
        if (input.parentId !== undefined) {
          sets.push("parent_id = ?");
          params.push(input.parentId);
        }
        if (input.position !== undefined) {
          sets.push("position = ?");
          params.push(input.position);
        }
        if (sets.length === 0)
          return queryFirst<WikiPageRow>(db, `SELECT * FROM wiki_pages WHERE id = ?`, id).pipe(
            Effect.map(rowToWikiPage)
          );
        sets.push("updated_at = datetime('now')");
        params.push(id);
        return run(db, `UPDATE wiki_pages SET ${sets.join(", ")} WHERE id = ?`, ...params)
          .pipe(Effect.flatMap(() => queryFirst<WikiPageRow>(db, `SELECT * FROM wiki_pages WHERE id = ?`, id)))
          .pipe(Effect.map(rowToWikiPage));
      },

      delete: (id: string): Effect.Effect<void, ConstraintViolation | DbError> =>
        run(db, `DELETE FROM wiki_pages WHERE id = ?`, id).pipe(Effect.map(() => undefined)),

      countChildren: (id: string): Effect.Effect<number, DbError> =>
        queryFirst<{ count: number }>(
          db,
          `SELECT COUNT(*) as count FROM wiki_pages WHERE parent_id = ?`,
          id
        ).pipe(
          Effect.map((r) => r.count),
          Effect.catchTag("RowNotFound", () => Effect.succeed(0))
        ),

      createRevision: (
        pageId: string,
        title: string,
        slug: string,
        content: string,
        contentText: string,
        saveType: "autosave" | "manual"
      ): Effect.Effect<WikiPageRevision, DbError | ConstraintViolation> =>
        Effect.gen(function* () {
          const id = crypto.randomUUID();
          yield* run(
            db,
            `INSERT INTO wiki_page_revisions (id, page_id, title, slug, content, content_text, save_type)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            id, pageId, title, slug, content, contentText, saveType
          );
          return yield* queryFirst<WikiPageRevisionRow>(
            db,
            `SELECT * FROM wiki_page_revisions WHERE id = ?`,
            id
          ).pipe(
            Effect.map(rowToWikiPageRevision),
            Effect.catchTag("RowNotFound", () =>
              new DbError({ message: "Revision not found after insert" })
            )
          );
        }),

      listRevisions: (
        pageId: string,
        limit?: number
      ): Effect.Effect<WikiPageRevisionSummary[], DbError> =>
        queryAll<WikiPageRevisionRow>(
          db,
          `SELECT * FROM wiki_page_revisions WHERE page_id = ? ORDER BY created_at DESC LIMIT ?`,
          pageId,
          limit ?? 20
        ).pipe(Effect.map((rows) => rows.map(rowToWikiPageRevisionSummary))),

      getRevision: (id: string): Effect.Effect<WikiPageRevision, RowNotFound | DbError> =>
        queryFirst<WikiPageRevisionRow>(
          db,
          `SELECT * FROM wiki_page_revisions WHERE id = ?`,
          id
        ).pipe(Effect.map(rowToWikiPageRevision)),

      maxPosition: (
        projectId: string,
        parentId?: string | null
      ): Effect.Effect<number, DbError> => {
        const sql =
          parentId === null
            ? `SELECT COALESCE(MAX(position), -1) as max_pos FROM wiki_pages WHERE project_id = ? AND parent_id IS NULL`
            : `SELECT COALESCE(MAX(position), -1) as max_pos FROM wiki_pages WHERE project_id = ? AND parent_id = ?`;
        const params: unknown[] =
          parentId === null ? [projectId] : [projectId, parentId];
        return queryFirst<{ max_pos: number }>(db, sql, ...params).pipe(
          Effect.map((r) => r.max_pos),
          Effect.catchTag("RowNotFound", () => Effect.succeed(-1))
        );
      },
    };
  }),
}) {}
