import { describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../env";
import { EMBEDDING_DIMENSIONS, embedTexts } from "./embeddings-client";

const CONFIGURED: RuntimeEnv = {
  LXK_WORKERS_AI_ACCOUNT_ID: "acct-123",
  LXK_WORKERS_AI_API_TOKEN: "token-abc",
};

function vector(fill: number): number[] {
  return Array.from({ length: EMBEDDING_DIMENSIONS }, () => fill);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("embedTexts", () => {
  it("returns null without fetching when unconfigured", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return json({ data: [] });
    }) as unknown as typeof fetch;

    const result = await embedTexts({ LXK_WORKERS_AI_ACCOUNT_ID: "acct-123" }, ["hello"], { fetchImpl });
    expect(result).toBeNull();
    expect(calls).toBe(0);
  });

  it("returns an empty list for empty input without fetching", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return json({ data: [] });
    }) as unknown as typeof fetch;

    const result = await embedTexts(CONFIGURED, [], { fetchImpl });
    expect(result).toEqual([]);
    expect(calls).toBe(0);
  });

  it("parses ordered vectors from the embeddings endpoint", async () => {
    const first = vector(0.25);
    const second = vector(-0.5);
    const urls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      urls.push(String(input));
      expect(init?.method).toBe("POST");
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer token-abc");
      expect(JSON.parse(String(init?.body))).toEqual({
        model: "@cf/baai/bge-base-en-v1.5",
        input: ["alpha", "beta"],
      });
      return json({ data: [{ embedding: first }, { embedding: second }] });
    }) as unknown as typeof fetch;

    const result = await embedTexts(CONFIGURED, ["alpha", "beta"], { fetchImpl });
    expect(result).toEqual([first, second]);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toBe("https://api.cloudflare.com/client/v4/accounts/acct-123/ai/v1/embeddings");
  });

  it("retries once on a 5xx then returns null", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return json({ errors: [{ code: 500 }] }, 500);
    }) as unknown as typeof fetch;

    const result = await embedTexts(CONFIGURED, ["alpha"], { fetchImpl });
    expect(result).toBeNull();
    expect(calls).toBe(2);
  });

  it("returns null when a vector length is not the embedding dimension", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      let calls = 0;
      const fetchImpl = (async () => {
        calls += 1;
        return json({ data: [{ embedding: vector(1).slice(0, EMBEDDING_DIMENSIONS - 1) }] });
      }) as unknown as typeof fetch;

      const result = await embedTexts(CONFIGURED, ["alpha"], { fetchImpl });
      expect(result).toBeNull();
      expect(calls).toBe(1);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("falls back to /ai/run when the embeddings endpoint answers 404", async () => {
    const embedding = vector(0.75);
    const urls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith("/ai/v1/embeddings")) return json({ errors: [{ code: 404 }] }, 404);
      return json({ result: { data: [embedding] } });
    }) as unknown as typeof fetch;

    const result = await embedTexts(CONFIGURED, ["alpha"], { fetchImpl });
    expect(result).toEqual([embedding]);
    expect(urls).toHaveLength(2);
    expect(urls[1]).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acct-123/ai/run/@cf/baai/bge-base-en-v1.5"
    );
  });

  it("returns null after one retry when the network throws", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      throw new TypeError("network down");
    }) as unknown as typeof fetch;

    const result = await embedTexts(CONFIGURED, ["alpha"], { fetchImpl });
    expect(result).toBeNull();
    expect(calls).toBe(2);
  });

  it("times out a stalled response body instead of waiting for it", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        calls += 1;
        const signal = init?.signal;
        return {
          ok: true,
          status: 200,
          json: () => {
            const { promise, reject } = Promise.withResolvers<unknown>();
            signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
            return promise;
          },
        } as unknown as Response;
      }) as unknown as typeof fetch;

      const pending = embedTexts(CONFIGURED, ["alpha"], { fetchImpl });
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await pending).toBeNull();
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
