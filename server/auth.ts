import { betterAuth } from "better-auth";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { organization, admin, createAccessControl } from "better-auth/plugins";
import { createAuthEndpoint } from "better-auth/api";
import { z } from "zod";
import { Database } from "bun:sqlite";
import { getEnv, type RuntimeEnv } from "./env";

export const DATABASE_PATH = process.env.DATABASE_PATH || "/app/data/lexa.db";
export const PUBLIC_URL = process.env.LXK_PUBLIC_URL || "http://localhost:3000";

function resolvePublicUrl(env: RuntimeEnv): string {
  return env.LXK_PUBLIC_URL ?? PUBLIC_URL;
}

function resolveDatabasePath(env: RuntimeEnv): string {
  return env.DATABASE_PATH ?? DATABASE_PATH;
}

function resolveTrustedOrigins(env: RuntimeEnv, publicUrl: string): string[] {
  const extra = (env.LXK_TRUSTED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
  return env.LXK_ENV === "dev"
    ? [publicUrl, "http://localhost:5173", ...extra]
    : [publicUrl, ...extra];
}

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

const adminAc = createAccessControl({
  user: ["create", "list", "set-role", "ban", "delete", "set-password", "set-email", "get", "update", "impersonate"],
  session: ["list", "revoke", "delete"],
});

function makeLexaInvitesPlugin(db: Database, getAuth: () => any) {
  return () => ({
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
          const row = db
            .prepare("SELECT id, email, expires_at, accepted_at FROM workspace_invitations WHERE token = ?")
            .get(ctx.body.token) as { id: string; email: string; expires_at: string; accepted_at: string | null } | null;
          if (!row) throw ctx.error("BAD_REQUEST", { code: "INVALID_TOKEN" });
          if (row.accepted_at) throw ctx.error("BAD_REQUEST", { code: "INVALID_TOKEN" });
          if (new Date(row.expires_at).getTime() < Date.now()) throw ctx.error("BAD_REQUEST", { code: "INVALID_TOKEN" });
          const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(row.email) as { id: string } | null;
          if (existing) {
            throw ctx.error("BAD_REQUEST", { code: "USER_EXISTS" });
          }
          await getAuth().api.createUser({
            body: { email: row.email, password: ctx.body.password, name: ctx.body.name, data: { role: "member" } },
          });
          db.prepare("UPDATE workspace_invitations SET accepted_at = datetime('now') WHERE id = ?").run(row.id);
          return ctx.json({ status: true as const, email: row.email });
        },
      ),
    },
  });
}

const authRefMap = new WeakMap<object, { current: any }>();

export function buildAuthOptions(env: RuntimeEnv) {
  const publicUrl = resolvePublicUrl(env);
  const databasePath = resolveDatabasePath(env);
  const trustedOrigins = resolveTrustedOrigins(env, publicUrl);

  // TODO Phase 6: Workers D1 init — env.DB is D1Database; better-auth needs a D1
  // adapter (e.g. kysely/d1). The cast below documents intent and keeps Bun path
  // identical; replace with the real D1 adapter when wiring Phase 6.
  const database = env.DB ? (env.DB as unknown as Database) : new Database(databasePath);

  const authRef: { current: any } = { current: null };

  const invitesPlugin = env.DB
    ? () => ({
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
              throw ctx.error("NOT_IMPLEMENTED" as any, { message: "D1 invites not yet wired — Phase 6" });
            },
          ),
        },
      })
    : makeLexaInvitesPlugin(database as Database, () => authRef.current);

  const options = {
    baseURL: publicUrl,
    trustedOrigins,
    database,
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
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
      additionalFields: { role: { type: "string" as const, required: false } },
    },
    plugins: [
      invitesPlugin(),
      organization({
        creatorRole: "owner",
        allowUserToCreateOrganization: (user) => (user as { role?: string }).role === "superadmin",
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
    advanced: { useSecureCookies: publicUrl.startsWith("https"), cookieCache: { enabled: false } },
  };

  authRefMap.set(options, authRef);
  return options;
}

function createAuthInstance(env: RuntimeEnv) {
  const opts = buildAuthOptions(env);
  const instance = betterAuth(opts);
  const ref = authRefMap.get(opts);
  if (ref) ref.current = instance;
  return instance;
}

export const auth = createAuthInstance(getEnv());

export interface LexaAuth {
  env: RuntimeEnv;
  databasePath: string;
  publicUrl: string;
  trustedOrigins: string[];
  authIpLimiter: typeof authIpLimiter;
  loginLimiter: typeof loginLimiter;
  handler: (req: Request) => Promise<Response>;
  auth: unknown;
}

export function createAuth(env: RuntimeEnv): LexaAuth {
  const publicUrl = resolvePublicUrl(env);
  const databasePath = resolveDatabasePath(env);
  const trustedOrigins = resolveTrustedOrigins(env, publicUrl);
  const instance = createAuthInstance(env);
  return {
    env,
    databasePath,
    publicUrl,
    trustedOrigins,
    authIpLimiter,
    loginLimiter,
    handler: instance.handler as unknown as LexaAuth["handler"],
    auth: instance,
  };
}
