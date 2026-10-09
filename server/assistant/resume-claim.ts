import { Effect } from "effect";
import { run, type ConstraintViolation, type DbDriver, type DbError } from "../db/db";

// Resume-claim idempotency (ADR-0005 §Port P3; LX-80). One reservation per
// approval batch so a retry, a double-click, or two tabs cannot re-execute the
// same approved writes. Shared by the chat and task resume paths so the
// release/keep contract cannot drift.
export type ResumeClaimOutcome = "claimed" | "duplicate" | "unclaimed";

/**
 * `INSERT OR IGNORE` on the batch id is the atomic claim. Outcomes:
 *   claimed   — this caller owns the batch and may execute it.
 *   duplicate — a prior claim exists (or a non-missing-table DB error): refuse/
 *               no-op, mirroring the DO's "already claimed" semantics
 *               (`agent.ts:939`). Never blanket-proceed on a DB failure.
 *   unclaimed — the claim table is missing (migration 0029 not applied): a
 *               deployment state, not a batch state — proceed without a claim
 *               rather than block every resume; logged once per attempt.
 */
export function claimResumeBatch(db: DbDriver, batchId: string): Effect.Effect<ResumeClaimOutcome, never> {
  return run(db, "INSERT OR IGNORE INTO assistant_resume_claims (batch_id) VALUES (?)", batchId).pipe(
    Effect.map((changes) => (changes > 0 ? ("claimed" as const) : ("duplicate" as const))),
    Effect.catchAll((e: ConstraintViolation | DbError) => {
      const message = String((e as { message?: unknown }).message ?? e);
      if (/no such table/i.test(message)) {
        return Effect.logWarning(`[assistant] assistant_resume_claims missing (migration 0029) — resume ${batchId} proceeds without a claim`).pipe(Effect.as("unclaimed" as const));
      }
      return Effect.logError(`[assistant] resume claim failed for ${batchId}: ${message}`).pipe(Effect.as("duplicate" as const));
    })
  );
}

/** Release a claim for a batch that turned out not executable (still pending /
 *  no rows) so a later attempt can resume it. Best-effort. */
export function releaseResumeBatch(db: DbDriver, batchId: string): Effect.Effect<void, never> {
  return run(db, "DELETE FROM assistant_resume_claims WHERE batch_id = ?", batchId).pipe(
    Effect.asVoid,
    Effect.catchAll(() => Effect.void)
  );
}
