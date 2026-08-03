import { Effect } from "effect";
import { Sqlite, queryAll, queryFirst, run, DbError, RowNotFound, ConstraintViolation } from "../db/database";
import type { Machine } from "../../shared/types";

interface MachineRow {
  id: string;
  hostname: string;
  last_seen: string | null;
  created_at: string;
}

function rowToMachine(row: MachineRow): Machine {
  return {
    id: row.id,
    hostname: row.hostname,
    lastSeen: row.last_seen,
    createdAt: row.created_at,
  };
}

export class RuntimeMachineRepo extends Effect.Service<RuntimeMachineRepo>()("Lexa/RuntimeMachineRepo", {
  effect: Effect.gen(function* () {
    const db = yield* Sqlite;

    return {
      heartbeat: (input: { id: string; hostname: string }): Effect.Effect<Machine, ConstraintViolation | DbError> =>
        Effect.gen(function* () {
          yield* run(
            db,
            `INSERT INTO machines (id, hostname, last_seen) VALUES (?, ?, datetime('now'))
             ON CONFLICT(id) DO UPDATE SET hostname = excluded.hostname, last_seen = datetime('now')`,
            input.id,
            input.hostname
          );
          const rows = yield* queryAll<MachineRow>(db, `SELECT * FROM machines WHERE id = ?`, input.id);
          const row = rows[0];
          if (!row) return yield* Effect.fail(new DbError({ message: "machine row missing after heartbeat" }));
          return rowToMachine(row);
        }),

      markOffline: (): Effect.Effect<void, ConstraintViolation | DbError> =>
        run(db, `UPDATE machines SET last_seen = NULL WHERE last_seen < datetime('now', '-2 minutes')`).pipe(
          Effect.map(() => undefined)
        ),

      findById: (id: string): Effect.Effect<Machine, DbError | RowNotFound> =>
        queryFirst<MachineRow>(db, `SELECT * FROM machines WHERE id = ?`, id).pipe(Effect.map(rowToMachine)),

      list: (): Effect.Effect<Machine[], DbError> =>
        queryAll<MachineRow>(db, `SELECT * FROM machines ORDER BY last_seen DESC, created_at DESC`).pipe(
          Effect.map((rows) => rows.map(rowToMachine))
        ),
    };
  }),
}) {}
