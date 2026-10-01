// Worker-side handlers for the DO → Worker internal routes (ADR-0003 §B.2/B.3).
// These are mounted in `server/workers-entry.ts` behind the HMAC guard
// (`authorizeInternalRequest`) and operate on the async `DbDriver` the worker
// factory already holds. Kept pure of `Request` parsing where possible so the
// D1 read/write contract is unit-testable with a bun-sqlite driver.
//
//   GET  /api/internal/assistant/legacy/<threadKey>  → { messages }
//   POST /api/internal/assistant/mirror              → { ok: true }

import { Effect } from "effect";
import type { DbDriver } from "../db/db";
import { queryFirst, runReturning, RowNotFound, type ConstraintViolation, type DbError } from "../db/db";
import { parseThreadKey } from "./agent-gate";

export interface MirrorThreadInput {
  threadKey: string;
  projectId: string;
  messages: unknown[];
  summary: string | null;
  // `null` preserves the existing column (engine value not supplied yet);
  // a number replaces it. See `MirrorTranscriptInput` in agent-runtime.ts.
  summarizedCount: number | null;
  title: string | null;
}

interface ThreadRow {
  messages: string;
}

// Read the D1 mirror row's raw messages for a thread key. `null` means "no row
// or empty transcript" — nothing to import (migrate-on-read is a no-op).
export function readLegacyThread(
  driver: DbDriver,
  documentType: string,
  documentId: string
): Effect.Effect<unknown[] | null, DbError> {
  return queryFirst<ThreadRow>(
    driver,
    `SELECT messages FROM assistant_threads WHERE document_type = ? AND document_id = ?`,
    documentType,
    documentId
  ).pipe(
    Effect.map((row) => {
      try {
        const parsed = JSON.parse(row.messages);
        return Array.isArray(parsed) && parsed.length > 0 ? (parsed as unknown[]) : null;
      } catch {
        return null;
      }
    }),
    Effect.catchTag("RowNotFound", () => Effect.succeed(null))
  );
}

// Upsert semantics match `AssistantThreadRepo.saveThread`: project/owner are not
// written here (the D1 row already exists — the gate upserts chat rows and the
// task/wiki surfaces create theirs); title backfills only when still NULL, and
// summary/summarized_count only when the caller supplies a non-NULL value.
// A missing row (no thread surface created it) is warned, not silently dropped.
export function mirrorThread(
  driver: DbDriver,
  input: MirrorThreadInput
): Effect.Effect<{ ok: true }, ConstraintViolation | DbError> {
  const parsed = parseThreadKey(input.threadKey);
  if (!parsed) return Effect.succeed({ ok: true });
  return runReturning<{ document_id: string }>(
    driver,
    `UPDATE assistant_threads
     SET messages = ?,
         summary = COALESCE(?, assistant_threads.summary),
         summarized_count = COALESCE(?, assistant_threads.summarized_count),
         title = COALESCE(assistant_threads.title, ?),
         updated_at = datetime('now')
     WHERE document_type = ? AND document_id = ?
     RETURNING document_id`,
    JSON.stringify(input.messages),
    input.summary,
    input.summarizedCount,
    input.title,
    parsed.documentType,
    parsed.documentId
  ).pipe(
    Effect.as({ ok: true as const }),
    Effect.catchTag("RowNotFound", () =>
      Effect.logWarning(
        `[Assistant] mirror: no assistant_threads row for ${parsed.documentType}:${parsed.documentId}`
      ).pipe(Effect.as({ ok: true as const }))
    )
  );
}

export interface InternalAssistantRouteResult {
  status: number;
  body: unknown;
}

/**
 * Dispatch one authenticated `/api/internal/assistant/*` request. Returns a
 * `{ status, body }` result so the caller (workers-entry) can serialise it in
 * the same envelope as the rest of the worker. Unknown paths → 404.
 */
export async function handleInternalAssistantRequest(input: {
  method: string;
  path: string;
  body: unknown;
  driver: DbDriver;
}): Promise<InternalAssistantRouteResult> {
  const { method, path, driver } = input;

  if (method === "POST" && path === "/api/internal/assistant/mirror") {
    const payload = (input.body ?? {}) as Partial<MirrorThreadInput>;
    if (
      typeof payload.threadKey !== "string" ||
      typeof payload.projectId !== "string" ||
      !Array.isArray(payload.messages)
    ) {
      return { status: 400, body: { error: { code: "INVALID_PAYLOAD", message: "Invalid mirror payload" } } };
    }
    const result = await Effect.runPromise(
      mirrorThread(driver, {
        threadKey: payload.threadKey,
        projectId: payload.projectId,
        messages: payload.messages,
        summary: typeof payload.summary === "string" ? payload.summary : null,
        summarizedCount: typeof payload.summarizedCount === "number" ? payload.summarizedCount : null,
        title: typeof payload.title === "string" ? payload.title : null,
      })
    );
    return { status: 200, body: result };
  }

  if (method === "GET" && path.startsWith("/api/internal/assistant/legacy/")) {
    const rawSegment = path.slice("/api/internal/assistant/legacy/".length);
    if (rawSegment.length === 0 || rawSegment.includes("/")) {
      return { status: 404, body: { error: { code: "ASSISTANT_THREAD_NOT_FOUND", message: "Unknown thread" } } };
    }
    let threadKey: string;
    try {
      threadKey = decodeURIComponent(rawSegment);
    } catch {
      return { status: 404, body: { error: { code: "ASSISTANT_THREAD_NOT_FOUND", message: "Unknown thread" } } };
    }
    const parsed = parseThreadKey(threadKey);
    if (!parsed) {
      return { status: 404, body: { error: { code: "ASSISTANT_THREAD_NOT_FOUND", message: "Unknown thread" } } };
    }
    const messages = await Effect.runPromise(readLegacyThread(driver, parsed.documentType, parsed.documentId));
    if (messages === null) {
      return { status: 404, body: { error: { code: "ASSISTANT_THREAD_NOT_FOUND", message: "No legacy transcript" } } };
    }
    return { status: 200, body: { messages } };
  }

  return { status: 404, body: { error: { code: "ASSISTANT_THREAD_NOT_FOUND", message: "Unknown internal assistant route" } } };
}
