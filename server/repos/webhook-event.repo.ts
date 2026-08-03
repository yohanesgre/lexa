import { Effect } from "effect";
import { Sqlite, queryFirst, run, DbError, ConstraintViolation } from "../db/database";

export class WebhookEventRepo extends Effect.Service<WebhookEventRepo>()("Lexa/WebhookEventRepo", {
  effect: Effect.gen(function* () {
    const db = yield* Sqlite;

    return {
      // Cheap pre-check: has this delivery id been processed before?
      isSeen: (deliveryId: string): Effect.Effect<boolean, DbError> =>
        Effect.map(
          queryFirst<{ delivery_id: string }>(db, `SELECT delivery_id FROM webhook_events WHERE delivery_id = ?`, deliveryId).pipe(
            Effect.catchTag("RowNotFound", () => Effect.succeed(null))
          ),
          (row) => row !== null
        ),

      // INSERT AFTER successful processing (never before — a mid-processing
      // failure must leave the delivery unrecorded so GitHub's retry
      // reprocesses it; all handlers are idempotent).
      recordDelivery: (deliveryId: string): Effect.Effect<void, DbError | ConstraintViolation> =>
        Effect.map(
          run(db, `INSERT OR IGNORE INTO webhook_events (delivery_id) VALUES (?)`, deliveryId),
          () => undefined
        ),

      prune: (olderThanDays: number): Effect.Effect<void, DbError | ConstraintViolation> =>
        Effect.map(
          run(db, `DELETE FROM webhook_events WHERE received_at < datetime('now', ?)`, `-${olderThanDays} days`),
          () => undefined
        ),
    };
  }),
  dependencies: [],
}) {}
