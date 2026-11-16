import { estimateTokenCount } from "tokenx";

export const CHUNK_TARGET_TOKENS = 450;
export const CHUNK_OVERLAP_TOKENS = 50;
export const CHUNK_HARD_MAX_TOKENS = 512;
/** Chunker title prefix for project-memory rows. The write path, the
 * backfill, and the retrieval display must share it or memory chunks split
 * by title prefix. */
export const MEMORY_TITLE = "Project memory";

export interface DocumentChunk {
  index: number;
  text: string;
}

export interface EmbeddingCandidate {
  id: string;
  kind: "wiki" | "task" | "memory";
  refId: string;
  chunkIndex: number;
  content: string;
  vector: Float32Array;
}

export interface RankedCandidate {
  candidate: EmbeddingCandidate;
  score: number;
}

function composeChunk(title: string, words: readonly string[]): string {
  if (words.length === 0) return title;
  const body = words.join(" ");
  return title ? `${title}\n${body}` : body;
}

// Start of the ~CHUNK_OVERLAP_TOKENS suffix of an emitted body slice, so the
// next chunk reopens with the same passage.
function overlapStart(start: number, end: number, prefix: readonly number[]): number {
  for (let offset = 1; offset <= end - start; offset += 1) {
    if (prefix[end]! - prefix[end - offset]! >= CHUNK_OVERLAP_TOKENS) return end - offset;
  }
  return start;
}

export function chunkDocument(title: string, body: string): DocumentChunk[] {
  const head = title.trim();
  const words = body.split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) return head ? [{ index: 0, text: head }] : [];
  const titleCost = head ? estimateTokenCount(`${head}\n`) : 0;
  // The title is never sliced. When it alone fills the budget there is no room
  // for body text, so the document collapses to its title.
  if (titleCost >= CHUNK_HARD_MAX_TOKENS) return [{ index: 0, text: head }];

  // One estimate per word, then prefix sums: tokenx usually counts single
  // spaces as zero tokens and splits each word the same way in context, so a
  // range difference approximates the body estimate without re-estimating a
  // growing prefix. Separator/structure tokens can differ; the exact per-chunk
  // re-estimate below plus its shrink loop enforces the hard cap.
  const prefix: number[] = [0];
  for (let index = 0; index < words.length; index += 1) {
    prefix.push(prefix[index]! + Math.max(1, estimateTokenCount(words[index]!)));
  }

  const chunks: DocumentChunk[] = [];
  let cursor = 0;
  let sliceStart = 0;

  while (cursor < words.length) {
    let start = sliceStart;
    let end = cursor + 1;
    while (end < words.length && titleCost + (prefix[end]! - prefix[start]!) < CHUNK_TARGET_TOKENS) end += 1;

    let text = composeChunk(head, words.slice(start, end));
    let estimate = estimateTokenCount(text);
    // Boundary check: prefix sums are exact for plain body words, but a title
    // boundary or an oversized trailing word can still overshoot the cap, so
    // drop trailing body words (then seeded overlap) until the chunk fits.
    while (estimate > CHUNK_HARD_MAX_TOKENS) {
      if (end - 1 > cursor) end -= 1;
      else if (start < cursor) start += 1;
      else break; // a single new word over the cap is unavoidable: progress wins
      text = composeChunk(head, words.slice(start, end));
      estimate = estimateTokenCount(text);
    }

    chunks.push({ index: chunks.length, text });
    cursor = end;
    sliceStart = overlapStart(start, end, prefix);
  }

  return chunks;
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    const x = a[index]!;
    const y = b[index]!;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (!Number.isFinite(denominator) || denominator === 0) return 0;
  const similarity = dot / denominator;
  if (!Number.isFinite(similarity)) return 0;
  return Math.min(1, Math.max(-1, similarity));
}

export function topK(candidates: readonly EmbeddingCandidate[], query: Float32Array, k: number): RankedCandidate[] {
  const limit = Math.floor(k);
  if (!(limit > 0)) return [];
  const ranked = candidates.map((candidate) => {
    const score = cosineSimilarity(candidate.vector, query);
    return { candidate, score: Number.isFinite(score) ? score : -Infinity };
  });
  ranked.sort((left, right) => {
    if (left.score !== right.score) return right.score - left.score;
    if (left.candidate.chunkIndex !== right.candidate.chunkIndex) {
      return left.candidate.chunkIndex - right.candidate.chunkIndex;
    }
    return left.candidate.id < right.candidate.id ? -1 : left.candidate.id > right.candidate.id ? 1 : 0;
  });
  return ranked.slice(0, Math.min(limit, ranked.length));
}

export function encodeEmbedding(vector: Float32Array): Uint8Array {
  const bytes = new Uint8Array(vector.length * 4);
  const view = new DataView(bytes.buffer);
  let offset = 0;
  for (const value of vector) {
    view.setFloat32(offset, value, true);
    offset += 4;
  }
  return bytes;
}

export function decodeEmbedding(blob: Uint8Array | ArrayBuffer): Float32Array {
  const bytes = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
  if (bytes.byteLength % 4 !== 0) {
    throw new RangeError(`embedding byteLength ${bytes.byteLength} is not a multiple of 4`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const vector = new Float32Array(bytes.byteLength / 4);
  for (let index = 0; index < vector.length; index += 1) {
    vector[index] = view.getFloat32(index * 4, true);
  }
  return vector;
}
