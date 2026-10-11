import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeSignature } from "better-auth/crypto";
import { runMigrations } from "./db/migrate";
import { auth, createAuth, authIpLimiter, authLimiterSizes, loginLimiter, sweepAuthLimiters, handleAuthSurface } from "./auth";
import { capabilities, capabilitiesFromRuntimeEnv, chatAttachmentsEnabled, hasSecretsMasterKey, tasksBulkEnabled } from "./capabilities";
import { getEnv, type RuntimeEnv } from "./env";

const MIGRATIONS = fileURLToPath(new URL("../migrations", import.meta.url));

// better-auth's fixed fallback when no `secret` is configured.
const LIBRARY_DEFAULT_SECRET = "better-auth-secret-12345678901234567890";
const MASTER_KEY = Buffer.from("factory-test-master-key-000000000").toString("base64");
const KEY = Buffer.from("k".repeat(32)).toString("base64");

let dir: string;
let dbPath: string;

const saved: Record<string, string | undefined> = {};
for (const key of ["DATABASE_PATH", "LXK_PUBLIC_URL", "LXK_ENV", "LXK_TRUSTED_ORIGINS"] as const) {
  saved[key] = process.env[key];
}

const baseEnv = (): RuntimeEnv => ({
  DATABASE_PATH: dbPath,
  LXK_PUBLIC_URL: "https://factory.test",
  LXK_ENV: "prod",
  LXK_SECRETS_MASTER_KEY: MASTER_KEY,
});

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "lexa-auth-factory-"));
  dbPath = join(dir, "test.db");
  runMigrations(dbPath, MIGRATIONS);
  // The factory must ignore the ambient process env — pin it to decoys so a
  // regression (reading process.env instead of the argument) fails loudly.
  process.env.DATABASE_PATH = join(dir, "decoy.db");
  process.env.LXK_PUBLIC_URL = "http://process-env-decoy.test";
  process.env.LXK_ENV = "dev";
  delete process.env.LXK_TRUSTED_ORIGINS;
});

afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value !== undefined) process.env[key] = value;
    else delete process.env[key];
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("createAuth(env) per-request factory", () => {
  it("resolves publicUrl/databasePath/trustedOrigins from the passed env, with Bun-host defaults when absent", () => {
    const lexa = createAuth(baseEnv());
    expect(lexa.publicUrl).toBe("https://factory.test");
    expect(lexa.databasePath).toBe(dbPath);
    expect(lexa.trustedOrigins).toEqual(["https://factory.test"]);
    expect(lexa.env.LXK_PUBLIC_URL).toBe("https://factory.test");

    const fallback = createAuth({ DATABASE_PATH: dbPath, LXK_SECRETS_MASTER_KEY: MASTER_KEY });
    expect(fallback.publicUrl).toBe("http://localhost:5173");
    expect(fallback.trustedOrigins).toEqual(["http://localhost:5173"]);

    const dev = createAuth({ ...baseEnv(), LXK_ENV: "dev", LXK_TRUSTED_ORIGINS: "https://extra.test" });
    expect(dev.trustedOrigins).toEqual(["https://factory.test", "http://localhost:5173", "https://extra.test"]);
    const prod = createAuth({ ...baseEnv(), LXK_TRUSTED_ORIGINS: "https://extra.test" });
    expect(prod.trustedOrigins).toEqual(["https://factory.test", "https://extra.test"]);
  });

  it("recreates an isolated handler per env and exposes the shared limiters", () => {
    const a = createAuth({ ...baseEnv(), LXK_PUBLIC_URL: "https://a.test" });
    const b = createAuth({ ...baseEnv(), LXK_PUBLIC_URL: "https://b.test" });
    expect(a.publicUrl).toBe("https://a.test");
    expect(b.publicUrl).toBe("https://b.test");
    expect(a.handler).not.toBe(b.handler);
    expect(typeof a.handler).toBe("function");
    expect(typeof a.authIpLimiter).toBe("function");
    expect(typeof a.loginLimiter.check).toBe("function");
  });
});

describe("session cookie cache (perf/auth-cookie-cache)", () => {
  it("enables cookieCache under session (not advanced) with a 300s maxAge", () => {
    const lexa = createAuth(baseEnv());
    const options = (lexa.auth as {
      options: {
        session: { freshAge?: number; cookieCache?: { enabled?: boolean; maxAge?: number } };
        advanced?: { cookieCache?: unknown };
      };
    }).options;
    // better-auth 1.6.27 reads `options.session.cookieCache`; an
    // `advanced.cookieCache` block is a silent no-op.
    expect(options.session.cookieCache).toEqual({ enabled: true, maxAge: 300 });
    expect(options.session.freshAge).toBe(0);
    expect(options.advanced?.cookieCache).toBeUndefined();
  });
});

describe("auth signing secret (cookieCache forgery closed)", () => {
  const ctxOf = async (lexa: ReturnType<typeof createAuth>) =>
    (lexa.auth as {
      $context: Promise<{
        secret: string;
        authCookies: { sessionToken: { name: string }; sessionData: { name: string } };
      }>;
    }).$context;

  it("derives the secret from LXK_SECRETS_MASTER_KEY and fails closed when missing or blank", async () => {
    const lexa = createAuth(baseEnv());
    const ctx = await ctxOf(lexa);
    expect(ctx.secret).toBe(`lexa-better-auth:${MASTER_KEY}`);
    expect(ctx.secret).not.toBe(LIBRARY_DEFAULT_SECRET);
    expect(() => createAuth({ DATABASE_PATH: dbPath, LXK_PUBLIC_URL: "https://factory.test" })).toThrow(/LXK_SECRETS_MASTER_KEY/);
    expect(() => createAuth({ ...baseEnv(), LXK_SECRETS_MASTER_KEY: "   " })).toThrow(/LXK_SECRETS_MASTER_KEY/);
  });

  it("rejects a session cookie signed with better-auth's library-default secret", async () => {
    const lexa = createAuth(baseEnv());
    const ctx = await ctxOf(lexa);
    const token = "forged-session-token";
    const signature = await makeSignature(token, LIBRARY_DEFAULT_SECRET);
    const session = await (lexa.auth as { api: { getSession: (o: { headers: Headers }) => Promise<unknown> } }).api.getSession({
      headers: new Headers({ cookie: `${ctx.authCookies.sessionToken.name}=${token}.${signature}` }),
    });
    expect(session).toBeNull();
  });
});

describe("Bun-host auth singleton (lazy)", () => {
  it("initializes from the process env snapshot at first use", () => {
    expect(typeof auth.handler).toBe("function");
    expect(auth.api).toBeTruthy();
    expect(typeof auth.api.getSession).toBe("function");
    expect(getEnv().LXK_PUBLIC_URL).toBe("http://process-env-decoy.test");
  });
});

describe("handleAuthSurface", () => {
  it("rejects a body over the cap with 413 before reaching the handler", async () => {
    let called = false;
    const res = await handleAuthSurface(
      new Request("http://auth.test/api/auth/sign-in/email", { method: "POST", body: "x".repeat(64) }),
      { ip: "10.0.0.1", maxBodyBytes: 16, handler: async () => { called = true; return new Response("ok"); } }
    );
    expect(called).toBe(false);
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("BODY_TOO_LARGE");
  });

  it("throttles an exhausted IP and locks an email after repeated 401s", async () => {
    const ip = "10.0.0.2";
    for (let i = 0; i < 120; i++) authIpLimiter(ip);
    expect(authIpLimiter(ip).ok).toBe(false);
    let called = false;
    const res = await handleAuthSurface(
      new Request("http://auth.test/api/auth/sign-out", { method: "POST" }),
      { ip, maxBodyBytes: 1024, handler: async () => { called = true; return new Response("ok"); } }
    );
    expect(called).toBe(false);
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("RATE_LIMITED");

    const email = "throttle@lexa.test";
    let calls = 0;
    const deps = { ip: "10.0.0.3", maxBodyBytes: 1024, handler: async () => { calls += 1; return new Response("", { status: 401 }); } };
    const signIn = () =>
      new Request("http://auth.test/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password: "nope" }),
      });
    for (let i = 0; i < 5; i++) {
      expect((await handleAuthSurface(signIn(), deps)).status).toBe(401);
    }
    expect(loginLimiter.check(email).ok).toBe(false);
    const blocked = await handleAuthSurface(signIn(), deps);
    expect(blocked.status).toBe(429);
    expect(calls).toBe(5);
    expect(((await blocked.json()) as { error: { code: string } }).error.code).toBe("RATE_LIMITED");
    loginLimiter.recordSuccess(email);
  });
});

describe("capabilities (GET /api/capabilities)", () => {
  it("hasSecretsMasterKey requires a non-empty key", () => {
    expect(hasSecretsMasterKey({})).toBe(false);
    expect(hasSecretsMasterKey({ LXK_SECRETS_MASTER_KEY: "" })).toBe(false);
    expect(hasSecretsMasterKey({ LXK_SECRETS_MASTER_KEY: KEY })).toBe(true);
  });

  it("both kill switches are enabled unless set to exactly '1'", () => {
    expect(chatAttachmentsEnabled({})).toBe(true);
    expect(chatAttachmentsEnabled({ LXK_DISABLE_CHAT_ATTACHMENTS: "0" })).toBe(true);
    expect(chatAttachmentsEnabled({ LXK_DISABLE_CHAT_ATTACHMENTS: "true" })).toBe(true);
    expect(chatAttachmentsEnabled({ LXK_DISABLE_CHAT_ATTACHMENTS: "" })).toBe(true);
    expect(chatAttachmentsEnabled({ LXK_DISABLE_CHAT_ATTACHMENTS: "1" })).toBe(false);
    expect(tasksBulkEnabled({})).toBe(true);
    expect(tasksBulkEnabled({ LXK_DISABLE_TASKS_BULK: "0" })).toBe(true);
    expect(tasksBulkEnabled({ LXK_DISABLE_TASKS_BULK: "1" })).toBe(false);
  });

  it("gates assistant on the master key and the rest on their kill switches, per flavor", () => {
    expect(capabilities("bun", {})).toEqual({ assistant: false, flavor: "bun", chatAttachments: false, tasksBulk: true });
    expect(capabilities("bun", { LXK_SECRETS_MASTER_KEY: KEY })).toEqual({ assistant: true, flavor: "bun", chatAttachments: true, tasksBulk: true });
    expect(capabilities("workers", {})).toEqual({ assistant: false, flavor: "workers", chatAttachments: false, tasksBulk: true });
    expect(capabilities("workers", { LXK_SECRETS_MASTER_KEY: KEY, LXK_DISABLE_CHAT_ATTACHMENTS: "1" })).toEqual({
      assistant: true,
      flavor: "workers",
      chatAttachments: false,
      tasksBulk: true,
    });
    expect(capabilities("workers", { LXK_SECRETS_MASTER_KEY: KEY, LXK_DISABLE_TASKS_BULK: "1" })).toEqual({
      assistant: true,
      flavor: "workers",
      chatAttachments: true,
      tasksBulk: false,
    });
    const env = { LXK_SECRETS_MASTER_KEY: KEY } as RuntimeEnv;
    expect(capabilitiesFromRuntimeEnv("workers", env)).toEqual(capabilities("workers", env));
  });
});

describe("sweepAuthLimiters / authLimiterSizes", () => {
  it("reports live bucket counts and drops expired ones", () => {
    authIpLimiter("10.0.0.9");
    loginLimiter.recordFailure("sweep@lexa.test");
    const sizes = authLimiterSizes();
    expect(sizes.ip).toBeGreaterThan(0);
    expect(sizes.login).toBeGreaterThan(0);
    sweepAuthLimiters(Date.now() + 20 * 60_000);
    expect(authLimiterSizes()).toEqual({ ip: 0, login: 0 });
  });
});
