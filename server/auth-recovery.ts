// Workers self-service password recovery: the public request path above the
// native Better Auth handler. It owns the uniform acknowledgement, the strict
// rolling D1 admission, origin/body/IP boundaries, and the request-lifetime
// job that re-checks eligibility, issues the native 30-minute token, and
// sends the fixed email. Native /request-password-reset HTTP therefore has no
// unprotected bypass; /reset-password stays the single consume path.

import { Effect, Either } from "effect";
import { queryFirst, run, type DbDriver } from "./db/db";
import { resolvePublicUrl, resolveTrustedOrigins, resolveTrustedProxyCidrs, type RuntimeEnv } from "./env";
import { resolveClientIp } from "./api/rate-limit";
import { emailDeliveryConfigured, passwordResetTemplate, sendEmail } from "./services/email.service";

export const RECOVERY_ACK_MESSAGE = "If an active account exists for this email, you’ll receive a password reset link.";

const ADDRESS_MINUTE_LIMIT = 1;
const ADDRESS_HOUR_LIMIT = 5;
const IP_WINDOW_LIMIT = 10;
const ADDRESS_MINUTE_SEC = 60;
const ADDRESS_HOUR_SEC = 3600;
const IP_WINDOW_SEC = 600;
export const RECOVERY_ROW_RETENTION_SEC = ADDRESS_HOUR_SEC;

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

const RESPONSE_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
} as const;

function json(data: unknown, status = 200, extra?: Record<string, string>): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...RESPONSE_HEADERS, ...extra } });
}

function errorJson(code: string, message: string, status: number, extra?: Record<string, string>): Response {
  return json({ error: { code, message } }, status, extra);
}

function safeErrorCategory(error: unknown): string {
  if (!(error instanceof Error)) return "unknown";
  if (!("code" in error)) return /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name) ? error.name : "unknown";
  const code = error.code;
  return typeof code === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(code) ? code : "unknown";
}

/** SHA-256 hex of a normalized subject. No plaintext address/IP is stored. */
export async function hashRecoverySubject(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface RecoveryAdmission {
  admitted: boolean;
  retryAfterSec: number;
}

// One statement is the whole admission decision: no read-then-write window, so
// concurrent Worker/driver instances cannot both pass a boundary or partially
// consume a budget. Rejected requests write nothing, so retries cannot extend
// the lockout.
const ADMISSION_SQL = `INSERT INTO recovery_requests (id, address_hash, ip_hash, requested_at)
SELECT ?, ?, ?, ?
WHERE (SELECT COUNT(*) FROM recovery_requests WHERE address_hash = ? AND requested_at > ?) < ${ADDRESS_MINUTE_LIMIT}
  AND (SELECT COUNT(*) FROM recovery_requests WHERE address_hash = ? AND requested_at > ?) < ${ADDRESS_HOUR_LIMIT}
  AND (SELECT COUNT(*) FROM recovery_requests WHERE ip_hash = ? AND requested_at > ?) < ${IP_WINDOW_LIMIT}`;

const RETRY_SQL = `SELECT
  (SELECT COUNT(*) FROM recovery_requests WHERE address_hash = ? AND requested_at > ?) AS minute_count,
  (SELECT MIN(requested_at) FROM recovery_requests WHERE address_hash = ? AND requested_at > ?) AS minute_oldest,
  (SELECT COUNT(*) FROM recovery_requests WHERE address_hash = ? AND requested_at > ?) AS hour_count,
  (SELECT MIN(requested_at) FROM recovery_requests WHERE address_hash = ? AND requested_at > ?) AS hour_oldest,
  (SELECT COUNT(*) FROM recovery_requests WHERE ip_hash = ? AND requested_at > ?) AS ip_count,
  (SELECT MIN(requested_at) FROM recovery_requests WHERE ip_hash = ? AND requested_at > ?) AS ip_oldest`;

interface RetryRow {
  minute_count: number;
  minute_oldest: number | null;
  hour_count: number;
  hour_oldest: number | null;
  ip_count: number;
  ip_oldest: number | null;
}

function retryAfterFrom(row: RetryRow, now: number): number {
  const waits: number[] = [];
  if (row.minute_count >= ADDRESS_MINUTE_LIMIT && row.minute_oldest !== null) {
    waits.push(row.minute_oldest + ADDRESS_MINUTE_SEC - now);
  }
  if (row.hour_count >= ADDRESS_HOUR_LIMIT && row.hour_oldest !== null) {
    waits.push(row.hour_oldest + ADDRESS_HOUR_SEC - now);
  }
  if (row.ip_count >= IP_WINDOW_LIMIT && row.ip_oldest !== null) {
    waits.push(row.ip_oldest + IP_WINDOW_SEC - now);
  }
  const wait = waits.length > 0 ? Math.max(...waits) : ADDRESS_MINUTE_SEC;
  return Math.max(1, Math.ceil(wait));
}

export function admitRecoveryRequest(
  driver: DbDriver,
  input: { addressHash: string; ipHash: string; now: number; id: string }
) {
  return Effect.gen(function* () {
    const changes = yield* run(
      driver,
      ADMISSION_SQL,
      input.id,
      input.addressHash,
      input.ipHash,
      input.now,
      input.addressHash,
      input.now - ADDRESS_MINUTE_SEC,
      input.addressHash,
      input.now - ADDRESS_HOUR_SEC,
      input.ipHash,
      input.now - IP_WINDOW_SEC
    );
    if (changes > 0) return { admitted: true, retryAfterSec: 0 } satisfies RecoveryAdmission;
    const row = yield* queryFirst<RetryRow>(
      driver,
      RETRY_SQL,
      input.addressHash,
      input.now - ADDRESS_MINUTE_SEC,
      input.addressHash,
      input.now - ADDRESS_MINUTE_SEC,
      input.addressHash,
      input.now - ADDRESS_HOUR_SEC,
      input.addressHash,
      input.now - ADDRESS_HOUR_SEC,
      input.ipHash,
      input.now - IP_WINDOW_SEC,
      input.ipHash,
      input.now - IP_WINDOW_SEC
    );
    return { admitted: false, retryAfterSec: retryAfterFrom(row, input.now) } satisfies RecoveryAdmission;
  });
}

export interface RecoveryAuthApi {
  api: {
    requestPasswordReset: (opts: { body: { email: string } }) => Promise<unknown>;
  };
}

interface WaitUntilContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface RecoveryRequestDeps {
  env: RuntimeEnv;
  auth: RecoveryAuthApi;
  driver: DbDriver;
  ctx: WaitUntilContext;
  maxBodyBytes: number;
}

async function readBody(req: Request, maxBytes: number): Promise<ArrayBuffer | null> {
  const reader = req.body?.getReader();
  if (!reader) return new ArrayBuffer(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) return null;
      chunks.push(value);
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer as ArrayBuffer;
}

function originAllowed(req: Request, env: RuntimeEnv): boolean {
  const origin = req.headers.get("origin");
  if (origin === null || origin === "") return true;
  const normalized = origin.replace(/\/+$/, "");
  const allowed = new Set(resolveTrustedOrigins(env).map((o) => o.replace(/\/+$/, "")));
  return allowed.has(normalized);
}

async function findActiveAccount(driver: DbDriver, email: string): Promise<boolean> {
  const row = await Effect.runPromise(
    queryFirst<{ id: string }>(driver, "SELECT id FROM users WHERE lower(email) = ? AND banned = 0", email).pipe(
      Effect.catchTag("RowNotFound", () => Effect.succeed(null))
    )
  );
  return row !== null;
}

/**
 * Public request path. Responds before recipient lookup or provider wait; the
 * entire eligibility → native issuance → send chain rides ctx.waitUntil.
 */
export async function handlePasswordRecoveryRequest(req: Request, deps: RecoveryRequestDeps): Promise<Response> {
  if (!originAllowed(req, deps.env)) {
    return errorJson("FORBIDDEN", "Origin not allowed", 403);
  }

  const body = await readBody(req, deps.maxBodyBytes);
  if (body === null) {
    console.warn("[Recovery] body too large");
    return errorJson("BODY_TOO_LARGE", "Request body too large", 413);
  }
  let email: string;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
    if (!("email" in parsed) || typeof parsed.email !== "string") throw new Error("missing email");
    email = parsed.email.trim().toLowerCase();
  } catch {
    return errorJson("INVALID_INPUT", "Enter a valid email address.", 400);
  }
  if (email.length > 254 || !EMAIL_RE.test(email)) {
    return errorJson("INVALID_INPUT", "Enter a valid email address.", 400);
  }

  if (!emailDeliveryConfigured(deps.env)) {
    return errorJson("RESET_PASSWORD_DISABLED", "Password recovery is not available", 400);
  }

  const ip = resolveClientIp("", req.headers.get("cf-connecting-ip"), resolveTrustedProxyCidrs(deps.env));
  const now = Math.floor(Date.now() / 1000);
  const [addressHash, ipHash] = await Promise.all([hashRecoverySubject(email), hashRecoverySubject(ip)]);
  const admissionResult = await Effect.runPromise(
    Effect.either(admitRecoveryRequest(deps.driver, { addressHash, ipHash, now, id: crypto.randomUUID() }))
  );
  if (Either.isLeft(admissionResult)) {
    const tag = admissionResult.left._tag;
    console.warn(`[Recovery] admission unavailable category=${/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(tag) ? tag : "unknown"}`);
    return errorJson("INTERNAL", "Internal error", 500);
  }
  const admission = admissionResult.right;
  if (!admission.admitted) {
    return errorJson("RATE_LIMITED", "Too many requests — try again later", 429, {
      "Retry-After": String(admission.retryAfterSec),
    });
  }

  deps.ctx.waitUntil(
    (async () => {
      try {
        if (!(await findActiveAccount(deps.driver, email))) return;
        await deps.auth.api.requestPasswordReset({ body: { email } });
      } catch (error) {
        console.warn(`[Recovery] job failed category=${safeErrorCategory(error)}`);
      }
    })()
  );

  return json({ status: true, message: RECOVERY_ACK_MESSAGE });
}

export interface ResetEmailAdapter {
  internalAdapter: {
    findUserById: (id: string) => Promise<{ id: string; email: string; banned?: boolean | number | null } | null>;
    findVerificationValue: (identifier: string) => Promise<{ expiresAt: Date | string } | null>;
  };
}

/**
 * Native sendResetPassword target. Runs immediately before submission: it
 * re-reads the account (a deactivation racing issuance must not receive mail)
 * and reads the issued verification row's own expiresAt, so the message never
 * recomputes a lifetime. Outcomes stay in logs; the public response is already
 * sent and never depends on this path.
 */
export async function deliverSelfServiceReset(
  env: RuntimeEnv,
  input: { userId: string; userEmail: string; token: string },
  getAdapter: () => Promise<ResetEmailAdapter | null>
): Promise<void> {
  try {
    const adapter = await getAdapter();
    if (!adapter) return;
    const user = await adapter.internalAdapter.findUserById(input.userId);
    if (!user || user.banned === true || user.banned === 1) return;
    if (user.email.toLowerCase() !== input.userEmail.toLowerCase()) return;
    const verification = await adapter.internalAdapter.findVerificationValue(`reset-password:${input.token}`);
    if (!verification) return;
    const expiresAt = verification.expiresAt instanceof Date ? verification.expiresAt.toISOString() : verification.expiresAt;
    const origin = resolvePublicUrl(env).replace(/\/+$/, "");
    const link = `${origin}/set-password?token=${encodeURIComponent(input.token)}`;
    await sendEmail(env, passwordResetTemplate({ to: user.email, origin, link, expiresAt }));
  } catch (error) {
    console.warn(`[Recovery] send failed category=${safeErrorCategory(error)}`);
  }
}
