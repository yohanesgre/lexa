// Managed secret envelopes — one AES-256-GCM keyring for every stored
// credential the webapp manages (MCP client tokens, LLM provider API keys, the
// Jev API key).
//
// The master key lives ONLY in the environment (LXK_SECRETS_MASTER_KEY, with
// LXK_SECRETS_MASTER_KEY_PREV as the rotation read path); the DB stores
// AES-256-GCM ciphertext. Nothing here logs, and no returned or thrown string
// ever carries the plaintext, the ciphertext, or the key: every failure is one
// fixed message, so an upstream `OperationError` (or a caller's own mistake)
// can never quote secret material into a log line, a report body, or an HTTP
// response.
//
// Ciphertext is bound to its scope AND its owner through the AAD
// (`<prefix>:<ownerId>`) using a frozen prefix per scope, so a blob copied onto
// another row or another scope fails to decrypt.
//
// Plain assistant-tier module: not an Effect service, no service deps, no DB
// (invariant #1) — Web Crypto and the base64 helpers only, so the same code
// runs on Bun and on workerd. No Node builtins are used at all (base64 goes
// through atob/btoa), because the Workers bundle ships none.

import type { RuntimeEnv } from "../env";

export const SECRETS_MASTER_KEY_ENV_KEY = "LXK_SECRETS_MASTER_KEY";
export const SECRETS_MASTER_KEY_PREV_ENV_KEY = "LXK_SECRETS_MASTER_KEY_PREV";

// The keyring slot names, which are also the stored `key_id`. Frozen
// convention: `key_id` is the SLOT a blob was encrypted under, never a key
// fingerprint, counter, or date. It is INFORMATIONAL: rotation demotes the
// active key to `prev` and installs a new one, so the slot a row names stops
// being the slot that holds its key. Rotation therefore never needs a rewrap —
// `decryptSecret` tries the active key and falls back to `prev`. The label
// is still checked against this vocabulary, so a row naming an unknown slot
// fails closed instead of opening on a guess.
export const SECRET_KEY_ID_ACTIVE = "active";
export const SECRET_KEY_ID_PREV = "prev";
export type SecretKeyId = typeof SECRET_KEY_ID_ACTIVE | typeof SECRET_KEY_ID_PREV;

// AES-256-GCM: the only AEAD both Bun and workerd expose through
// crypto.subtle (XChaCha20/ChaCha20 are unavailable on workerd, and no new
// WASM dep is wanted).
export const SECRETS_MASTER_KEY_BYTES = 32;
export const SECRET_IV_BYTES = 12;
const SECRET_TAG_BITS = 128;

export type SecretScope = "mcp" | "provider" | "jev" | "github";

// Frozen per-scope AAD prefixes. "mcp" MUST stay "lexa-mcp-v1" — stored MCP
// blobs authenticate against `lexa-mcp-v1:<serverId>` and must keep opening.
export const SECRET_AAD_PREFIXES: Readonly<Record<SecretScope, string>> = Object.freeze({
  mcp: "lexa-mcp-v1",
  provider: "lexa-provider-v1",
  jev: "lexa-jev-v1",
  github: "lexa-github-v1",
});

// Fixed messages. They name the required shape or the failure class and
// nothing else — never the offending value.
export const SECRETS_MASTER_KEY_INVALID = "Secrets master key must be 32 bytes, base64-encoded";
export const SECRET_DECRYPT_FAILED = "stored secret could not be decrypted with the configured master key";

export interface SecretKeyring {
  active: CryptoKey;
  prev?: CryptoKey | undefined;
}

/** The columns a scope's secret table stores — the ONLY thing persisted. */
export interface EncryptedSecret {
  /** base64 of `ciphertext || tag`. */
  ciphertextB64: string;
  /** base64 of the 12-byte IV. */
  ivB64: string;
  /** The keyring slot the blob was encrypted under. Informational, not a selector. */
  keyId: SecretKeyId;
}

/** What `decryptSecret` needs: the stored blob plus its scope and owner. */
export interface SecretRow extends EncryptedSecret {
  scope: SecretScope;
  ownerId: string;
}

const encoder = new TextEncoder();

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// base64url is what most secret generators emit (`openssl rand -base64 32`
// emits padded standard base64, so both must be accepted), and whitespace is
// stripped so a value pasted with a trailing newline is not a boot failure.
function decodeKeyMaterial(raw: string): Uint8Array<ArrayBuffer> {
  const normalized = raw.trim().replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
  if (normalized === "") throw new Error(SECRETS_MASTER_KEY_INVALID);
  // atob throws on a bad alphabet or a bad length; either way the caller gets
  // the fixed message, never the underlying DOMException text.
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = fromBase64(normalized);
  } catch {
    throw new Error(SECRETS_MASTER_KEY_INVALID);
  }
  if (bytes.byteLength !== SECRETS_MASTER_KEY_BYTES) throw new Error(SECRETS_MASTER_KEY_INVALID);
  return bytes;
}

/**
 * Import a base64/base64url master key as a non-extractable AES-GCM key.
 * `extractable: false` is the point: the raw key bytes can never be read back
 * out of the runtime, so a heap dump is the only remaining exposure.
 * Rejects empty, short, long, and non-base64 input with one fixed message.
 */
export async function parseMasterKey(raw: string | null | undefined): Promise<CryptoKey> {
  const material = decodeKeyMaterial(typeof raw === "string" ? raw : "");
  return crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

// A CryptoKey carries no name, so a keyring records the slot each key occupies
// in a weak map. Registration is per key OBJECT, so a key imported twice (a
// fresh process, a re-parsed env) simply re-registers under the same slot
// rather than colliding, and an unregistered key — one this module never
// placed in a keyring — resolves to no slot and is refused rather than
// mislabelled.
const KEY_SLOTS = new WeakMap<CryptoKey, SecretKeyId>();

/** The keyring slot a key belongs to, or null when it belongs to none. */
export function keyIdFor(key: CryptoKey | null | undefined): SecretKeyId | null {
  if (key === null || key === undefined) return null;
  return KEY_SLOTS.get(key) ?? null;
}

/**
 * Build a keyring from already-imported keys, recording which slot each one
 * occupies. A key already registered to the other slot is re-registered for
 * the slot it was passed as — the keyring is the authority, not history.
 */
export function keyringFromKeys(active: CryptoKey, prev?: CryptoKey | null): SecretKeyring {
  KEY_SLOTS.set(active, SECRET_KEY_ID_ACTIVE);
  if (prev !== null && prev !== undefined) KEY_SLOTS.set(prev, SECRET_KEY_ID_PREV);
  return { active, ...(prev === null || prev === undefined ? {} : { prev }) };
}

function aadFor(scope: SecretScope, ownerId: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(`${SECRET_AAD_PREFIXES[scope]}:${ownerId}`) as Uint8Array<ArrayBuffer>;
}

function cipherParams(iv: Uint8Array<ArrayBuffer>, scope: SecretScope, ownerId: string): AesGcmParams {
  return { name: "AES-GCM", iv, additionalData: aadFor(scope, ownerId), tagLength: SECRET_TAG_BITS };
}

/**
 * Encrypt a secret for one (scope, owner). A fresh 12-byte IV per write, so the
 * same plaintext never produces the same blob twice. `keyring` is optional:
 * pass it and the stored `keyId` is resolved from which slot the key occupies
 * (a key outside both slots is a caller mistake and is refused); omit it and
 * the key is taken at face value as the active slot.
 */
export async function encryptSecret(
  plaintext: string,
  scope: SecretScope,
  ownerId: string,
  key: CryptoKey,
  keyring?: SecretKeyring | undefined
): Promise<EncryptedSecret> {
  const keyId = keyring === undefined ? SECRET_KEY_ID_ACTIVE : keyIdFor(key);
  if (keyId === null) throw new Error(SECRET_DECRYPT_FAILED);
  const iv = crypto.getRandomValues(new Uint8Array(SECRET_IV_BYTES));
  const sealed = await crypto.subtle.encrypt(cipherParams(iv, scope, ownerId), key, encoder.encode(plaintext));
  return { ciphertextB64: toBase64(new Uint8Array(sealed)), ivB64: toBase64(iv), keyId };
}

function isKnownKeyId(keyId: string): keyId is SecretKeyId {
  return keyId === SECRET_KEY_ID_ACTIVE || keyId === SECRET_KEY_ID_PREV;
}

/**
 * Open a stored secret. The ACTIVE key is tried first and PREV is the
 * fallback, because `key_id` is the slot at WRITE time: a rotation demotes the
 * key a row was encrypted under from `active` to `prev`, so a row that named
 * the key that can open it would fail exactly when rotation was supposed to
 * keep it alive. AEAD makes the fallback safe — a wrong key fails
 * authentication, it never returns a wrong plaintext, so trying both slots
 * cannot open a blob the active key did not seal.
 *
 * A wrong key, a tampered ciphertext or IV, a blob copied onto another owner or
 * another scope, an unknown `key_id`, and a row whose only key has been retired
 * are all the SAME fixed-message failure — one message for every class, so
 * nothing about the row leaks through the error and the number of keys tried is
 * not observable. Callers map it to a hard refusal; an undecryptable blob is
 * never a silent "connect with no header".
 */
export async function decryptSecret(row: SecretRow, keyring: SecretKeyring): Promise<string> {
  // An unknown slot is a corrupt or foreign row: refused before any key is
  // tried, so a row is never opened on a guess about what it meant.
  if (!isKnownKeyId(row.keyId)) throw new Error(SECRET_DECRYPT_FAILED);
  let iv: Uint8Array<ArrayBuffer>;
  let ciphertext: Uint8Array<ArrayBuffer>;
  try {
    iv = fromBase64(row.ivB64);
    if (iv.byteLength !== SECRET_IV_BYTES) throw new Error("iv length");
    ciphertext = fromBase64(row.ciphertextB64);
  } catch {
    throw new Error(SECRET_DECRYPT_FAILED);
  }
  const keys = keyring.prev === undefined ? [keyring.active] : [keyring.active, keyring.prev];
  for (const key of keys) {
    try {
      const plaintext = await crypto.subtle.decrypt(cipherParams(iv, row.scope, row.ownerId), key, ciphertext);
      return new TextDecoder().decode(plaintext);
    } catch {
      // Wrong key for this slot, or a tampered blob. Either way the next slot
      // is the only remaining candidate; a total failure is one fixed message.
    }
  }
  throw new Error(SECRET_DECRYPT_FAILED);
}

/**
 * Build the keyring from a RuntimeEnv snapshot. Returns null when no active
 * key is configured — the documented disable switch, so a managed save is
 * refused and secret-less clients keep working. A configured-but-malformed key
 * is an error, never a silent disable: an operator who set the key and got it
 * wrong must be told.
 */
export async function secretsKeyringFromEnv(
  env: Pick<RuntimeEnv, "LXK_SECRETS_MASTER_KEY" | "LXK_SECRETS_MASTER_KEY_PREV"> | null | undefined
): Promise<SecretKeyring | null> {
  const active = typeof env?.LXK_SECRETS_MASTER_KEY === "string" ? env.LXK_SECRETS_MASTER_KEY.trim() : "";
  if (active === "") return null;
  const prev = typeof env?.LXK_SECRETS_MASTER_KEY_PREV === "string" ? env.LXK_SECRETS_MASTER_KEY_PREV.trim() : "";
  return keyringFromKeys(await parseMasterKey(active), prev === "" ? null : await parseMasterKey(prev));
}

/**
 * Whether managed secrets are usable on this server — the one boolean the
 * registry surfaces so a UI never has to hardcode the feature on or off.
 *
 * Read from the SAME env snapshot `secretsKeyringFromEnv` (and therefore the
 * save path) reads, so the rendered capability and the enforced one cannot
 * drift. A key that is configured but malformed reports `true` on purpose: a
 * key IS set, so the managed branch stays reachable and the save path's
 * SECRETS_MASTER_KEY_INVALID 400 is what names the required shape to the
 * operator. Reporting `false` there would blame a missing variable for a wrong
 * value and hide the only diagnosis. Never throws — the capability read must
 * not be able to fail the registry read it rides along on.
 */
export async function secretsManagedEnabled(
  env: Pick<RuntimeEnv, "LXK_SECRETS_MASTER_KEY" | "LXK_SECRETS_MASTER_KEY_PREV"> | null | undefined
): Promise<boolean> {
  const active = typeof env?.LXK_SECRETS_MASTER_KEY === "string" ? env.LXK_SECRETS_MASTER_KEY.trim() : "";
  if (active === "") return false;
  try {
    return (await secretsKeyringFromEnv(env)) !== null;
  } catch {
    return true;
  }
}
