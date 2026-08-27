import { Effect } from "effect";
import { Sqlite, queryAll, queryFirst, run, DbError, RowNotFound, ConstraintViolation } from "../db/database";
import type { RuntimeEvent, RuntimeEventAction, HearthProvider } from "../../shared/types";

export interface RuntimeEventRow {
  id: string;
  machine_id: string;
  action: RuntimeEventAction;
  agent_cli: HearthProvider;
  api_key_id: string | null;
  status: RuntimeEvent["status"];
  error: string | null;
  created_at: string;
  claimed_at: string | null;
  finished_at: string | null;
}

function rowToRuntimeEvent(row: RuntimeEventRow): RuntimeEvent {
  return {
    id: row.id,
    machineId: row.machine_id,
    action: row.action,
    agentCli: row.agent_cli,
    apiKeyId: row.api_key_id,
    status: row.status,
    error: row.error,
    createdAt: row.created_at,
    claimedAt: row.claimed_at,
    finishedAt: row.finished_at,
  };
}

const rawKeyStore = new Map<string, string>();
const RAW_KEY_TTL_MS = 5 * 60 * 1000;

export function storeRawKey(eventId: string, rawKey: string): void {
  rawKeyStore.set(eventId, rawKey);
  setTimeout(() => rawKeyStore.delete(eventId), RAW_KEY_TTL_MS).unref?.();
}

export function takeRawKey(eventId: string): string | null {
  const rawKey = rawKeyStore.get(eventId) ?? null;
  rawKeyStore.delete(eventId);
  return rawKey;
}

export class RuntimeEventRepo extends Effect.Service<RuntimeEventRepo>()("Lexa/RuntimeEventRepo", {
  effect: Effect.gen(function* () {
    const db = yield* Sqlite;

    return {
      create: (input: {
        id: string;
        machineId: string;
        action: RuntimeEventAction;
        agentCli: HearthProvider;
        apiKeyId: string | null;
      }): Effect.Effect<RuntimeEvent, ConstraintViolation | DbError> =>
        Effect.gen(function* () {
          yield* run(
            db,
            `INSERT INTO runtime_events (id, machine_id, action, agent_cli, api_key_id, status)
             VALUES (?, ?, ?, ?, ?, 'pending')`,
            input.id,
            input.machineId,
            input.action,
            input.agentCli,
            input.apiKeyId
          );
          const rows = yield* queryAll<RuntimeEventRow>(db, `SELECT * FROM runtime_events WHERE id = ?`, input.id);
          const row = rows[0]!;
          if (!row) return yield* Effect.fail(new DbError({ message: "runtime event row missing after create" }));
          return rowToRuntimeEvent(row);
        }),

      claimNextForMachine: (machineId: string): Effect.Effect<RuntimeEvent | null, ConstraintViolation | DbError> =>
        Effect.gen(function* () {
          yield* run(
            db,
            `UPDATE runtime_events SET status = 'pending', claimed_at = NULL
             WHERE machine_id = ? AND status = 'claimed' AND claimed_at < datetime('now', '-2 minutes')`,
            machineId
          );
          const rows = yield* queryAll<RuntimeEventRow>(
            db,
            `SELECT * FROM runtime_events
             WHERE machine_id = ? AND status = 'pending'
             ORDER BY created_at LIMIT 1`,
            machineId
          );
          const event = rows[0]!;
          if (!event) return null;
          const claimed = yield* run(
            db,
            `UPDATE runtime_events SET status = 'claimed', claimed_at = datetime('now')
             WHERE id = ? AND machine_id = ? AND status = 'pending'`,
            event.id,
            machineId
          );
          if (claimed === 0) return null;
          const updatedRows = yield* queryAll<RuntimeEventRow>(db, `SELECT * FROM runtime_events WHERE id = ?`, event.id);
          const updated = updatedRows[0]!;
          if (!updated) return yield* Effect.fail(new DbError({ message: "runtime event row missing after claim" }));
          return rowToRuntimeEvent(updated);
        }),

      complete: (id: string): Effect.Effect<RuntimeEvent, RowNotFound | ConstraintViolation | DbError> =>
        Effect.gen(function* () {
          const changed = yield* run(
            db,
            `UPDATE runtime_events SET status = 'completed', finished_at = datetime('now'), error = NULL
             WHERE id = ? AND status = 'claimed'`,
            id
          );
          if (changed === 0) return yield* Effect.fail(new RowNotFound({ table: "runtime_events" }));
          return yield* queryFirst<RuntimeEventRow>(db, `SELECT * FROM runtime_events WHERE id = ?`, id).pipe(
            Effect.map(rowToRuntimeEvent)
          );
        }),

      fail: (id: string, error: string): Effect.Effect<RuntimeEvent, RowNotFound | ConstraintViolation | DbError> =>
        Effect.gen(function* () {
          const changed = yield* run(
            db,
            `UPDATE runtime_events SET status = 'failed', finished_at = datetime('now'), error = ?
             WHERE id = ? AND status = 'claimed'`,
            error.slice(0, 2000),
            id
          );
          if (changed === 0) return yield* Effect.fail(new RowNotFound({ table: "runtime_events" }));
          return yield* queryFirst<RuntimeEventRow>(db, `SELECT * FROM runtime_events WHERE id = ?`, id).pipe(
            Effect.map(rowToRuntimeEvent)
          );
        }),

      findById: (id: string): Effect.Effect<RuntimeEvent, RowNotFound | DbError> =>
        queryFirst<RuntimeEventRow>(db, `SELECT * FROM runtime_events WHERE id = ?`, id).pipe(
          Effect.map(rowToRuntimeEvent)
        ),

      list: (machineId?: string): Effect.Effect<RuntimeEvent[], DbError> => {
        const query = machineId
          ? queryAll<RuntimeEventRow>(db, `SELECT * FROM runtime_events WHERE machine_id = ? ORDER BY created_at DESC LIMIT 50`, machineId)
          : queryAll<RuntimeEventRow>(db, `SELECT * FROM runtime_events ORDER BY created_at DESC LIMIT 50`);
        return query.pipe(Effect.map((rows) => rows.map(rowToRuntimeEvent)));
      },
    };
  }),
}) {}
