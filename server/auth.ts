import { betterAuth } from "better-auth";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { organization, admin, createAccessControl } from "better-auth/plugins";
import { createAuthEndpoint } from "better-auth/api";
import { Effect } from "effect";
import { z } from "zod";
import type { D1Database } from "@cloudflare/workers-types";
import { Database } from "bun:sqlite";
import { queryFirst, run, type DbDriver } from "./db/db";
import { createD1Driver } from "./db/drivers/d1";
import { d1DatabaseToD1Like } from "./api/workers-ports";
import { getEnv, resolveDatabasePath, resolvePublicUrl, resolveTrustedOrigins, type RuntimeEnv } from "./env";

// Bun-host compat aliases. Resolved once from the process env snapshot via
// server/env.ts (no direct `process.env` reads here). Workers code MUST NOT
// import these — the per-request path resolves the same defaults from the
// workerd `env` binding via `createAuth(env)` + the resolve* helpers in
// server/env.ts.
export const DATABASE_PATH = resolveDatabasePath(getEnv());
export const PUBLIC_URL = resolvePublicUrl(getEnv());

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

type LexaAuthApi = { api: { createUser: (opts: { body: { email: string; password: string; name: string; data: { role: string } } }) => Promise<unknown> } };

// D1-backed invites plugin (Workers). Same contract as the Bun plugin
// below — SELECTs + accepted_at stamp over the async driver, user
// creation through the D1-wired better-auth instance. The D1 binding is
// adapted with the same workers-ports helper the entry uses, so there is
// exactly one D1Like adaptation.
function makeLexaInvitesPluginD1(d1: D1Database, getAuth: () => LexaAuthApi) {
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
          const driver = createD1Driver(d1DatabaseToD1Like(d1));
          const row = await Effect.runPromise(
            queryFirst<{ id: string; email: string; expires_at: string; accepted_at: string | null }>(
              driver,
              "SELECT id, email, expires_at, accepted_at FROM workspace_invitations WHERE token = ?",
              ctx.body.token
            ).pipe(Effect.catchTag("RowNotFound", () => Effect.succeed(null)))
          );
          if (!row) throw ctx.error("BAD_REQUEST", { code: "INVALID_TOKEN" });
          if (row.accepted_at) throw ctx.error("BAD_REQUEST", { code: "INVALID_TOKEN" });
          if (new Date(row.expires_at).getTime() < Date.now()) throw ctx.error("BAD_REQUEST", { code: "INVALID_TOKEN" });
          const existing = await Effect.runPromise(
            queryFirst<{ id: string }>(driver, "SELECT id FROM users WHERE email = ?", row.email).pipe(
              Effect.catchTag("RowNotFound", () => Effect.succeed(null))
            )
          );
          if (existing) {
            throw ctx.error("BAD_REQUEST", { code: "USER_EXISTS" });
          }
          await getAuth().api.createUser({
            body: { email: row.email, password: ctx.body.password, name: ctx.body.name, data: { role: "member" } },
          });
          await Effect.runPromise(
            run(driver, "UPDATE workspace_invitations SET accepted_at = datetime('now') WHERE id = ?", row.id)
          );
          return ctx.json({ status: true as const, email: row.email });
        },
      ),
    },
  });
}
function makeLexaInvitesPlugin(db: Database, getAuth: () => LexaAuthApi) {
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

const authRefMap = new WeakMap<object, { current: unknown }>();

export function buildAuthOptions(env: RuntimeEnv) {
  const publicUrl = resolvePublicUrl(env);
  const databasePath = resolveDatabasePath(env);
  const trustedOrigins = resolveTrustedOrigins(env, publicUrl);

  // Workers D1 (B6b): pass the D1 binding straight through — installed
  // better-auth 1.6.27 auto-detects it (`"batch" in db && "exec" in db &&
  // "prepare" in db` → vendored D1SqliteDialect in
  // @better-auth/kysely-adapter) and drives it with batch()-safe,
  // transaction-free queries. Verified against the installed dist, not
  // just the docs claim. The static bun:sqlite import above serves the
  // Bun singleton path only; the workerd bundle maps it to the throwing
  // shim (never constructed when env.DB is present).
  const database = env.DB ? (env.DB as unknown as Database) : new Database(databasePath);

  const authRef: { current: unknown } = { current: null };

  const invitesPlugin = env.DB
    ? makeLexaInvitesPluginD1(env.DB, () => authRef.current as LexaAuthApi)
    : makeLexaInvitesPlugin(database as Database, () => authRef.current as LexaAuthApi);

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
    // tanstackStartCookies is Bun/Start-SSR only: the real subpath imports
    // Vite-virtual modules unresolvable in a direct workerd bundle (hence
    // the B4 shim), and its only job is mirroring Set-Cookie into Start's
    // server-function store — irrelevant when /api/auth/* is served as raw
    // Responses (core cookie read/write is independent of the plugin).
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
      ...(env.DB ? [] : [tanstackStartCookies()]),
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

type AuthInstance = ReturnType<typeof createAuthInstance>;

let cachedSingleton: AuthInstance | null = null;
function singleton(): AuthInstance {
  if (!cachedSingleton) cachedSingleton = createAuthInstance(getEnv());
  return cachedSingleton;
}

// Bun-host singleton. Lazy on purpose: importing this module must not open a
// database or read env — on Workers `process.env` is undefined and
// `bun:sqlite` does not exist, so any import-time side effect would crash the
// isolate at startup. First property access builds the instance from the
// process env snapshot. Workers code MUST use `createAuth(env)` per request
// instead of this singleton.
export const auth: AuthInstance = new Proxy({} as AuthInstance, {
  get(_target, prop) {
    const instance = singleton() as unknown as Record<PropertyKey, unknown>;
    const value = instance[prop];
    return typeof value === "function" ? (value as (...args: never[]) => unknown).bind(singleton()) : value;
  },
  has(_target, prop) {
    return prop in (singleton() as unknown as object);
  },
});

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
    handler: instance.handler as LexaAuth["handler"],
    auth: instance,
  };
}
