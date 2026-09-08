import { Effect, Data } from "effect";
import { createHash, timingSafeEqual } from "node:crypto";
import { DeviceLoginRepo, storeDeviceRawKey, takeDeviceRawKey } from "../repos/device-login.repo";
import { generateRawKeyForMint, sha256 } from "./api-key.service";
import { Db, batch, run, DbError, RowNotFound, ConstraintViolation } from "../db/db";
import { DeviceLoginNotFound, DeviceLoginExpired, DeviceLoginDenied, InvalidName } from "../api/errors";
import { getEnv, resolvePublicUrl } from "../env";
import type { DeviceLoginRequestInfo } from "../../shared/types";

// Pairing flow (docs/API.md → "Device login (CLI pairing)"): the CLI creates
// a request and prints a verify URL carrying a 256-bit random token; a
// logged-in user opens it and approves; the CLI's poll receives the minted
// user-bound key ONCE (row consumed — replay impossible). token_hash lookup
// is the only secret in the DB (api_keys.key_hash idiom); the short code is
// display-only.
const REQUEST_TTL_MS = 10 * 60 * 1000;
const CLIENT_NAME_MAX = 120;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function tokensEqual(hexA: string, hexB: string): boolean {
  const bufA = Buffer.from(hexA, "hex");
  const bufB = Buffer.from(hexB, "hex");
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

function randomHex(bytes: number): string {
  const out = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(out).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomCode(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let s = "";
  for (const b of bytes) s += chars[b % chars.length];
  return s;
}

export class DeviceLoginService extends Effect.Service<DeviceLoginService>()("Lexa/DeviceLoginService", {
  dependencies: [DeviceLoginRepo.Default],
  effect: Effect.gen(function* () {
    const repo = yield* DeviceLoginRepo;
    const db = yield* Db;

    return {
      // Mint a pending pairing request; returns the one-time token embedded in
      // verifyUrl (the CLI needs it for poll + the browser page for approve).
      create: (clientName: string): Effect.Effect<DeviceLoginRequestInfo, InvalidName | DbError | ConstraintViolation | RowNotFound> =>
        Effect.gen(function* () {
          const trimmed = clientName.trim();
          if (!trimmed || trimmed.length > CLIENT_NAME_MAX) {
            return yield* new InvalidName({ reason: `clientName must be 1-${CLIENT_NAME_MAX} characters` });
          }
          const id = crypto.randomUUID();
          const token = randomHex(32);
          const code = randomCode();
          yield* repo.create({ id, tokenHash: hashToken(token), code, clientName: trimmed });
          const base = resolvePublicUrl(getEnv());
          return {
            id,
            code,
            clientName: trimmed,
            status: "pending",
            expiresMs: Date.now() + REQUEST_TTL_MS,
            verifyUrl: `${base}/device-login?request=${id}&token=${token}`,
          };
        }),

      // Poll loop (CLI, ~2s). Pending carries the fields the approve page
      // shows; approved returns the raw key exactly once then consumes the row.
      poll: (id: string, token: string): Effect.Effect<
        | { status: "pending"; clientName: string; code: string; expiresAt: string }
        | { status: "approved"; rawKey: string; keyName: string; approverName: string | null },
        DeviceLoginNotFound | DeviceLoginExpired | DeviceLoginDenied | DbError | ConstraintViolation | RowNotFound
      > =>
        Effect.gen(function* () {
          const row = yield* repo.findById(id).pipe(
            Effect.catchTag("RowNotFound", () => Effect.fail(new DeviceLoginNotFound()))
          );
          if (!tokensEqual(hashToken(token), row.token_hash)) return yield* new DeviceLoginNotFound();
          if (row.status === "denied") return yield* new DeviceLoginDenied();
          if (row.status === "approved") {
            const rawKey = takeDeviceRawKey(row.id);
            if (!rawKey) return yield* new DeviceLoginExpired();
            yield* repo.deleteById(row.id);
            return { status: "approved", rawKey, keyName: row.key_name ?? "", approverName: row.approver_name };
          }
          if (row.is_expired) return yield* new DeviceLoginExpired();
          return { status: "pending", clientName: row.client_name, code: row.code, expiresAt: row.expires_at_iso ?? row.expires_at };
        }),

      // Browser approval: user-bound identity (session or user-bound key) + token
      // (both required). Mints a user-bound key (owner = approver, name =
      // clientName). The insert + status flip run as ONE atomic batch — on
      // Bun (transaction) and on D1 (driver.batch is atomic) — so a
      // concurrent approve/deny can never leave an orphan key row.
      approve: (userId: string, id: string, token: string): Effect.Effect<
        { status: "approved"; clientName: string },
        DeviceLoginNotFound | DeviceLoginExpired | ConstraintViolation | DbError | RowNotFound
      > =>
        Effect.gen(function* () {
          const row = yield* repo.findById(id).pipe(
            Effect.catchTag("RowNotFound", () => Effect.fail(new DeviceLoginNotFound()))
          );
          if (!tokensEqual(hashToken(token), row.token_hash)) return yield* new DeviceLoginNotFound();
          if (row.status !== "pending") return yield* new DeviceLoginNotFound(); // already decided — no oracle
          if (row.is_expired) return yield* new DeviceLoginExpired();
          const keyId = crypto.randomUUID();
          const rawKey = generateRawKeyForMint();
          const keyHash = yield* Effect.promise(() => sha256(rawKey));
          yield* batch(db, [
            {
              sql: "INSERT INTO api_keys (id, name, key_hash, user_id) VALUES (?, ?, ?, ?)",
              params: [keyId, row.client_name, keyHash, userId],
            },
            {
              sql: "UPDATE device_login_requests SET status = 'approved', approver_user_id = ?, api_key_id = ? WHERE id = ? AND status = 'pending'",
              params: [userId, keyId, row.id],
            },
          ]);
          // Verify the flip landed for THIS approver; compensate (delete the
          // minted key) if a concurrent decide won between read and batch.
          const after = yield* repo.findById(row.id).pipe(Effect.catchAll(() => Effect.succeed(null)));
          if (!after || after.status !== "approved" || after.approver_user_id !== userId) {
            yield* run(db, "DELETE FROM api_keys WHERE id = ?", keyId).pipe(Effect.catchAll(() => Effect.succeed(0)));
            return yield* new DeviceLoginNotFound();
          }
          storeDeviceRawKey(row.id, rawKey);
          return { status: "approved", clientName: row.client_name };
        }),

      deny: (id: string, token: string): Effect.Effect<
        { status: "denied"; clientName: string },
        DeviceLoginNotFound | DeviceLoginExpired | DbError | ConstraintViolation | RowNotFound
      > =>
        Effect.gen(function* () {
          const row = yield* repo.findById(id).pipe(
            Effect.catchTag("RowNotFound", () => Effect.fail(new DeviceLoginNotFound()))
          );
          if (!tokensEqual(hashToken(token), row.token_hash)) return yield* new DeviceLoginNotFound();
          if (row.status !== "pending") return yield* new DeviceLoginNotFound();
          if (row.is_expired) return yield* new DeviceLoginExpired();
          yield* repo.setDenied(row.id).pipe(
            Effect.catchTag("RowNotFound", () => Effect.fail(new DeviceLoginNotFound()))
          );
          return { status: "denied", clientName: row.client_name };
        }),
    };
  }),
}) {}