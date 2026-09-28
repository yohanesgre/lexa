import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { createApiHandler } from "./http";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));
const ADMIN_KEY = "lxk_" + "h".repeat(43);
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

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "lexa-assistant-health-http-"));
  const dbPath = join(dir, "test.db");
  runMigrations(dbPath, MIGRATIONS);
  const adminHash = await sha256(ADMIN_KEY);
  db = new Database(dbPath);
  db.exec(`
    INSERT INTO users (id, email, name, role) VALUES ('u1','a@lexa.test','A','superadmin');
    INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k1','test','${adminHash}','u1');
    INSERT INTO assistant_providers (id, label, base_url, api_key) VALUES ('pr1','P','https://x', '');
  `);
  handler = createApiHandler(dbPath);
});

afterAll(() => { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => {
  db.prepare("DELETE FROM assistant_provider_health WHERE provider_id = 'pr1'").run();
  db.prepare("DELETE FROM assistant_call_logs WHERE provider_id = 'pr1'").run();
});

describe("GET /api/admin/assistant/providers/:id/health", () => {
  it("returns closed default when missing, with null enrichment fields", async () => {
    const res = await handler(authed("GET", "/api/admin/assistant/providers/pr1/health"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.providerId).toBe("pr1");
    expect(body.circuitState).toBe("closed");
    expect(body.failureCount).toBe(0);
    expect(body.consecutiveFailures).toBe(0);
    expect(body.openedAt).toBeNull();
    expect(body.latencyMs).toBeNull();
    expect(body.retryAfterSeconds).toBeNull();
    expect(body.lastFailureCode).toBeNull();
    expect(body.lastFailureAt).toBeNull();
    expect(body.lastCheckedAt).toBeNull();
  });

  it("reflects open state after failures with a retry countdown", async () => {
    db.prepare("INSERT INTO assistant_provider_health (provider_id, failure_count, circuit_state, opened_at, consecutive_failures) VALUES ('pr1',3,'open',?,3)").run(new Date().toISOString());
    const res = await handler(authed("GET", "/api/admin/assistant/providers/pr1/health"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.circuitState).toBe("open");
    expect(body.failureCount).toBe(3);
    expect(body.retryAfterSeconds).toBeGreaterThan(0);
    expect(body.retryAfterSeconds).toBeLessThanOrEqual(300);
  });

  it("surfaces latency, last failure, and last checked time from the call log", async () => {
    db.prepare(
      `INSERT INTO assistant_call_logs (id, project_id, provider_id, model, kind, status, error_code, latency_ms, created_at)
       VALUES ('cl1', NULL, 'pr1', 'm1', 'openai_compatible', 'error', 'PROVIDER_UNREACHABLE', 1234, '2026-01-01 10:00:00')`
    ).run();
    const res = await handler(authed("GET", "/api/admin/assistant/providers/pr1/health"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.latencyMs).toBe(1234);
    expect(body.lastFailureCode).toBe("PROVIDER_UNREACHABLE");
    expect(body.lastFailureAt).toBe("2026-01-01 10:00:00");
    expect(body.lastCheckedAt).not.toBeNull();
  });

  it("non-admin → 403", async () => {
    const memberKey = "lxk_" + "m".repeat(43);
    const h = await sha256(memberKey);
    db.prepare("INSERT INTO users (id, email, name, role) VALUES ('u2','m@lexa.test','M','member')").run();
    db.prepare("INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k2','mem','" + h + "','u2')").run();
    const res = await handler(new Request("http://lexa.test/api/admin/assistant/providers/pr1/health", { headers: { authorization: `Bearer ${memberKey}` } }));
    expect(res.status).toBe(403);
  });
});
