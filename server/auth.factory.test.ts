import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runMigrations } from "./db/migrate";
import { auth, createAuth } from "./auth";
import { getEnv, type RuntimeEnv } from "./env";

const MIGRATIONS = fileURLToPath(new URL("../migrations", import.meta.url));

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
  it("resolves publicUrl/databasePath/trustedOrigins from the passed env, not process.env", () => {
    const lexa = createAuth(baseEnv());
    expect(lexa.publicUrl).toBe("https://factory.test");
    expect(lexa.databasePath).toBe(dbPath);
    expect(lexa.trustedOrigins).toEqual(["https://factory.test"]);
    expect(lexa.env.LXK_PUBLIC_URL).toBe("https://factory.test");
  });

  it("dev env adds the vite host plus extras; prod does not", () => {
    const dev = createAuth({
      ...baseEnv(),
      LXK_ENV: "dev",
      LXK_TRUSTED_ORIGINS: "https://extra.test",
    });
    expect(dev.trustedOrigins).toEqual(["https://factory.test", "http://localhost:5173", "https://extra.test"]);
    const prod = createAuth({ ...baseEnv(), LXK_TRUSTED_ORIGINS: "https://extra.test" });
    expect(prod.trustedOrigins).toEqual(["https://factory.test", "https://extra.test"]);
  });

  it("falls back to Bun-host defaults when keys are absent", () => {
    const lexa = createAuth({ DATABASE_PATH: dbPath });
    expect(lexa.publicUrl).toBe("http://localhost:3000");
    expect(lexa.trustedOrigins).toEqual(["http://localhost:3000"]);
  });

  it("two factories from different envs are isolated", () => {
    const a = createAuth({ ...baseEnv(), LXK_PUBLIC_URL: "https://a.test" });
    const b = createAuth({ ...baseEnv(), LXK_PUBLIC_URL: "https://b.test" });
    expect(a.publicUrl).toBe("https://a.test");
    expect(b.publicUrl).toBe("https://b.test");
    expect(a.handler).not.toBe(b.handler);
  });

  it("exposes a request handler and the shared limiters", () => {
    const lexa = createAuth(baseEnv());
    expect(typeof lexa.handler).toBe("function");
    expect(typeof lexa.authIpLimiter).toBe("function");
    expect(typeof lexa.loginLimiter.check).toBe("function");
  });
});

describe("Bun-host auth singleton (lazy)", () => {
  it("exposes handler + api without import-time side effects", () => {
    expect(typeof auth.handler).toBe("function");
    expect(auth.api).toBeTruthy();
    expect(typeof auth.api.getSession).toBe("function");
  });

  it("initializes from the process env snapshot at first use", () => {
    expect(getEnv().LXK_PUBLIC_URL).toBe("http://process-env-decoy.test");
    expect(typeof auth.handler).toBe("function");
  });
});
