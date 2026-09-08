import { describe, it, expect } from "vitest";
import {
  DEFAULT_DATABASE_PATH,
  DEFAULT_PUBLIC_URL,
  getEnv,
  getEnvFromWorkers,
  resolveDatabasePath,
  resolvePublicUrl,
  resolveTrustedOrigins,
} from "./env";

describe("getEnv", () => {
  it("maps an explicit source without touching process.env", () => {
    const rt = getEnv({
      DATABASE_PATH: "/tmp/x.db",
      PORT: "4000",
      LXK_ENV: "prod",
      LXK_PUBLIC_URL: "https://lexa.example.com",
      LXK_TRUSTED_ORIGINS: "https://a.example.com, https://b.example.com",
      GITHUB_APP_ID: "123",
      LXK_MAX_BODY_MB: "32",
      LXK_RATE_LIMIT_MAX: "1000",
      LXK_RATE_LIMIT_WINDOW_MS: "60000",
      LXK_HEARTH_REPO_CAP: "5",
      HEARTH_STALE_RUN_MIN: "45",
      LOG_LEVEL: "debug",
    });
    expect(rt.DATABASE_PATH).toBe("/tmp/x.db");
    expect(rt.PORT).toBe("4000");
    expect(rt.LXK_ENV).toBe("prod");
    expect(rt.LXK_PUBLIC_URL).toBe("https://lexa.example.com");
    expect(rt.LXK_TRUSTED_ORIGINS).toBe("https://a.example.com, https://b.example.com");
    expect(rt.GITHUB_APP_ID).toBe("123");
    expect(rt.LXK_MAX_BODY_MB).toBe("32");
    expect(rt.LXK_RATE_LIMIT_MAX).toBe("1000");
    expect(rt.LXK_RATE_LIMIT_WINDOW_MS).toBe("60000");
    expect(rt.LXK_HEARTH_REPO_CAP).toBe("5");
    expect(rt.HEARTH_STALE_RUN_MIN).toBe("45");
    expect(rt.LOG_LEVEL).toBe("debug");
  });

  it("falls back to LXK_-prefixed TanStack AI keys", () => {
    const rt = getEnv({ LXK_TANSTACK_AI_DEBUG: "1", LXK_TANSTACK_AI_JSON: "1" } as Record<string, string | undefined>);
    expect(rt.TANSTACK_AI_DEBUG).toBe("1");
    expect(rt.TANSTACK_AI_JSON).toBe("1");
  });
});

describe("resolvers", () => {
  it("applies Bun-host defaults when keys are absent", () => {
    expect(resolvePublicUrl({})).toBe(DEFAULT_PUBLIC_URL);
    expect(resolveDatabasePath({})).toBe(DEFAULT_DATABASE_PATH);
    expect(DEFAULT_PUBLIC_URL).toBe("http://localhost:3000");
    expect(DEFAULT_DATABASE_PATH).toBe("/app/data/lexa.db");
  });

  it("prefers explicit values over defaults", () => {
    expect(resolvePublicUrl({ LXK_PUBLIC_URL: "https://x.test" })).toBe("https://x.test");
    expect(resolveDatabasePath({ DATABASE_PATH: "/tmp/y.db" })).toBe("/tmp/y.db");
  });

  it("dev trusted origins add the vite host; prod does not", () => {
    const dev = resolveTrustedOrigins({ LXK_ENV: "dev", LXK_PUBLIC_URL: "https://x.test" });
    expect(dev).toContain("https://x.test");
    expect(dev).toContain("http://localhost:5173");
    const prod = resolveTrustedOrigins({ LXK_ENV: "prod", LXK_PUBLIC_URL: "https://x.test" });
    expect(prod).toContain("https://x.test");
    expect(prod).not.toContain("http://localhost:5173");
  });

  it("appends extra origins and drops blanks", () => {
    const origins = resolveTrustedOrigins({
      LXK_PUBLIC_URL: "https://x.test",
      LXK_TRUSTED_ORIGINS: "https://a.test,, ,https://b.test",
    });
    expect(origins).toEqual(["https://x.test", "https://a.test", "https://b.test"]);
  });
});

describe("getEnvFromWorkers", () => {
  it("maps the workerd env binding per request", () => {
    const fakeDb = { kind: "d1" };
    const fakeBlob = { kind: "r2" };
    const fakeKv = { kind: "kv" };
    const rt = getEnvFromWorkers({
      LXK_ENV: "prod",
      LXK_PUBLIC_URL: "https://lexa.example.com",
      GITHUB_APP_ID: "123",
      GITHUB_WEBHOOK_SECRET: "whsec",
      LXK_TRUSTED_ORIGINS: "https://a.test",
      LOG_LEVEL: "warn",
      LXK_MAX_BODY_MB: "16",
      LXK_RATE_LIMIT_MAX: "1000",
      LXK_HEARTH_DAEMON_TOKEN: "daemon",
      DB: fakeDb,
      BLOB: fakeBlob,
      KV: fakeKv,
      CRON_SECRET: "cron",
    });
    expect(rt.LXK_ENV).toBe("prod");
    expect(rt.LXK_PUBLIC_URL).toBe("https://lexa.example.com");
    expect(rt.GITHUB_APP_ID).toBe("123");
    expect(rt.GITHUB_WEBHOOK_SECRET).toBe("whsec");
    expect(rt.LXK_TRUSTED_ORIGINS).toBe("https://a.test");
    expect(rt.LOG_LEVEL).toBe("warn");
    expect(rt.LXK_MAX_BODY_MB).toBe("16");
    expect(rt.LXK_RATE_LIMIT_MAX).toBe("1000");
    expect(rt.LXK_HEARTH_DAEMON_TOKEN).toBe("daemon");
    expect(rt.CRON_SECRET).toBe("cron");
    expect(rt.DB).toBe(fakeDb);
    expect(rt.BLOB).toBe(fakeBlob);
    expect(rt.KV).toBe(fakeKv);
  });

  it("drops Bun-only keys and forces the r2 storage driver", () => {
    const rt = getEnvFromWorkers({ DATABASE_PATH: "/tmp/x.db", PORT: "3000" });
    expect(rt.DATABASE_PATH).toBeUndefined();
    expect(rt.PORT).toBeUndefined();
    expect(rt.LXK_STORAGE_DRIVER).toBe("r2");
    expect(rt.LXK_STORAGE_FS_ROOT).toBeUndefined();
  });

  it("ignores non-string binding values", () => {
    const rt = getEnvFromWorkers({ LXK_MAX_BODY_MB: 16, LOG_LEVEL: null, LXK_API_KEY: 42 });
    expect(rt.LXK_MAX_BODY_MB).toBeUndefined();
    expect(rt.LOG_LEVEL).toBeUndefined();
    // Removed env keys are dropped entirely, never passed through.
    expect("LXK_API_KEY" in rt).toBe(false);
  });
});
