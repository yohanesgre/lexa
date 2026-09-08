import { Effect } from "effect";
import { Db, queryFirst, run, DbError, RowNotFound, ConstraintViolation } from "../db/db";

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

// Raw key transit store: the minted key is handed to the CLI's poll exactly
// once through this in-memory map (30 min TTL) — never persisted. Same idiom
// as runtime-event.repo.ts.
// LIMITATION (documented): per-isolate memory. On Workers an approve that
// lands on isolate A and a poll served by isolate B cannot see the same
// store — the poll 410s and the minted key is undeliverable (the expired row
// is pruned on the next boot; no security impact). Bun serves all requests
// from one process, so self-hosted deployments are unaffected.
const rawKeyStore = new Map<string, string>();
const RAW_KEY_TTL_MS = 30 * 60 * 1000;

export function storeDeviceRawKey(requestId: string, rawKey: string): void {
  rawKeyStore.set(requestId, rawKey);
  setTimeout(() => rawKeyStore.delete(requestId), RAW_KEY_TTL_MS).unref?.();
}

export function takeDeviceRawKey(requestId: string): string | null {
  const rawKey = rawKeyStore.get(requestId) ?? null;
  rawKeyStore.delete(requestId);
  return rawKey;
}

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

      setApproved: (id: string, approverUserId: string, apiKeyId: string): Effect.Effect<void, RowNotFound | ConstraintViolation | DbError> =>
        Effect.gen(function* () {
          const changed = yield* run(
            db,
            `UPDATE device_login_requests SET status = 'approved', approver_user_id = ?, api_key_id = ?
             WHERE id = ? AND status = 'pending'`,
            approverUserId,
            apiKeyId,
            id
          );
          if (changed === 0) return yield* Effect.fail(new RowNotFound({ table: "device_login_requests" }));
        }),

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