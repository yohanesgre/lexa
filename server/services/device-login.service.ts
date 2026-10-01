import { Effect, Data } from "effect";
import { createHash, timingSafeEqual } from "node:crypto";
import { DeviceLoginRepo } from "../repos/device-login.repo";
import { ApiKeyService, type ApiKeyNameEmpty } from "./api-key.service";
import { DbError, RowNotFound, ConstraintViolation } from "../db/db";
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
  dependencies: [DeviceLoginRepo.Default, ApiKeyService.Default],
  effect: Effect.gen(function* () {
    const repo = yield* DeviceLoginRepo;
    const apiKeys = yield* ApiKeyService;

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
      // shows; approved consumes the row and then mints the user-bound key in
      // the same response — one-shot, replay impossible, no shared transit
      // state. Consume and mint are two statements: if the mint fails the
      // request is already spent and the client re-runs `lx login`.
      poll: (id: string, token: string): Effect.Effect<
        | { status: "pending"; clientName: string; code: string; expiresAt: string }
        | { status: "approved"; rawKey: string; keyName: string; approverName: string | null },
        DeviceLoginNotFound | DeviceLoginExpired | DeviceLoginDenied | ApiKeyNameEmpty | DbError | ConstraintViolation | RowNotFound
      > =>
        Effect.gen(function* () {
          const row = yield* repo.findById(id).pipe(
            Effect.catchTag("RowNotFound", () => Effect.fail(new DeviceLoginNotFound()))
          );
          if (!tokensEqual(hashToken(token), row.token_hash)) return yield* new DeviceLoginNotFound();
          if (row.status === "denied") return yield* new DeviceLoginDenied();
          if (row.status === "approved") {
            // Guard BEFORE consuming: an approved row with no recorded approver
            // can never mint a user-bound key, and must not be destroyed.
            if (!row.approver_user_id) return yield* new DeviceLoginNotFound();
            const consumed = yield* repo.consumeApproved(row.id).pipe(
              Effect.catchTag("RowNotFound", () => Effect.fail(new DeviceLoginNotFound()))
            );
            const minted = yield* apiKeys.createFor(row.approver_user_id, consumed.client_name);
            return { status: "approved", rawKey: minted.rawKey, keyName: minted.key.name, approverName: row.approver_name };
          }
          if (row.is_expired) return yield* new DeviceLoginExpired();
          return { status: "pending", clientName: row.client_name, code: row.code, expiresAt: row.expires_at_iso ?? row.expires_at };
        }),

      // Browser approval: user-bound identity (session or user-bound key) + token
      // (both required). Flips the request to approved and records the approver
      // — nothing is minted here. The CLI's next poll consumes the row and mints
      // the user-bound key (owner = approver, name = clientName), so approve and
      // poll can land on different isolates.
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
          // Conditional UPDATE (WHERE status='pending') is the flip verification:
          // a concurrent decide that won between read and write yields
          // RowNotFound → NotFound. Nothing minted, so nothing to compensate.
          yield* repo.setApproved(row.id, userId).pipe(
            Effect.catchTag("RowNotFound", () => Effect.fail(new DeviceLoginNotFound()))
          );
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