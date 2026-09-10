import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { createApiHandler } from "./http";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

const ADMIN_KEY = "lxk_" + "a".repeat(43);
const TEAM_ADMIN_KEY = "lxk_" + "b".repeat(43);
const MEMBER_KEY = "lxk_" + "c".repeat(43);

async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

let dir: string;
let db: Database;
let handler: (req: Request) => Promise<Response>;

const createEvent = (key: string, teamId: string | null) =>
  new Request("http://lexa.test/api/hearth/runtime-events", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ machineId: "m1", action: "update", agentCli: "opencode", teamId }),
  });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "lexa-runtime-event-team-"));
  const dbPath = join(dir, "test.db");
  runMigrations(dbPath, MIGRATIONS);
  const [adminHash, taHash, memHash] = await Promise.all([ADMIN_KEY, TEAM_ADMIN_KEY, MEMBER_KEY].map(sha256));
  db = new Database(dbPath);
  db.exec(`
    INSERT INTO users (id, email, name, role) VALUES
      ('u-admin','admin@lexa.test','Admin','superadmin'),
      ('u-ta','ta@lexa.test','Team Admin','member'),
      ('u-mem','mem@lexa.test','Member','member');
    INSERT INTO api_keys (id, name, key_hash, user_id) VALUES
      ('k-admin','admin','${adminHash}','u-admin'),
      ('k-ta','ta','${taHash}','u-ta'),
      ('k-mem','mem','${memHash}','u-mem');
    INSERT INTO organization (id, name, slug, createdAt) VALUES
      ('t1','Team One','team-one','2026-01-01T00:00:00.000Z'),
      ('t2','Team Two','team-two','2026-01-01T00:00:00.000Z');
    INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES
      ('m-ta','t1','u-ta','owner','2026-01-01T00:00:00.000Z');
    INSERT INTO machines (id, hostname) VALUES ('m1','host');
  `);
  handler = createApiHandler(dbPath);
});

afterAll(() => {
  try { db.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

describe("POST /api/hearth/runtime-events team scoping (R13)", () => {
  it("superadmin may bind any team", async () => {
    const res = await handler(createEvent(ADMIN_KEY, "t2"));
    expect(res.status).toBe(201);
    const body = await res.json() as { teamId: string | null };
    expect(body.teamId).toBe("t2");
  });

  it("superadmin may bind Global (null)", async () => {
    const res = await handler(createEvent(ADMIN_KEY, null));
    expect(res.status).toBe(201);
    const body = await res.json() as { teamId: string | null };
    expect(body.teamId).toBeNull();
  });

  it("team admin may bind their own team", async () => {
    const res = await handler(createEvent(TEAM_ADMIN_KEY, "t1"));
    expect(res.status).toBe(201);
    const body = await res.json() as { teamId: string | null };
    expect(body.teamId).toBe("t1");
  });

  it("team admin cannot bind another team", async () => {
    const res = await handler(createEvent(TEAM_ADMIN_KEY, "t2"));
    expect(res.status).toBe(403);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("team admin cannot bind Global", async () => {
    const res = await handler(createEvent(TEAM_ADMIN_KEY, null));
    expect(res.status).toBe(403);
  });

  it("a plain member cannot bind any team", async () => {
    const res = await handler(createEvent(MEMBER_KEY, "t1"));
    expect(res.status).toBe(403);
  });
});
