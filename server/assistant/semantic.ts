// Read-path retrieval orchestrator: one query embedding, one scan of the
// project's chunk rows, cosine ranking, and the prompt hint block. The SQL
// lives in the repo, the vector math in shared/assistant-chunks, the HTTP in
// the embeddings client — this module only sequences them.
//
// Nothing here throws. Unconfigured env, an embed failure, a DB failure, and a
// corrupt row are all "no vector" outcomes: the hint is advisory and the tool
// is model-facing, so neither may fail the turn it rides on.

import { Effect } from "effect";
import { decodeEmbedding, topK, type EmbeddingCandidate } from "../../shared/assistant-chunks";
import type { DbDriver } from "../db/db";
import { candidatesForProject, type EmbeddingKind } from "../repos/assistant-embeddings.repo";
import { embeddingsModelFrom, type RuntimeEnv } from "../runtime-env";
import { EMBEDDING_DIMENSIONS, embedTexts, embeddingsConfigured } from "./embeddings-client";

/** Minimum top-1 cosine for the auto-injected prompt hint (calibrated by the
 *  paraphrase eval; bge cosine for genuinely related text typically ≥0.4). */
export const SEMANTIC_HINT_MIN_COSINE = 0.3;
/** Freshest chunks per scan — the scan budget, never the result count. */
export const SEMANTIC_SCAN_CAP = 4096;
/** Default result count for the tool and the REST default. */
export const SEMANTIC_RESULT_CAP = 5;
export const SEMANTIC_SNIPPET_CAP = 500;

const HINT_LABEL = "[Possibly relevant — auto-retrieved from project content; not authoritative]";
const ALL_KINDS: readonly EmbeddingKind[] = ["wiki", "task", "memory"];

export interface SemanticHit {
  kind: EmbeddingKind;
  title: string;
  snippet: string;
  locator: string;
  score: number;
}

interface SemanticSearchOpts {
  fetchImpl?: typeof fetch;
}

/** Ranked retrieval over one project's live wiki/task/memory chunks.
 *  null = unconfigured env, embed failure, or DB failure; [] = no candidates. */
export async function semanticSearch(
  db: DbDriver,
  env: RuntimeEnv,
  projectId: string,
  query: string,
  limit: number,
  kinds?: readonly EmbeddingKind[],
  opts?: SemanticSearchOpts
): Promise<SemanticHit[] | null> {
  if (!embeddingsConfigured(env)) return null;
  try {
    const vectors = await embedTexts(env, [query], opts?.fetchImpl ? { fetchImpl: opts.fetchImpl } : undefined);
    const rawQuery = vectors?.[0];
    if (!rawQuery) return null;
    const queryVector = Float32Array.from(rawQuery);
    const rows = await Effect.runPromise(
      candidatesForProject(db, projectId, embeddingsModelFrom(env), kinds ?? ALL_KINDS, SEMANTIC_SCAN_CAP)
    );
    const candidates: EmbeddingCandidate[] = [];
    const metaById = new Map(rows.map((row) => [row.id, row] as const));
    for (const row of rows) {
      try {
        const vector = decodeEmbedding(row.embedding);
        // A vector of the wrong width is a corrupt row (provider contract
        // change or a truncated write): skip it rather than score it as 0.
        if (vector.length !== EMBEDDING_DIMENSIONS) continue;
        candidates.push({
          id: row.id,
          kind: row.kind,
          refId: row.refId,
          chunkIndex: row.chunkIndex,
          content: row.content,
          vector,
        });
      } catch {
        // byteLength not a multiple of 4 — same contract, same skip.
      }
    }
    const hits: SemanticHit[] = [];
    for (const { candidate, score } of topK(candidates, queryVector, limit)) {
      const meta = metaById.get(candidate.id);
      if (meta === undefined) continue;
      hits.push({
        kind: candidate.kind,
        title: meta.title,
        snippet: candidate.content.slice(0, SEMANTIC_SNIPPET_CAP),
        locator: meta.locator,
        score,
      });
    }
    return hits;
  } catch {
    return null;
  }
}

/** The prompt hint: top-1 hit above the threshold, in the fixed labeled
 *  block, or null (unconfigured, failure, no hit, below threshold). */
export async function semanticHint(
  db: DbDriver,
  env: RuntimeEnv,
  projectId: string,
  query: string,
  opts?: SemanticSearchOpts
): Promise<string | null> {
  try {
    const hits = await semanticSearch(db, env, projectId, query, 1, undefined, opts);
    const top = hits?.[0];
    if (top === undefined || top.score < SEMANTIC_HINT_MIN_COSINE) return null;
    return `${HINT_LABEL}\n${top.title} (${top.kind}): ${top.snippet}`;
  } catch {
    return null;
  }
}
