import { describe, expect, it } from "vitest";
import { estimateTokenCount } from "tokenx";
import {
  CHUNK_HARD_MAX_TOKENS,
  chunkDocument,
  cosineSimilarity,
  decodeEmbedding,
  encodeEmbedding,
  topK,
  type DocumentChunk,
  type EmbeddingCandidate,
} from "./assistant-chunks";

function bodyWords(chunk: DocumentChunk, title: string): string[] {
  const prefix = `${title}\n`;
  const body = chunk.text.startsWith(prefix) ? chunk.text.slice(prefix.length) : chunk.text;
  return body.split(" ").filter((word) => word.length > 0);
}

function candidate(id: string, chunkIndex: number, vector: number[]): EmbeddingCandidate {
  return { id, kind: "wiki", refId: "wiki-1", chunkIndex, content: id, vector: Float32Array.from(vector) };
}

describe("chunkDocument", () => {
  it("keeps a short document in one title-prefixed chunk", () => {
    const chunk = chunkDocument("Deploy runbook", "Restart the service then verify the health endpoint.")[0];
    expect(chunk?.index).toBe(0);
    expect(chunk?.text).toBe("Deploy runbook\nRestart the service then verify the health endpoint.");
  });

  it("emits one title-only chunk for an empty body and nothing when the title is blank too", () => {
    expect(chunkDocument("Empty page", "  \n\t ")).toEqual([{ index: 0, text: "Empty page" }]);
    expect(chunkDocument("   ", "\n\t")).toEqual([]);
  });

  it("splits a long body with overlap, full coverage, hard-capped chunks, and sequential indices", () => {
    const title = "Retrieval notes";
    const body = Array.from({ length: 3000 }, (_, index) => `token${index}`).join(" ");
    const chunks = chunkDocument(title, body);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((chunk) => chunk.index)).toEqual(chunks.map((_, index) => index));
    for (const chunk of chunks) {
      expect(chunk.text.startsWith(`${title}\n`)).toBe(true);
      expect(estimateTokenCount(chunk.text)).toBeLessThanOrEqual(CHUNK_HARD_MAX_TOKENS);
    }

    const covered = new Set(chunks.flatMap((chunk) => bodyWords(chunk, title)));
    expect(body.split(" ").filter((word) => !covered.has(word))).toEqual([]);

    for (let index = 1; index < chunks.length; index += 1) {
      const previous = new Set(bodyWords(chunks[index - 1]!, title));
      const shared = bodyWords(chunks[index]!, title).filter((word) => previous.has(word));
      expect(shared.length).toBeGreaterThan(0);
    }

    expect(chunkDocument(title, body)).toEqual(chunks);
  });
});

describe("embedding bytes", () => {
  it("round-trips float32 values as little-endian bytes for Uint8Array and ArrayBuffer blobs", () => {
    const vector = Float32Array.from([1.5, -2.25, 0, 3.5]);
    const encoded = encodeEmbedding(vector);
    expect(Array.from(encoded)).toEqual([
      0x00, 0x00, 0xc0, 0x3f, // 1.5
      0x00, 0x00, 0x10, 0xc0, // -2.25
      0x00, 0x00, 0x00, 0x00, // 0
      0x00, 0x00, 0x60, 0x40, // 3.5
    ]);
    expect(Array.from(decodeEmbedding(encoded))).toEqual(Array.from(vector));
    const arrayBuffer = new ArrayBuffer(encoded.byteLength);
    new Uint8Array(arrayBuffer).set(encoded);
    expect(Array.from(decodeEmbedding(arrayBuffer))).toEqual(Array.from(vector));
    expect(Array.from(decodeEmbedding(new Uint8Array([0x00, 0x00, 0xc0, 0x3f])))).toEqual([1.5]);
    expect(() => decodeEmbedding(new Uint8Array(3))).toThrow(RangeError);
  });
});

describe("cosineSimilarity", () => {
  it("scores identical vectors 1, orthogonal vectors 0, and zero vectors 0", () => {
    const vector = Float32Array.from([3, -4]);
    expect(cosineSimilarity(vector, vector)).toBe(1);
    expect(cosineSimilarity(Float32Array.from([3, -4]), Float32Array.from([-3, 4]))).toBe(-1);
    expect(cosineSimilarity(Float32Array.from([1, 0]), Float32Array.from([0, 1]))).toBe(0);
    expect(cosineSimilarity(Float32Array.from([0, 0]), vector)).toBe(0);
    expect(cosineSimilarity(new Float32Array(), new Float32Array())).toBe(0);
    expect(cosineSimilarity(Float32Array.from([1, 0]), Float32Array.from([1, 0, 0]))).toBe(0);
  });
});

describe("topK", () => {
  it("orders by score with a chunkIndex/id tiebreak and clamps k", () => {
    const query = Float32Array.from([1, 0]);
    const candidates = [
      candidate("c", 0, [0, 1]),
      candidate("a", 2, [1, 0]),
      candidate("b", 2, [1, 0]),
      candidate("d", 1, [1, 0]),
      candidate("e", 0, [-1, 0]),
    ];

    expect(topK(candidates, query, 99).map((entry) => entry.candidate.id)).toEqual(["d", "a", "b", "c", "e"]);
    expect(topK(candidates, query, 2).map((entry) => entry.candidate.id)).toEqual(["d", "a"]);
    expect(topK(candidates, query, 1)[0]?.score).toBe(1);
    expect(topK(candidates, query, 0)).toEqual([]);
    expect(topK(candidates, query, -3)).toEqual([]);
  });
});
