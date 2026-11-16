// Thin SQL repo for the semantic-retrieval corpus (`assistant_embeddings`).
//
// No Effect.Service: the three write paths (wiki/task/memory) each own their
// own transaction, so the chunk statements ride their save batch, and the
// read path is a plain function over the injected driver. The SQL lives here;
// chunking, cosine ranking and thresholding are pure functions elsewhere.

import { Effect } from "effect";
import { queryAll, run, DbError, type BatchStmt, type DbDriver } from "../db/db";

export type EmbeddingKind = "wiki" | "task" | "memory";

export interface ChunkInput {
  index: number;
  text: string;
}

export interface CandidateRow {
  id: string;
  kind: EmbeddingKind;
  refId: string;
  chunkIndex: number;
  content: string;
  embedding: Uint8Array | ArrayBuffer;
  title: string;
  locator: string;
}

interface CandidateDbRow {
  id: string;
  kind: EmbeddingKind;
  ref_id: string;
  chunk_index: number;
  content: string;
  embedding: Uint8Array | ArrayBuffer;
  title: string;
  locator: string;
}

/** Delete a source's chunk rows and re-insert the current chunks (embedding
 *  NULL until filled), as ONE batch so it joins the caller's save. */
export function replaceChunksStmts(input: {
  kind: EmbeddingKind;
  refId: string;
  projectId: string;
  model: string;
  chunks: ChunkInput[];
}): BatchStmt[] {
  const chunks = [...input.chunks].sort((a, b) => a.index - b.index);
  return [
    { sql: `DELETE FROM assistant_embeddings WHERE kind = ? AND ref_id = ?`, params: [input.kind, input.refId] },
    ...chunks.map((chunk) => ({
      sql: `INSERT INTO assistant_embeddings (id, project_id, kind, ref_id, chunk_index, content, embedding, embedding_model)
             VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
      params: [crypto.randomUUID(), input.projectId, input.kind, input.refId, chunk.index, chunk.text, input.model],
    })),
  ];
}

/** Chunks of one source still missing a vector, in chunk order. */
export function nullChunks(
  db: DbDriver,
  kind: EmbeddingKind,
  refId: string
): Effect.Effect<{ id: string; content: string }[], DbError> {
  return queryAll<{ id: string; content: string }>(
    db,
    `SELECT id, content FROM assistant_embeddings
     WHERE kind = ? AND ref_id = ? AND embedding IS NULL
     ORDER BY chunk_index`,
    kind,
    refId
  );
}

/** Fill one chunk's vector after commit. Id-addressed: a chunk replaced by a
 *  newer save no longer exists and the UPDATE matches 0 rows. */
export function fillEmbedding(db: DbDriver, id: string, blob: Uint8Array): Effect.Effect<void, DbError> {
  return run(
    db,
    `UPDATE assistant_embeddings SET embedding = ?, updated_at = datetime('now') WHERE id = ?`,
    blob,
    id
  ).pipe(
    Effect.mapError((e) => (e instanceof DbError ? e : new DbError({ message: e.message, cause: e }))),
    Effect.asVoid
  );
}

/** Embeddable chunks of a project for the current model, with the live source
 *  row's title and locator. One query: LEFT JOINs on the matching kind, and a
 *  chunk whose source row was deleted (missed cleanup) drops out. */
export function candidatesForProject(
  db: DbDriver,
  projectId: string,
  model: string,
  kinds: readonly EmbeddingKind[],
  cap: number
): Effect.Effect<CandidateRow[], DbError> {
  if (kinds.length === 0) return Effect.succeed([]);
  const placeholders = kinds.map(() => "?").join(", ");
  return queryAll<CandidateDbRow>(
    db,
    `SELECT e.id, e.kind, e.ref_id, e.chunk_index, e.content, e.embedding,
            CASE e.kind WHEN 'wiki' THEN w.title WHEN 'task' THEN t.title ELSE 'Project memory' END AS title,
            CASE e.kind WHEN 'wiki' THEN w.slug WHEN 'task' THEN t.key ELSE e.content END AS locator
     FROM assistant_embeddings e
     LEFT JOIN wiki_pages w ON e.kind = 'wiki' AND w.id = e.ref_id
     LEFT JOIN tasks t ON e.kind = 'task' AND t.id = e.ref_id
     LEFT JOIN project_memory m ON e.kind = 'memory' AND m.id = e.ref_id
     WHERE e.project_id = ?
       AND e.embedding IS NOT NULL
       AND e.embedding_model = ?
       AND e.kind IN (${placeholders})
       AND (w.id IS NOT NULL OR t.id IS NOT NULL OR m.id IS NOT NULL)
     ORDER BY e.updated_at DESC, e.id
     LIMIT ?`,
    projectId,
    model,
    ...kinds,
    cap
  ).pipe(
    Effect.map((rows) =>
      rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        refId: row.ref_id,
        chunkIndex: row.chunk_index,
        content: row.content,
        embedding: row.embedding,
        title: row.title,
        locator: row.locator,
      }))
    )
  );
}
