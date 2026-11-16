// Workers AI embeddings over the account-scoped REST API. Leaf module: it reads
// the RuntimeEnv snapshot and does HTTP only — no DB, no Effect service, no
// service dependency. One code path serves Bun dev and the deployed Worker:
// POST /accounts/<id>/ai/v1/embeddings with { model, input }, Authorization
// Bearer <token>. A primary 404/405 falls back internally to the native
// /ai/run/<model> shape.
//
// `embedTexts` never throws: unconfigured, transport, timeout, JSON and shape
// failures are all `null`, which callers treat as "no vectors this time".

import type { RuntimeEnv } from "../env";

export const EMBEDDINGS_MODEL_DEFAULT = "@cf/baai/bge-base-en-v1.5";
export const EMBEDDING_DIMENSIONS = 768;

const API_BASE = "https://api.cloudflare.com/client/v4/accounts";
const BATCH_SIZE = 100;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 2;

export function embeddingsConfigured(env: RuntimeEnv): boolean {
  return (
    (env.LXK_WORKERS_AI_ACCOUNT_ID ?? "").trim() !== "" &&
    (env.LXK_WORKERS_AI_API_TOKEN ?? "").trim() !== ""
  );
}

export async function embedTexts(
  env: RuntimeEnv,
  texts: string[],
  opts?: { fetchImpl?: typeof fetch }
): Promise<number[][] | null> {
  const accountId = (env.LXK_WORKERS_AI_ACCOUNT_ID ?? "").trim();
  const token = (env.LXK_WORKERS_AI_API_TOKEN ?? "").trim();
  if (accountId === "" || token === "") return null;
  if (texts.length === 0) return [];

  const fetchImpl = opts?.fetchImpl ?? fetch;
  const model = env.LXK_EMBEDDINGS_MODEL?.trim() || EMBEDDINGS_MODEL_DEFAULT;
  const primaryUrl = `${API_BASE}/${accountId}/ai/v1/embeddings`;
  const fallbackUrl = `${API_BASE}/${accountId}/ai/run/${model}`;
  const vectors: number[][] = [];
  for (let start = 0; start < texts.length; start += BATCH_SIZE) {
    const batch = texts.slice(start, start + BATCH_SIZE);
    const batchVectors = await embedBatch({ primaryUrl, fallbackUrl, token, model, batch, fetchImpl });
    if (batchVectors === null) return null;
    vectors.push(...batchVectors);
  }
  return vectors;
}

type AttemptResult =
  | { kind: "ok"; vectors: number[][] }
  | { kind: "retry" }
  | { kind: "fail" };

interface BatchConfig {
  primaryUrl: string;
  fallbackUrl: string;
  token: string;
  model: string;
  batch: string[];
  fetchImpl: typeof fetch;
}

// One retry on 5xx or a thrown network/timeout error; the 404/405 fallback is
// internal to an attempt and does not consume the retry budget.
async function embedBatch(cfg: BatchConfig): Promise<number[][] | null> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const result = await attemptBatch(cfg);
    if (result.kind === "ok") return result.vectors;
    if (result.kind === "fail") return null;
  }
  return null;
}

async function attemptBatch(cfg: BatchConfig): Promise<AttemptResult> {
  const primary = await postJson(cfg.primaryUrl, { model: cfg.model, input: cfg.batch }, cfg.token, cfg.fetchImpl);
  if (primary.kind === "network") return { kind: "retry" };
  if (primary.status === 404 || primary.status === 405) {
    const fallback = await postJson(cfg.fallbackUrl, { text: cfg.batch }, cfg.token, cfg.fetchImpl);
    if (fallback.kind === "network") return { kind: "retry" };
    if (!fallback.ok) return fallback.status >= 500 ? { kind: "retry" } : { kind: "fail" };
    const vectors = parseVectors(objectField(objectField(fallback.body, "result"), "data"), cfg.batch.length);
    return vectors === null ? { kind: "fail" } : { kind: "ok", vectors };
  }
  if (!primary.ok) return primary.status >= 500 ? { kind: "retry" } : { kind: "fail" };
  const entries = objectField(primary.body, "data");
  if (!Array.isArray(entries) || entries.length !== cfg.batch.length) return { kind: "fail" };
  const vectors = parseVectors(entries.map((entry) => objectField(entry, "embedding")), cfg.batch.length);
  return vectors === null ? { kind: "fail" } : { kind: "ok", vectors };
}

type HttpResult =
  | { kind: "network" }
  | { kind: "response"; ok: boolean; status: number; body: unknown };

// The abort timer covers the response body too: a stalled body must not outlive
// the 10 s per-call budget the caller relies on.
async function postJson(
  url: string,
  payload: unknown,
  token: string,
  fetchImpl: typeof fetch
): Promise<HttpResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) return { kind: "response", ok: false, status: res.status, body: undefined };
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      if (controller.signal.aborted) return { kind: "network" };
      body = undefined;
    }
    return { kind: "response", ok: true, status: res.status, body };
  } catch {
    return { kind: "network" };
  } finally {
    clearTimeout(timer);
  }
}

function objectField(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return (value as Record<string, unknown>)[key];
}

// Every vector must be exactly EMBEDDING_DIMENSIONS long; a mismatch means the
// provider contract changed, so the batch is dropped rather than persisted as a
// corrupt row. One warning per bad batch.
function parseVectors(raw: unknown, expectedCount: number): number[][] | null {
  if (!Array.isArray(raw) || raw.length !== expectedCount) return null;
  const vectors: number[][] = [];
  for (const value of raw) {
    if (!Array.isArray(value) || value.length !== EMBEDDING_DIMENSIONS || value.some((n) => typeof n !== "number")) {
      console.warn(`[embeddings] unexpected vector shape — expected ${EMBEDDING_DIMENSIONS} dimensions; dropping batch`);
      return null;
    }
    vectors.push(value as number[]);
  }
  return vectors;
}
