import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { createAssistantApiHandler } from "./assistant-api";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));
const ADMIN_KEY = "lxk_" + "r".repeat(43);
const MEMBER_KEY = "lxk_" + "s".repeat(43);
async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

let dir: string;
let handler: (req: Request) => Promise<Response>;
let db: Database;

const authed = (path: string, key = ADMIN_KEY) =>
  new Request(`http://lexa.test${path}`, { headers: { authorization: `Bearer ${key}` } });

const json = (path: string, method: string, body: unknown, key = ADMIN_KEY) =>
  new Request(`http://lexa.test${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "lexa-assistant-schedules-http-"));
  const dbPath = join(dir, "test.db");
  runMigrations(dbPath, MIGRATIONS);
  const adminHash = await sha256(ADMIN_KEY);
  const memberHash = await sha256(MEMBER_KEY);
  db = new Database(dbPath);
  db.exec(`
    INSERT INTO users (id, email, name, role) VALUES ('u1','a@lexa.test','A','superadmin'), ('u2','m@lexa.test','M','member');
    INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k1','test','${adminHash}','u1'), ('k2','mem','${memberHash}','u2');
    INSERT INTO projects (id, name, slug) VALUES ('p1','Alpha','alpha');
  `);
  handler = createAssistantApiHandler(dbPath);
});

afterAll(() => { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });

beforeEach(() => { db.prepare("DELETE FROM assistant_schedules").run(); });

describe("assistant schedules CRUD", () => {
  it("creates, lists, reads, patches, and deletes", async () => {
    const created = await handler(json("/api/assistant/schedules/p1", "POST", { title: "Nightly", prompt: "summarize", cron: "0 9 * * *" }));
    expect(created.status).toBe(201);
    const row = await created.json() as Record<string, unknown>;
    expect(row).toMatchObject({
      projectId: "p1",
      title: "Nightly",
      prompt: "summarize",
      cron: "0 9 * * *",
      intervalSeconds: null,
      threadKey: null,
      createdBy: "u1",
      enabled: true,
      lastRunAt: null,
      lastRunId: null,
    });
    expect(typeof row.id).toBe("string");
    expect(typeof row.nextRunAt).toBe("string");

    const list = await handler(authed("/api/assistant/schedules/p1"));
    expect(list.status).toBe(200);
    const listBody = await list.json() as { data: Array<{ id: string }> };
    expect(listBody.data.map((r) => r.id)).toEqual([row.id]);

    const get = await handler(authed(`/api/assistant/schedules/p1/${row.id as string}`));
    expect(get.status).toBe(200);
    expect((await get.json() as { id: string }).id).toBe(row.id);

    const patched = await handler(json(`/api/assistant/schedules/p1/${row.id as string}`, "PATCH", { title: "Renamed", enabled: false }));
    expect(patched.status).toBe(200);
    const patchedBody = await patched.json() as { title: string; enabled: boolean };
    expect(patchedBody.title).toBe("Renamed");
    expect(patchedBody.enabled).toBe(false);

    const del = await handler(new Request(`http://lexa.test/api/assistant/schedules/p1/${row.id as string}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
    }));
    expect(del.status).toBe(204);
    const after = await handler(authed(`/api/assistant/schedules/p1/${row.id as string}`));
    expect(after.status).toBe(404);
  });

  it("403s a member key on write", async () => {
    const res = await handler(json("/api/assistant/schedules/p1", "POST", { title: "x", prompt: "y", intervalSeconds: 60 }, MEMBER_KEY));
    expect(res.status).toBe(403);
    expect(db.prepare("SELECT COUNT(*) AS n FROM assistant_schedules").get()).toMatchObject({ n: 0 });
  });

  it("422s a create with no timing and a patch clearing both", async () => {
    const bad = await handler(json("/api/assistant/schedules/p1", "POST", { title: "x", prompt: "y" }));
    expect(bad.status).toBe(422);

    const created = await handler(json("/api/assistant/schedules/p1", "POST", { title: "x", prompt: "y", intervalSeconds: 60 }));
    expect(created.status).toBe(201);
    const row = await created.json() as { id: string };
    const cleared = await handler(json(`/api/assistant/schedules/p1/${row.id}`, "PATCH", { cron: null, intervalSeconds: null }));
    expect(cleared.status).toBe(422);
  });

  it("404s an unknown or cross-project schedule id", async () => {
    const missing = await handler(authed("/api/assistant/schedules/p1/nope"));
    expect(missing.status).toBe(404);
    const created = await handler(json("/api/assistant/schedules/p1", "POST", { title: "x", prompt: "y", intervalSeconds: 60 }));
    const row = await created.json() as { id: string };
    db.prepare("INSERT INTO projects (id, name, slug) VALUES ('p2','Beta','beta')").run();
    const crossProject = await handler(authed(`/api/assistant/schedules/p2/${row.id}`));
    expect(crossProject.status).toBe(404);
  });
});
