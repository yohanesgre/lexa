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

      usageStats: (filters: { from?: string | null; to?: string | null; projectId?: string | null } = {}): Effect.Effect<{ totalTokens: number; promptTokens: number; completionTokens: number; totalCostCents: number; totalCostUsd: number; avgLatencyMs: number | null; errorRate: number; totalCalls: number; errorCalls: number }, DbError> =>
        Effect.gen(function* () {
          const params: unknown[] = [];
          const conds: string[] = [];
          if (filters.projectId) { conds.push("project_id = ?"); params.push(filters.projectId); }
          if (filters.from) { conds.push("date(created_at) >= date(?)"); params.push(filters.from); }
          if (filters.to) { conds.push("date(created_at) <= date(?)"); params.push(filters.to); }
          const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
          const row = yield* Effect.try({
            try: () => {
              const sql = `SELECT
                COUNT(*) as totalCalls,
                COALESCE(SUM(usage_in),0) as promptTokens,
                COALESCE(SUM(usage_out),0) as completionTokens,
                COALESCE(SUM(usage_in + usage_out + cached_in),0) as totalTokens,
                COALESCE(SUM(cost_cents),0) as totalCostCents,
                AVG(latency_ms) as avgLatencyMs,
                COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END),0) as errorCalls
                FROM herald_call_logs ${where}`;
              return db.prepare(sql).get(...params) as {
                totalCalls: number; promptTokens: number; completionTokens: number; totalTokens: number; totalCostCents: number; avgLatencyMs: number | null; errorCalls: number;
              } | null;
            },
            catch: (e) => new DbError({ message: String(e), cause: e }),
          });
          const totalCalls = Number(row?.totalCalls ?? 0);
          const errorCalls = Number(row?.errorCalls ?? 0);
          return {
            totalTokens: Number(row?.totalTokens ?? 0),
            promptTokens: Number(row?.promptTokens ?? 0),
            completionTokens: Number(row?.completionTokens ?? 0),
            totalCostCents: Number(row?.totalCostCents ?? 0),
            totalCostUsd: Number(row?.totalCostCents ?? 0) / 100,
            avgLatencyMs: row?.avgLatencyMs !== null && row?.avgLatencyMs !== undefined ? Math.round(Number(row.avgLatencyMs)) : null,
            errorRate: totalCalls > 0 ? errorCalls / totalCalls : 0,
            totalCalls,
            errorCalls,
          };
        }),

      byDay: (filters: { from?: string | null; to?: string | null; projectId?: string | null } = {}): Effect.Effect<Array<{ day: string; tokens: number; costCents: number; costUsd: number; avgLatencyMs: number | null; calls: number; errorRate: number }>, DbError> =>
        Effect.gen(function* () {
          const params: unknown[] = [];
          const conds: string[] = [];
          if (filters.projectId) { conds.push("project_id = ?"); params.push(filters.projectId); }
          if (filters.from) { conds.push("date(created_at) >= date(?)"); params.push(filters.from); }
          if (filters.to) { conds.push("date(created_at) <= date(?)"); params.push(filters.to); }
          const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
          const rows = yield* Effect.try({
            try: () => {
              const sql = `SELECT
                date(created_at) as day,
                COALESCE(SUM(usage_in + usage_out + cached_in),0) as tokens,
                COALESCE(SUM(cost_cents),0) as costCents,
                AVG(latency_ms) as avgLatencyMs,
                COUNT(*) as calls,
                COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END),0) as errorCalls
                FROM herald_call_logs ${where}
                GROUP BY date(created_at)
                ORDER BY day ASC`;
              return db.prepare(sql).all(...params) as Array<{ day: string; tokens: number; costCents: number; avgLatencyMs: number | null; calls: number; errorCalls: number }>;
            },
            catch: (e) => new DbError({ message: String(e), cause: e }),
          });
          return rows.map((r) => ({
            day: r.day,
            tokens: Number(r.tokens),
            costCents: Number(r.costCents),
            costUsd: Number(r.costCents) / 100,
            avgLatencyMs: r.avgLatencyMs !== null ? Math.round(Number(r.avgLatencyMs)) : null,
            calls: Number(r.calls),
            errorRate: Number(r.calls) > 0 ? Number(r.errorCalls) / Number(r.calls) : 0,
          }));
        }),

      byModel: (filters: { from?: string | null; to?: string | null; projectId?: string | null } = {}): Effect.Effect<Array<{ model: string; tokens: number; costCents: number; costUsd: number; avgLatencyMs: number | null; calls: number; errorRate: number }>, DbError> =>
        Effect.gen(function* () {
          const params: unknown[] = [];
          const conds: string[] = [];
          if (filters.projectId) { conds.push("project_id = ?"); params.push(filters.projectId); }
          if (filters.from) { conds.push("date(created_at) >= date(?)"); params.push(filters.from); }
          if (filters.to) { conds.push("date(created_at) <= date(?)"); params.push(filters.to); }
          const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
          const rows = yield* Effect.try({
            try: () => {
              const sql = `SELECT
                model,
                COALESCE(SUM(usage_in + usage_out + cached_in),0) as tokens,
                COALESCE(SUM(cost_cents),0) as costCents,
                AVG(latency_ms) as avgLatencyMs,
                COUNT(*) as calls,
                COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END),0) as errorCalls
                FROM herald_call_logs ${where}
                GROUP BY model
                ORDER BY tokens DESC`;
              return db.prepare(sql).all(...params) as Array<{ model: string; tokens: number; costCents: number; avgLatencyMs: number | null; calls: number; errorCalls: number }>;
            },
            catch: (e) => new DbError({ message: String(e), cause: e }),
          });
          return rows.map((r) => ({
            model: r.model,
            tokens: Number(r.tokens),
            costCents: Number(r.costCents),
            costUsd: Number(r.costCents) / 100,
            avgLatencyMs: r.avgLatencyMs !== null ? Math.round(Number(r.avgLatencyMs)) : null,
            calls: Number(r.calls),
            errorRate: Number(r.calls) > 0 ? Number(r.errorCalls) / Number(r.calls) : 0,
          }));
        }),

      csv: (filters: { from?: string | null; to?: string | null; projectId?: string | null } = {}): Effect.Effect<string, DbError> =>
        Effect.gen(function* () {
          const params: unknown[] = [];
          const conds: string[] = [];
          if (filters.projectId) { conds.push("project_id = ?"); params.push(filters.projectId); }
          if (filters.from) { conds.push("date(created_at) >= date(?)"); params.push(filters.from); }
          if (filters.to) { conds.push("date(created_at) <= date(?)"); params.push(filters.to); }
          const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
          const rows = yield* Effect.try({
            try: () => {
              const sql = `SELECT
                date(created_at) as day,
                model,
                COALESCE(SUM(usage_in + usage_out + cached_in),0) as tokens,
                COALESCE(SUM(cost_cents),0) as costCents,
                AVG(latency_ms) as avgLatencyMs,
                COUNT(*) as calls,
                COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END),0) as errorCalls
                FROM herald_call_logs ${where}
                GROUP BY date(created_at), model
                ORDER BY day ASC, tokens DESC`;
              return db.prepare(sql).all(...params) as Array<{ day: string; model: string; tokens: number; costCents: number; avgLatencyMs: number | null; calls: number; errorCalls: number }>;
            },
            catch: (e) => new DbError({ message: String(e), cause: e }),
          });
          const header = "day,model,tokens,cost_cents,cost_usd,avg_latency_ms,calls,error_rate";
          const lines = rows.map((r) => {
            const errorRate = Number(r.calls) > 0 ? Number(r.errorCalls) / Number(r.calls) : 0;
            const avg = r.avgLatencyMs !== null ? Math.round(Number(r.avgLatencyMs)) : "";
            const costUsd = (Number(r.costCents) / 100).toFixed(2);
            return `${r.day},${r.model},${r.tokens},${r.costCents},${costUsd},${avg},${r.calls},${errorRate.toFixed(4)}`;
          });
          return [header, ...lines].join("\n");
        }),
    };
  }),
}) {}
