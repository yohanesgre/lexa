import { Effect } from "effect";
import { Sqlite, queryFirst, run, DbError, RowNotFound, ConstraintViolation } from "../db/database";

export interface HeraldHealthRow {
  provider_id: string;
  failure_count: number;
  circuit_state: "open" | "closed" | "half-open";
  opened_at: string | null;
  last_probe_at: string | null;
  consecutive_failures: number;
}

export interface HeraldHealthDomain {
  providerId: string;
  failureCount: number;
  circuitState: "open" | "closed" | "half-open";
  openedAt: string | null;
  lastProbeAt: string | null;
  consecutiveFailures: number;
}

function toDomain(row: HeraldHealthRow): HeraldHealthDomain {
  return {
    providerId: row.provider_id,
    failureCount: row.failure_count,
    circuitState: row.circuit_state,
    openedAt: row.opened_at,
    lastProbeAt: row.last_probe_at,
    consecutiveFailures: row.consecutive_failures,
  };
}

export class HeraldHealthRepo extends Effect.Service<HeraldHealthRepo>()("Lexa/HeraldHealthRepo", {
  effect: Effect.gen(function* () {
    const db = yield* Sqlite;

    return {
      get: (providerId: string): Effect.Effect<HeraldHealthRow, RowNotFound | DbError> =>
        queryFirst<HeraldHealthRow>(db, `SELECT * FROM herald_provider_health WHERE provider_id = ?`, providerId),

      getDomain: (providerId: string): Effect.Effect<HeraldHealthDomain, RowNotFound | DbError> =>
        Effect.map(queryFirst<HeraldHealthRow>(db, `SELECT * FROM herald_provider_health WHERE provider_id = ?`, providerId), toDomain),

      getOrNull: (providerId: string): Effect.Effect<HeraldHealthRow | null, DbError> =>
        Effect.gen(function* () {
          const row = yield* queryFirst<HeraldHealthRow>(db, `SELECT * FROM herald_provider_health WHERE provider_id = ?`, providerId).pipe(
            Effect.catchTags({
              RowNotFound: () => Effect.succeed<HeraldHealthRow | null>(null),
              DbError: (e) => Effect.fail(e),
            })
          );
          return row;
        }),

      upsert: (row: { providerId: string; failureCount?: number; circuitState?: HeraldHealthRow["circuit_state"]; openedAt?: string | null; lastProbeAt?: string | null; consecutiveFailures?: number }): Effect.Effect<HeraldHealthRow, ConstraintViolation | DbError | RowNotFound> =>
        Effect.gen(function* () {
          const existing = yield* queryFirst<HeraldHealthRow>(db, `SELECT * FROM herald_provider_health WHERE provider_id = ?`, row.providerId).pipe(
            Effect.catchTag("RowNotFound", () => Effect.succeed<HeraldHealthRow | null>(null))
          );
          if (existing) {
            const failureCount = row.failureCount ?? existing.failure_count;
            const circuitState = row.circuitState ?? existing.circuit_state;
            const openedAt = row.openedAt !== undefined ? row.openedAt : existing.opened_at;
            const lastProbeAt = row.lastProbeAt !== undefined ? row.lastProbeAt : existing.last_probe_at;
            const consecutiveFailures = row.consecutiveFailures ?? existing.consecutive_failures;
            yield* run(
              db,
              `UPDATE herald_provider_health SET failure_count = ?, circuit_state = ?, opened_at = ?, last_probe_at = ?, consecutive_failures = ? WHERE provider_id = ?`,
              failureCount, circuitState, openedAt, lastProbeAt, consecutiveFailures, row.providerId
            );
          } else {
            yield* run(
              db,
              `INSERT INTO herald_provider_health (provider_id, failure_count, circuit_state, opened_at, last_probe_at, consecutive_failures) VALUES (?, ?, ?, ?, ?, ?)`,
              row.providerId, row.failureCount ?? 0, row.circuitState ?? "closed", row.openedAt ?? null, row.lastProbeAt ?? null, row.consecutiveFailures ?? 0
            );
          }
          return yield* queryFirst<HeraldHealthRow>(db, `SELECT * FROM herald_provider_health WHERE provider_id = ?`, row.providerId);
        }),

      put: (row: HeraldHealthRow): Effect.Effect<HeraldHealthRow, ConstraintViolation | DbError | RowNotFound> =>
        run(
          db,
          `INSERT INTO herald_provider_health (provider_id, failure_count, circuit_state, opened_at, last_probe_at, consecutive_failures) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(provider_id) DO UPDATE SET failure_count = excluded.failure_count, circuit_state = excluded.circuit_state, opened_at = excluded.opened_at, last_probe_at = excluded.last_probe_at, consecutive_failures = excluded.consecutive_failures`,
          row.provider_id, row.failure_count, row.circuit_state, row.opened_at, row.last_probe_at, row.consecutive_failures
        ).pipe(Effect.flatMap(() => queryFirst<HeraldHealthRow>(db, `SELECT * FROM herald_provider_health WHERE provider_id = ?`, row.provider_id))),

      delete: (providerId: string): Effect.Effect<void, DbError | ConstraintViolation> =>
        run(db, `DELETE FROM herald_provider_health WHERE provider_id = ?`, providerId).pipe(Effect.map(() => undefined)),
    };
  }),
}) {}
