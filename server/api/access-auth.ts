import { createPublicKey, verify } from "node:crypto";

interface AccessJwk {
  kid?: string;
  kty?: string;
  use?: string;
  alg?: string;
  n?: string;
  e?: string;
}

interface CachedJwks {
  keys: AccessJwk[];
  fetchedAt: number;
  ttlMs: number;
}

const JWKS_TTL_MS = 60 * 60 * 1000;
const JWKS_CACHE_MAX = 10;
const JWKS_FETCH_TIMEOUT_MS = 10_000;
const jwksCache = new Map<string, CachedJwks>();

function base64urlDecode(input: string): Buffer {
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  return Buffer.from(b64 + pad, "base64");
}

// The iss claim is attacker-controlled until the signature verifies, so the
// JWKS fetch must be pinned to Cloudflare's domains — anything else is a
// blind SSRF primitive. https-only, exact-or-subdomain cloudflareaccess.com.
function isAllowedJwksIssuer(iss: string): boolean {
  let url: URL;
  try {
    url = new URL(iss);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  return host === "cloudflareaccess.com" || host.endsWith(".cloudflareaccess.com");
}

async function fetchJwks(iss: string): Promise<AccessJwk[] | null> {
  if (!isAllowedJwksIssuer(iss)) return null;

  const cached = jwksCache.get(iss);
  if (cached && Date.now() - cached.fetchedAt < cached.ttlMs) return cached.keys;

  let res: Response;
  try {
    res = await fetch(`${iss}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(JWKS_FETCH_TIMEOUT_MS) });
  } catch {
    return null;
  }
  if (!res.ok) return null;

  let data: { keys?: unknown };
  try {
    data = (await res.json()) as { keys?: unknown };
  } catch {
    return null;
  }
  if (!Array.isArray(data.keys)) return null;

  let ttlMs = JWKS_TTL_MS;
  const cacheControl = res.headers.get("cache-control");
  const maxAge = cacheControl ? /max-age=(\d+)/.exec(cacheControl)?.[1] : null;
  if (maxAge) ttlMs = Math.min(JWKS_TTL_MS, Number(maxAge) * 1000);

  const keys = data.keys as AccessJwk[];
  jwksCache.set(iss, { keys, fetchedAt: Date.now(), ttlMs });
  if (jwksCache.size > JWKS_CACHE_MAX) {
    const oldest = jwksCache.keys().next().value;
    if (oldest !== undefined) jwksCache.delete(oldest);
  }
  return keys;
}

// Verify the Cf-Access-Jwt-Assertion header (RS256, CF JWKS from the JWT iss
// claim), returning the identity claims (email, name) or null. Opt-in via
// LXK_ACCESS_AUD: when unset this returns null and callers keep trusting the
// Cf-Access-* headers as-is.
export async function verifyAccessAssertion(req: Request): Promise<{ email: string; name: string } | null> {
  const aud = process.env.LXK_ACCESS_AUD;
  if (!aud) return null;

  const assertion = req.headers.get("Cf-Access-Jwt-Assertion");
  if (!assertion) return null;

  const parts = assertion.split(".");
  if (parts.length !== 3) return null;
  const [headerPart, payloadPart, signaturePart] = parts;

  let header: { kid?: string; alg?: string };
  let payload: { iss?: string; exp?: number; nbf?: number; aud?: string; email?: string; name?: string };
  try {
    header = JSON.parse(base64urlDecode(headerPart).toString("utf8")) as { kid?: string; alg?: string };
    payload = JSON.parse(base64urlDecode(payloadPart).toString("utf8")) as {
      iss?: string;
      exp?: number;
      nbf?: number;
      aud?: string;
      email?: string;
      name?: string;
    };
  } catch {
    return null;
  }

  if (!header.kid || header.alg !== "RS256" || !payload.iss) return null;

  const keys = await fetchJwks(payload.iss);
  if (!keys) return null;
  const jwk = keys.find((k) => k.kid === header.kid && k.kty === "RSA" && k.use === "sig" && k.alg === "RS256" && k.n && k.e);
  if (!jwk) return null;

  try {
    const publicKey = createPublicKey({ key: { kty: "RSA", n: jwk.n!, e: jwk.e! } as JsonWebKey, format: "jwk" });
    const data = Buffer.from(`${headerPart}.${payloadPart}`, "utf8");
    const signature = base64urlDecode(signaturePart);
    if (!verify("RSA-SHA256", data, publicKey, signature)) return null;
  } catch {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp <= now) return null;
  if (typeof payload.nbf === "number" && payload.nbf > now + 60) return null;
  if (payload.aud !== aud) return null;
  if (!payload.email) return null;

  return { email: payload.email, name: payload.name || payload.email.split("@")[0] };
}
