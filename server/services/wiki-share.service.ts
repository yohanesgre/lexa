import { Effect } from "effect";
import { randomBytes, randomUUID } from "node:crypto";
import { WikiShareRepo } from "../repos/wiki-share.repo";
import type { WikiShareLinkRow, SubtreeRow } from "../repos/wiki-share.repo";
import { WikiRepo } from "../repos/wiki.repo";
import { DbError } from "../db/database";
import { ShareLinkNotFound, WikiPageNotFound } from "../api/errors";

export interface SharedPageNode {
  id: string;
  title: string;
  slug: string;
  content: unknown;
  updatedAt: string;
  children: SharedPageNode[];
}

export class WikiShareService extends Effect.Service<WikiShareService>()("Lexa/WikiShareService", {
  dependencies: [WikiShareRepo.Default, WikiRepo.Default],
  effect: Effect.gen(function* () {
    const shareRepo = yield* WikiShareRepo;
    const wikiRepo = yield* WikiRepo;

    const toNode = (row: SubtreeRow): SharedPageNode => ({
      id: row.id,
      title: row.title,
      slug: row.slug,
      content: JSON.parse(row.content),
      updatedAt: row.updated_at,
      children: [],
    });

    return {
      create: (input: {
        projectId: string;
        pageId: string;
        expiresAt: string | null;
        createdBy: string | null;
      }): Effect.Effect<WikiShareLinkRow, WikiPageNotFound | DbError> =>
        Effect.gen(function* () {
          const page = yield* wikiRepo.findById(input.pageId).pipe(
            Effect.catchTag("RowNotFound", () => new WikiPageNotFound({ id: input.pageId }))
          );
          if (page.projectId !== input.projectId) {
            return yield* new WikiPageNotFound({ id: input.pageId });
          }
          const expiresAt = input.expiresAt === null ? null : new Date(input.expiresAt).toISOString();
          const link = {
            id: randomUUID(),
            pageId: input.pageId,
            token: randomBytes(18).toString("base64url"),
            expiresAt,
            createdBy: input.createdBy,
          };
          yield* shareRepo.insert(link).pipe(
            Effect.catchTag(
              "ConstraintViolation",
              () => new DbError({ message: "Failed to create share link" })
            )
          );
          const row = yield* shareRepo.findByToken(link.token);
          if (!row) {
            return yield* new DbError({ message: "Share link not found after insert" });
          }
          return row;
        }),

      list: (pageId: string): Effect.Effect<WikiShareLinkRow[], DbError> =>
        shareRepo.listByPage(pageId),

      revoke: (linkId: string, projectId: string): Effect.Effect<void, ShareLinkNotFound | DbError> =>
        shareRepo.deleteByIdInProject(linkId, projectId).pipe(
          Effect.catchTag(
            "ConstraintViolation",
            () => new DbError({ message: "Failed to revoke share link" })
          ),
          Effect.flatMap((deleted) => (deleted ? Effect.void : new ShareLinkNotFound()))
        ),

      resolvePublic: (
        token: string
      ): Effect.Effect<{ root: SharedPageNode }, ShareLinkNotFound | DbError> =>
        Effect.gen(function* () {
          const link = yield* shareRepo.findByToken(token);
          // Missing, expired, and revoked tokens fail identically — no oracle.
          if (!link || (link.expires_at !== null && link.expires_at <= new Date().toISOString())) {
            return yield* new ShareLinkNotFound();
          }
          const rows = yield* shareRepo.findSubtreeRows(link.page_id);
          const byId = new Map<string, SharedPageNode>(rows.map((row) => [row.id, toNode(row)]));
          let root: SharedPageNode | null = null;
          for (const row of rows) {
            const node = byId.get(row.id)!;
            const parent = row.parent_id ? byId.get(row.parent_id) : undefined;
            if (parent) parent.children.push(node);
            else root = node;
          }
          if (!root) return yield* new ShareLinkNotFound();
          return { root };
        }),
    };
  }),
}) {}
