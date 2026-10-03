import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { createApiHandler } from "./http";
import { capabilities } from "../capabilities";

// ADR-0003 §F: the Bun flavor drops the assistant end-to-end. The assistant
// groups are not mounted, so `/api/assistant/*` and `/api/admin/assistant/*`
// return the framework's 404 (not 401/501), while base routes and health keep
// working. `/api/capabilities` is a separate boot contract served outside the
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
  dir = mkdtempSync(join(tmpdir(), "lexa-bun-assistant-absent-"));
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

describe("Bun flavor has no assistant surface", () => {
  it("GET /api/assistant/chat/does-not-exist → 404", async () => {
    const res = await handler(authed("GET", "/api/assistant/chat/does-not-exist"));
    expect(res.status).toBe(404);
  });

  it("POST /api/assistant/chat/stream → 404", async () => {
    const res = await handler(authed("POST", "/api/assistant/chat/stream"));
    expect(res.status).toBe(404);
  });

  it("assistant 404 carries the security headers (parity with Workers)", async () => {
    const res = await handler(authed("GET", "/api/assistant/chat/does-not-exist"));
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("GET /api/admin/assistant/usage → 404", async () => {
    const res = await handler(authed("GET", "/api/admin/assistant/usage"));
    expect(res.status).toBe(404);
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

  it("capabilities(\"bun\") is assistant:false, flavor:\"bun\"", () => {
    const caps = capabilities("bun", {});
    expect(caps.assistant).toBe(false);
    expect(caps.flavor).toBe("bun");
  });
});
