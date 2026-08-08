import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { createApiHandler } from "./http";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

const KEY = "lxk_" + "b".repeat(43);

async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

let dir: string;
let handler: (req: Request) => Promise<Response>;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "lexa-me-api-"));
  const dbPath = join(dir, "test.db");
  runMigrations(dbPath, MIGRATIONS);
  const keyHash = await sha256(KEY);
  const db = new Database(dbPath);
  db.exec(`
INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k1', 'test-key', '${keyHash}', NULL);
INSERT INTO users (id, email, name, role, created_at, last_seen) VALUES ('u1', 'maria@lexa.test', 'Maria', 'member', '2026-01-01 10:00:00', '2026-01-02 10:00:00');
`);
  db.close();
  handler = createApiHandler(dbPath);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const base = (email?: string) =>
  new Request("http://lexa.test/api/me", {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${KEY}`,
      ...(email ? { "x-lxk-user": email } : {}),
      "content-type": "application/json",
    },
    body: JSON.stringify({ name: "Maria Silva" }),
  });

describe("PATCH /api/me", () => {
  it("renames the acting user and returns the full shape", async () => {
    const res = await handler(base("maria@lexa.test"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("Maria Silva");
    expect(body.email).toBe("maria@lexa.test");
    expect(body.role).toBe("member");
    expect(body.createdAt).toBeTruthy();
    expect(body.lastSeen).toBeTruthy();
  });

  it("trims the name", async () => {
    const res = await handler(new Request("http://lexa.test/api/me", {
      method: "PATCH",
      headers: { authorization: `Bearer ${KEY}`, "x-lxk-user": "maria@lexa.test", "content-type": "application/json" },
      body: JSON.stringify({ name: "  Maria  " }),
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("Maria");
  });

  it("rejects an empty or whitespace-only name with 422 INVALID_NAME", async () => {
    for (const name of ["", "   "]) {
      const res = await handler(new Request("http://lexa.test/api/me", {
        method: "PATCH",
        headers: { authorization: `Bearer ${KEY}`, "x-lxk-user": "maria@lexa.test", "content-type": "application/json" },
        body: JSON.stringify({ name }),
      }));
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.error.code).toBe("INVALID_NAME");
    }
  });

  it("rejects a name longer than 80 chars with 422 INVALID_NAME", async () => {
    const res = await handler(new Request("http://lexa.test/api/me", {
      method: "PATCH",
      headers: { authorization: `Bearer ${KEY}`, "x-lxk-user": "maria@lexa.test", "content-type": "application/json" },
      body: JSON.stringify({ name: "x".repeat(81) }),
    }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_NAME");
  });

  it("rejects a bare API key (no x-lxk-user) with 400 NO_USER_CONTEXT", async () => {
    const res = await handler(base());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("NO_USER_CONTEXT");
  });

  it("auto-provisions an unknown x-lxk-user email (middleware upsert), then renames it", async () => {
    const res = await handler(new Request("http://lexa.test/api/me", {
      method: "PATCH",
      headers: { authorization: `Bearer ${KEY}`, "x-lxk-user": "ghost@lexa.test", "content-type": "application/json" },
      body: JSON.stringify({ name: "Ghost" }),
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.email).toBe("ghost@lexa.test");
    expect(body.name).toBe("Ghost");
    expect(body.role).toBe("member");
  });

  it("rejects without a key", async () => {
    const res = await handler(new Request("http://lexa.test/api/me", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Maria" }),
    }));
    expect(res.status).toBe(401);
  });
});
