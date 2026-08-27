import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { createApiHandler } from "./http";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));
const ADMIN_KEY = "lxk_" + "u".repeat(43);
async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

let dir: string;
let handler: (req: Request) => Promise<Response>;
let db: Database;

const authed = (method: string, path: string, body?: unknown) =>
  new Request(`http://lexa.test${path}`, {
    method,
    headers: {
      authorization: `Bearer ${ADMIN_KEY}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "lexa-herald-usage-http-"));
  const dbPath = join(dir, "test.db");
  runMigrations(dbPath, MIGRATIONS);
  const adminHash = await sha256(ADMIN_KEY);
  db = new Database(dbPath);
  db.exec(`
    INSERT INTO users (id, email, name, role) VALUES ('u1','a@lexa.test','A','superadmin');
    INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k1','test','${adminHash}','u1');
    INSERT INTO projects (id, name, slug) VALUES ('p1','Proj1','proj1'), ('p2','Proj2','proj2');
  `);
  db.exec(`
    INSERT INTO herald_call_logs (id, project_id, provider_id, model, kind, status, usage_in, usage_out, cached_in, latency_ms, cost_cents, created_at)
    VALUES
      ('l1','p1',NULL,'anthropic/claude-sonnet-4','openai_compatible','done',100,50,0,1200,100,'2026-08-01 10:00:00'),
      ('l2','p1',NULL,'anthropic/claude-sonnet-4','openai_compatible','done',200,100,0,800,200,'2026-08-02 10:00:00'),
      ('l3','p2',NULL,'openai/gpt-5-mini','openai_compatible','error',10,5,0,500,10,'2026-08-02 11:00:00'),
      ('l4','p1',NULL,'openai/gpt-5-mini','openai_compatible','done',50,25,0,1000,50,'2026-08-03 10:00:00');
  `);
  handler = createApiHandler(dbPath);
});

afterAll(() => { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });

describe("GET /api/admin/herald/usage", () => {
  it("returns summary + byDay + byModel aggregated", async () => {
    const res = await handler(authed("GET", "/api/admin/herald/usage"));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.summary).toBeDefined();
    expect(body.summary.totalCalls).toBe(4);
    expect(body.summary.totalTokens).toBeGreaterThan(0);
    expect(body.summary.totalCostCents).toBe(360);
    expect(body.summary.errorRate).toBeCloseTo(0.25);
    expect(body.byDay.length).toBe(3);
    expect(body.byDay[0]!.day).toBe("2026-08-01");
    expect(body.byModel.length).toBeGreaterThanOrEqual(2);
    expect(body.totalCostCents).toBe(360);
  });

  it("filters by from/to inclusive", async () => {
    const res = await handler(authed("GET", "/api/admin/herald/usage?from=2026-08-02&to=2026-08-02"));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.summary.totalCalls).toBe(2);
    expect(body.byDay.length).toBe(1);
    expect(body.byDay[0]!.day).toBe("2026-08-02");
  });

  it("filters by projectId", async () => {
    const res = await handler(authed("GET", "/api/admin/herald/usage?projectId=p1"));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.summary.totalCalls).toBe(3);
    expect(body.byModel.find((m: any) => m.model === "anthropic/claude-sonnet-4").calls).toBe(2);
  });

  it("non-admin → 403", async () => {
    const memberKey = "lxk_" + "m".repeat(43);
    const h = await sha256(memberKey);
    db.prepare("INSERT INTO users (id, email, name, role) VALUES ('u2','m@lexa.test','M','member')").run();
    db.prepare("INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k2','mem','" + h + "','u2')").run();
    const res = await handler(new Request("http://lexa.test/api/admin/herald/usage", { headers: { authorization: `Bearer ${memberKey}` } }));
    expect(res.status).toBe(403);
  });
});

describe("GET /api/admin/herald/usage.csv", () => {
  it("returns csv with header and rows", async () => {
    const res = await handler(authed("GET", "/api/admin/herald/usage.csv"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/csv");
    const text = await res.text();
    expect(text.split("\n")[0]).toBe("day,model,tokens,cost_cents,cost_usd,avg_latency_ms,calls,error_rate");
    expect(text).toContain("2026-08-01");
  });

  it("filters csv by projectId", async () => {
    const res = await handler(authed("GET", "/api/admin/herald/usage.csv?projectId=p2"));
    const text = await res.text();
    expect(text).toContain("openai/gpt-5-mini");
    expect(text).not.toContain("anthropic/claude-sonnet-4,300");
  });

  it("non-admin → 403 csv", async () => {
    const memberKey = "lxk_" + "m".repeat(43);
    const res = await handler(new Request("http://lexa.test/api/admin/herald/usage.csv", { headers: { authorization: `Bearer ${memberKey}` } }));
    expect(res.status).toBe(403);
  });
});

describe("PUT /api/admin/herald/prices", () => {
  it("upserts price and returns row", async () => {
    const res = await handler(authed("PUT", "/api/admin/herald/prices", { model: "anthropic/claude-sonnet-4", prompt_price: 0.003, completion_price: 0.015 }));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.model).toBe("anthropic/claude-sonnet-4");
    expect(body.prompt_price).toBe(0.003);
    expect(body.updated_at).toBeTruthy();
    const get = await handler(authed("GET", "/api/admin/herald/prices"));
    expect(get.status).toBe(200);
    const list = await get.json() as any;
    expect(list.data.find((r: any) => r.model === "anthropic/claude-sonnet-4")).toBeTruthy();
  });

  it("rejects invalid decimals", async () => {
    const res = await handler(authed("PUT", "/api/admin/herald/prices", { model: "x", prompt_price: 0.1234567, completion_price: 0 }));
    expect(res.status).toBe(422);
    const body = await res.json() as any;
    expect(body.error.code).toBe("INVALID_ARGS");
  });

  it("non-admin → 403", async () => {
    const memberKey = "lxk_" + "m".repeat(43);
    const res = await handler(new Request("http://lexa.test/api/admin/herald/prices", { method: "PUT", headers: { authorization: `Bearer ${memberKey}`, "content-type": "application/json" }, body: JSON.stringify({ model: "x", prompt_price: 0, completion_price: 0 }) }));
    expect(res.status).toBe(403);
  });
});

describe("GET /api/projects/:slug/herald/usage", () => {
  it("returns scoped usage", async () => {
    const res = await handler(authed("GET", "/api/projects/proj1/herald/usage"));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.summary.totalCalls).toBe(3);
    expect(body.byDay.length).toBe(3);
  });

  it("unknown slug → 404", async () => {
    const res = await handler(authed("GET", "/api/projects/nonexistent/herald/usage"));
    expect(res.status).toBe(404);
  });

  it("non-admin → 403", async () => {
    const memberKey = "lxk_" + "m".repeat(43);
    const res = await handler(new Request("http://lexa.test/api/projects/proj1/herald/usage", { headers: { authorization: `Bearer ${memberKey}` } }));
    expect(res.status).toBe(403);
  });
});
