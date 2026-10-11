import { describe, expect, it, afterEach, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { resolveApiKeyIdentity } from "./auth-key";
import { actorFromIdentity } from "./auth";
import { LexaApi } from "./http";
import type { auth as AuthInstance } from "../auth";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));
const RAW_KEY = "lxk_" + "k".repeat(43);
const KEY_HASH = createHash("sha256").update(RAW_KEY).digest("hex");

let dirs: string[] = [];
let dbs: Database[] = [];

function tmpDb(): { db: Database; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "lexa-auth-key-"));
  dirs.push(dir);
  const path = join(dir, "test.db");
  runMigrations(path, MIGRATIONS);
  const db = new Database(path);
  db.exec("PRAGMA foreign_keys = ON");
  dbs.push(db);
  return { db, path };
}

afterEach(() => {
  for (const db of dbs) {
    try { db.close(); } catch {}
  }
  dbs = [];
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("resolveApiKeyIdentity", () => {
  it("returns keyName for an unowned key (admin, no user context)", () => {
    const { db, path } = tmpDb();
    db.prepare("INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k1', 'opencode-local', ?, NULL)").run(KEY_HASH);
    const res = resolveApiKeyIdentity(`Bearer ${RAW_KEY}`, new Headers(), db, path);
    expect(res).not.toBeNull();
    expect(res!.keyId).toBe("k1");
    expect(res!.keyName).toBe("opencode-local");
    expect(res!.userId).toBeNull();
    expect(res!.userName).toBeNull();
    expect(res!.role).toBe("admin");
  });

  it("a key bound to a member user carries the member role and owner name", () => {
    const { db, path } = tmpDb();
    db.prepare("INSERT INTO users (id, email, name, role) VALUES ('u1', 'maria@lexa.test', 'Maria', 'member')").run();
    db.prepare("INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k1', 'opencode-local', ?, 'u1')").run(KEY_HASH);
    const res = resolveApiKeyIdentity(`Bearer ${RAW_KEY}`, new Headers(), db, path);
    expect(res!.userId).toBe("u1");
    expect(res!.userName).toBe("Maria");
    expect(res!.role).toBe("member");
  });

  it("a key bound to a superadmin user maps to the admin role", () => {
    const { db, path } = tmpDb();
    db.prepare("INSERT INTO users (id, email, name, role) VALUES ('u1', 'sa@lexa.test', 'SA', 'superadmin')").run();
    db.prepare("INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k1', 'opencode-local', ?, 'u1')").run(KEY_HASH);
    const res = resolveApiKeyIdentity(`Bearer ${RAW_KEY}`, new Headers(), db, path);
    expect(res!.userId).toBe("u1");
    expect(res!.role).toBe("admin");
  });

  it("ignores the removed x-lxk-user header entirely (no upsert)", () => {
    const { db, path } = tmpDb();
    db.prepare("INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k1', 'opencode-local', ?, NULL)").run(KEY_HASH);
    const res = resolveApiKeyIdentity(`Bearer ${RAW_KEY}`, new Headers({ "x-lxk-user": "new@lexa.test" }), db, path);
    expect(res!.userId).toBeNull();
    const created = db.prepare("SELECT id FROM users WHERE email = 'new@lexa.test'").get() as { id: string } | null;
    expect(created).toBeNull();
  });

  it("returns null for an unknown key", () => {
    const { db, path } = tmpDb();
    expect(resolveApiKeyIdentity("Bearer lxk_" + "z".repeat(43), new Headers(), db, path)).toBeNull();
  });

  it("ignores malformed Authorization headers", () => {
    const { db, path } = tmpDb();
    expect(resolveApiKeyIdentity("Basic abc", new Headers(), db, path)).toBeNull();
    expect(resolveApiKeyIdentity("Bearer notlxk_short", new Headers(), db, path)).toBeNull();
  });
});

describe("actorFromIdentity", () => {
  it("user identity → user actor with userName label", () => {
    expect(actorFromIdentity({ keyId: "k1", keyName: "opencode-local", userId: "u1", userName: "Maria", role: "member" })).toEqual({ kind: "user", label: "Maria", userId: "u1" });
  });

  it("agent identity → agent actor with keyName label", () => {
    expect(actorFromIdentity({ keyId: "k1", keyName: "opencode-local", userId: null, userName: null, role: "admin" })).toEqual({ kind: "agent", label: "opencode-local", userId: null });
  });
});

// --- carried: PATCH /api/me + workspace invite peek/accept -----------------
// (absorbed from the former me.test.ts and auth-invite.test.ts)

const HTTP_KEY = "lxk_" + "b".repeat(43);
const MEMBER_HTTP_KEY = "lxk_" + "d".repeat(43);

async function sha256(text: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

let httpDir: string;
let httpDbPath: string;
let handler: (req: Request) => Promise<Response>;
let sessionCookie: string;
let auth: typeof AuthInstance;

beforeAll(async () => {
  httpDir = mkdtempSync(join(tmpdir(), "lexa-auth-key-http-"));
  httpDbPath = join(httpDir, "test.db");
  runMigrations(httpDbPath, MIGRATIONS);
  process.env.DATABASE_PATH = httpDbPath;
  process.env.LXK_PUBLIC_URL = "https://localhost:3000";
  const keyHash = await sha256(HTTP_KEY);
  const memberHash = await sha256(MEMBER_HTTP_KEY);
  const db = new Database(httpDbPath);
  db.exec(`INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k1', 'agent-key', '${keyHash}', NULL);`);
  db.close();
  // Dynamic import: server/auth.ts binds its DB from DATABASE_PATH at import
  // time — the env must be set before the auth/http chain evaluates.
  const { createApiHandler } = await import("./http");
  handler = createApiHandler(httpDbPath);
  ({ auth } = await import("../auth"));
  await auth.api.createUser({
    body: { email: "maria@lexa.test", password: "password123", name: "Maria", data: { role: "member" } },
  });
  const signIn = (await auth.api.signInEmail({
    body: { email: "maria@lexa.test", password: "password123" },
    returnHeaders: true,
  })) as unknown as { headers?: Headers };
  sessionCookie = (signIn.headers?.get?.("set-cookie") ?? "").split(";")[0]!!;
  expect(sessionCookie).toMatch(/^__Secure-better-auth\.session_token=/);
  // A member-bound key for the route-auth matrix (below).
  const db2 = new Database(httpDbPath);
  db2.exec(`INSERT INTO api_keys (id, name, key_hash, user_id) SELECT 'kmem', 'member-matrix', '${memberHash}', id FROM users WHERE email = 'maria@lexa.test';`);
  db2.close();
});

afterAll(() => {
  rmSync(httpDir, { recursive: true, force: true });
});

const mePatch = (headers: Record<string, string>, name: string) =>
  handler(new Request("http://lexa.test/api/me", {
    method: "PATCH",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ name }),
  }));

describe("PATCH /api/me", () => {
  it("renames the acting session user (trimmed); rejects empty/whitespace/over-long names with 422 INVALID_NAME and an unbound key with 400 NO_USER_CONTEXT", async () => {
    const res = await mePatch({ cookie: sessionCookie }, "  Maria Silva  ");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ name: "Maria Silva", email: "maria@lexa.test", role: "member" });
    expect(body.createdAt).toBeTruthy();
    for (const name of ["", "   ", "x".repeat(81)]) {
      const bad = await mePatch({ cookie: sessionCookie }, name);
      expect(bad.status).toBe(422);
      expect((await bad.json()).error.code).toBe("INVALID_NAME");
    }
    // agents have no profile to edit
    const noUser = await mePatch({ authorization: `Bearer ${HTTP_KEY}` }, "Agent");
    expect(noUser.status).toBe(400);
    expect((await noUser.json()).error.code).toBe("NO_USER_CONTEXT");
  });
});

const inviteAccept = (body: unknown) =>
  auth.handler(new Request("http://localhost:3000/api/auth/invite/accept", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));

const invitePeek = (body: unknown) =>
  auth.handler(new Request("http://localhost:3000/api/auth/invite/peek", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));

function seedInvite(email: string, opts: { expired?: boolean; accepted?: boolean } = {}): string {
  const db = new Database(httpDbPath);
  const token = `tok-${email}-${Math.random().toString(36).slice(2)}`;
  const expiresAt = opts.expired
    ? new Date(Date.now() - 1000).toISOString()
    : new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
  db.prepare("INSERT INTO workspace_invitations (id, email, role, token, expires_at, created_by, accepted_at) VALUES (?, ?, 'member', ?, ?, NULL, ?)")
    .run(crypto.randomUUID(), email, token, expiresAt, opts.accepted ? new Date().toISOString() : null);
  db.close();
  return token;
}

describe("workspace invite peek/accept", () => {
  it("a live invite is peekable without consuming it; accept mints the member, the token is single-use; USER_EXISTS stays pending and a too-short password refuses before any write", async () => {
    const token = seedInvite("invitee@lexa.dev");
    const peek = await invitePeek({ token });
    expect(peek.status).toBe(200);
    expect(await peek.json()).toEqual({ valid: true, email: "invitee@lexa.dev" });
    const db = new Database(httpDbPath);
    const peeked = db.query("SELECT accepted_at FROM workspace_invitations WHERE token = ?").get(token) as { accepted_at: string | null } | null;
    db.close();
    expect(peeked?.accepted_at).toBeNull();

    const accept = await inviteAccept({ token, name: "Invitee", password: "password123" });
    expect(accept.status).toBe(200);
    const accepted = await accept.json();
    expect(accepted.email).toBe("invitee@lexa.dev");
    const db2 = new Database(httpDbPath);
    const user = db2.query("SELECT id, email, role FROM users WHERE email = 'invitee@lexa.dev'").get() as { id: string; role: string } | null;
    db2.close();
    expect(user?.role).toBe("member");
    const signIn = await auth.api.signInEmail({ body: { email: "invitee@lexa.dev", password: "password123" } });
    expect(signIn.user.email).toBe("invitee@lexa.dev");

    // peek now reports it as used, and reuse is rejected.
    const peek2 = await invitePeek({ token });
    expect(await peek2.json()).toEqual({ valid: false, reason: "used" });
    const reuse = await inviteAccept({ token, name: "Again", password: "password123" });
    expect(reuse.status).toBe(400);
    expect((await reuse.json()).code).toBe("INVALID_TOKEN");

    // An existing account forces the two-step set-password path: the invite
    // must stay pending (not stamped).
    await auth.api.createUser({ body: { email: "legacy@lexa.dev", password: "password123", name: "Legacy", data: { role: "member" } } });
    const legacyToken = seedInvite("legacy@lexa.dev");
    const exists = await inviteAccept({ token: legacyToken, name: "X", password: "password123" });
    expect(exists.status).toBe(400);
    expect((await exists.json()).code).toBe("USER_EXISTS");
    const db3 = new Database(httpDbPath);
    const legacyRow = db3.query("SELECT accepted_at FROM workspace_invitations WHERE token = ?").get(legacyToken) as { accepted_at: string | null } | null;
    expect(legacyRow?.accepted_at).toBeNull();
    db3.close();

    const shortToken = seedInvite("shortpw@lexa.dev");
    const short = await inviteAccept({ token: shortToken, name: "X", password: "short" });
    expect(short.status).toBe(400);
    const db4 = new Database(httpDbPath);
    expect(db4.query("SELECT id FROM users WHERE email = 'shortpw@lexa.dev'").get()).toBeNull();
    db4.close();
  });
});

// --- mounted route auth matrix (middleware identity contract) --------------
// Enumerates the live route table from the HttpApi definition, so a NEW route
// that forgets the middleware (or a member-scoped admin route) fails here
// instead of going silently uncovered. This owns the generic per-file 401/403
// middleware assertions once asserted in every route test file.

interface ApiRoute { method: string; path: string }

const ROUTES: ApiRoute[] = (() => {
  const groups = (LexaApi as unknown as {
    groups: Record<string, { endpoints: Record<string, { method: string; path: string }> }>;
  }).groups;
  const out: ApiRoute[] = [];
  for (const g of Object.values(groups)) {
    for (const ep of Object.values(g.endpoints)) out.push({ method: ep.method, path: ep.path });
  }
  return out;
})();

const concrete = (path: string): string => path.replace(/:[A-Za-z0-9_]+/g, "x");

// Paths the middleware deliberately exempts: health, the setup wizard, public
// share capability URLs (the token IS the auth) and device-login create/poll.
const isAuthExempt = (method: string, path: string): boolean =>
  (method === "GET" && path === "/api/health") ||
  path === "/api/setup" || path.startsWith("/api/setup/") ||
  path.startsWith("/api/share/") ||
  (method === "POST" && path === "/api/device-login/requests") ||
  (method === "GET" && /^\/api\/device-login\/requests\/[^/]+$/.test(path));

// The admin-gated GET surface (requireAdmin / requireSuperadmin). Payload
// routes need a decodable body, so the matrix pins the GET subset.
const isAdminScopedGet = (method: string, path: string): boolean =>
  method === "GET" && (
    path.startsWith("/api/admin/") ||
    path.startsWith("/api/settings/") ||
    path.startsWith("/api/workspace/") ||
    path === "/api/assistant/mcp-servers" ||
    path === "/api/assistant/jev" ||
    /^\/api\/teams\/[^/]+\/members$/.test(path)
  );

describe("mounted route auth matrix", () => {
  it("rejects every mounted route without a credential with 401 UNAUTHORIZED (documented exempt paths aside)", async () => {
    expect(ROUTES.length).toBeGreaterThan(150);
    const checked = ROUTES.filter((r) => !isAuthExempt(r.method, r.path));
    expect(checked.length).toBeGreaterThan(140);
    for (const r of checked) {
      const res = await handler(new Request(`http://lexa.test${concrete(r.path)}`, { method: r.method }));
      expect(res.status, `${r.method} ${r.path}`).toBe(401);
      expect((await res.json()).error.code, `${r.method} ${r.path}`).toBe("UNAUTHORIZED");
    }
  });

  it("answers 403 FORBIDDEN on every admin-scoped GET for a member-bound key", async () => {
    const routes = ROUTES.filter((r) => isAdminScopedGet(r.method, r.path));
    expect(routes.length).toBeGreaterThan(10);
    for (const r of routes) {
      const res = await handler(new Request(`http://lexa.test${concrete(r.path)}`, {
        method: r.method,
        headers: { authorization: `Bearer ${MEMBER_HTTP_KEY}` },
      }));
      expect(res.status, `${r.method} ${r.path}`).toBe(403);
    }
  });
});

// --- carried: setup wizard -------------------------------------------------
// (absorbed from the former setup.test.ts; its own DB + auth binding, so the
// module registry is reset before importing the http/auth chain afresh)

interface SetupBody {
  needsAdmin?: boolean;
  configured?: boolean;
  seeded?: boolean;
  error?: { code?: string };
}
const setupJson = async (res: Response): Promise<SetupBody> => res.json();

describe("provisioning (setup wizard)", () => {
  let sDir: string;
  let sDbPath: string;
  let sHandler: (req: Request) => Promise<Response>;
  let resetCache: () => void;

  beforeAll(async () => {
    vi.resetModules();
    const fs = await import("node:fs");
    sDir = fs.mkdtempSync(join(tmpdir(), "lexa-setup-"));
    sDbPath = join(sDir, "test.db");
    const { runMigrations: migrate } = await import("../db/migrate");
    migrate(sDbPath, MIGRATIONS);
    // The setup setAdmin handler provisions through the better-auth instance
    // (server/auth.ts) — point its DB here before the chain evaluates.
    process.env.DATABASE_PATH = sDbPath;
    process.env.LXK_PUBLIC_URL = "http://localhost:3000";
    const { createApiHandler } = await import("./http");
    sHandler = createApiHandler(sDbPath);
    ({ resetSettingsCache: resetCache } = await import("./workers-ports"));
  });

  afterAll(() => {
    rmSync(sDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    resetCache();
  });

  const setAdmin = (body: unknown) =>
    sHandler(new Request("http://localhost:3000/api/setup/admin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }));
  const status = () => sHandler(new Request("http://localhost:3000/api/setup/status"));
  const complete = () => sHandler(new Request("http://localhost:3000/api/setup/complete", { method: "POST" }));
  const seed = (h: (req: Request) => Promise<Response>, flavor: string) =>
    h(new Request("http://localhost:3000/api/setup/seed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ flavor }),
    }));

  it("fresh DB reports needsAdmin and never writes admin_emails / hasApiKey; setAdmin creates the superadmin (allow-list does not gate first install) and a lookalike path is not exempt", async () => {
    const st = await setupJson(await status());
    expect(st.needsAdmin).toBe(true);
    expect("hasApiKey" in st).toBe(false);
    const db = new Database(sDbPath);
    const adminEmails = db.query("SELECT COUNT(*) c FROM settings WHERE key = 'admin_emails'").get() as { c: number };
    db.close();
    expect(adminEmails.c).toBe(0);
    expect((await sHandler(new Request("http://localhost:3000/api/setup/api-key", { method: "POST" }))).status).toBe(404);

    // LXK_ADMIN_EMAILS is a non-matching address: it must not gate who may
    // become superadmin at first install.
    process.env.LXK_ADMIN_EMAILS = "someone-else@lexa.dev";
    const res = await setAdmin({ email: "ops@lexa.dev", password: "password123" });
    expect(res.status).toBe(200);
    const db2 = new Database(sDbPath);
    const user = db2.query("SELECT role FROM users WHERE email = 'ops@lexa.dev'").get() as { role: string } | null;
    db2.close();
    expect(user?.role).toBe("superadmin");
    const { auth: setupAuth } = await import("../auth");
    const signIn = await setupAuth.api.signInEmail({ body: { email: "ops@lexa.dev", password: "password123" } });
    expect(signIn.user.email).toBe("ops@lexa.dev");

    // Setup exemption is exact-prefix only — never spoofable by a lookalike.
    const spoof = await sHandler(new Request("http://localhost:3000/api/setupAnything"));
    expect(spoof.status).toBe(401);
    const spoofBody = await setupJson(spoof);
    expect(spoofBody.error?.code).toBe("UNAUTHORIZED");
    expect((await sHandler(new Request("http://localhost:3000/api/setup-extra/status"))).status).toBe(401);
  }, 20000);

  it("second setAdmin → 403 SETUP_LOCKED; status flips to configured; complete locks setAdmin and seed", async () => {
    const res = await setAdmin({ email: "other@lexa.dev", password: "password123" });
    expect(res.status).toBe(403);
    expect((await setupJson(res)).error).toMatchObject({ code: "SETUP_LOCKED" });
    const st = await setupJson(await status());
    expect(st.configured).toBe(true);
    expect(st.needsAdmin).toBe(false);

    // complete gates on (keys && admin emails): clear both so the wizard's own
    // Done step can run, then both endpoints must lock.
    const db = new Database(sDbPath);
    db.prepare("DELETE FROM api_keys").run();
    db.close();
    delete process.env.LXK_ADMIN_EMAILS;
    expect((await complete()).status).toBe(200);
    const admin = await setAdmin({ email: "late@lexa.dev", password: "password123" });
    expect(admin.status).toBe(403);
    expect((await setupJson(admin)).error).toMatchObject({ code: "SETUP_LOCKED" });
    expect((await seed(sHandler, "minimal")).status).toBe(403);
  });

  it("seed backfills task keys and completes (full flavor); the minimal flavor seeds one starter project", async () => {
    const db = new Database(sDbPath);
    db.prepare("DELETE FROM api_keys").run();
    db.prepare("DELETE FROM settings WHERE key = 'setup_complete'").run();
    db.close();
    resetCache();

    const full = await setupJson(await seed(sHandler, "full"));
    expect(full.seeded).toBe(true);
    const d1 = new Database(sDbPath);
    const nimbus = d1.query("SELECT key, next_task_number FROM projects WHERE slug = 'nimbus'").get() as { key: string; next_task_number: number };
    const firstTask = d1.query("SELECT key FROM tasks WHERE project_id = (SELECT id FROM projects WHERE slug = 'nimbus') AND number = 1").get() as { key: string };
    const projectCount = d1.query("SELECT COUNT(*) c FROM projects").get() as { c: number };
    expect(projectCount.c).toBeGreaterThan(0);
    d1.close();
    expect(nimbus.key).toBe("NMB");
    expect(nimbus.next_task_number).toBeGreaterThan(0);
    expect(firstTask.key).toBe("NMB-1");
    expect((await complete()).status).toBe(200);
    const d2 = new Database(sDbPath);
    const completeFlag = d2.query("SELECT value FROM settings WHERE key = 'setup_complete'").get() as { value: string } | null;
    d2.close();
    expect(completeFlag?.value).toBe("1");

    // Minimal flavor on a fresh DB: one starter project with explicit keys.
    const mDir = mkdtempSync(join(tmpdir(), "lexa-setup-min-"));
    const mDbPath = join(mDir, "test.db");
    const { runMigrations: migrate } = await import("../db/migrate");
    migrate(mDbPath, MIGRATIONS);
    const { createApiHandler } = await import("./http");
    const mHandler = createApiHandler(mDbPath);
    const min = await setupJson(await seed(mHandler, "minimal"));
    expect(min.seeded).toBe(true);
    const d3 = new Database(mDbPath);
    const project = d3.query("SELECT key, next_task_number FROM projects WHERE slug = 'getting-started'").get() as { key: string; next_task_number: number };
    const counts = d3.query("SELECT (SELECT COUNT(*) FROM tasks WHERE project_id = (SELECT id FROM projects WHERE slug='getting-started')) tasks, (SELECT COUNT(*) FROM wiki_pages WHERE project_id = (SELECT id FROM projects WHERE slug='getting-started')) wiki, (SELECT is_done FROM columns WHERE project_id = (SELECT id FROM projects WHERE slug='getting-started') AND name='Done') done, (SELECT is_done FROM columns WHERE project_id = (SELECT id FROM projects WHERE slug='getting-started') AND name='Backlog') backlog, (SELECT key FROM tasks WHERE project_id = (SELECT id FROM projects WHERE slug='getting-started') AND number=1) first").get() as { tasks: number; wiki: number; done: number; backlog: number; first: string };
    d3.close();
    expect(project.key).toBe("GS");
    expect(project.next_task_number).toBe(5);
    expect(counts).toMatchObject({ tasks: 5, wiki: 1, done: 1, backlog: 0, first: "GS-1" });
    expect((await mHandler(new Request("http://localhost:3000/api/setup/complete", { method: "POST" }))).status).toBe(200);
    rmSync(mDir, { recursive: true, force: true });
  }, 20000);
});
