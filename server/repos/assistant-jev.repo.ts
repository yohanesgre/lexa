import { Effect } from "effect";
import { Db, queryAll, queryFirst, run, DbError, ConstraintViolation } from "../db/db";

// The singleton config row (always present: migration 0013 seeds id='default').
export interface JevConfigRow {
  id: string;
  base_url: string;
  model: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

// The bridge read shape: the config row plus whatever secret row the LEFT JOIN
// found. The ciphertext NEVER enters the bare JevConfigRow, so a `SELECT *` of
// the config cannot surface a blob; the `secret_*` columns are all-or-nothing
// (any non-null means a key is stored). `secret_key_id` stays a plain string
// here — this is the storage boundary, and the slot vocabulary is validated
// where the blob is opened (server/assistant/secrets.ts).
export interface JevConfigRowWithSecret extends JevConfigRow {
  secret_ciphertext: string | null;
  secret_iv: string | null;
  secret_key_id: string | null;
  secret_key_hint: string | null;
}

export interface JevProjectRow {
  project_id: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

/** The blob columns of the stored Jev key, exactly as the secret table stores them. */
export interface JevSecretStorage {
  ciphertext: string;
  iv: string;
  keyId: string;
  keyHint: string;
}

export interface JevConfigPatch {
  baseUrl?: string;
  model?: string;
  enabled?: boolean;
}

export class AssistantJevRepo extends Effect.Service<AssistantJevRepo>()("Lexa/AssistantJevRepo", {
  effect: Effect.gen(function* () {
    const db = yield* Db;

    // Every config read goes through this projection: the singleton row plus the
    // secret row when one exists. A LEFT JOIN (never INNER) keeps a keyless
    // config readable, and the alias names keep the blob out of a bare
    // `SELECT *` of assistant_jev_config.
    const SELECT_WITH_SECRET = `SELECT c.*, s.ciphertext AS secret_ciphertext, s.iv AS secret_iv, s.key_id AS secret_key_id, s.key_hint AS secret_key_hint
       FROM assistant_jev_config c
       LEFT JOIN assistant_jev_secrets s ON s.config_id = c.id
       WHERE c.id = 'default'`;

    const readConfig = (): Effect.Effect<JevConfigRowWithSecret, DbError> =>
      queryFirst<JevConfigRowWithSecret>(db, SELECT_WITH_SECRET).pipe(
        // The singleton is seeded by 0013; a missing read is a database fault,
        // not a not-found the caller must handle.
        Effect.catchTag("RowNotFound", () => Effect.fail(new DbError({ message: "assistant_jev_config row 'default' missing — migration 0013 seeds it" })))
      );

    return {
      getConfig: (): Effect.Effect<JevConfigRowWithSecret, DbError> => readConfig(),

      updateConfig: (patch: JevConfigPatch): Effect.Effect<JevConfigRowWithSecret, DbError | ConstraintViolation> =>
        Effect.gen(function* () {
          const sets: string[] = [];
          const params: unknown[] = [];
          if (patch.baseUrl !== undefined) { sets.push("base_url = ?"); params.push(patch.baseUrl); }
          if (patch.model !== undefined) { sets.push("model = ?"); params.push(patch.model); }
          if (patch.enabled !== undefined) { sets.push("enabled = ?"); params.push(patch.enabled ? 1 : 0); }
          if (sets.length === 0) return yield* readConfig();
          sets.push("updated_at = datetime('now')");
          yield* run(db, `UPDATE assistant_jev_config SET ${sets.join(", ")} WHERE id = 'default'`, ...params);
          return yield* readConfig();
        }),

      // Upsert the stored blob. `ON CONFLICT` keeps a re-save a single statement,
      // and the write always carries the seeded config id as the key, so no row
      // can be orphaned.
      putSecret: (secret: JevSecretStorage): Effect.Effect<void, ConstraintViolation | DbError> =>
        run(
          db,
          `INSERT INTO assistant_jev_secrets (config_id, ciphertext, iv, key_id, key_hint)
           VALUES ('default', ?, ?, ?, ?)
           ON CONFLICT(config_id) DO UPDATE SET
             ciphertext = excluded.ciphertext, iv = excluded.iv, key_id = excluded.key_id,
             key_hint = excluded.key_hint, updated_at = datetime('now')`,
          secret.ciphertext,
          secret.iv,
          secret.keyId,
          secret.keyHint
        ).pipe(Effect.asVoid),

      // Pure row delete — no crypto, so it works with no master key configured
      // (the clear affordance must never depend on a key being present).
      deleteSecret: (): Effect.Effect<void, ConstraintViolation | DbError> =>
        run(db, `DELETE FROM assistant_jev_secrets WHERE config_id = 'default'`).pipe(Effect.asVoid),

      // Absence is the opt-out state, so this read is nullable rather than a
      // not-found the caller has to catch.
      getProject: (projectId: string): Effect.Effect<JevProjectRow | null, DbError> =>
        queryAll<JevProjectRow>(db, `SELECT * FROM assistant_jev_projects WHERE project_id = ?`, projectId).pipe(
          Effect.map((rows) => rows[0] ?? null)
        ),

      setProject: (projectId: string, enabled: boolean): Effect.Effect<JevProjectRow, DbError | ConstraintViolation> =>
        Effect.gen(function* () {
          yield* run(
            db,
            `INSERT INTO assistant_jev_projects (project_id, enabled) VALUES (?, ?)
             ON CONFLICT(project_id) DO UPDATE SET enabled = excluded.enabled, updated_at = datetime('now')`,
            projectId,
            enabled ? 1 : 0
          );
          const row = yield* queryAll<JevProjectRow>(db, `SELECT * FROM assistant_jev_projects WHERE project_id = ?`, projectId);
          const written = row[0];
          if (written === undefined) return yield* Effect.fail(new DbError({ message: `assistant_jev_projects row '${projectId}' missing after write` }));
          return written;
        }),
    };
  }),
}) {}