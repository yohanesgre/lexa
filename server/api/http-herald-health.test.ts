import { describe, it, expect, beforeAll, afterAll } from "vitest";
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
  dir = mkdtempSync(join(tmpdir(), "lexa-herald-health-http-"));
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

describe("GET /api/admin/herald/providers/:id/health", () => {
  it("returns closed default when missing", async () => {
    const res = await handler(authed("GET", "/api/admin/herald/providers/pr1/health"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.providerId).toBe("pr1");
    expect(body.circuitState).toBe("closed");
    expect(body.failureCount).toBe(0);
    expect(body.consecutiveFailures).toBe(0);
    expect(body.openedAt).toBeNull();
  });

  it("reflects open state after failures", async () => {
    db.prepare("INSERT INTO herald_provider_health (provider_id, failure_count, circuit_state, opened_at, consecutive_failures) VALUES ('pr1',3,'open',?,3)").run(new Date().toISOString());
    const res = await handler(authed("GET", "/api/admin/herald/providers/pr1/health"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.circuitState).toBe("open");
    expect(body.failureCount).toBe(3);
  });

  it("non-admin → 403", async () => {
    const memberKey = "lxk_" + "m".repeat(43);
    const h = await sha256(memberKey);
    db.prepare("INSERT INTO users (id, email, name, role) VALUES ('u2','m@lexa.test','M','member')").run();
    db.prepare("INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k2','mem','" + h + "','u2')").run();
    const res = await handler(new Request("http://lexa.test/api/admin/herald/providers/pr1/health", { headers: { authorization: `Bearer ${memberKey}` } }));
    expect(res.status).toBe(403);
  });
});
