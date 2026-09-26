import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { createApiHandler } from "./http";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));
const ADMIN_KEY = "lxk_" + "y".repeat(43);
const MEMBER_KEY = "lxk_" + "z".repeat(43);
async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

let dir: string;
let handler: (req: Request) => Promise<Response>;
let db: Database;

const authed = (path: string, key = ADMIN_KEY) =>
  new Request(`http://lexa.test${path}`, { method: "POST", headers: { authorization: `Bearer ${key}` } });

const okModels = {
  ok: true,
  status: 200,
  json: async () => ({ data: [{ id: "anthropic/claude-sonnet-4", pricing: { prompt: "0.000003", completion: "0.000015" } }] }),
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "lexa-assistant-price-sync-http-"));
  const dbPath = join(dir, "test.db");
  runMigrations(dbPath, MIGRATIONS);
  const adminHash = await sha256(ADMIN_KEY);
  const memberHash = await sha256(MEMBER_KEY);
  db = new Database(dbPath);
  db.exec(`
    INSERT INTO users (id, email, name, role) VALUES ('u1','a@lexa.test','A','superadmin'), ('u2','m@lexa.test','M','member');
    INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k1','test','${adminHash}','u1'), ('k2','mem','${memberHash}','u2');
  `);
  handler = createApiHandler(dbPath);
});

afterAll(() => { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });
beforeEach(() => { db.prepare("DELETE FROM assistant_model_prices").run(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("POST /api/admin/assistant/prices/sync", () => {
  it("returns synced count plus the refreshed price rows", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okModels));
    const res = await handler(authed("/api/admin/assistant/prices/sync"));
    expect(res.status).toBe(200);
    const body = await res.json() as { synced: number; data: Array<Record<string, unknown>> };
    expect(body.synced).toBe(1);
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.model).toBe("anthropic/claude-sonnet-4");
    expect(body.data[0]!.prompt_price).toBe(3);
    expect(body.data[0]!.completion_price).toBe(15);
  });

  it("returns synced 0 and existing rows when the upstream fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    const res = await handler(authed("/api/admin/assistant/prices/sync"));
    expect(res.status).toBe(200);
    const body = await res.json() as { synced: number; data: unknown[] };
    expect(body.synced).toBe(0);
    expect(body.data).toEqual([]);
  });

  it("member → 403", async () => {
    const res = await handler(authed("/api/admin/assistant/prices/sync", MEMBER_KEY));
    expect(res.status).toBe(403);
  });
});
