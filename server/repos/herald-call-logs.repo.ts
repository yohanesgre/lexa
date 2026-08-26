import { Effect } from "effect";
import { Sqlite, queryAll, queryFirst, run, DbError, RowNotFound, ConstraintViolation } from "../db/database";
import type { HeraldCallLogRow, HeraldCallLogInput } from "../../shared/herald";

export interface HeraldCallLogDbRow {
  id: string;
  project_id: string | null;
  provider_id: string | null;
  model: string;
  kind: string;
  status: string;
  error_code: string | null;
  usage_in: number;
  usage_out: number;
  cached_in: number;
  latency_ms: number | null;
  cost_cents: number;
  estimated: number;
  created_at: string;
}

function toDomain(row: HeraldCallLogDbRow): HeraldCallLogRow {
  return {
    id: row.id,
    projectId: row.project_id,
    providerId: row.provider_id,
    model: row.model,
    kind: row.kind as HeraldCallLogRow["kind"],
    status: row.status as HeraldCallLogRow["status"],
    errorCode: row.error_code,
    usageIn: row.usage_in,
    usageOut: row.usage_out,
    cachedIn: row.cached_in,
    latencyMs: row.latency_ms,
    costCents: row.cost_cents,
    estimated: row.estimated === 1,
    createdAt: row.created_at,
  };
}

export class HeraldCallLogsRepo extends Effect.Service<HeraldCallLogsRepo>()("Lexa/HeraldCallLogsRepo", {
  effect: Effect.gen(function* () {
    const db = yield* Sqlite;

    return {
      insert: (input: { id: string } & HeraldCallLogInput): Effect.Effect<HeraldCallLogRow, ConstraintViolation | DbError | RowNotFound> =>
        run(
          db,
          `INSERT INTO herald_call_logs (id, project_id, provider_id, model, kind, status, error_code, usage_in, usage_out, cached_in, latency_ms, cost_cents, estimated)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          input.id,
          input.projectId ?? null,
          input.providerId ?? null,
          input.model,
          input.kind,
          input.status,
          input.errorCode ?? null,
          input.usageIn ?? 0,
          input.usageOut ?? 0,
          input.cachedIn ?? 0,
          input.latencyMs ?? null,
          input.costCents ?? 0,
          input.estimated ? 1 : 0
        ).pipe(
          Effect.flatMap(() => queryFirst<HeraldCallLogDbRow>(db, `SELECT * FROM herald_call_logs WHERE id = ?`, input.id)),
          Effect.map(toDomain)
        ),

      getById: (id: string): Effect.Effect<HeraldCallLogRow, RowNotFound | DbError> =>
        Effect.map(queryFirst<HeraldCallLogDbRow>(db, `SELECT * FROM herald_call_logs WHERE id = ?`, id), toDomain),

      listByProject: (projectId: string, limit = 100): Effect.Effect<HeraldCallLogRow[], DbError> =>
        Effect.map(
          queryAll<HeraldCallLogDbRow>(db, `SELECT * FROM herald_call_logs WHERE project_id = ? ORDER BY created_at DESC LIMIT ?`, projectId, limit),
          (rows) => rows.map(toDomain)
        ),

      listByProvider: (providerId: string, limit = 100): Effect.Effect<HeraldCallLogRow[], DbError> =>
        Effect.map(
          queryAll<HeraldCallLogDbRow>(db, `SELECT * FROM herald_call_logs WHERE provider_id = ? ORDER BY created_at DESC LIMIT ?`, providerId, limit),
          (rows) => rows.map(toDomain)
        ),

      listByModel: (model: string, limit = 100): Effect.Effect<HeraldCallLogRow[], DbError> =>
        Effect.map(
          queryAll<HeraldCallLogDbRow>(db, `SELECT * FROM herald_call_logs WHERE model = ? ORDER BY created_at DESC LIMIT ?`, model, limit),
          (rows) => rows.map(toDomain)
        ),

      listRecent: (limit = 100): Effect.Effect<HeraldCallLogRow[], DbError> =>
        Effect.map(
          queryAll<HeraldCallLogDbRow>(db, `SELECT * FROM herald_call_logs ORDER BY created_at DESC LIMIT ?`, limit),
          (rows) => rows.map(toDomain)
        ),
    };
  }),
}) {}
