// Post-commit vector fill for one source's chunk rows. The chunk rows are
// written inside the source's save batch (embedding NULL); this runs AFTER
// that batch commits and fills the BLOBs best-effort: any failure is swallowed
// and leaves NULLs, which the next save retries. No service dependency — it
// takes the driver and the env snapshot the caller already resolved.

import { Effect } from "effect";
import { batch, type DbDriver } from "../db/db";
import type { RuntimeEnv } from "../env";
import { encodeEmbedding } from "../../shared/assistant-chunks";
import { fillEmbeddingStmts, nullChunks, type EmbeddingKind } from "../repos/assistant-embeddings.repo";
import { embedTexts, embeddingsConfigured } from "./embeddings-client";

export async function embedRefChunks(
  db: DbDriver,
  env: RuntimeEnv,
  kind: EmbeddingKind,
  refId: string
): Promise<void> {
  if (!embeddingsConfigured(env)) return;
  try {
    const chunks = await Effect.runPromise(nullChunks(db, kind, refId));
    if (chunks.length === 0) return;
    const vectors = await embedTexts(env, chunks.map((chunk) => chunk.content));
    if (vectors === null) return;
    const updates: { id: string; blob: Uint8Array }[] = [];
    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i];
      const vector = vectors[i];
      if (chunk === undefined || vector === undefined) break;
      updates.push({ id: chunk.id, blob: encodeEmbedding(Float32Array.from(vector)) });
    }
    if (updates.length > 0) await Effect.runPromise(batch(db, fillEmbeddingStmts(updates)));
  } catch {
    // Best-effort: the source save already committed; NULLs stay for the next save.
  }
}
