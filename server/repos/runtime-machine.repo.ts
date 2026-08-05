import { Effect } from "effect";
import { Sqlite, queryAll, queryFirst, run, DbError, RowNotFound, ConstraintViolation } from "../db/database";
import type { Machine } from "../../shared/types";

interface MachineRow {
  id: string;
  hostname: string;
  secret: string;
  clis: string;
  last_seen: string | null;
  created_at: string;
}

export interface MachineCli {
  provider: "opencode" | "hermes" | "command-code";
  version: string;
}

function parseClis(raw: string): MachineCli[] {
  try {
    const parsed = JSON.parse(raw) as MachineCli[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function rowToMachine(row: MachineRow): Machine {
  return {
    id: row.id,
    hostname: row.hostname,
    clis: parseClis(row.clis),
    lastSeen: row.last_seen,
    createdAt: row.created_at,
  };
}

export class RuntimeMachineRepo extends Effect.Service<RuntimeMachineRepo>()("Lexa/RuntimeMachineRepo", {
  effect: Effect.gen(function* () {
    const db = yield* Sqlite;

    return {
      // Called by `lexa-cli login` — binds the machine without marking it
      // listening. last_seen must survive: a logged-in machine is "bound,
      // not listening" until its listener heartbeats. Binding is secret-
      // gated: unknown ids get a server-minted secret (mintedSecret) stored
      // on insert; known ids must present the stored secret (client secret)
      // — a different host, a legacy '' secret, or a mismatch all conflict.
      register: (input: { id: string; hostname: string; secret: string; mintedSecret: string }): Effect.Effect<
        | { _tag: "created"; machine: Machine }
        | { _tag: "registered"; machine: Machine }
        | { _tag: "conflict"; reason: "hostname" | "legacy" | "secret_mismatch"; machine: Machine },
        ConstraintViolation | DbError
      > =>
        Effect.gen(function* () {
          const existing = yield* queryFirst<MachineRow>(db, `SELECT * FROM machines WHERE id = ?`, input.id).pipe(
            Effect.catchTag("RowNotFound", () => Effect.succeed(null))
          );
          if (existing) {
            if (existing.hostname !== input.hostname) {
              return { _tag: "conflict", reason: "hostname", machine: rowToMachine(existing) };
            }
            if (existing.secret === "") {
              return { _tag: "conflict", reason: "legacy", machine: rowToMachine(existing) };
            }
            if (existing.secret !== input.secret) {
              return { _tag: "conflict", reason: "secret_mismatch", machine: rowToMachine(existing) };
            }
            return { _tag: "registered", machine: rowToMachine(existing) };
          }
          yield* run(
            db,
            `INSERT INTO machines (id, hostname, secret, last_seen) VALUES (?, ?, ?, NULL)`,
            input.id,
            input.hostname,
            input.mintedSecret
          );
          const rows = yield* queryAll<MachineRow>(db, `SELECT * FROM machines WHERE id = ?`, input.id);
          const row = rows[0];
          if (!row) return yield* Effect.fail(new DbError({ message: "machine row missing after register" }));
          return { _tag: "created", machine: rowToMachine(row) };
        }),

      findSecret: (id: string): Effect.Effect<string, RowNotFound | DbError> =>
        queryFirst<{ secret: string }>(db, `SELECT secret FROM machines WHERE id = ?`, id).pipe(
          Effect.map((row) => row.secret)
        ),

      heartbeat: (input: { id: string; hostname: string; clis?: MachineCli[] }): Effect.Effect<Machine, ConstraintViolation | DbError> =>
        Effect.gen(function* () {
          yield* run(
            db,
            `INSERT INTO machines (id, hostname, clis, last_seen) VALUES (?, ?, ?, datetime('now'))
             ON CONFLICT(id) DO UPDATE SET
               hostname = excluded.hostname,
               clis = excluded.clis,
               last_seen = datetime('now')`,
            input.id,
            input.hostname,
            JSON.stringify(input.clis ?? [])
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

      delete: (id: string): Effect.Effect<void, RowNotFound | ConstraintViolation | DbError> =>
        run(db, `DELETE FROM machines WHERE id = ?`, id).pipe(
          Effect.flatMap((changes) =>
            changes === 0 ? Effect.fail(new RowNotFound({ table: "machines" })) : Effect.void
          )
        ),
    };
  }),
}) {}
