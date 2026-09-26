import { Effect } from "effect";
import { Db, queryFirst, run, DbError, RowNotFound, ConstraintViolation } from "../db/db";

export interface AssistantHealthRow {
  provider_id: string;
  failure_count: number;
  circuit_state: "open" | "closed" | "half-open";
  opened_at: string | null;
  last_probe_at: string | null;
  consecutive_failures: number;
}

export interface AssistantHealthDomain {
  providerId: string;
  failureCount: number;
  circuitState: "open" | "closed" | "half-open";
  openedAt: string | null;
  lastProbeAt: string | null;
  consecutiveFailures: number;
}

function toDomain(row: AssistantHealthRow): AssistantHealthDomain {
  return {
    providerId: row.provider_id,
    failureCount: row.failure_count,
    circuitState: row.circuit_state,
    openedAt: row.opened_at,
    lastProbeAt: row.last_probe_at,
    consecutiveFailures: row.consecutive_failures,
  };
}

export class AssistantHealthRepo extends Effect.Service<AssistantHealthRepo>()("Lexa/AssistantHealthRepo", {
  effect: Effect.gen(function* () {
    const db = yield* Db;

    return {
      get: (providerId: string): Effect.Effect<AssistantHealthRow, RowNotFound | DbError> =>
        queryFirst<AssistantHealthRow>(db, `SELECT * FROM assistant_provider_health WHERE provider_id = ?`, providerId),

      getDomain: (providerId: string): Effect.Effect<AssistantHealthDomain, RowNotFound | DbError> =>
        Effect.map(queryFirst<AssistantHealthRow>(db, `SELECT * FROM assistant_provider_health WHERE provider_id = ?`, providerId), toDomain),

      getOrNull: (providerId: string): Effect.Effect<AssistantHealthRow | null, DbError> =>
        Effect.gen(function* () {
          const row = yield* queryFirst<AssistantHealthRow>(db, `SELECT * FROM assistant_provider_health WHERE provider_id = ?`, providerId).pipe(
            Effect.catchTags({
              RowNotFound: () => Effect.succeed<AssistantHealthRow | null>(null),
              DbError: (e) => Effect.fail(e),
            })
          );
          return row;
        }),

      // Last observable signals for a provider, read from the call log (the
      // health row stores counts only). Feeds the enriched health response:
      // latency for the "Slow" state, the last failure code/time, and the
      // last call time (combined with last_probe_at into lastCheckedAt).
      lastProviderSignals: (providerId: string): Effect.Effect<{ latencyMs: number | null; lastFailureCode: string | null; lastFailureAt: string | null; lastCallAt: string | null }, DbError> =>
        queryFirst<{ latency_ms: number | null; last_failure_code: string | null; last_failure_at: string | null; last_call_at: string | null }>(
          db,
          `SELECT
             (SELECT latency_ms FROM assistant_call_logs WHERE provider_id = ? AND latency_ms IS NOT NULL ORDER BY created_at DESC, rowid DESC LIMIT 1) AS latency_ms,
             (SELECT error_code FROM assistant_call_logs WHERE provider_id = ? AND status = 'error' AND error_code IS NOT NULL ORDER BY created_at DESC, rowid DESC LIMIT 1) AS last_failure_code,
             (SELECT created_at FROM assistant_call_logs WHERE provider_id = ? AND status = 'error' ORDER BY created_at DESC, rowid DESC LIMIT 1) AS last_failure_at,
             (SELECT created_at FROM assistant_call_logs WHERE provider_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1) AS last_call_at`,
          providerId,
          providerId,
          providerId,
          providerId
        ).pipe(
          Effect.map((r) => ({
            latencyMs: r.latency_ms ?? null,
            lastFailureCode: r.last_failure_code ?? null,
            lastFailureAt: r.last_failure_at ?? null,
            lastCallAt: r.last_call_at ?? null,
          })),
          Effect.catchTag("RowNotFound", () => Effect.succeed({ latencyMs: null, lastFailureCode: null, lastFailureAt: null, lastCallAt: null }))
        ),

      upsert: (row: { providerId: string; failureCount?: number; circuitState?: AssistantHealthRow["circuit_state"]; openedAt?: string | null; lastProbeAt?: string | null; consecutiveFailures?: number }): Effect.Effect<AssistantHealthRow, ConstraintViolation | DbError | RowNotFound> =>
        Effect.gen(function* () {
          const existing = yield* queryFirst<AssistantHealthRow>(db, `SELECT * FROM assistant_provider_health WHERE provider_id = ?`, row.providerId).pipe(
            Effect.catchTag("RowNotFound", () => Effect.succeed<AssistantHealthRow | null>(null))
          );
          if (existing) {
            const failureCount = row.failureCount ?? existing.failure_count;
            const circuitState = row.circuitState ?? existing.circuit_state;
            const openedAt = row.openedAt !== undefined ? row.openedAt : existing.opened_at;
            const lastProbeAt = row.lastProbeAt !== undefined ? row.lastProbeAt : existing.last_probe_at;
            const consecutiveFailures = row.consecutiveFailures ?? existing.consecutive_failures;
            yield* run(
              db,
              `UPDATE assistant_provider_health SET failure_count = ?, circuit_state = ?, opened_at = ?, last_probe_at = ?, consecutive_failures = ? WHERE provider_id = ?`,
              failureCount, circuitState, openedAt, lastProbeAt, consecutiveFailures, row.providerId
            );
          } else {
            yield* run(
              db,
              `INSERT INTO assistant_provider_health (provider_id, failure_count, circuit_state, opened_at, last_probe_at, consecutive_failures) VALUES (?, ?, ?, ?, ?, ?)`,
              row.providerId, row.failureCount ?? 0, row.circuitState ?? "closed", row.openedAt ?? null, row.lastProbeAt ?? null, row.consecutiveFailures ?? 0
            );
          }
          return yield* queryFirst<AssistantHealthRow>(db, `SELECT * FROM assistant_provider_health WHERE provider_id = ?`, row.providerId);
        }),

      put: (row: AssistantHealthRow): Effect.Effect<AssistantHealthRow, ConstraintViolation | DbError | RowNotFound> =>
        run(
          db,
          `INSERT INTO assistant_provider_health (provider_id, failure_count, circuit_state, opened_at, last_probe_at, consecutive_failures) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(provider_id) DO UPDATE SET failure_count = excluded.failure_count, circuit_state = excluded.circuit_state, opened_at = excluded.opened_at, last_probe_at = excluded.last_probe_at, consecutive_failures = excluded.consecutive_failures`,
          row.provider_id, row.failure_count, row.circuit_state, row.opened_at, row.last_probe_at, row.consecutive_failures
        ).pipe(Effect.flatMap(() => queryFirst<AssistantHealthRow>(db, `SELECT * FROM assistant_provider_health WHERE provider_id = ?`, row.provider_id))),

      delete: (providerId: string): Effect.Effect<void, DbError | ConstraintViolation> =>
        run(db, `DELETE FROM assistant_provider_health WHERE provider_id = ?`, providerId).pipe(Effect.map(() => undefined)),
    };
  }),
}) {}
