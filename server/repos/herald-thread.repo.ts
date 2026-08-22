import { Effect } from "effect";
import { Sqlite, queryFirst, queryAll, run, withTx, DbError, RowNotFound, ConstraintViolation } from "../db/database";
import type { ID, ISODate } from "../../shared/types";
import type { HeraldThreadType } from "../../shared/herald";

export interface HeraldThread {
  documentType: HeraldThreadType;
  documentId: string;
  projectId: ID;
  ownerUserId: ID | null;
  title: string | null;
  pinned: boolean;
  agentId: string | null;
  skillId: string | null;
  messages: unknown[];
  summary: string | null;
  summarizedCount: number;
  createdAt: ISODate;
  updatedAt: ISODate;
}

interface HeraldThreadRow {
  document_type: HeraldThreadType;
  document_id: string;
  project_id: string;
  owner_user_id: string | null;
  title: string | null;
  pinned: number;
  agent_id: string | null;
  skill_id: string | null;
  messages: string;
  summary: string | null;
  summarized_count: number;
  created_at: string;
  updated_at: string;
}

function rowToThread(row: HeraldThreadRow): HeraldThread {
  let messages: unknown[] = [];
  try {
    const parsed = JSON.parse(row.messages);
    if (Array.isArray(parsed)) messages = parsed;
  } catch {
    messages = [];
  }
  return {
    documentType: row.document_type,
    documentId: row.document_id,
    projectId: row.project_id,
    ownerUserId: row.owner_user_id,
    title: row.title,
    pinned: row.pinned === 1,
    agentId: row.agent_id,
    skillId: row.skill_id,
    messages,
    summary: row.summary,
    summarizedCount: row.summarized_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface SaveThreadPatch {
  projectId: ID;
  ownerUserId?: ID | null;
  title?: string | null;
  agentId?: string | null;
  skillId?: string | null;
  messages: unknown[];
  summary?: string | null;
  summarizedCount?: number;
}

export class HeraldThreadRepo extends Effect.Service<HeraldThreadRepo>()("Lexa/HeraldThreadRepo", {
  effect: Effect.gen(function* () {
    const db = yield* Sqlite;

    return {
      loadThread: (documentType: HeraldThreadType, documentId: string): Effect.Effect<HeraldThread, RowNotFound | DbError> =>
        queryFirst<HeraldThreadRow>(
          db,
          `SELECT * FROM herald_threads WHERE document_type = ? AND document_id = ?`,
          documentType,
          documentId
        ).pipe(Effect.map(rowToThread)),

      // Insert-or-overwrite. project_id/owner_user_id are written on insert
      // only — a thread never migrates between projects/owners. Agent/skill
      // changes overwrite the row (fresh thread per S6), model/provider
      // changes do not touch this table. `title` backfills only when the
      // stored value is NULL (COALESCE) — a rename survives later saves.
      saveThread: (documentType: HeraldThreadType, documentId: string, patch: SaveThreadPatch): Effect.Effect<HeraldThread, ConstraintViolation | DbError> =>
        Effect.gen(function* () {
          yield* run(
            db,
            `INSERT INTO herald_threads (document_type, document_id, project_id, owner_user_id, title, agent_id, skill_id, messages, summary, summarized_count)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(document_type, document_id) DO UPDATE SET
               messages = excluded.messages,
               summary = excluded.summary,
               summarized_count = excluded.summarized_count,
               agent_id = excluded.agent_id,
               skill_id = excluded.skill_id,
               title = COALESCE(herald_threads.title, excluded.title),
               updated_at = datetime('now')`,
            documentType,
            documentId,
            patch.projectId,
            patch.ownerUserId ?? null,
            patch.title ?? null,
            patch.agentId ?? null,
            patch.skillId ?? null,
            JSON.stringify(patch.messages),
            patch.summary ?? null,
            patch.summarizedCount ?? 0
          );
          const rows = yield* queryAll<HeraldThreadRow>(
            db,
            `SELECT * FROM herald_threads WHERE document_type = ? AND document_id = ?`,
            documentType,
            documentId
          );
          return rowToThread(rows[0]!);
        }),

      resetThread: (documentType: HeraldThreadType, documentId: string): Effect.Effect<void, RowNotFound | ConstraintViolation | DbError> =>
        run(db, `DELETE FROM herald_threads WHERE document_type = ? AND document_id = ?`, documentType, documentId).pipe(
          Effect.flatMap((changes) =>
            changes === 0 ? Effect.fail(new RowNotFound({ table: "herald_threads" })) : Effect.void
          )
        ),

      // Chat threads are owner-scoped: a missing row and an owner mismatch
      // are indistinguishable (both RowNotFound → 404 at the boundary).
      loadChat: (chatId: string, userId: string): Effect.Effect<HeraldThread, RowNotFound | DbError> =>
        queryFirst<HeraldThreadRow>(
          db,
          `SELECT * FROM herald_threads WHERE document_type = 'chat' AND document_id = ? AND owner_user_id = ?`,
          chatId,
          userId
        ).pipe(Effect.map(rowToThread)),

      appendChatMessage: (chatId: string, userId: string, message: unknown): Effect.Effect<HeraldThread, RowNotFound | ConstraintViolation | DbError> =>
        withTx(
          db,
          Effect.gen(function* () {
            const existing = yield* queryFirst<HeraldThreadRow>(
              db,
              `SELECT * FROM herald_threads WHERE document_type = 'chat' AND document_id = ? AND owner_user_id = ?`,
              chatId,
              userId
            );
            const prior = rowToThread(existing);
            return yield* Effect.map(
              run(
                db,
                `UPDATE herald_threads SET messages = ?, updated_at = datetime('now')
                 WHERE document_type = 'chat' AND document_id = ? AND owner_user_id = ?`,
                JSON.stringify([...prior.messages, message]),
                chatId,
                userId
              ),
              () => ({ ...prior, messages: [...prior.messages, message] })
            );
          })
        ),

      // Owner-scoped chat list for the sidebar: pinned threads first, then
      // newest activity. Optional q = case-exact LIKE substring prefilter
      // over title or raw transcript JSON (% and _ escaped by the caller).
      listChats: (
        projectId: string,
        userId: string,
        opts: { limit?: number; q?: string } = {}
      ): Effect.Effect<Array<HeraldThread>, DbError> => {
        const conditions = [`document_type = 'chat'`, `project_id = ?`, `owner_user_id = ?`];
        const params: unknown[] = [projectId, userId];
        if (opts.q !== undefined && opts.q !== "") {
          const like = `%${opts.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
          conditions.push(`(title LIKE ? ESCAPE '\\' OR messages LIKE ? ESCAPE '\\')`);
          params.push(like, like);
        }
        params.push(opts.limit ?? 100);
        return queryAll<HeraldThreadRow>(
          db,
          `SELECT * FROM herald_threads
           WHERE ${conditions.join(" AND ")}
           ORDER BY pinned DESC, updated_at DESC
           LIMIT ?`,
          ...params
        ).pipe(Effect.map((rows) => rows.map(rowToThread)));
      },

      // Owner-scoped metadata update — at least one field must be present
      // (validated by the service). A missing row and an owner mismatch are
      // both RowNotFound (404 at the boundary).
      updateChatMeta: (
        chatId: string,
        userId: string,
        patch: { title?: string; pinned?: boolean }
      ): Effect.Effect<HeraldThread, RowNotFound | ConstraintViolation | DbError> =>
        Effect.gen(function* () {
          const sets: string[] = [];
          const params: unknown[] = [];
          if (patch.title !== undefined) {
            sets.push(`title = ?`);
            params.push(patch.title);
          }
          if (patch.pinned !== undefined) {
            sets.push(`pinned = ?`);
            params.push(patch.pinned ? 1 : 0);
          }
          sets.push(`updated_at = datetime('now')`);
          const changes = yield* run(
            db,
            `UPDATE herald_threads SET ${sets.join(", ")}
             WHERE document_type = 'chat' AND document_id = ? AND owner_user_id = ?`,
            ...params,
            chatId,
            userId
          );
          if (changes === 0) return yield* new RowNotFound({ table: "herald_threads" });
          const rows = yield* queryAll<HeraldThreadRow>(
            db,
            `SELECT * FROM herald_threads WHERE document_type = 'chat' AND document_id = ? AND owner_user_id = ?`,
            chatId,
            userId
          );
          return rowToThread(rows[0]!);
        }),

      // Owner-scoped transcript truncation for edit/regenerate/retry: keeps
      // messages[0..fromIndex), drops the rest. fromIndex === length is a
      // no-op write (still bumps updated_at).
      truncateChatFrom: (chatId: string, userId: string, fromIndex: number): Effect.Effect<HeraldThread, RowNotFound | ConstraintViolation | DbError> =>
        withTx(
          db,
          Effect.gen(function* () {
            const existing = yield* queryFirst<HeraldThreadRow>(
              db,
              `SELECT * FROM herald_threads WHERE document_type = 'chat' AND document_id = ? AND owner_user_id = ?`,
              chatId,
              userId
            );
            const prior = rowToThread(existing);
            const kept = prior.messages.slice(0, fromIndex);
            yield* run(
              db,
              `UPDATE herald_threads SET messages = ?, updated_at = datetime('now')
               WHERE document_type = 'chat' AND document_id = ? AND owner_user_id = ?`,
              JSON.stringify(kept),
              chatId,
              userId
            );
            return { ...prior, messages: kept };
          })
        ),
    };
  }),
}) {}
