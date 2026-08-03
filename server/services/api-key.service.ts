import { Effect, Data } from "effect";
import { ApiKeyRepo } from "../repos/api-key.repo";
import { DbError, RowNotFound, ConstraintViolation } from "../db/database";
import type { ApiKey, ApiKeyCreateResult } from "../../shared/types";

export class ApiKeyNameEmpty extends Data.TaggedError("ApiKeyNameEmpty")<{}> {}

// System/bootstrap keys created outside the settings UI (env LXK_API_KEY seed,
// first-run wizard key, dev seed). They authenticate the frontend/server but
// are not user-managed — the settings list shows only user-generated keys.
const SYSTEM_KEY_NAMES = new Set(["admin", "setup-wizard", "dev-local"]);

function rowToApiKey(row: { id: string; name: string; created_at: string; last_used_at: string | null }): ApiKey {
  return { id: row.id, name: row.name, createdAt: row.created_at, lastUsedAt: row.last_used_at };
}

function generateRawKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  let value = 0n;
  for (const b of bytes) value = (value << 8n) | BigInt(b);
  let result = "";
  const base = 62n;
  while (value > 0n) { result = chars[Number(value % base)] + result; value /= base; }
  while (result.length < 43) result = chars[0] + result;
  return `lxk_${result}`;
}

async function sha256(text: string): Promise<string> {
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
          rows.flatMap((r) => (SYSTEM_KEY_NAMES.has(r.name) ? [] : [rowToApiKey(r)]))
        ),

      create: (name: string): Effect.Effect<ApiKeyCreateResult, ApiKeyNameEmpty | DbError | ConstraintViolation | RowNotFound> =>
        Effect.gen(function* () {
          const trimmed = name.trim();
          if (!trimmed) return yield* new ApiKeyNameEmpty();
          const rawKey = generateRawKey();
          const keyHash = yield* Effect.promise(() => sha256(rawKey));
          const id = crypto.randomUUID();
          const row = yield* repo.create({ id, name: trimmed, keyHash });
          yield* Effect.logInfo(`[ApiKey] Created ${row.id} name=${trimmed}`);
          return { key: rowToApiKey(row), rawKey };
        }),

      delete: (id: string): Effect.Effect<void, DbError | RowNotFound | ConstraintViolation> =>
        repo.deleteById(id).pipe(
          Effect.tap(() => Effect.logInfo(`[ApiKey] Deleted ${id}`))
        ),
    };
  }),
}) {}
