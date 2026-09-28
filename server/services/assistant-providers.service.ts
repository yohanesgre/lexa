import { Effect } from "effect";
import { DbError, ConstraintViolation, RowNotFound } from "../db/db";
import {
  AssistantProvidersRepo,
  type AssistantProviderRowWithSecret,
  type ProviderSecretStorage,
} from "../repos/assistant-providers.repo";
import { InvalidArgs, ProviderAuthFailed, SecretKeyUnavailable } from "../api/errors";
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
import type { AssistantProviderMasked } from "../../shared/assistant";

export const PROVIDER_SECRET_REQUIRES_MASTER_KEY =
  "a provider API key needs LXK_SECRETS_MASTER_KEY to be set — managed secrets are disabled without it";

export const PROVIDER_KEY_UNDECRYPTABLE =
  "stored provider key could not be decrypted with the configured master key — re-enter the key";

export const PROVIDER_CLEAR_KEY_CONFLICT_REJECTED =
  "clearKey: true cannot be combined with an apiKey in the same request";

// A real credential is a non-blank value; a blank field is "absent, not a
// value", so a UI that always posts its (empty) input cannot silently wipe a
// stored key and cannot mean "clear".
export function blankApiKey(apiKey: string | null | undefined): string | null {
  return apiKey === null || apiKey === undefined || apiKey.trim() === "" ? null : apiKey;
}

export interface ProviderCreateInput {
  label: string;
  baseUrl: string;
  /** A managed provider key. Write-only: never returned, logged, or echoed. */
  apiKey?: string | null;
}

export interface ProviderUpdateInput {
  label?: string;
  baseUrl?: string;
  /** A replacement API key. Write-only: never returned, logged, or echoed. */
  apiKey?: string | null;
  /**
   * The only removal route: `true` deletes the stored ciphertext row. An
   * omitted or empty `apiKey` means "keep". Needs no master key (a row delete,
   * no crypto).
   */
  clearKey?: boolean;
}

export class AssistantProvidersService extends Effect.Service<AssistantProvidersService>()("Lexa/AssistantProvidersService", {
  dependencies: [AssistantProvidersRepo.Default],
  effect: Effect.gen(function* () {
    const repo = yield* AssistantProvidersRepo;

    const requireRow = (id: string): Effect.Effect<AssistantProviderRowWithSecret, RowNotFound | DbError> =>
      repo.getById(id);

    // Same env snapshot the save path reads, so the rendered capability and the
    // enforced one cannot drift. Never throws — the capability read must not
    // fail the registry read it rides along on.
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
    // forwards the thrown message: a WebCrypto error can quote the key
    // material it choked on, and `reason` is copied verbatim into the 400 body.
    const loadKeyring = (): Effect.Effect<SecretKeyring | null, SecretKeyUnavailable> =>
      Effect.gen(function* () {
        const env = yield* currentEnv;
        return yield* Effect.tryPromise({
          try: () => secretsKeyringFromEnv(env),
          catch: () => new SecretKeyUnavailable({ reason: SECRETS_MASTER_KEY_INVALID }),
        });
      });

    // The single ENCRYPTION point for a provider key: a fresh IV per write,
    // AAD bound to the provider id, and the plaintext exists only as a local
    // here and in the caller's effect frame.
    const sealKey = (
      id: string,
      plaintext: string,
      keyring: SecretKeyring
    ): Effect.Effect<ProviderSecretStorage, SecretKeyUnavailable> =>
      Effect.tryPromise({
        try: () => encryptSecret(plaintext, "provider", id, keyring.active, keyring),
        catch: () => new SecretKeyUnavailable({ reason: "provider API key could not be encrypted" }),
      }).pipe(
        Effect.map((sealed) => ({ ciphertext: sealed.ciphertextB64, iv: sealed.ivB64, keyId: sealed.keyId, keyHint: plaintext.slice(-4) }))
      );

    const list = (): Effect.Effect<AssistantProviderMasked[], DbError> => repo.maskedList();

    const view = (id: string): Effect.Effect<AssistantProviderMasked, RowNotFound | DbError> => repo.maskedView(id);

    const create = (
      input: ProviderCreateInput
    ): Effect.Effect<AssistantProviderMasked, SecretKeyUnavailable | RowNotFound | DbError | ConstraintViolation> =>
      Effect.gen(function* () {
        const id = crypto.randomUUID();
        const apiKey = blankApiKey(input.apiKey);
        // Encrypt BEFORE any write: a crypto fault then leaves nothing behind
        // at all, instead of a credential-less registration.
        const sealed = apiKey !== null
          ? yield* loadKeyring().pipe(
              Effect.flatMap((keyring) =>
                keyring === null
                  ? Effect.fail(new SecretKeyUnavailable({ reason: PROVIDER_SECRET_REQUIRES_MASTER_KEY }))
                  : sealKey(id, apiKey, keyring)
              )
            )
          : null;
        yield* repo.create({ id, label: input.label, baseUrl: input.baseUrl });
        if (sealed !== null) yield* repo.putSecret(id, sealed);
        return yield* repo.maskedView(id);
      });

    const update = (
      id: string,
      input: ProviderUpdateInput
    ): Effect.Effect<AssistantProviderMasked, InvalidArgs | SecretKeyUnavailable | RowNotFound | DbError | ConstraintViolation> =>
      Effect.gen(function* () {
        const existing = yield* requireRow(id);
        const apiKey = blankApiKey(input.apiKey);
        if (input.clearKey === true && apiKey !== null) {
          return yield* Effect.fail(new InvalidArgs({ reason: PROVIDER_CLEAR_KEY_CONFLICT_REJECTED }));
        }

        const patch: { label?: string; baseUrl?: string } = {};
        if (input.label !== undefined) patch.label = input.label;
        if (input.baseUrl !== undefined) patch.baseUrl = input.baseUrl;

        // Encrypt BEFORE any write: a crypto fault then leaves the registry
        // untouched, and a payload refused by the keyring gate never
        // half-applies.
        const sealed = input.clearKey !== true && apiKey !== null
          ? yield* loadKeyring().pipe(
              Effect.flatMap((keyring) =>
                keyring === null
                  ? Effect.fail(new SecretKeyUnavailable({ reason: PROVIDER_SECRET_REQUIRES_MASTER_KEY }))
                  : sealKey(id, apiKey, keyring)
              )
            )
          : null;

        if (patch.label !== undefined || patch.baseUrl !== undefined) {
          yield* repo.update(id, patch);
        }
        // The clear path is a pure row delete and needs no master key, so a
        // superadmin can always revoke a key even on a deployment whose key is
        // gone.
        if (input.clearKey === true) yield* repo.deleteSecret(id);
        else if (sealed !== null) yield* repo.putSecret(id, sealed);

        return yield* repo.maskedView(existing.id);
      });

    const remove = (id: string): Effect.Effect<void, RowNotFound | DbError | ConstraintViolation> =>
      repo.remove(id);

    // Open a key from an ALREADY-FETCHED registry row. The gateway lists every
    // provider once (the LEFT JOIN carries the secret columns), so resolving its
    // keys must not issue a second getById per provider. A keyless row resolves
    // to "" (a provider can legitimately be configured without a credential); a
    // stored-but-unopenable key is a hard refusal with the fixed catalog
    // message, never a silent empty header.
    const openProviderKey = (row: AssistantProviderRowWithSecret): Effect.Effect<string, ProviderAuthFailed> =>
      Effect.gen(function* () {
        if (row.secret_ciphertext === null || row.secret_iv === null || row.secret_key_id === null) return "";
        const env = yield* currentEnv;
        const keyring = yield* Effect.tryPromise({
          try: () => secretsKeyringFromEnv(env),
          catch: () => null,
        }).pipe(Effect.orElseSucceed(() => null));
        if (keyring === null) {
          return yield* Effect.fail(new ProviderAuthFailed({ message: PROVIDER_KEY_UNDECRYPTABLE }));
        }
        const apiKey = yield* Effect.tryPromise({
          try: () =>
            decryptSecret(
              {
                ciphertextB64: row.secret_ciphertext as string,
                ivB64: row.secret_iv as string,
                keyId: row.secret_key_id as SecretKeyId,
                scope: "provider",
                ownerId: row.id,
              },
              keyring
            ),
          catch: () => null,
        }).pipe(Effect.orElseSucceed(() => null));
        if (apiKey === null) {
          return yield* Effect.fail(new ProviderAuthFailed({ message: PROVIDER_KEY_UNDECRYPTABLE }));
        }
        return apiKey;
      });

    const resolveApiKeyForRow = openProviderKey;

    // The single-id read for the provider test endpoints. Reads the row, then
    // opens it with the same helper the gateway uses on listed rows.
    const resolveApiKey = (id: string): Effect.Effect<string, ProviderAuthFailed | DbError> =>
      Effect.gen(function* () {
        const row = yield* repo.getById(id).pipe(Effect.catchTag("RowNotFound", () => Effect.succeed(null)));
        if (row === null) return "";
        return yield* openProviderKey(row);
      });

    return { list, view, secretsEnabled, create, update, remove, resolveApiKey, resolveApiKeyForRow } as const;
  }),
}) {}
