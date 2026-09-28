import { Effect } from "effect";
import { Db, queryAll, queryFirst, run, DbError, RowNotFound, ConstraintViolation } from "../db/db";
import type { AssistantProviderMasked, AssistantModelRow, ProviderKind } from "../../shared/assistant";

// The registry row. `api_key` (the legacy plaintext column) is deliberately
// absent: nothing reads it, every write stores '' (the column is NOT NULL), and
// release N+1 drops it. Secrets live in `assistant_provider_secrets` and are
// only ever reachable through the `secret_*` projection below.
export interface AssistantProviderRow {
  id: string;
  label: string;
  base_url: string;
  created_at: string;
  updated_at: string;
}

// The bridge read shape: a registry row plus whatever secret row the LEFT JOIN
// found. Ciphertext lives in `assistant_provider_secrets` and NEVER enters
// `AssistantProviderRow`, so a bare `SELECT *` of the registry cannot surface a
// blob; the `secret_*` columns are all-or-nothing (any non-null means a key is
// stored). `secret_key_id` stays a plain string here — this is the storage
// boundary, and the slot vocabulary is validated where the blob is opened
// (server/assistant/secrets.ts).
export interface AssistantProviderRowWithSecret extends AssistantProviderRow {
  secret_ciphertext: string | null;
  secret_iv: string | null;
  secret_key_id: string | null;
  secret_key_hint: string | null;
}

/** The blob columns of a stored provider key, exactly as the secret table stores them. */
export interface ProviderSecretStorage {
  ciphertext: string;
  iv: string;
  keyId: string;
  keyHint: string;
}

interface AssistantModelDbRow {
  id: string;
  provider_id: string;
  model_id: string;
  kind: ProviderKind;
  priority: number;
  enabled: number;
  created_at: string;
}

function toMasked(row: AssistantProviderRowWithSecret): AssistantProviderMasked {
  return {
    id: row.id,
    label: row.label,
    baseUrl: row.base_url,
    hasKey: row.secret_ciphertext !== null,
    keyMask: row.secret_key_hint ? `sk-…${row.secret_key_hint}` : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toModelDomain(row: AssistantModelDbRow): AssistantModelRow {
  return {
    id: row.id,
    providerId: row.provider_id,
    modelId: row.model_id,
    kind: row.kind,
    priority: row.priority,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
  };
}

export class AssistantProvidersRepo extends Effect.Service<AssistantProvidersRepo>()("Lexa/AssistantProvidersRepo", {
  effect: Effect.gen(function* () {
    const db = yield* Db;

    // Every read goes through this projection: the registry columns (api_key
    // deliberately omitted — it is a dead column and must never reach a
    // caller) plus the secret row when one exists. A LEFT JOIN (never INNER)
    // keeps a keyless provider readable, and the alias names keep the blob out
    // of a bare `SELECT *` of assistant_providers.
    const SELECT_WITH_SECRET = `SELECT p.id, p.label, p.base_url, p.created_at, p.updated_at,
         sec.ciphertext AS secret_ciphertext, sec.iv AS secret_iv, sec.key_id AS secret_key_id, sec.key_hint AS secret_key_hint
       FROM assistant_providers p
       LEFT JOIN assistant_provider_secrets sec ON sec.provider_id = p.id`;

    return {
      // `api_key` is always stored '' — the legacy column is dead, and only the
      // boot backfill ever reads a non-empty value out of it.
      create: (input: { id: string; label: string; baseUrl: string }): Effect.Effect<AssistantProviderRowWithSecret, ConstraintViolation | DbError | RowNotFound> =>
        run(db, `INSERT INTO assistant_providers (id, label, base_url, api_key) VALUES (?, ?, ?, '')`, input.id, input.label, input.baseUrl).pipe(
          Effect.flatMap(() => queryFirst<AssistantProviderRowWithSecret>(db, `${SELECT_WITH_SECRET} WHERE p.id = ?`, input.id))
        ),

      getById: (id: string): Effect.Effect<AssistantProviderRowWithSecret, RowNotFound | DbError> =>
        queryFirst<AssistantProviderRowWithSecret>(db, `${SELECT_WITH_SECRET} WHERE p.id = ?`, id),

      list: (): Effect.Effect<AssistantProviderRowWithSecret[], DbError> =>
        queryAll<AssistantProviderRowWithSecret>(db, `${SELECT_WITH_SECRET} ORDER BY p.created_at ASC`),

      // `api_key` is never in this patch and never touched by the UPDATE.
      update: (id: string, patch: { label?: string; baseUrl?: string }): Effect.Effect<AssistantProviderRowWithSecret, RowNotFound | ConstraintViolation | DbError> =>
        Effect.gen(function* () {
          const sets: string[] = [];
          const params: unknown[] = [];
          if (patch.label !== undefined) { sets.push("label = ?"); params.push(patch.label); }
          if (patch.baseUrl !== undefined) { sets.push("base_url = ?"); params.push(patch.baseUrl); }
          if (sets.length === 0) return yield* queryFirst<AssistantProviderRowWithSecret>(db, `${SELECT_WITH_SECRET} WHERE p.id = ?`, id);
          sets.push("updated_at = datetime('now')");
          params.push(id);
          yield* run(db, `UPDATE assistant_providers SET ${sets.join(", ")} WHERE id = ?`, ...params);
          return yield* queryFirst<AssistantProviderRowWithSecret>(db, `${SELECT_WITH_SECRET} WHERE p.id = ?`, id);
        }),

      // Upsert the stored blob. `ON CONFLICT` keeps a re-save a single
      // statement, and the write always carries a non-null provider_id: the
      // table's bare `TEXT PRIMARY KEY` is NULL-insertable in SQLite practice,
      // so the repo refuses to hand SQLite a NULL key (the caller passes the id
      // of a registry row it just read).
      putSecret: (id: string, secret: ProviderSecretStorage): Effect.Effect<void, ConstraintViolation | DbError> =>
        run(
          db,
          `INSERT INTO assistant_provider_secrets (provider_id, ciphertext, iv, key_id, key_hint)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(provider_id) DO UPDATE SET
             ciphertext = excluded.ciphertext, iv = excluded.iv, key_id = excluded.key_id,
             key_hint = excluded.key_hint, updated_at = datetime('now')`,
          id,
          secret.ciphertext,
          secret.iv,
          secret.keyId,
          secret.keyHint
        ).pipe(Effect.asVoid),

      // Pure row delete — no crypto, so it works with no master key configured
      // (the clear affordance must never depend on a key being present).
      deleteSecret: (id: string): Effect.Effect<void, ConstraintViolation | DbError> =>
        run(db, `DELETE FROM assistant_provider_secrets WHERE provider_id = ?`, id).pipe(Effect.asVoid),

      remove: (id: string): Effect.Effect<void, RowNotFound | DbError | ConstraintViolation> =>
        Effect.gen(function* () {
          // Migration 0014's ON DELETE CASCADE fires on the Bun app connection
          // (PRAGMA foreign_keys = ON) and under the Workers/D1 runner, but NOT
          // on the migration runner's short-lived connection, which sets
          // PRAGMA foreign_keys = OFF for the run (server/db/migrate.ts) — so
          // the child row is deleted explicitly instead of stranding
          // ciphertext if any path deletes a provider without the pragma on.
          // Child first, then the not-found check.
          yield* run(db, `DELETE FROM assistant_provider_secrets WHERE provider_id = ?`, id);
          const changes = yield* run(db, `DELETE FROM assistant_providers WHERE id = ?`, id);
          if (changes === 0) return yield* Effect.fail(new RowNotFound({ table: "assistant_providers" }));
        }),

      maskedView: (id: string): Effect.Effect<AssistantProviderMasked, RowNotFound | DbError> =>
        Effect.gen(function* () {
          const row = yield* queryFirst<AssistantProviderRowWithSecret>(db, `${SELECT_WITH_SECRET} WHERE p.id = ?`, id);
          const masked = toMasked(row);
          const modelRows = yield* queryAll<AssistantModelDbRow>(db, `SELECT * FROM assistant_models WHERE provider_id = ? ORDER BY priority ASC, id ASC`, id).pipe(
            Effect.catchAll(() => Effect.succeed([] as AssistantModelDbRow[]))
          );
          const models = modelRows.map((row) => {
            const m = toModelDomain(row);
            return { id: m.id, providerId: m.providerId, modelId: m.modelId, kind: m.kind, priority: m.priority, enabled: m.enabled, createdAt: m.createdAt };
          });
          return { ...masked, models } as AssistantProviderMasked;
        }),

      maskedList: (): Effect.Effect<AssistantProviderMasked[], DbError> =>
        Effect.gen(function* () {
          const rows = yield* queryAll<AssistantProviderRowWithSecret>(db, `${SELECT_WITH_SECRET} ORDER BY p.created_at ASC`);
          const modelRows = yield* queryAll<AssistantModelDbRow>(db, `SELECT * FROM assistant_models ORDER BY priority ASC, id ASC`).pipe(
            Effect.catchAll(() => Effect.succeed([] as AssistantModelDbRow[]))
          );
          const byProvider = new Map<string, AssistantModelDbRow[]>();
          for (const mr of modelRows) {
            const arr = byProvider.get(mr.provider_id) ?? [];
            arr.push(mr);
            byProvider.set(mr.provider_id, arr);
          }
          return rows.map((r) => {
            const masked = toMasked(r);
            const models = (byProvider.get(r.id) ?? []).map((row) => {
              const m = toModelDomain(row);
              return { id: m.id, providerId: m.providerId, modelId: m.modelId, kind: m.kind, priority: m.priority, enabled: m.enabled, createdAt: m.createdAt };
            });
            return { ...masked, models } as AssistantProviderMasked;
          });
        }),
    };
  }),
}) {}
