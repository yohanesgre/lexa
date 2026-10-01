// Internal HMAC auth between the Workers assistant gate and the Durable Object
// (ADR-0003 §B.2, decision D6). Pure module — WebCrypto only, no Effect, no
// IO, so it is unit-testable on Bun, Node, workerd, and inside the DO.
//
// Key derivation: `HMAC-SHA-256(masterSecret, "lexa-internal-v1")` produces the
// 32-byte signing key. Both sides derive it from `LXK_SECRETS_MASTER_KEY`; no
// new secret is introduced, and the Workers assistant therefore requires the
// master key (surfaced as `assistant:false` by /api/capabilities when absent).
//
// Header value: `v1:<unix-seconds>:<base64url-hmac>`. The HMAC covers the
// version, the timestamp, and the identity triple, so a tampered
// actor/project/thread header invalidates the signature.

export const INTERNAL_AUTH_HEADER = "X-Lexa-Internal";
export const INTERNAL_AUTH_ACTOR_HEADER = "X-Lexa-Actor-UserId";
export const INTERNAL_AUTH_PROJECT_HEADER = "X-Lexa-Project-Id";
export const INTERNAL_AUTH_THREAD_HEADER = "X-Lexa-Thread-Key";

export const INTERNAL_AUTH_VERSION = "v1";
export const INTERNAL_AUTH_CONTEXT = "lexa-internal-v1";
export const INTERNAL_AUTH_MAX_SKEW_SECONDS = 120;

/** Prefix shared by every header the gate strips before forwarding to the DO. */
export const X_LEXA_HEADER_PREFIX = "x-lexa-";

export interface InternalAuthIdentity {
  actorUserId: string;
  projectId: string;
  threadKey: string;
}

export interface InternalAuthVerifyOptions {
  nowMs?: number;
  maxSkewSeconds?: number;
}

const encoder = new TextEncoder();

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const pad = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  const binary = atob(normalized + pad);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function importHmacKey(raw: BufferSource, usages: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, usages);
}

async function deriveSigningKey(masterSecret: string): Promise<CryptoKey> {
  const master = await importHmacKey(encoder.encode(masterSecret), ["sign"]);
  const derived = await crypto.subtle.sign("HMAC", master, encoder.encode(INTERNAL_AUTH_CONTEXT));
  return importHmacKey(new Uint8Array(derived), ["sign", "verify"]);
}

function signaturePayload(identity: InternalAuthIdentity, timestamp: number): Uint8Array<ArrayBuffer> {
  return encoder.encode(
    JSON.stringify([INTERNAL_AUTH_VERSION, timestamp, identity.actorUserId, identity.projectId, identity.threadKey])
  );
}

/** Mint the `X-Lexa-Internal` header value for an identity. */
export async function signInternalAuth(
  masterSecret: string,
  identity: InternalAuthIdentity,
  nowMs: number = Date.now()
): Promise<string> {
  const timestamp = Math.floor(nowMs / 1000);
  const key = await deriveSigningKey(masterSecret);
  const signature = await crypto.subtle.sign("HMAC", key, signaturePayload(identity, timestamp));
  return `${INTERNAL_AUTH_VERSION}:${timestamp}:${base64UrlEncode(new Uint8Array(signature))}`;
}

/**
 * Verify an `X-Lexa-Internal` value against an identity. Returns false for a
 * missing/malformed header, a stale timestamp (> max skew), or a signature
 * that does not cover the supplied identity.
 */
export async function verifyInternalAuth(
  masterSecret: string,
  headerValue: string | null | undefined,
  identity: InternalAuthIdentity,
  options: InternalAuthVerifyOptions = {}
): Promise<boolean> {
  if (typeof headerValue !== "string" || headerValue.length === 0) return false;
  const parts = headerValue.split(":");
  if (parts.length !== 3) return false;
  const [version, timestampRaw, signatureRaw] = parts as [string, string, string];
  if (version !== INTERNAL_AUTH_VERSION) return false;
  const timestamp = Number(timestampRaw);
  if (!Number.isInteger(timestamp) || timestamp <= 0) return false;
  const nowSeconds = Math.floor((options.nowMs ?? Date.now()) / 1000);
  const maxSkewSeconds = options.maxSkewSeconds ?? INTERNAL_AUTH_MAX_SKEW_SECONDS;
  if (Math.abs(nowSeconds - timestamp) > maxSkewSeconds) return false;
  let signature: Uint8Array<ArrayBuffer>;
  try {
    signature = base64UrlDecode(signatureRaw);
  } catch {
    return false;
  }
  const key = await deriveSigningKey(masterSecret);
  try {
    return await crypto.subtle.verify("HMAC", key, signature, signaturePayload(identity, timestamp));
  } catch {
    return false;
  }
}
