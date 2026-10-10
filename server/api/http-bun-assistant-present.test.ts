import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { createApiHandler } from "./http";
import { capabilities } from "../capabilities";

// ADR-0005 D7: the Bun flavor now mounts the assistant tier (in-process TanStack
// AI over SSE) — reversing ADR-0003 §F. `/api/assistant/*` is no longer the
// framework's 404: a bare admin key with no user binding is refused by the
// handler's identity gate, which proves the group is mounted. Base routes and
// health are unaffected. `/api/capabilities` is served by entry.ts before the
// HttpApi app; its contract is asserted at the `capabilities()` seam.

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));
const ADMIN_KEY = "lxk_" + "z".repeat(43);

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

const authed = (method: string, path: string) =>
  new Request(`http://lexa.test${path}`, {
    method,
    headers: { authorization: `Bearer ${ADMIN_KEY}` },
  });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "lexa-bun-assistant-present-"));
  const dbPath = join(dir, "test.db");
  runMigrations(dbPath, MIGRATIONS);
  const keyHash = await sha256(ADMIN_KEY);
  db = new Database(dbPath);
  db.exec(`INSERT INTO api_keys (id, name, key_hash) VALUES ('k1', 'test-admin', '${keyHash}')`);
  handler = createApiHandler(dbPath);
});

afterAll(() => {
  try { db.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

describe("Bun flavor mounts the assistant surface", () => {
  it("GET /api/assistant/chat/does-not-exist is mounted (400 NO_USER_CONTEXT, not 404)", async () => {
    const res = await handler(authed("GET", "/api/assistant/chat/does-not-exist"));
    expect(res.status).not.toBe(404);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("NO_USER_CONTEXT");
  });

  it("POST /api/assistant/chat/stream is mounted (not 404)", async () => {
    const res = await handler(authed("POST", "/api/assistant/chat/stream"));
    expect(res.status).not.toBe(404);
  });

  it("GET /api/admin/assistant/usage is mounted (not 404)", async () => {
    const res = await handler(authed("GET", "/api/admin/assistant/usage"));
    expect(res.status).not.toBe(404);
  });

  it("assistant responses carry the security headers (parity with Workers)", async () => {
    const res = await handler(authed("GET", "/api/assistant/chat/does-not-exist"));
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("base routes still work (GET /api/projects → 200)", async () => {
    const res = await handler(authed("GET", "/api/projects"));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual([]);
  });

  it("GET /api/health → 200 {ok:true}", async () => {
    const res = await handler(new Request("http://lexa.test/api/health"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("capabilities(\"bun\") reports assistant:true when the master key is set (D7)", () => {
    const caps = capabilities("bun", { LXK_SECRETS_MASTER_KEY: "k".repeat(32) });
    expect(caps.assistant).toBe(true);
    expect(caps.flavor).toBe("bun");
  });
});
