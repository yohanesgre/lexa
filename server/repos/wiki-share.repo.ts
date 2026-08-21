import { Effect } from "effect";
import { Sqlite, queryAll, queryFirst, run, DbError, RowNotFound, ConstraintViolation } from "../db/database";

export interface WikiShareLinkRow {
  id: string;
  page_id: string;
  token: string;
  expires_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface SubtreeRow {
  id: string;
  parent_id: string | null;
  title: string;
  slug: string;
  content: string;
  updated_at: string;
}

export interface SubtreeNode {
  page: SubtreeRow;
  children: SubtreeNode[];
}

// The recursive CTE returns flat rows; hierarchy is assembled here via a
// parent map. Returns null when rows is empty.
export function buildSubtreeTree(rows: SubtreeRow[]): SubtreeNode | null {
  const byId = new Map<string, SubtreeNode>(rows.map((row) => [row.id, { page: row, children: [] }]));
  let root: SubtreeNode | null = null;
  for (const node of byId.values()) {
    const parent = node.page.parent_id ? byId.get(node.page.parent_id) : undefined;
    if (parent) parent.children.push(node);
    else root = node;
  }
  return root;
}

export class WikiShareRepo extends Effect.Service<WikiShareRepo>()("Lexa/WikiShareRepo", {
  effect: Effect.gen(function* () {
    const db = yield* Sqlite;

    return {
      insert: (link: {
        id: string;
        pageId: string;
        token: string;
        expiresAt?: string | null;
        createdBy: string | null;
      }): Effect.Effect<void, ConstraintViolation | DbError> =>
        run(
          db,
          `INSERT INTO wiki_share_links (id, page_id, token, expires_at, created_by)
           VALUES (?, ?, ?, ?, ?)`,
          link.id,
          link.pageId,
          link.token,
          link.expiresAt ?? null,
          link.createdBy
        ).pipe(Effect.map(() => undefined)),

      listByPage: (pageId: string): Effect.Effect<WikiShareLinkRow[], DbError> =>
        queryAll<WikiShareLinkRow>(
          db,
          `SELECT * FROM wiki_share_links WHERE page_id = ? ORDER BY created_at ASC, id ASC`,
          pageId
        ),

      deleteById: (id: string): Effect.Effect<boolean, ConstraintViolation | DbError> =>
        run(db, `DELETE FROM wiki_share_links WHERE id = ?`, id).pipe(
          Effect.map((changes) => changes > 0)
        ),

      findByToken: (token: string): Effect.Effect<WikiShareLinkRow | null, DbError> =>
        queryFirst<WikiShareLinkRow>(
          db,
          `SELECT * FROM wiki_share_links WHERE token = ?`,
          token
        ).pipe(
          Effect.map((row) => row),
          Effect.catchTag("RowNotFound", () => Effect.succeed(null))
        ),

      findSubtreeRows: (pageId: string): Effect.Effect<SubtreeRow[], DbError> =>
        queryAll<SubtreeRow>(
          db,
          `WITH RECURSIVE subtree(id) AS (
             SELECT id FROM wiki_pages WHERE id = ?
             UNION ALL
             SELECT wp.id FROM wiki_pages wp JOIN subtree s ON wp.parent_id = s.id
           )
           SELECT id, parent_id, title, slug, content, updated_at
           FROM wiki_pages WHERE id IN (SELECT id FROM subtree)`,
          pageId
        ),
    };
  }),
}) {}
