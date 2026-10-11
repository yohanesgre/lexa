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

interface CreatedRequest {
  id: string;
  token: string;
  body: { clientName: string; verifyUrl: string; status: string; code: string; expiresMs: number };
}

// Create a pairing request via the (key-exempt) endpoint, returning id +
// token parsed from verifyUrl.
async function createRequest(clientName = "cli-testhost"): Promise<CreatedRequest> {
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
  sessionCookie = (signIn.headers?.get?.("set-cookie") ?? "").split(";")[0]!!;
  expect(sessionCookie).toMatch(/^__Secure-better-auth\.session_token=/);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("device-login request + poll (key-exempt)", () => {
  it("mints pending without auth (empty name 422); poll returns the pending shape; unknown id / wrong token / absent token → 404 no-oracle; denial → 403 DEVICE_LOGIN_DENIED; expiry → 410", async () => {
    const { id, token, body } = await createRequest();
    expect(body.clientName).toBe("cli-testhost");
    expect(body.verifyUrl).toMatch(/^https:\/\/lexa\.test\/device-login\?request=[^&]+&token=/);

    const bad = await call("POST", "/api/device-login/requests", { body: { clientName: "   " } });
    expect(bad.status).toBe(422);
    expect((await bad.json()).error.code).toBe("INVALID_NAME");

    const pending = await call("GET", `/api/device-login/requests/${id}`, { headers: { "x-device-token": token } });
    expect(pending.status).toBe(200);
    const pendingBody = await pending.json();
    expect(pendingBody).toMatchObject({ status: "pending", clientName: "cli-testhost", code: expect.any(String) });
    expect(pendingBody.expiresAt).toBeTruthy();

    for (const res of [
      await call("GET", `/api/device-login/requests/${id}`, { headers: { "x-device-token": "aa".repeat(32) } }),
      await call("GET", "/api/device-login/requests/does-not-exist", { headers: { "x-device-token": token } }),
      await call("GET", `/api/device-login/requests/${id}`),
    ]) {
      expect(res.status).toBe(404);
      expect((await res.json()).error.code).toBe("DEVICE_LOGIN_NOT_FOUND");
    }

    // Denial is terminal: a later approve 404s.
    const denied = await createRequest();
    const deny = await call("POST", `/api/device-login/requests/${denied.id}/deny`, { body: { token: denied.token }, headers: { cookie: sessionCookie } });
    expect(deny.status).toBe(200);
    expect((await deny.json()).status).toBe("denied");
    const pollDenied = await call("GET", `/api/device-login/requests/${denied.id}`, { headers: { "x-device-token": denied.token } });
    expect(pollDenied.status).toBe(403);
    expect((await pollDenied.json()).error.code).toBe("DEVICE_LOGIN_DENIED");
    expect((await call("POST", `/api/device-login/requests/${denied.id}/approve`, { body: { token: denied.token }, headers: { cookie: sessionCookie } })).status).toBe(404);

    // Expiry is terminal too.
    const expiring = await createRequest();
    const db = new Database(process.env.DATABASE_PATH!);
    db.prepare("UPDATE device_login_requests SET expires_at = datetime('now', '-1 minute') WHERE id = ?").run(expiring.id);
    db.close();
    const pollExpired = await call("GET", `/api/device-login/requests/${expiring.id}`, { headers: { "x-device-token": expiring.token } });
    expect(pollExpired.status).toBe(410);
    expect((await pollExpired.json()).error.code).toBe("DEVICE_LOGIN_EXPIRED");
    const approveExpired = await call("POST", `/api/device-login/requests/${expiring.id}/approve`, { body: { token: expiring.token }, headers: { cookie: sessionCookie } });
    expect(approveExpired.status).toBe(410);
    expect((await approveExpired.json()).error.code).toBe("DEVICE_LOGIN_EXPIRED");
  });
});

describe("approve → poll → consume", () => {
  it("approve records the approver without minting; the poll mints the member-bound key exactly once (two concurrent polls: one mints, one 404s); the minted key reads its project and is 403 on admin; personal api-keys CRUD; a bare server key cannot mint", async () => {
    const { id, token } = await createRequest("cli-approve-host");

    // No session → 401.
    const noSession = await call("POST", `/api/device-login/requests/${id}/approve`, { body: { token } });
    expect(noSession.status).toBe(401);

    const approve = await call("POST", `/api/device-login/requests/${id}/approve`, { body: { token }, headers: { cookie: sessionCookie } });
    expect(approve.status).toBe(200);
    expect(await approve.json()).toMatchObject({ status: "approved", clientName: "cli-approve-host" });

    const db = new Database(process.env.DATABASE_PATH!);
    const afterApprove = db
      .prepare("SELECT status, approver_user_id, api_key_id FROM device_login_requests WHERE id = ?")
      .get(id) as unknown as { status: string; approver_user_id: string | null; api_key_id: string | null };
    expect(afterApprove.status).toBe("approved");
    expect(afterApprove.approver_user_id).toBeTruthy();
    expect(afterApprove.api_key_id).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS n FROM api_keys WHERE name = ?").get("cli-approve-host")).toMatchObject({ n: 0 });
    db.close();

    const poll = await call("GET", `/api/device-login/requests/${id}`, { headers: { "x-device-token": token } });
    expect(poll.status).toBe(200);
    const polled = await poll.json();
    expect(polled.rawKey).toMatch(/^lxk_[0-9A-Za-z]{43}$/);
    expect(polled.keyName).toBe("cli-approve-host");

    const db2 = new Database(process.env.DATABASE_PATH!);
    const minted = db2.prepare("SELECT name, user_id FROM api_keys WHERE name = ?").get("cli-approve-host") as unknown as { name: string; user_id: string };
    expect(minted.user_id).toBe(afterApprove.approver_user_id);
    // The request row is consumed by the poll that delivered the key.
    expect(db2.prepare("SELECT COUNT(*) AS n FROM device_login_requests WHERE id = ?").get(id)).toMatchObject({ n: 0 });
    db2.close();

    // Consumed — replay is impossible.
    const again = await call("GET", `/api/device-login/requests/${id}`, { headers: { "x-device-token": token } });
    expect(again.status).toBe(404);
    expect((await again.json()).error.code).toBe("DEVICE_LOGIN_NOT_FOUND");

    // Two concurrent polls after approval: exactly one mints.
    const concurrent = await createRequest("cli-concurrent-poll");
    await call("POST", `/api/device-login/requests/${concurrent.id}/approve`, { body: { token: concurrent.token }, headers: { cookie: sessionCookie } });
    const [a, b] = await Promise.all([
      call("GET", `/api/device-login/requests/${concurrent.id}`, { headers: { "x-device-token": concurrent.token } }),
      call("GET", `/api/device-login/requests/${concurrent.id}`, { headers: { "x-device-token": concurrent.token } }),
    ]);
    const winner = a.status === 200 ? a : b;
    const loser = a.status === 200 ? b : a;
    expect([a.status, b.status].sort()).toEqual([200, 404]);
    const rawKey = (await winner.json()).rawKey;
    expect(rawKey).toMatch(/^lxk_[0-9A-Za-z]{43}$/);
    expect((await loser.json()).error.code).toBe("DEVICE_LOGIN_NOT_FOUND");
    const db3 = new Database(process.env.DATABASE_PATH!);
    expect(db3.prepare("SELECT COUNT(*) AS n FROM api_keys WHERE name = ?").get("cli-concurrent-poll")).toMatchObject({ n: 1 });
    db3.close();

    // The minted member-bound key: owner surface + project read work, admin gates 403.
    const headers = { authorization: `Bearer ${rawKey}` };
    expect((await call("GET", "/api/me/api-keys", { headers })).status).toBe(200);
    const admin = await call("GET", "/api/settings/api-keys", { headers });
    expect(admin.status).toBe(403);
    expect((await admin.json()).error.code).toBe("FORBIDDEN");
    expect((await call("GET", "/api/projects/p1/board", { headers })).status).toBe(200);

    // Personal api keys: create/list/revoke; a bare server key cannot mint; a
    // foreign delete 404s without minting an oracle.
    const create = await call("POST", "/api/me/api-keys", { body: { name: "my-script" }, headers: { cookie: sessionCookie } });
    expect(create.status).toBe(201);
    const { key, rawKey: mine } = await create.json();
    expect(key.name).toBe("my-script");
    expect(mine).toMatch(/^lxk_[0-9A-Za-z]{43}$/);
    const list = await call("GET", "/api/me/api-keys", { headers: { cookie: sessionCookie } });
    expect(list.status).toBe(200);
    expect((await list.json()).data.some((k: { id: string; name: string }) => k.id === key.id && k.name === "my-script")).toBe(true);
    expect((await call("DELETE", `/api/me/api-keys/${key.id}`, { headers: { cookie: sessionCookie } })).status).toBe(204);
    // the revoked key no longer authenticates
    expect((await call("GET", "/api/projects", { headers: { authorization: `Bearer ${mine}` } })).status).toBe(401);

    const noUser = await call("POST", "/api/me/api-keys", { body: { name: "sneaky" }, headers: { authorization: `Bearer ${SERVER_KEY}` } });
    expect(noUser.status).toBe(403);
    expect((await noUser.json()).error.code).toBe("NO_USER_CONTEXT");

    const { auth } = await import("../auth");
    await auth.api.createUser({ body: { email: "pam@lexa.test", password: "password123", name: "Pam", data: { role: "member" } } });
    const signIn = (await auth.api.signInEmail({
      body: { email: "pam@lexa.test", password: "password123" },
      returnHeaders: true,
    })) as unknown as { headers?: Headers };
    const pamCookie = signIn.headers?.get?.("set-cookie")?.split(";")[0]!;
    const mine2 = await call("POST", "/api/me/api-keys", { body: { name: "keep-this" }, headers: { cookie: sessionCookie } });
    const mineId = ((await mine2.json()) as { key: { id: string } }).key.id;
    expect((await call("DELETE", `/api/me/api-keys/${mineId}`, { headers: { cookie: pamCookie } })).status).toBe(404);
    const after = await call("GET", "/api/me/api-keys", { headers: { cookie: sessionCookie } });
    expect((await after.json()).data.some((k: { id: string }) => k.id === mineId)).toBe(true);
  });
});
