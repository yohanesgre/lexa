import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { createApiHandler } from "./http";
import { apiRateLimiter, DEFAULT_RATE_LIMIT_MAX, DEFAULT_RATE_LIMIT_WINDOW_MS } from "./rate-limit";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

const ADMIN_KEY = "lxk_" + "a".repeat(43);
const MEMBER_KEY = "lxk_" + "m".repeat(43);

async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

let dir: string;
let db: Database;
let handler: (req: Request) => Promise<Response>;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "lexa-rate-limit-api-"));
  const dbPath = join(dir, "test.db");
  runMigrations(dbPath, MIGRATIONS);
  const adminHash = await sha256(ADMIN_KEY);
  const memberHash = await sha256(MEMBER_KEY);
  db = new Database(dbPath);
  db.exec(`
INSERT INTO users (id, email, name, role) VALUES ('u1', 'maria@lexa.test', 'Maria', 'member');
INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k1', 'test-admin', '${adminHash}', NULL);
INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k2', 'test-member', '${memberHash}', 'u1');
`);
  handler = createApiHandler(dbPath);
});

afterAll(() => {
  // Restore the shared limiter and drop the global settings rows so this
  // file's mutations don't leak into later tests in the same worker.
  apiRateLimiter.setLimits({ max: DEFAULT_RATE_LIMIT_MAX, windowMs: DEFAULT_RATE_LIMIT_WINDOW_MS });
  db.exec("DELETE FROM settings WHERE key IN ('rate_limit_max', 'rate_limit_window_ms')");
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const json = (method: string, path: string, body?: unknown, key: string = ADMIN_KEY) =>
  new Request(`http://lexa.test${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

describe("settings rate-limit endpoints", () => {
  it("GET returns defaults when no settings are stored (envOverride always false — env is bootstrap-only)", async () => {
    db.exec("DELETE FROM settings WHERE key IN ('rate_limit_max', 'rate_limit_window_ms')");
    apiRateLimiter.setLimits({ max: DEFAULT_RATE_LIMIT_MAX, windowMs: DEFAULT_RATE_LIMIT_WINDOW_MS });
    const res = await handler(json("GET", "/api/settings/rate-limit"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ max: 6000, windowMs: 600_000, envOverride: false });
  });

  it("GET ignores env vars at runtime (DB is the single source of truth)", async () => {
    const savedMax = process.env.LXK_RATE_LIMIT_MAX;
    const savedWindow = process.env.LXK_RATE_LIMIT_WINDOW_MS;
    process.env.LXK_RATE_LIMIT_MAX = "1000";
    process.env.LXK_RATE_LIMIT_WINDOW_MS = "60000";
    try {
      db.exec("DELETE FROM settings WHERE key IN ('rate_limit_max', 'rate_limit_window_ms')");
      const res = await handler(json("GET", "/api/settings/rate-limit"));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ max: 6000, windowMs: 600_000, envOverride: false });
    } finally {
      if (savedMax !== undefined) process.env.LXK_RATE_LIMIT_MAX = savedMax; else delete process.env.LXK_RATE_LIMIT_MAX;
      if (savedWindow !== undefined) process.env.LXK_RATE_LIMIT_WINDOW_MS = savedWindow; else delete process.env.LXK_RATE_LIMIT_WINDOW_MS;
    }
  });

  it("PUT with valid values saves, applies, and GET reflects them", async () => {
    const res = await handler(json("PUT", "/api/settings/rate-limit", { max: 100, windowMs: 5000 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ max: 100, windowMs: 5000, envOverride: false });
    const get = await handler(json("GET", "/api/settings/rate-limit"));
    expect(get.status).toBe(200);
    expect(await get.json()).toEqual({ max: 100, windowMs: 5000, envOverride: false });
    // Persisted to the settings KV table.
    expect(db.prepare("SELECT value FROM settings WHERE key = 'rate_limit_max'").get()).toEqual({ value: "100" });
    expect(db.prepare("SELECT value FROM settings WHERE key = 'rate_limit_window_ms'").get()).toEqual({ value: "5000" });
  });

  it.each([
    { max: 0, windowMs: 5000 },
    { max: -1, windowMs: 5000 },
    { max: 1.5, windowMs: 5000 },
    { max: 100 }, // missing windowMs
    { windowMs: 5000 }, // missing max
  ])("PUT with invalid body %o → 422 INVALID_RATE_LIMIT", async (body) => {
    const res = await handler(json("PUT", "/api/settings/rate-limit", body));
    expect(res.status).toBe(422);
    const parsed = await res.json();
    expect(parsed.error.code).toBe("INVALID_RATE_LIMIT");
  });

  it("member-bound key → 403 FORBIDDEN on both endpoints", async () => {
    const get = await handler(json("GET", "/api/settings/rate-limit", undefined, MEMBER_KEY));
    expect(get.status).toBe(403);
    expect((await get.json()).error.code).toBe("FORBIDDEN");
    const put = await handler(json("PUT", "/api/settings/rate-limit", { max: 1, windowMs: 1000 }, MEMBER_KEY));
    expect(put.status).toBe(403);
    expect((await put.json()).error.code).toBe("FORBIDDEN");
  });

  it("rejects without a key → 401", async () => {
    const res = await handler(new Request("http://lexa.test/api/settings/rate-limit"));
    expect(res.status).toBe(401);
  });
});
