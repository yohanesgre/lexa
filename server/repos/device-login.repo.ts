import { Effect } from "effect";
import { Db, queryFirst, run, runReturning, DbError, RowNotFound, ConstraintViolation } from "../db/db";

export type DeviceLoginStatus = "pending" | "approved" | "denied";

export interface DeviceLoginRequestRow {
  id: string;
  token_hash: string;
  code: string;
  client_name: string;
  status: DeviceLoginStatus;
  expires_at: string;
  approver_user_id: string | null;
  api_key_id: string | null;
  created_at: string;
  // Computed in SQL: lexical comparison against datetime('now') — SQLite
  // timestamps ('YYYY-MM-DD HH:MM:SS') are not directly comparable to JS
  // ISO strings, so expiry is evaluated by the DB, not the caller.
  is_expired: number;
  // RFC-3339 with Z suffix — JS Date parses SQLite naive datetimes as local
  // time, shifting the approve page's "expires in N min" by the UTC offset.
  expires_at_iso: string;
  key_name: string | null;
  approver_name: string | null;
}

// No raw-key transit store: the key is minted on the first poll after
// approval and returned in that response, so approve and poll need no shared
// memory and any isolate can serve either leg. The `api_key_id` column is
// legacy/unused — new requests never set it (the key does not exist until the
// poll mints it); the LEFT JOIN below still resolves it for old rows.
const SELECT_DEVICE_LOGIN = `SELECT r.*,
  (r.expires_at < datetime('now')) AS is_expired,
  strftime('%Y-%m-%dT%H:%M:%SZ', r.expires_at) AS expires_at_iso,
  k.name AS key_name,
  u.name AS approver_name
FROM device_login_requests r
LEFT JOIN api_keys k ON k.id = r.api_key_id
LEFT JOIN users u ON u.id = r.approver_user_id`;

export class DeviceLoginRepo extends Effect.Service<DeviceLoginRepo>()("Lexa/DeviceLoginRepo", {
  effect: Effect.gen(function* () {
    const db = yield* Db;

    return {
      create: (input: { id: string; tokenHash: string; code: string; clientName: string }): Effect.Effect<DeviceLoginRequestRow, ConstraintViolation | DbError> =>
        Effect.gen(function* () {
          yield* run(
            db,
            `INSERT INTO device_login_requests (id, token_hash, code, client_name, status, expires_at)
             VALUES (?, ?, ?, ?, 'pending', datetime('now', '+10 minutes'))`,
            input.id,
            input.tokenHash,
            input.code,
            input.clientName
          );
          return yield* queryFirst<DeviceLoginRequestRow>(db, `${SELECT_DEVICE_LOGIN} WHERE r.id = ?`, input.id).pipe(
            Effect.catchTag("RowNotFound", () => Effect.fail(new DbError({ message: "device login row missing after create" })))
          );
        }),

      findById: (id: string): Effect.Effect<DeviceLoginRequestRow, RowNotFound | DbError> =>
        queryFirst<DeviceLoginRequestRow>(db, `${SELECT_DEVICE_LOGIN} WHERE r.id = ?`, id),

      setApproved: (id: string, approverUserId: string): Effect.Effect<void, RowNotFound | ConstraintViolation | DbError> =>
        Effect.gen(function* () {
          // Flip only — the key is minted and returned by the first poll.
          const changed = yield* run(
            db,
            `UPDATE device_login_requests SET status = 'approved', approver_user_id = ?
             WHERE id = ? AND status = 'pending'`,
            approverUserId,
            id
          );
          if (changed === 0) return yield* Effect.fail(new RowNotFound({ table: "device_login_requests" }));
        }),

      // One-shot consume: atomically deletes the approved row and returns what
      // the poll needs to mint the user-bound key. A concurrent poll loses the
      // DELETE and gets RowNotFound (→ NotFound, no oracle).
      consumeApproved: (
        id: string
      ): Effect.Effect<{ client_name: string; approver_user_id: string | null }, RowNotFound | ConstraintViolation | DbError> =>
        runReturning<{ client_name: string; approver_user_id: string | null }>(
          db,
          `DELETE FROM device_login_requests WHERE id = ? AND status = 'approved'
           RETURNING client_name, approver_user_id`,
          id
        ),

      setDenied: (id: string): Effect.Effect<void, RowNotFound | ConstraintViolation | DbError> =>
        Effect.gen(function* () {
          const changed = yield* run(
            db,
            `UPDATE device_login_requests SET status = 'denied' WHERE id = ? AND status = 'pending'`,
            id
          );
          if (changed === 0) return yield* Effect.fail(new RowNotFound({ table: "device_login_requests" }));
        }),

      deleteById: (id: string): Effect.Effect<void, DbError | ConstraintViolation> =>
        Effect.map(run(db, `DELETE FROM device_login_requests WHERE id = ?`, id), () => undefined),
    };
  }),
  dependencies: [],
}) {}