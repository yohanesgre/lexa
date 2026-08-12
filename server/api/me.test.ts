import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";

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
let sessionCookie: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "lexa-me-api-"));
  const dbPath = join(dir, "test.db");
  runMigrations(dbPath, MIGRATIONS);
  process.env.DATABASE_PATH = dbPath;
  process.env.LXK_PUBLIC_URL = "http://localhost:3000";
  const keyHash = await sha256(KEY);
  const db = new Database(dbPath);
  db.exec(`
INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k1', 'agent-key', '${keyHash}', NULL);
`);
  db.close();
  // Dynamic import: server/auth.ts binds its DB from DATABASE_PATH at import
  // time — the env must be set before the auth/http chain evaluates.
  const { createApiHandler } = await import("./http");
  handler = createApiHandler(dbPath);

  // Session for the acting member (dual-channel: cookie, not key).
  const { auth } = await import("../auth");
  await auth.api.createUser({
    body: { email: "maria@lexa.test", password: "password123", name: "Maria", data: { role: "member" } },
  });
  const signIn = (await auth.api.signInEmail({
    body: { email: "maria@lexa.test", password: "password123" },
    returnHeaders: true,
  })) as unknown as { headers?: Headers };
  const setCookie = signIn.headers?.get?.("set-cookie") ?? "";
  sessionCookie = setCookie.split(";")[0];
  expect(sessionCookie).toMatch(/^__Secure-better-auth\.session_token=/);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const patch = (headers: Record<string, string>, name: string) =>
  handler(new Request("http://lexa.test/api/me", {
    method: "PATCH",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ name }),
  }));

describe("PATCH /api/me", () => {
  it("renames the acting session user and returns the full shape", async () => {
    const res = await patch({ cookie: sessionCookie }, "Maria Silva");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("Maria Silva");
    expect(body.email).toBe("maria@lexa.test");
    expect(body.role).toBe("member");
    expect(body.createdAt).toBeTruthy();
  });

  it("trims the name", async () => {
    const res = await patch({ cookie: sessionCookie }, "  Maria  ");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("Maria");
  });

  it("rejects an empty or whitespace-only name with 422 INVALID_NAME", async () => {
    for (const name of ["", "   "]) {
      const res = await patch({ cookie: sessionCookie }, name);
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.error.code).toBe("INVALID_NAME");
    }
  });

  it("rejects a name longer than 80 chars with 422 INVALID_NAME", async () => {
    const res = await patch({ cookie: sessionCookie }, "x".repeat(81));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_NAME");
  });

  it("rejects an unbound API key with 400 NO_USER_CONTEXT", async () => {
    // agents have no profile to edit
    const res = await patch({ authorization: `Bearer ${KEY}` }, "Agent");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("NO_USER_CONTEXT");
  });

  it("rejects without any auth with 401", async () => {
    const res = await patch({}, "Maria");
    expect(res.status).toBe(401);
  });
});
