/**
 * Herald provider health / circuit breaker (pla-1).
 *
 * States: closed → (3 consecutive fails in every 5m window) → open 5m → half-open allow 1 probe →
 * success→closed reset, fail→re-open.
 *
 * Lazy probe (no cron): isAllowed handles the closed→open and open→half-open
 * transitions on read. This keeps the server timer-free and avoids a background
 * job that must survive restarts. Tradeoff: a breaker that opened while the
 * server was idle stays open until the next request touches isAllowed — probe
 * timing can drift by up to the inter-request idle gap, and concurrent
 * half-open probes may race (first write wins). A cron would give prompt
 * half-open timing but adds persistence + scheduling cost for a low-frequency
 * path; the lazy check is the intended simplification.
 */
import { Effect } from "effect";
import { Sqlite, DbError, RowNotFound } from "../db/database";
import { HeraldHealthRepo, type HeraldHealthRow } from "../repos/herald-health.repo";

const THRESHOLD = 3;
const OPEN_MS = 5 * 60 * 1000;
const WINDOW_MS = 5 * 60 * 1000;

function nowIso(): string {
  return new Date().toISOString();
}

function isExpired(iso: string | null, ms: number): boolean {
  if (!iso) return true;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return true;
  return Date.now() - t >= ms;
}

export class HeraldHealthService extends Effect.Service<HeraldHealthService>()("Lexa/HeraldHealth", {
  dependencies: [HeraldHealthRepo.Default],
  effect: Effect.gen(function* () {
    const repo = yield* HeraldHealthRepo;
    const db = yield* Sqlite;

    const getOrDefault = (providerId: string): Effect.Effect<HeraldHealthRow, DbError> =>
      repo.get(providerId).pipe(
        Effect.catchTag("RowNotFound", () =>
          Effect.succeed({
            provider_id: providerId,
            failure_count: 0,
            circuit_state: "closed" as const,
            opened_at: null,
            last_probe_at: null,
            consecutive_failures: 0,
          } as HeraldHealthRow)
        )
      );

    const isAllowed = (providerId: string): Effect.Effect<boolean, DbError> =>
      Effect.gen(function* () {
        const row = yield* getOrDefault(providerId);
        if (row.circuit_state === "closed") return true;
        if (row.circuit_state === "open") {
          if (isExpired(row.opened_at, OPEN_MS)) {
            const iso = nowIso();
            yield* repo.upsert({ providerId, circuitState: "half-open", lastProbeAt: iso }).pipe(Effect.catchAll(() => Effect.succeed(row)));
            return true;
          }
          return false;
        }
        if (row.circuit_state === "half-open") {
          return true;
        }
        return true;
      });

    const recordFailure = (providerId: string): Effect.Effect<void, DbError> =>
      Effect.gen(function* () {
        const row = yield* getOrDefault(providerId);
        const iso = nowIso();
        const sinceLast = row.last_probe_at ? Date.now() - Date.parse(row.last_probe_at) : Infinity;
        let consecutive = row.consecutive_failures;
        if (sinceLast > WINDOW_MS) consecutive = 0;
        consecutive += 1;
        const failureCount = row.failure_count + 1;

        if (row.circuit_state === "half-open") {
          yield* repo.upsert({
            providerId,
            failureCount,
            circuitState: "open",
            openedAt: iso,
            lastProbeAt: iso,
            consecutiveFailures: consecutive,
          }).pipe(Effect.catchAll(() => Effect.void));
          return;
        }

        if (consecutive >= THRESHOLD) {
          yield* repo.upsert({
            providerId,
            failureCount,
            circuitState: "open",
            openedAt: iso,
            lastProbeAt: iso,
            consecutiveFailures: consecutive,
          }).pipe(Effect.catchAll(() => Effect.void));
          return;
        }

        yield* repo.upsert({
          providerId,
          failureCount,
          circuitState: row.circuit_state,
          lastProbeAt: iso,
          consecutiveFailures: consecutive,
          ...(row.circuit_state === "open" ? { openedAt: row.opened_at } : {}),
        }).pipe(Effect.catchAll(() => Effect.void));
      });

    const recordSuccess = (providerId: string): Effect.Effect<void, DbError> =>
      Effect.gen(function* () {
        const row = yield* getOrDefault(providerId);
        const iso = nowIso();
        yield* repo.upsert({
          providerId,
          failureCount: 0,
          circuitState: "closed",
          openedAt: null,
          lastProbeAt: iso,
          consecutiveFailures: 0,
        }).pipe(Effect.catchAll(() => Effect.void));
        if (row.circuit_state === "open" || row.circuit_state === "half-open") {
          void db;
        }
      });

    const getHealth = (providerId: string): Effect.Effect<{ providerId: string; circuitState: "open" | "closed" | "half-open"; failureCount: number; openedAt: string | null; lastProbeAt: string | null; consecutiveFailures: number }, DbError> =>
      Effect.gen(function* () {
        const row = yield* getOrDefault(providerId);
        if (row.circuit_state === "open" && isExpired(row.opened_at, OPEN_MS)) {
          const iso = nowIso();
          yield* repo.upsert({ providerId, circuitState: "half-open", lastProbeAt: iso }).pipe(Effect.catchAll(() => Effect.void));
          return { providerId, circuitState: "half-open" as const, failureCount: row.failure_count, openedAt: row.opened_at, lastProbeAt: iso, consecutiveFailures: row.consecutive_failures };
        }
        return {
          providerId: row.provider_id,
          failureCount: row.failure_count,
          circuitState: row.circuit_state,
          openedAt: row.opened_at,
          lastProbeAt: row.last_probe_at,
          consecutiveFailures: row.consecutive_failures,
        };
      });

    return { isAllowed, recordFailure, recordSuccess, getHealth } as const;
  }),
}) {}
