import { Effect } from "effect";
import { Sqlite, queryFirst, queryAll, run, withTx, DbError, RowNotFound, ConstraintViolation } from "../db/database";
import type { ID, ISODate } from "../../shared/types";

export interface ProjectMemoryEntry {
  id: ID;
  projectId: ID;
  content: string;
  source: "manual" | "herald";
  createdAt: ISODate;
  updatedAt: ISODate;
}

interface ProjectMemoryRow {
  id: string;
  project_id: string;
  content: string;
  source: "manual" | "herald";
  created_at: string;
  updated_at: string;
}

function rowToEntry(row: ProjectMemoryRow): ProjectMemoryEntry {
  return {
    id: row.id,
    projectId: row.project_id,
    content: row.content,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const MEMORY_SEARCH_K = 5;
export const MEMORY_CHAR_CAP = 2000;

export class ProjectMemoryRepo extends Effect.Service<ProjectMemoryRepo>()("Lexa/ProjectMemoryRepo", {
  effect: Effect.gen(function* () {
    const db = yield* Sqlite;

    // FTS5 external-content table — the index is maintained here, in the same
    // transaction as the content write (no triggers).
    const syncFtsInsert = (id: string) =>
      run(db, `INSERT INTO project_memory_fts(rowid, content) SELECT rowid, content FROM project_memory WHERE id = ?`, id);

    return {
      create: (input: { id: string; projectId: string; content: string; source?: "manual" | "herald" }): Effect.Effect<ProjectMemoryEntry, ConstraintViolation | DbError> =>
        withTx(
          db,
          Effect.gen(function* () {
            yield* run(
              db,
              `INSERT INTO project_memory (id, project_id, content, source) VALUES (?, ?, ?, ?)`,
              input.id,
              input.projectId,
              input.content,
              input.source ?? "manual"
            );
            yield* syncFtsInsert(input.id);
            const rows = yield* queryAll<ProjectMemoryRow>(db, `SELECT * FROM project_memory WHERE id = ?`, input.id);
            return rowToEntry(rows[0]!);
          })
        ),

      get: (id: string): Effect.Effect<ProjectMemoryEntry, RowNotFound | DbError> =>
        queryFirst<ProjectMemoryRow>(db, `SELECT * FROM project_memory WHERE id = ?`, id).pipe(Effect.map(rowToEntry)),

      list: (projectId: string): Effect.Effect<ProjectMemoryEntry[], DbError> =>
        queryAll<ProjectMemoryRow>(
          db,
          `SELECT * FROM project_memory WHERE project_id = ? ORDER BY created_at DESC, rowid DESC`,
          projectId
        ).pipe(Effect.map((rows) => rows.map(rowToEntry))),

      remove: (id: string): Effect.Effect<void, RowNotFound | ConstraintViolation | DbError> =>
        withTx(
          db,
          Effect.gen(function* () {
            const rows = yield* queryAll<{ rowid: number }>(db, `SELECT rowid FROM project_memory WHERE id = ?`, id);
            const rowid = rows[0]?.rowid;
            if (rowid === undefined) return yield* Effect.fail(new RowNotFound({ table: "project_memory" }));
            yield* run(db, `DELETE FROM project_memory WHERE id = ?`, id);
            yield* run(db, `DELETE FROM project_memory_fts WHERE rowid = ?`, rowid);
          })
        ),

      // FTS-match the given terms against one project's memories, best rank
      // first, at most k hits, cumulative content capped at charCap (the last
      // hit is truncated to fit). Empty terms → no hits.
      searchByProject: (
        projectId: string,
        queryTerms: string[],
        opts?: { k?: number; charCap?: number }
      ): Effect.Effect<string[], DbError> => {
        const k = opts?.k ?? MEMORY_SEARCH_K;
        const charCap = opts?.charCap ?? MEMORY_CHAR_CAP;
        if (queryTerms.length === 0) return Effect.succeed([]);
        const match = queryTerms.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
        return queryAll<{ content: string }>(
          db,
          `SELECT pm.content
           FROM project_memory_fts fts
           JOIN project_memory pm ON pm.rowid = fts.rowid
           WHERE pm.project_id = ? AND project_memory_fts MATCH ?
           ORDER BY rank
           LIMIT ?`,
          projectId,
          match,
          k
        ).pipe(
          Effect.map((rows) => {
            const picked: string[] = [];
            let total = 0;
            for (const { content } of rows) {
              if (total >= charCap) break;
              const room = charCap - total;
              picked.push(content.length > room ? content.slice(0, room) : content);
              total += Math.min(content.length, room);
            }
            return picked;
          })
        );
      },
    };
  }),
}) {}
