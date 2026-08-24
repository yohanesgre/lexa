import { betterAuth } from "better-auth";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { organization, admin, createAccessControl } from "better-auth/plugins";
import { createAuthEndpoint } from "better-auth/api";
import { z } from "zod";
import { Database } from "bun:sqlite";

export const DATABASE_PATH = process.env.DATABASE_PATH || "/app/data/lexa.db";
export const PUBLIC_URL = process.env.LXK_PUBLIC_URL || "http://localhost:3000";

// Dev-only trusted origin: vite dev (http://localhost:5173) proxies /api and
// sends the Origin header on cookie-bearing auth POSTs (sign-out,
// change-password, reset-password) — without this they 403 INVALID_ORIGIN.
// LXK_TRUSTED_ORIGINS (comma-separated) adds LAN/Tailscale origins so plain-HTTP
// sign-ins from other devices pass the origin check,
// e.g. http://192.168.0.131:3000,http://machine-name.tailnet-name.ts.net:3000
const extraTrustedOrigins = (process.env.LXK_TRUSTED_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter((o) => o.length > 0);
const TRUSTED_ORIGINS =
  process.env.LXK_ENV === "dev"
    ? [PUBLIC_URL, "http://localhost:5173", ...extraTrustedOrigins]
    : [PUBLIC_URL, ...extraTrustedOrigins];

// Per-IP throttle for the keyless /api/auth/* surface (the per-email login
// budget only guards one email; an attacker can otherwise spam scrypt-hash
// sign-in attempts from one IP against many emails). 120 req/min burst,
// in-memory — single server process, like loginLimiter.
const authIpBuckets = new Map<string, { count: number; windowStart: number }>();
const AUTH_IP_LIMIT = 120;
const AUTH_IP_WINDOW_MS = 60_000;
export function authIpLimiter(ip: string): { ok: boolean; retryAfterSec: number } {
  const now = Date.now();
  const bucket = authIpBuckets.get(ip);
  if (!bucket || now - bucket.windowStart >= AUTH_IP_WINDOW_MS) {
    authIpBuckets.set(ip, { count: 1, windowStart: now });
    return { ok: true, retryAfterSec: 0 };
  }
  bucket.count++;
  if (bucket.count > AUTH_IP_LIMIT) {
    return { ok: false, retryAfterSec: Math.ceil((bucket.windowStart + AUTH_IP_WINDOW_MS - now) / 1000) };
  }
  return { ok: true, retryAfterSec: 0 };
}

// ── Login rate limit (R17) ──
// Better Auth 1.6.27 has no bundled rateLimit plugin (DECLARED DEVIATION) —
// this is a small in-process limiter (memory storage; fine for the single
// server process). Budget: 5 failed attempts per email per 60s, then a
// 15-minute lockout. A successful login resets the email's budget. Wired in
// server/entry.ts around POST /api/auth/sign-in/email only — the existing
// per-IP /api limiter is untouched.
const LOGIN_WINDOW_MS = 60_000;
const LOGIN_MAX_FAILURES = 5;
const LOGIN_LOCKOUT_MS = 15 * 60_000;

interface LoginBucket {
  failures: number;
  windowStart: number;
  lockedUntil: number;
}

const loginBuckets = new Map<string, LoginBucket>();

export const loginLimiter = {
  check(email: string): { ok: boolean; retryAfterSec: number } {
    const now = Date.now();
    const bucket = loginBuckets.get(email.toLowerCase());
    if (!bucket) return { ok: true, retryAfterSec: 0 };
    if (bucket.lockedUntil > now) {
      return { ok: false, retryAfterSec: Math.ceil((bucket.lockedUntil - now) / 1000) };
    }
    if (now - bucket.windowStart > LOGIN_WINDOW_MS) {
      loginBuckets.delete(email.toLowerCase());
      return { ok: true, retryAfterSec: 0 };
    }
    return { ok: true, retryAfterSec: 0 };
  },
  recordFailure(email: string): void {
    const key = email.toLowerCase();
    const now = Date.now();
    const bucket = loginBuckets.get(key);
    if (!bucket || now - bucket.windowStart > LOGIN_WINDOW_MS) {
      loginBuckets.set(key, { failures: 1, windowStart: now, lockedUntil: 0 });
      return;
    }
    bucket.failures += 1;
    if (bucket.failures >= LOGIN_MAX_FAILURES) {
      bucket.lockedUntil = now + LOGIN_LOCKOUT_MS;
    }
  },
  recordSuccess(email: string): void {
    loginBuckets.delete(email.toLowerCase());
  },
};

// Admin-plugin role surface (server-side auth.api.admin.*; HTTP
// /api/auth/admin/* is gated on the superadmin role). access-control
// statements mirror the built-in defaults (user CRUD + session ops).
const adminAc = createAccessControl({
  user: ["create", "list", "set-role", "ban", "delete", "set-password", "set-email", "get", "update", "impersonate"],
  session: ["list", "revoke", "delete"],
});

const authDb = new Database(DATABASE_PATH);

// Workspace-invite acceptance (R3/R6): superadmin mints a link-based invite
// (workspace_invitations row, 7d expiry, revocable while pending); the invited
// person opens /invite?token=… and sets name+password. This endpoint validates
// the token, creates the member account (credential password), and stamps
// accepted_at. Keyless + session-less by nature — the token is the auth.
const lexaInvitesPlugin = () => ({
  id: "lexa-invites",
  endpoints: {
    acceptInvite: createAuthEndpoint(
      "/invite/accept",
      {
        method: "POST",
        body: z.object({
          token: z.string(),
          name: z.string().min(1),
          password: z.string().min(8),
        }),
      },
      async (ctx) => {
        const row = authDb
          .prepare("SELECT id, email, expires_at, accepted_at FROM workspace_invitations WHERE token = ?")
          .get(ctx.body.token) as { id: string; email: string; expires_at: string; accepted_at: string | null } | null;
        if (!row) throw ctx.error("BAD_REQUEST", { code: "INVALID_TOKEN" });
        if (row.accepted_at) throw ctx.error("BAD_REQUEST", { code: "INVALID_TOKEN" });
        if (new Date(row.expires_at).getTime() < Date.now()) throw ctx.error("BAD_REQUEST", { code: "INVALID_TOKEN" });
        const existing = authDb.prepare("SELECT id FROM users WHERE email = ?").get(row.email) as { id: string } | null;
        if (existing) {
          // Two-step (R11): the account exists but may have no password (legacy
          // users) — the invite cannot set it. Do NOT stamp accepted_at: the
          // pending invite then blocks re-issue and forces the right path — a
          // superadmin-issued set-password link. The FE invite page shows the
          // "account exists — contact an admin" state.
          throw ctx.error("BAD_REQUEST", { code: "USER_EXISTS" });
        }
        await auth.api.createUser({
          body: { email: row.email, password: ctx.body.password, name: ctx.body.name, data: { role: "member" } },
        });
        authDb.prepare("UPDATE workspace_invitations SET accepted_at = datetime('now') WHERE id = ?").run(row.id);
        return ctx.json({ status: true as const, email: row.email });
      },
    ),
  },
});

// In-process Better Auth instance, mounted at /api/auth/* BEFORE the API-key
// middleware (see server/entry.ts). Email/password only — no social providers.
// Teams = Better Auth organizations (org plugin); tanstackStartCookies MUST be
// the last plugin (better-auth#8059). Superadmin is env-only (LXK_ADMIN_EMAILS),
// never derived from a provider — sign-up is disabled (R3: provisioning only).
// Team creation/deletion are closed on the org HTTP surface (R6: superadmin
// only via /api/teams) — creation is allow-listed, deletion is disabled.
export const auth = betterAuth({
  baseURL: PUBLIC_URL,
  database: authDb,
  emailAndPassword: {
    enabled: true,
    disableSignUp: true,
    // R11: setting a password through a reset/set-password link revokes all
    // the user's sessions (forgotten/lost-password paths invalidate the past).
    revokeSessionsOnPasswordReset: true,
  },
  user: {
    modelName: "users",
    fields: {
      name: "name",
      email: "email",
      image: "image",
      emailVerified: "email_verified",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
    additionalFields: { role: { type: "string", required: false } },
  },
  plugins: [
    lexaInvitesPlugin(),
    organization({
      creatorRole: "owner",
      allowUserToCreateOrganization: (user) => user.role === "superadmin",
      disableOrganizationDeletion: true,
    }),
    admin({
      defaultRole: "member",
      adminRoles: ["superadmin"],
      roles: {
        superadmin: adminAc.newRole({
          user: ["create", "list", "set-role", "ban", "delete", "set-password", "set-email", "get", "update"],
          session: ["list", "revoke", "delete"],
        }),
        member: adminAc.newRole({
          user: [],
          session: ["list", "revoke"],
        }),
      },
    }),
    tanstackStartCookies(),
  ],
  advanced: { useSecureCookies: PUBLIC_URL.startsWith("https") },
  trustedOrigins: TRUSTED_ORIGINS,
});
