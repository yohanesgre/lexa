// Pure Web Crypto helpers for GitHub App auth — no Effect/DB imports so this
// module is testable outside the bun runtime.

import { createPrivateKey } from "node:crypto";

const base64Url = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

export function createAppJwt(appId: string, privateKeyPem: string, nowSeconds?: number): Promise<string> {
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat: now - 60, exp: now + 540, iss: appId };
  const signingInput = `${base64Url(new TextEncoder().encode(JSON.stringify(header)))}.${base64Url(
    new TextEncoder().encode(JSON.stringify(payload))
  )}`;
  // GitHub App keys are PKCS#1 ("BEGIN RSA PRIVATE KEY"); Web Crypto's
  // importKey("pkcs8") only accepts PKCS#8 — normalize via node:crypto.
  const der = createPrivateKey(privateKeyPem).export({ type: "pkcs8", format: "der" });
  return crypto.subtle
    .importKey(
      "pkcs8",
      der,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"]
    )
    .then((key) => crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput)))
    .then((sig) => `${signingInput}.${base64Url(new Uint8Array(sig))}`);
}

// HMAC-SHA-256 over the RAW body, hex-compared against "sha256=..." with a
// constant-time comparison. Runs before any JSON parsing (route-level).
export async function verifyWebhookSignature(
  rawBody: ArrayBuffer,
  signatureHeader: string | null,
  secret: string
): Promise<boolean> {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;
  const expected = signatureHeader.slice("sha256=".length).toLowerCase();
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, rawBody);
  const actual = Buffer.from(sig).toString("hex");
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}
