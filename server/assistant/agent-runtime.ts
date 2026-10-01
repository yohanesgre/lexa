// DO ↔ Worker runtime helpers (ADR-0003 §B.3): legacy import-on-read and the
// per-step D1 mirror. Fetch-based with an injectable `fetchImpl` so the
// request/response contract, the retry-once policy, and the conversion are
// unit-testable outside workerd.
//
// Wire contract with the Worker internal routes (`server/assistant/internal-routes.ts`):
//   GET  /api/internal/assistant/legacy/<threadKey>  → { messages: LegacyStoredMessage[] }
//   POST /api/internal/assistant/mirror              → { ok: true }
// Both carry a freshly signed `X-Lexa-Internal` identity (D6).

import { signInternalAuth, type InternalAuthIdentity } from "./internal-auth";
import {
  INTERNAL_AUTH_ACTOR_HEADER,
  INTERNAL_AUTH_HEADER,
  INTERNAL_AUTH_PROJECT_HEADER,
  INTERNAL_AUTH_THREAD_HEADER,
} from "./internal-auth";
import {
  convertLegacyMessages,
  type ConvertedUIMessage,
  type LegacyStoredMessage,
} from "./legacy-convert";

export const INTERNAL_LEGACY_PATH = "/api/internal/assistant/legacy";
export const INTERNAL_MIRROR_PATH = "/api/internal/assistant/mirror";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface AssistantInternalDeps {
  /** Public worker origin, e.g. `https://lexa.example` (no trailing slash). */
  origin: string;
  identity: InternalAuthIdentity;
  masterKey: string;
  fetchImpl?: FetchLike | undefined;
  nowMs?: (() => number) | undefined;
}

export interface MirrorTranscriptInput {
  messages: unknown[];
  summary: string | null;
  // `null` = "the DO has no engine value yet, keep the D1 column" (the SQL uses
  // COALESCE). Never send a literal 0 here: 0 is a real value and would clobber
  // a seeded `summarized_count` on every persist.
  summarizedCount: number | null;
  title?: string | null | undefined;
}

async function signedHeaders(deps: AssistantInternalDeps): Promise<Headers> {
  const internal = await signInternalAuth(deps.masterKey, deps.identity, deps.nowMs?.() ?? Date.now());
  const headers = new Headers({ "Content-Type": "application/json" });
  headers.set(INTERNAL_AUTH_ACTOR_HEADER, deps.identity.actorUserId);
  headers.set(INTERNAL_AUTH_PROJECT_HEADER, deps.identity.projectId);
  headers.set(INTERNAL_AUTH_THREAD_HEADER, deps.identity.threadKey);
  headers.set(INTERNAL_AUTH_HEADER, internal);
  return headers;
}

function originOf(deps: AssistantInternalDeps): string {
  return deps.origin.endsWith("/") ? deps.origin.slice(0, -1) : deps.origin;
}

/** Raised when the DO cannot reach its Worker internal routes. */
export class AssistantInternalUnavailable extends Error {
  constructor(message = "Assistant internal route unavailable") {
    super(message);
    this.name = "AssistantInternalUnavailable";
  }
}

async function withRetryOnce<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch {
    return await run();
  }
}

/**
 * Read the legacy D1 transcript for this thread and convert it to UIMessages.
 * Returns `null` when the thread has no legacy D1 row/messages (nothing to
 * import). Throws `AssistantInternalUnavailable` after the retry-once policy
 * fails — the caller maps that to `502 ASSISTANT_UNAVAILABLE`.
 */
export async function fetchLegacyTranscript(deps: AssistantInternalDeps): Promise<ConvertedUIMessage[] | null> {
  const fetchImpl: FetchLike = deps.fetchImpl ?? ((input, init) => fetch(input, init));
  const url = `${originOf(deps)}${INTERNAL_LEGACY_PATH}/${encodeURIComponent(deps.identity.threadKey)}`;
  try {
    return await withRetryOnce(async () => {
      const res = await fetchImpl(url, { method: "GET", headers: await signedHeaders(deps) });
      if (res.status === 404) return null;
      if (!res.ok) throw new AssistantInternalUnavailable(`legacy read failed (${res.status})`);
      const body = (await res.json()) as { messages?: unknown };
      const messages = Array.isArray(body.messages) ? (body.messages as LegacyStoredMessage[]) : [];
      return convertLegacyMessages(messages);
    });
  } catch (e) {
    if (e instanceof AssistantInternalUnavailable) throw e;
    throw new AssistantInternalUnavailable(e instanceof Error ? e.message : String(e));
  }
}

/**
 * Mirror the persisted transcript to D1 (`assistant_threads`). Retries once on
 * failure; returns whether the mirror landed. Never throws — a mirror failure
 * is a warn + leave the cursor advanced by the caller so the next step
 * re-mirrors the tail.
 */
export async function mirrorTranscript(deps: AssistantInternalDeps, input: MirrorTranscriptInput): Promise<boolean> {
  const fetchImpl: FetchLike = deps.fetchImpl ?? ((input_, init) => fetch(input_, init));
  const url = `${originOf(deps)}${INTERNAL_MIRROR_PATH}`;
  const body = JSON.stringify({
    threadKey: deps.identity.threadKey,
    projectId: deps.identity.projectId,
    messages: input.messages,
    summary: input.summary,
    summarizedCount: input.summarizedCount,
    title: input.title ?? null,
  });
  try {
    return await withRetryOnce(async () => {
      const res = await fetchImpl(url, { method: "POST", headers: await signedHeaders(deps), body });
      if (!res.ok) throw new AssistantInternalUnavailable(`mirror failed (${res.status})`);
      return true;
    });
  } catch (e) {
    console.warn("[Assistant] mirror failed after retry:", e instanceof Error ? e.message : String(e));
    return false;
  }
}
