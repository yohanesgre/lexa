#!/usr/bin/env bun
// Idempotent, resumable backfill of the semantic-retrieval corpus
// (`assistant_embeddings`) for pre-existing wiki pages, tasks and project
// memories. Chunk rows are rewritten only when their chunk set (or the
// embedding model) differs from what is stored; NULL vectors are then filled in
// batches of 25. A failed embedding batch prints and continues, so a re-run
// resumes exactly where the previous one stopped. With an unchanged corpus and
// every vector filled, a second run performs no writes and no REST calls.
//
//   bun scripts/backfill-embeddings.ts

import { Database } from "bun:sqlite";
import { getEnv, resolveDatabasePath } from "../server/env";
import { applyEnvFile } from "../server/env-file";
import { embeddingsModelFrom } from "../server/runtime-env";
import { embedTexts, embeddingsConfigured } from "../server/assistant/embeddings-client";
import { chunkDocument, encodeEmbedding } from "../shared/assistant-chunks";
import { markdownToText } from "../shared/markdown";
import type { EmbeddingKind } from "../server/repos/assistant-embeddings.repo";

const FILL_BATCH = 25;
const MEMORY_TITLE = "Project memory";

// One-command path: `bun scripts/backfill-embeddings.ts` must work with
// credentials in .env.toml/.env. Real environment variables still win; a
// missing file is fine (the refusal below then explains what is absent).
applyEnvFile();
const env = getEnv();
if (!embeddingsConfigured(env)) {
  console.error(
    "[backfill] refused: LXK_WORKERS_AI_ACCOUNT_ID and LXK_WORKERS_AI_API_TOKEN must both be set"
  );
  process.exit(1);
}

const model = embeddingsModelFrom(env);
const dbPath = resolveDatabasePath(env);
const db = new Database(dbPath);

interface Source {
  kind: EmbeddingKind;
  refId: string;
  projectId: string;
  title: string;
  body: string;
}

interface ChunkRow {
  chunk_index: number;
  content: string;
  embedding_model: string;
}

interface PendingRow {
  id: string;
  content: string;
}

function loadSources(): Source[] {
  const wiki = db
    .query(`SELECT id, project_id, title, content_text FROM wiki_pages`)
    .all() as { id: string; project_id: string; title: string; content_text: string }[];
  const tasks = db
    .query(`SELECT id, project_id, title, description FROM tasks`)
    .all() as { id: string; project_id: string; title: string; description: string }[];
  const memory = db
    .query(`SELECT id, project_id, content FROM project_memory`)
    .all() as { id: string; project_id: string; content: string }[];
  return [
    ...wiki.map((row) => ({ kind: "wiki" as const, refId: row.id, projectId: row.project_id, title: row.title, body: row.content_text })),
    ...tasks.map((row) => ({ kind: "task" as const, refId: row.id, projectId: row.project_id, title: row.title, body: markdownToText(row.description) })),
    ...memory.map((row) => ({ kind: "memory" as const, refId: row.id, projectId: row.project_id, title: MEMORY_TITLE, body: row.content })),
  ];
}

const selectExisting = db.query(
  `SELECT chunk_index, content, embedding_model FROM assistant_embeddings
   WHERE kind = ? AND ref_id = ? ORDER BY chunk_index`
);
const deleteExisting = db.query(`DELETE FROM assistant_embeddings WHERE kind = ? AND ref_id = ?`);
const insertChunk = db.query(
  `INSERT INTO assistant_embeddings (id, project_id, kind, ref_id, chunk_index, content, embedding, embedding_model)
   VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`
);

function chunksMatch(existing: ChunkRow[], chunks: { index: number; text: string }[]): boolean {
  if (existing.length !== chunks.length) return false;
  return chunks.every((chunk, i) => {
    const row = existing[i];
    return (
      row !== undefined &&
      row.chunk_index === chunk.index &&
      row.content === chunk.text &&
      row.embedding_model === model
    );
  });
}

const replaceChunks = db.transaction((source: Source, chunks: { index: number; text: string }[]) => {
  deleteExisting.run(source.kind, source.refId);
  for (const chunk of chunks) {
    insertChunk.run(
      crypto.randomUUID(),
      source.projectId,
      source.kind,
      source.refId,
      chunk.index,
      chunk.text,
      model
    );
  }
});

let refsScanned = 0;
let refsUpdated = 0;
let chunksInserted = 0;
for (const source of loadSources()) {
  refsScanned += 1;
  const chunks = chunkDocument(source.title, source.body);
  const existing = selectExisting.all(source.kind, source.refId) as ChunkRow[];
  if (chunksMatch(existing, chunks)) continue;
  replaceChunks(source, chunks);
  refsUpdated += 1;
  chunksInserted += chunks.length;
}

const pending = db
  .query(
    `SELECT id, content FROM assistant_embeddings
     WHERE embedding IS NULL ORDER BY created_at, id`
  )
  .all() as PendingRow[];
const updateVector = db.query(
  `UPDATE assistant_embeddings SET embedding = ?, updated_at = datetime('now') WHERE id = ?`
);
const saveVectors = db.transaction((rows: { id: string; vector: Uint8Array }[]) => {
  for (const row of rows) updateVector.run(row.vector, row.id);
});

let vectorsFilled = 0;
let failures = 0;
for (let start = 0; start < pending.length; start += FILL_BATCH) {
  const batch = pending.slice(start, start + FILL_BATCH);
  const vectors = await embedTexts(env, batch.map((row) => row.content));
  if (vectors === null) {
    failures += 1;
    console.error(
      `[backfill] embedding batch ${Math.floor(start / FILL_BATCH) + 1} failed; ${batch.length} chunks left NULL (re-run to resume)`
    );
    continue;
  }
  const rows: { id: string; vector: Uint8Array }[] = [];
  for (let i = 0; i < batch.length; i += 1) {
    const row = batch[i];
    const vector = vectors[i];
    if (row === undefined || vector === undefined) continue;
    rows.push({ id: row.id, vector: encodeEmbedding(Float32Array.from(vector)) });
  }
  saveVectors(rows);
  vectorsFilled += rows.length;
}

db.close();
console.log(
  `[backfill] db=${dbPath} model=${model} refs scanned=${refsScanned} updated=${refsUpdated} chunks inserted=${chunksInserted} vectors filled=${vectorsFilled} failures=${failures}`
);
