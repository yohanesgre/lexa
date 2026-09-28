import { Effect } from "effect";
import { DbError, ConstraintViolation } from "../db/db";
import { AssistantJevRepo, type JevConfigRowWithSecret } from "../repos/assistant-jev.repo";
import { JevAuthFailed, JevInvalidConfig, JevUnreachable, SecretKeyUnavailable } from "../api/errors";
import { currentEnv } from "../runtime-env";
import {
  decryptSecret,
  encryptSecret,
  secretsKeyringFromEnv,
  secretsManagedEnabled,
  SECRETS_MASTER_KEY_INVALID,
  type SecretKeyId,
  type SecretKeyring,
} from "../assistant/secrets";
import { listJevModels, type JevRuntimeConfig } from "../assistant/jev";
import type { AssistantJevMasked } from "../../shared/assistant";

export const JEV_SECRET_REQUIRES_MASTER_KEY =
  "a Jev API key needs LXK_SECRETS_MASTER_KEY to be set — managed secrets are disabled without it";

export const JEV_CLEAR_SECRET_CONFLICT_REJECTED =
  "clearSecret: true cannot be combined with a secret in the same request";

export const JEV_MODEL_MAX_LENGTH = 120;

// A real credential is a non-blank value; a blank field is "absent, not a
// value", so a UI that always posts its (empty) input cannot silently wipe a
// stored key and cannot mean "clear".
export function blankSecret(secret: string | null | undefined): string | null {
  return secret === null || secret === undefined || secret.trim() === "" ? null : secret;
}

export type JevBaseUrlValidation = { ok: true; url: string } | { ok: false; reason: string };

// Absolute http(s) with no userinfo — a Jev base URL is a plain API root, and
// embedded credentials would be a second, uninspectable key path.
export function validateJevBaseUrl(raw: string): JevBaseUrlValidation {
  const trimmed = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: "baseUrl must be a valid absolute URL" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: "baseUrl scheme must be http or https" };
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return { ok: false, reason: "baseUrl must not contain userinfo credentials" };
  }
  return { ok: true, url: trimmed };
}

export function jevModelOrReason(raw: string): { ok: true; model: string } | { ok: false; reason: string } {
  const model = raw.trim();
  if (model.length < 1 || model.length > JEV_MODEL_MAX_LENGTH) {
    return { ok: false, reason: `model must be 1-${JEV_MODEL_MAX_LENGTH} characters` };
  }
  return { ok: true, model };
}

export function maskedJevKey(keyHint: string | null): string | null {
  return keyHint !== null && keyHint !== "" ? `jev-…${keyHint}` : null;
}

export function toJevMasked(row: JevConfigRowWithSecret): AssistantJevMasked {
  return {
    id: "default",
    baseUrl: row.base_url,
    model: row.model,
    enabled: row.enabled === 1,
    hasKey: row.secret_ciphertext !== null,
    keyMask: maskedJevKey(row.secret_key_hint),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface JevConfigInput {
  baseUrl?: string;
  model?: string;
  enabled?: boolean;
  /** A replacement API key. Write-only: never returned, logged, or echoed. */
  secret?: string | null;
  /**
   * The only removal route: `true` deletes the stored ciphertext row. An omitted
   * or empty `secret` means "keep". Needs no master key (a row delete, no
   * crypto).
   */
  clearSecret?: boolean;
}

export interface JevConfigView {
  config: AssistantJevMasked;
  secretsEnabled: boolean;
}

export interface JevProbeResult {
  ok: true;
  latencyMs: number;
  models: string[];
}

export class AssistantJevService extends Effect.Service<AssistantJevService>()("Lexa/AssistantJevService", {
  dependencies: [AssistantJevRepo.Default],
  effect: Effect.gen(function* () {
    const repo = yield* AssistantJevRepo;

    // Same env snapshot the save path reads, so the rendered capability and the
    // enforced one cannot drift. Never throws — the capability read must not
    // fail the config read it rides along on.
    const secretsEnabled = (): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        const env = yield* currentEnv;
        return yield* Effect.tryPromise({
          try: () => secretsManagedEnabled(env),
          catch: (cause) => cause,
        }).pipe(Effect.orElseSucceed(() => false));
      });

    // A managed save needs the keyring. Unset key -> null (the documented
    // disable switch); a configured-but-malformed key -> SecretKeyUnavailable
    // naming the required shape, so an operator who set it wrong is told
    // instead of silently getting a feature that never works. The catch never
    // forwards the thrown message: it can quote the key material it choked on.
    const loadKeyring = (): Effect.Effect<SecretKeyring | null, SecretKeyUnavailable> =>
      Effect.gen(function* () {
        const env = yield* currentEnv;
        return yield* Effect.tryPromise({
          try: () => secretsKeyringFromEnv(env),
          catch: () => new SecretKeyUnavailable({ reason: SECRETS_MASTER_KEY_INVALID }),
        });
      });

    // Open the stored key into the plain runtime shape, or null if any gate
    // fails. Total by construction: every caller fails open on null, and no
    // branch can throw.
    const openSecret = (row: JevConfigRowWithSecret): Effect.Effect<JevRuntimeConfig | null> =>
      Effect.gen(function* () {
        if (row.secret_ciphertext === null || row.secret_iv === null || row.secret_key_id === null) return null;
        const env = yield* currentEnv;
        const keyring = yield* Effect.tryPromise({
          try: () => secretsKeyringFromEnv(env),
          catch: () => null,
        }).pipe(Effect.orElseSucceed(() => null));
        if (keyring === null) return null;
        const apiKey = yield* Effect.tryPromise({
          try: () =>
            decryptSecret(
              {
                ciphertextB64: row.secret_ciphertext as string,
                ivB64: row.secret_iv as string,
                keyId: row.secret_key_id as SecretKeyId,
                scope: "jev",
                ownerId: row.id,
              },
              keyring
            ),
          catch: () => null,
        }).pipe(Effect.orElseSucceed(() => null));
        if (apiKey === null || apiKey.trim() === "") return null;
        return { apiKey, baseUrl: row.base_url, model: row.model };
      });

    const readConfig = (): Effect.Effect<JevConfigView, DbError> =>
      Effect.gen(function* () {
        const row = yield* repo.getConfig();
        return { config: toJevMasked(row), secretsEnabled: yield* secretsEnabled() };
      });

    const updateConfig = (
      input: JevConfigInput
    ): Effect.Effect<JevConfigView, JevInvalidConfig | SecretKeyUnavailable | DbError | ConstraintViolation> =>
      Effect.gen(function* () {
        const secret = blankSecret(input.secret);
        if (input.clearSecret === true && secret !== null) {
          return yield* Effect.fail(new JevInvalidConfig({ reason: JEV_CLEAR_SECRET_CONFLICT_REJECTED }));
        }

        const patch: { baseUrl?: string; model?: string; enabled?: boolean } = {};
        if (input.baseUrl !== undefined) {
          const result = validateJevBaseUrl(input.baseUrl);
          if (!result.ok) return yield* Effect.fail(new JevInvalidConfig({ reason: result.reason }));
          patch.baseUrl = result.url;
        }
        if (input.model !== undefined) {
          const result = jevModelOrReason(input.model);
          if (!result.ok) return yield* Effect.fail(new JevInvalidConfig({ reason: result.reason }));
          patch.model = result.model;
        }
        if (input.enabled !== undefined) patch.enabled = input.enabled;

        // Encrypt BEFORE any write: a crypto fault then leaves the registry
        // untouched, and a payload refused by the keyring gate never half-applies.
        let sealed: { ciphertext: string; iv: string; keyId: string; keyHint: string } | null = null;
        if (input.clearSecret !== true && secret !== null) {
          const keyring = yield* loadKeyring();
          if (keyring === null) {
            return yield* Effect.fail(new SecretKeyUnavailable({ reason: JEV_SECRET_REQUIRES_MASTER_KEY }));
          }
          const encrypted = yield* Effect.tryPromise({
            try: () => encryptSecret(secret, "jev", "default", keyring.active, keyring),
            catch: () => new SecretKeyUnavailable({ reason: "Jev API key could not be encrypted" }),
          });
          sealed = {
            ciphertext: encrypted.ciphertextB64,
            iv: encrypted.ivB64,
            keyId: encrypted.keyId,
            keyHint: secret.slice(-4),
          };
        }

        if (patch.baseUrl !== undefined || patch.model !== undefined || patch.enabled !== undefined) {
          yield* repo.updateConfig(patch);
        }
        // The clear path is a pure row delete and needs no master key, so a
        // superadmin can always revoke a key even on a deployment whose key is
        // gone.
        if (input.clearSecret === true) yield* repo.deleteSecret();
        else if (sealed !== null) yield* repo.putSecret(sealed);

        return yield* readConfig();
      });

    const probe = (): Effect.Effect<JevProbeResult, JevInvalidConfig | JevAuthFailed | JevUnreachable | DbError> =>
      Effect.gen(function* () {
        const row = yield* repo.getConfig();
        // Probe ignores the enabled flags: an operator tests a config before
        // switching it on. It does require a stored, openable key.
        const config = yield* openSecret(row);
        if (config === null) {
          return yield* Effect.fail(new JevInvalidConfig({ reason: "Jev is not configured — add an API key first" }));
        }
        const started = Date.now();
        const result = yield* Effect.tryPromise({
          try: () => listJevModels({ config }),
          // `listJevModels` is total, so this is belt-and-braces: a thrown
          // helper must surface as an unreachable upstream, never a defect.
          catch: () => new JevUnreachable({ message: "Jev request failed before a response" }),
        });
        if (result.ok) return { ok: true, latencyMs: Date.now() - started, models: result.models };
        if (result.code === "AUTH") return yield* Effect.fail(new JevAuthFailed({}));
        return yield* Effect.fail(new JevUnreachable({ message: result.message }));
      });

    // The one gate shared by the preflight and `jev_assess`: global enabled +
    // project row enabled + a stored, openable key. Total — a caller fails open
    // on null.
    const resolveForProject = (projectId: string): Effect.Effect<JevRuntimeConfig | null> =>
      Effect.gen(function* () {
        const row = yield* repo.getConfig().pipe(Effect.orElseSucceed(() => null));
        if (row === null || row.enabled !== 1) return null;
        const project = yield* repo.getProject(projectId).pipe(Effect.orElseSucceed(() => null));
        if (project === null || project.enabled !== 1) return null;
        return yield* openSecret(row);
      });

    // The project card's capability read: is Jev usable for projects at all?
    // Global config enabled AND a stored, openable key; this project's own row
    // is deliberately ignored, so a member without superadmin read access can
    // render the disabled toggle + configure notice. Total, and never key
    // material.
    const projectAvailable = (): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        const row = yield* repo.getConfig().pipe(Effect.orElseSucceed(() => null));
        if (row === null || row.enabled !== 1) return false;
        return (yield* openSecret(row)) !== null;
      });

    return { readConfig, updateConfig, probe, resolveForProject, projectAvailable, secretsEnabled } as const;
  }),
}) {}