import { Effect, Data } from "effect";
import { ApiKeyRepo, type ApiKeyWithOwnerRow } from "../repos/api-key.repo";
import type { ApiKeyRow } from "../../shared/db";
import { DbError, RowNotFound, ConstraintViolation } from "../db/db";
import type { ApiKey, ApiKeyCreateResult } from "../../shared/types";

export class ApiKeyNameEmpty extends Data.TaggedError("ApiKeyNameEmpty")<{}> {}

// Legacy/dev bootstrap rows created outside the settings UI (the env seed
// is removed — no new unbound keys are minted).
// The settings list hides only the seeded bootstrap
// keys — a user-minted key named the same must stay visible. Filter is
// name + unbound, never name alone.
const SYSTEM_KEY_NAMES = new Set(["admin", "setup-wizard"]);

function rowToApiKey(row: ApiKeyWithOwnerRow | ApiKeyRow): ApiKey {
  const r = row as ApiKeyWithOwnerRow;
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    ...(row.user_id !== null && r.owner_email != null ? { ownerEmail: r.owner_email } : {}),
    ...(row.user_id !== null && r.owner_name != null ? { ownerName: r.owner_name } : {}),
  };
}

function generateRawKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  let value = 0n;
  for (const b of bytes) value = (value << 8n) | BigInt(b);
  let result = "";
  const base = 62n;
  while (value > 0n) { result = chars[Number(value % base)] + result; value /= base; }
  while (result.length < 43) result = chars[0]! + result;
  return `lxk_${result}`;
}

// Shared by ApiKeyService and DeviceLoginService (device approval mints keys
// inside one atomic batch — the helpers must live in one place).
export function generateRawKeyForMint(): string {
  return generateRawKey();
}

export async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
}

export class ApiKeyService extends Effect.Service<ApiKeyService>()("Lexa/ApiKeyService", {
  dependencies: [ApiKeyRepo.Default],
  effect: Effect.gen(function* () {
    const repo = yield* ApiKeyRepo;

    return {
      list: (): Effect.Effect<ApiKey[], DbError> =>
        Effect.map(repo.listAll(), rows =>
          rows.flatMap((r) => (SYSTEM_KEY_NAMES.has(r.name) && r.user_id === null ? [] : [rowToApiKey(r)]))
        ),

      listForUser: (userId: string): Effect.Effect<ApiKey[], DbError> =>
        Effect.map(repo.listByUser(userId), rows => rows.map(rowToApiKey)),

      // The only mint path for UI/device keys: always binds to a user.
      createFor: (userId: string, name: string): Effect.Effect<ApiKeyCreateResult, ApiKeyNameEmpty | DbError | ConstraintViolation | RowNotFound> =>
        Effect.gen(function* () {
          const trimmed = name.trim();
          if (!trimmed) return yield* new ApiKeyNameEmpty();
          const rawKey = generateRawKey();
          const keyHash = yield* Effect.promise(() => sha256(rawKey));
          const id = crypto.randomUUID();
          const row = yield* repo.create({ id, name: trimmed, keyHash, userId });
          yield* Effect.logInfo(`[ApiKey] Created ${row.id} name=${trimmed} owner=${userId}`);
          return { key: rowToApiKey(row), rawKey };
        }),

      delete: (id: string): Effect.Effect<void, DbError | RowNotFound | ConstraintViolation> =>
        repo.deleteById(id).pipe(
          Effect.tap(() => Effect.logInfo(`[ApiKey] Deleted ${id}`))
        ),

      deleteOwn: (id: string, userId: string): Effect.Effect<void, DbError | RowNotFound | ConstraintViolation> =>
        repo.deleteOwn(id, userId).pipe(
          Effect.tap(() => Effect.logInfo(`[ApiKey] Deleted ${id} (owner-scoped)`))
        ),
    };
  }),
}) {}