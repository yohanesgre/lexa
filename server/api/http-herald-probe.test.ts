import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { createApiHandler } from "./http";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));
const ADMIN_KEY = "lxk_" + "p".repeat(43);
async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

let dir: string;
let handler: (req: Request) => Promise<Response>;
let db: Database;

const authed = (method: string, path: string) =>
  new Request(`http://lexa.test${path}`, { method, headers: { authorization: `Bearer ${ADMIN_KEY}` } });

const okModels = { status: 200, ok: true, json: async () => ({ data: [{ id: "m1" }] }) };

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "lexa-herald-probe-http-"));
  const dbPath = join(dir, "test.db");
  runMigrations(dbPath, MIGRATIONS);
  const adminHash = await sha256(ADMIN_KEY);
  db = new Database(dbPath);
  db.exec(`
    INSERT INTO users (id, email, name, role) VALUES ('u1','a@lexa.test','A','superadmin');
    INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k1','test','${adminHash}','u1');
    INSERT INTO herald_providers (id, label, base_url, api_key) VALUES ('pr1','P','https://x','sk');
  `);
  handler = createApiHandler(dbPath);
});

afterAll(() => { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("POST /api/admin/herald/providers/:id/probe", () => {
  it("success closes breaker and returns row", async () => {
    db.prepare("DELETE FROM herald_provider_health WHERE provider_id = 'pr1'").run();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okModels));
    const res = await handler(authed("POST", "/api/admin/herald/providers/pr1/probe"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.providerId).toBe("pr1");
    expect(body.circuitState).toBe("closed");
    expect(body.failureCount).toBe(0);
  });

  it("unreachable records failure and returns row", async () => {
    db.prepare("DELETE FROM herald_provider_health WHERE provider_id = 'pr1'").run();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    const res = await handler(authed("POST", "/api/admin/herald/providers/pr1/probe"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.circuitState).toBe("closed");
    expect(body.failureCount).toBe(1);
    expect(body.consecutiveFailures).toBe(1);
  });

  it("auth failure records failure and returns row", async () => {
    db.prepare("DELETE FROM herald_provider_health WHERE provider_id = 'pr1'").run();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 401, ok: false, json: async () => ({}) }));
    const res = await handler(authed("POST", "/api/admin/herald/providers/pr1/probe"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.failureCount).toBe(1);
  });

  it("failed probe on open breaker stays open with bumped counts", async () => {
    db.prepare("UPDATE herald_provider_health SET failure_count = 3, circuit_state = 'open', opened_at = ?, consecutive_failures = 3 WHERE provider_id = 'pr1'").run(new Date().toISOString());
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    const res = await handler(authed("POST", "/api/admin/herald/providers/pr1/probe"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.circuitState).toBe("open");
    expect(body.failureCount).toBe(4);
  });

  it("unknown provider → 404", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okModels));
    const res = await handler(authed("POST", "/api/admin/herald/providers/nope/probe"));
    expect(res.status).toBe(404);
  });

  it("non-admin → 403", async () => {
    const memberKey = "lxk_" + "q".repeat(43);
    const h = await sha256(memberKey);
    db.prepare("INSERT INTO users (id, email, name, role) VALUES ('u2','m@lexa.test','M','member')").run();
    db.prepare("INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k2','mem','" + h + "','u2')").run();
    const res = await handler(new Request("http://lexa.test/api/admin/herald/providers/pr1/probe", { method: "POST", headers: { authorization: `Bearer ${memberKey}` } }));
    expect(res.status).toBe(403);
  });
});
