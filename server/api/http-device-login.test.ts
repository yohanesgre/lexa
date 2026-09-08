import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

const SERVER_KEY = "lxk_" + "s".repeat(43);

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

const call = (method: string, path: string, opts: { body?: unknown; headers?: Record<string, string> } = {}) =>
  handler(new Request(`http://lexa.test${path}`, {
    method,
    headers: {
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      ...opts.headers,
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  }));

const tokenOf = (verifyUrl: string): string => {
  const token = new URL(verifyUrl).searchParams.get("token");
  expect(token).toBeTruthy();
  return token!;
};

// Create a pairing request via the (key-exempt) endpoint, returning id +
// token parsed from verifyUrl.
async function createRequest(clientName = "cli-testhost"): Promise<{ id: string; token: string; body: any }> {
  const res = await call("POST", "/api/device-login/requests", { body: { clientName } });
  expect(res.status).toBe(201);
  const body = await res.json();
  expect(body.status).toBe("pending");
  expect(body.code).toMatch(/^[A-Z0-9]{8}$/);
  expect(body.expiresMs).toBeGreaterThan(Date.now());
  return { id: body.id, token: tokenOf(body.verifyUrl), body };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "lexa-device-login-"));
  const dbPath = join(dir, "test.db");
  runMigrations(dbPath, MIGRATIONS);
  process.env.DATABASE_PATH = dbPath;
  process.env.LXK_PUBLIC_URL = "https://lexa.test";
  const serverHash = await sha256(SERVER_KEY);
  const db = new Database(dbPath);
  db.exec(`
INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('ksrv', 'server-key', '${serverHash}', NULL);
INSERT INTO projects (id, name, slug, key) VALUES ('p1', 'P', 'p1', 'P');
`);
  db.close();
  const { createApiHandler } = await import("./http");
  handler = createApiHandler(dbPath);

  const { auth } = await import("../auth");
  await auth.api.createUser({
    body: { email: "maria@lexa.test", password: "password123", name: "Maria", data: { role: "member" } },
  });
  // Explicit project grant so the member key exercises the authz path (board
  // read) — without a grant the member gets 403 PROJECT_ACCESS_DENIED.
  const grantDb = new Database(dbPath);
  grantDb.prepare("INSERT OR IGNORE INTO user_project_roles (user_id, role, project_id) SELECT id, 'member', 'p1' FROM users WHERE email = 'maria@lexa.test'").run();
  grantDb.close();
  const signIn = (await auth.api.signInEmail({
    body: { email: "maria@lexa.test", password: "password123" },
    returnHeaders: true,
  })) as unknown as { headers?: Headers };
  const setCookie = signIn.headers?.get?.("set-cookie") ?? "";
  sessionCookie = setCookie.split(";")[0]!!;
  expect(sessionCookie).toMatch(/^__Secure-better-auth\.session_token=/);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("POST /api/device-login/requests (key-exempt)", () => {
  it("mints a pending request without any auth and returns the verify URL", async () => {
    const { body } = await createRequest();
    expect(body.clientName).toBe("cli-testhost");
    expect(body.verifyUrl).toMatch(/^https:\/\/lexa\.test\/device-login\?request=[^&]+&token=/);
  });

  it("rejects an empty clientName (422 INVALID_NAME)", async () => {
    const res = await call("POST", "/api/device-login/requests", { body: { clientName: "   " } });
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("INVALID_NAME");
  });
});

describe("GET /api/device-login/requests/:id (poll, key-exempt)", () => {
  it("returns pending with clientName/code/expiresAt for the approve page", async () => {
    const { id, token } = await createRequest();
    const res = await call("GET", `/api/device-login/requests/${id}`, {
      headers: { "x-device-token": token },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ status: "pending", clientName: "cli-testhost", code: expect.any(String) });
    expect(body.expiresAt).toBeTruthy();
  });

  it("404 DEVICE_LOGIN_NOT_FOUND on unknown id or wrong token (no oracle)", async () => {
    const { id, token } = await createRequest();
    for (const req of [
      call("GET", `/api/device-login/requests/${id}`, { headers: { "x-device-token": "aa".repeat(32) } }),
      call("GET", "/api/device-login/requests/does-not-exist", { headers: { "x-device-token": token } }),
    ]) {
      const res = await req;
      expect(res.status).toBe(404);
      expect((await res.json()).error.code).toBe("DEVICE_LOGIN_NOT_FOUND");
    }
  });
});

describe("approve → poll → consume", () => {
  it("session approve mints a user-bound key; the CLI poll receives it exactly once", async () => {
    const { id, token } = await createRequest("cli-approve-host");

    // No session → 401.
    const noSession = await call("POST", `/api/device-login/requests/${id}/approve`, { body: { token } });
    expect(noSession.status).toBe(401);

    const approve = await call("POST", `/api/device-login/requests/${id}/approve`, {
      body: { token },
      headers: { cookie: sessionCookie },
    });
    expect(approve.status).toBe(200);
    expect((await approve.json())).toMatchObject({ status: "approved", clientName: "cli-approve-host" });

    const poll = await call("GET", `/api/device-login/requests/${id}`, { headers: { "x-device-token": token } });
    expect(poll.status).toBe(200);
    const polled = await poll.json();
    expect(polled.status).toBe("approved");
    expect(polled.rawKey).toMatch(/^lxk_[0-9A-Za-z]{43}$/);
    expect(polled.keyName).toBe("cli-approve-host");

    // Consumed — replay is impossible.
    const again = await call("GET", `/api/device-login/requests/${id}`, { headers: { "x-device-token": token } });
    expect(again.status).toBe(404);
    expect((await again.json()).error.code).toBe("DEVICE_LOGIN_NOT_FOUND");
  });

  it("the minted key acts as the approving member (project access ok, admin gates 403)", async () => {
    const { id, token } = await createRequest();
    await call("POST", `/api/device-login/requests/${id}/approve`, { body: { token }, headers: { cookie: sessionCookie } });
    const poll = await call("GET", `/api/device-login/requests/${id}`, { headers: { "x-device-token": token } });
    const { rawKey } = await poll.json();
    const headers = { authorization: `Bearer ${rawKey}` };

    // Owner-scoped surface works (member identity).
    const mine = await call("GET", "/api/me/api-keys", { headers });
    expect(mine.status).toBe(200);

    // Admin-only surface stays 403 for a member-bound key.
    const admin = await call("GET", "/api/settings/api-keys", { headers });
    expect(admin.status).toBe(403);
    expect((await admin.json()).error.code).toBe("FORBIDDEN");

    // Project read works for the member via AuthenticationService.
    const board = await call("GET", "/api/projects/p1/board", { headers });
    expect(board.status).toBe(200);
  });
});

describe("deny", () => {
  it("deny flips the request; poll → 403 DEVICE_LOGIN_DENIED; later approve → 404", async () => {
    const { id, token } = await createRequest();
    const deny = await call("POST", `/api/device-login/requests/${id}/deny`, {
      body: { token },
      headers: { cookie: sessionCookie },
    });
    expect(deny.status).toBe(200);
    expect((await deny.json()).status).toBe("denied");

    const poll = await call("GET", `/api/device-login/requests/${id}`, { headers: { "x-device-token": token } });
    expect(poll.status).toBe(403);
    expect((await poll.json()).error.code).toBe("DEVICE_LOGIN_DENIED");

    const approve = await call("POST", `/api/device-login/requests/${id}/approve`, {
      body: { token },
      headers: { cookie: sessionCookie },
    });
    expect(approve.status).toBe(404);
  });
});

describe("expiry", () => {
  it("an expired pending request polls as 410 DEVICE_LOGIN_EXPIRED", async () => {
    const { id, token } = await createRequest();
    const db = new Database(process.env.DATABASE_PATH!);
    db.prepare("UPDATE device_login_requests SET expires_at = datetime('now', '-1 minute') WHERE id = ?").run(id);
    db.close();
    const res = await call("GET", `/api/device-login/requests/${id}`, { headers: { "x-device-token": token } });
    expect(res.status).toBe(410);
    expect((await res.json()).error.code).toBe("DEVICE_LOGIN_EXPIRED");
  });

  it("approving an expired request → 410; polling without the token header → 404", async () => {
    const { id, token } = await createRequest();
    const db = new Database(process.env.DATABASE_PATH!);
    db.prepare("UPDATE device_login_requests SET expires_at = datetime('now', '-1 minute') WHERE id = ?").run(id);
    db.close();
    const approve = await call("POST", `/api/device-login/requests/${id}/approve`, {
      body: { token },
      headers: { cookie: sessionCookie },
    });
    expect(approve.status).toBe(410);
    expect((await approve.json()).error.code).toBe("DEVICE_LOGIN_EXPIRED");

    const noToken = await call("GET", `/api/device-login/requests/${id}`);
    expect(noToken.status).toBe(404);
    expect((await noToken.json()).error.code).toBe("DEVICE_LOGIN_NOT_FOUND");
  });
});

describe("personal api keys (/api/me/api-keys)", () => {
  it("session creates + lists + revokes own keys", async () => {
    const create = await call("POST", "/api/me/api-keys", {
      body: { name: "my-script" },
      headers: { cookie: sessionCookie },
    });
    expect(create.status).toBe(201);
    const { key, rawKey } = await create.json();
    expect(key.name).toBe("my-script");
    expect(rawKey).toMatch(/^lxk_[0-9A-Za-z]{43}$/);

    const list = await call("GET", "/api/me/api-keys", { headers: { cookie: sessionCookie } });
    expect(list.status).toBe(200);
    const { data } = await list.json();
    expect(data.some((k: { id: string; name: string }) => k.id === key.id && k.name === "my-script")).toBe(true);

    const del = await call("DELETE", `/api/me/api-keys/${key.id}`, { headers: { cookie: sessionCookie } });
    expect(del.status).toBe(204);

    const gone = await call("GET", "/api/projects", { headers: { authorization: `Bearer ${rawKey}` } });
    expect(gone.status).toBe(401);
  });

  it("a bare server key cannot mint — 403 NO_USER_CONTEXT; deleting someone else's key → 404", async () => {
    const mine = await create();
    const id = mine.body.key.id;

    const noUser = await call("POST", "/api/me/api-keys", {
      body: { name: "sneaky" },
      headers: { authorization: `Bearer ${SERVER_KEY}` },
    });
    expect(noUser.status).toBe(403);
    expect((await noUser.json()).error.code).toBe("NO_USER_CONTEXT");

    // Second user's session must not delete Maria's key (404, no oracle).
    const { auth } = await import("../auth");
    await auth.api.createUser({
      body: { email: "pam@lexa.test", password: "password123", name: "Pam", data: { role: "member" } },
    });
    const signIn = (await auth.api.signInEmail({
      body: { email: "pam@lexa.test", password: "password123" },
      returnHeaders: true,
    })) as unknown as { headers?: Headers };
    const pamCookie = signIn.headers?.get?.("set-cookie")?.split(";")[0]!;
    const del = await call("DELETE", `/api/me/api-keys/${id}`, { headers: { cookie: pamCookie } });
    expect(del.status).toBe(404);

    // Maria's key still there.
    const list = await call("GET", "/api/me/api-keys", { headers: { cookie: sessionCookie } });
    const { data } = await list.json();
    expect(data.some((k: { id: string }) => k.id === id)).toBe(true);
  });

  async function create(): Promise<{ body: { key: { id: string } } }> {
    const res = await call("POST", "/api/me/api-keys", {
      body: { name: "keep-this-1" },
      headers: { cookie: sessionCookie },
    });
    expect(res.status).toBe(201);
    return { body: await res.json() };
  }
});