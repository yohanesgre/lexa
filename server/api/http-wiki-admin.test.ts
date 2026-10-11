import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { createApiHandler } from "./http";
import { PUBLIC_URL } from "../auth";
import type { auth as AuthInstance } from "../auth";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

const ADMIN_KEY = "lxk_" + "a".repeat(43);
const MEMBER_KEY = "lxk_" + "m".repeat(43);
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
let db: Database;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "lexa-wiki-admin-api-"));
  const dbPath = join(dir, "test.db");
  runMigrations(dbPath, MIGRATIONS);
  const adminHash = await sha256(ADMIN_KEY);
  const memberHash = await sha256(MEMBER_KEY);
  const serverHash = await sha256(SERVER_KEY);
  db = new Database(dbPath);
  db.exec(`
INSERT INTO users (id, email, name, role) VALUES ('u1', 'maria@lexa.test', 'Maria', 'member'), ('u3', 'pam@lexa.test', 'Pam', 'member'), ('u0', 'root@lexa.test', 'Root', 'superadmin');
INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k1', 'test-admin', '${adminHash}', 'u0');
INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k2', 'test-member', '${memberHash}', 'u3');
INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k3', 'test-server', '${serverHash}', NULL);
INSERT INTO projects (id, name, slug) VALUES ('p1', 'P', 'p1');
INSERT INTO projects (id, name, slug) VALUES ('p2', 'Q', 'p2');
INSERT INTO wiki_pages (id, project_id, title, slug, content, content_text, position) VALUES ('w1', 'p1', 'Home', 'home', '{"type":"doc","content":[]}', 'hello world', 0);
INSERT INTO wiki_pages (id, project_id, title, slug, content, content_text, parent_id, position) VALUES ('w2', 'p1', 'Child', 'child', '{"type":"doc","content":[]}', 'child page', 'w1', 0);
`);
  handler = createApiHandler(dbPath);
});

afterAll(() => {
  try { db.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

const json = (method: string, path: string, body?: unknown, key: string = ADMIN_KEY) =>
  new Request(`http://lexa.test${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

const pub = (path: string) => new Request(`http://lexa.test${path}`);

describe("wiki routes", () => {
  it("list pages; create (201) + unknown project 404; duplicate slug 409; DELETE HAS_CHILDREN/leaf 204; FTS hit + invalid syntax 422", async () => {
    const listRes = await handler(json("GET", "/api/projects/p1/wiki"));
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json();
    expect(listBody.data.map((p: { slug: string }) => p.slug)).toEqual(["home", "child"]);
    expect(listBody.data[0]!.hasChildren).toBe(true);

    const ok = await handler(json("POST", "/api/projects/p1/wiki", { title: "New Page", slug: "new-page" }));
    expect(ok.status).toBe(201);
    expect(await ok.json()).toMatchObject({ title: "New Page", slug: "new-page", projectId: "p1" });
    const missing = await handler(json("POST", "/api/projects/nope/wiki", { title: "X" }));
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe("PROJECT_NOT_FOUND");

    const dupe = await handler(json("POST", "/api/projects/p1/wiki", { title: "Home Again", slug: "home" }));
    expect(dupe.status).toBe(409);
    expect((await dupe.json()).error.code).toBe("SLUG_TAKEN");

    const blocked = await handler(json("DELETE", "/api/projects/p1/wiki/home"));
    expect(blocked.status).toBe(409);
    const blockedBody = await blocked.json();
    expect(blockedBody.error.code).toBe("HAS_CHILDREN");
    expect(blockedBody.error.details.count).toBeGreaterThan(0);
    const leaf = await handler(json("POST", "/api/projects/p1/wiki", { title: "Leaf", slug: "leaf" }));
    const { slug } = await leaf.json();
    const del = await handler(json("DELETE", `/api/projects/p1/wiki/${slug}`));
    expect(del.status).toBe(204);
    expect(await del.text()).toBe("");

    const search = await handler(json("GET", "/api/projects/p1/wiki/search?q=hello"));
    expect(search.status).toBe(200);
    const searchBody = await search.json();
    expect(searchBody.data.length).toBeGreaterThan(0);
    expect(searchBody.data[0]!.slug).toBe("home");
    expect(searchBody.data[0]!.snippet).toContain("hello");

    const bad = await handler(json("GET", "/api/projects/p1/wiki/search?q=%22unbalanced"));
    expect(bad.status).toBe(422);
    expect((await bad.json()).error.code).toBe("SEARCH_ERROR");
  });
});

describe("settings api-keys routes", () => {
  it("mint returns the raw key once (201) and it works; DELETE → 204 stops it; server key cannot mint → 403 NO_USER_CONTEXT", async () => {
    const res = await handler(json("POST", "/api/settings/api-keys", { name: "ops" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.key.name).toBe("ops");
    expect(body.rawKey).toMatch(/^lxk_[0-9A-Za-z]{43}$/);
    const health = await handler(new Request("http://lexa.test/api/health", {
      headers: { authorization: `Bearer ${body.rawKey}` },
    }));
    expect(health.status).toBe(200);

    const del = await handler(json("DELETE", `/api/settings/api-keys/${body.key.id}`));
    expect(del.status).toBe(204);
    expect(await del.text()).toBe("");
    const after = await handler(new Request("http://lexa.test/api/projects", {
      headers: { authorization: `Bearer ${body.rawKey}` },
    }));
    expect(after.status).toBe(401);

    const serverKey = await handler(json("POST", "/api/settings/api-keys", { name: "sneaky" }, SERVER_KEY));
    expect(serverKey.status).toBe(403);
    expect((await serverKey.json()).error.code).toBe("NO_USER_CONTEXT");
  });
});

describe("wiki share-link routes", () => {
  it("share → 201 link never returns the token (link or list); DELETE via another project's path does not revoke (no cross-project IDOR)", async () => {
    const res = await handler(json("POST", "/api/projects/p1/wiki/pages/home/share", {}));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.link).toMatchObject({
      id: expect.any(String),
      url: expect.any(String),
      expiresAt: null,
      createdAt: expect.any(String),
    });
    expect(body.link.url.startsWith(`${PUBLIC_URL}/share/`)).toBe(true);
    expect(body.link.token).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("token");

    const listRes = await handler(json("GET", "/api/projects/p1/wiki/pages/home/share"));
    const list = await listRes.json();
    expect(list.data.length).toBeGreaterThan(0);
    for (const link of list.data) {
      expect(link.url.startsWith(`${PUBLIC_URL}/share/`)).toBe(true);
      expect(link.token).toBeUndefined();
    }

    const created = await handler(json("POST", "/api/projects/p1/wiki/pages/home/share", {}));
    const { link } = await created.json();
    const unknown = await handler(json("DELETE", "/api/projects/p1/wiki/share/nope"));
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).error.code).toBe("SHARE_LINK_NOT_FOUND");

    const wrongProject = await handler(json("DELETE", `/api/projects/p2/wiki/share/${link.id}`));
    expect(wrongProject.status).toBe(404);
    expect((await wrongProject.json()).error.code).toBe("SHARE_LINK_NOT_FOUND");
    const stillListed = await handler(json("GET", "/api/projects/p1/wiki/pages/home/share"));
    expect((await stillListed.json()).data.length).toBeGreaterThan(0);

    expect((await handler(json("DELETE", `/api/projects/p1/wiki/share/${link.id}`))).status).toBe(204);
  });
});

describe("public GET /api/share/:token", () => {
  async function createLink(expiresAt?: string): Promise<{ id: string; token: string }> {
    const res = await handler(json("POST", "/api/projects/p1/wiki/pages/home/share", expiresAt ? { expiresAt } : {}));
    expect(res.status).toBe(201);
    const body = await res.json();
    const token = (body.link.url).split("/share/")[1]!;
    return { id: body.link.id, token };
  }

  it("valid token → 200 root + descendant subtree without auth; expired/revoked indistinguishable 404; burst → 429 share bucket", async () => {
    const { token } = await createLink();
    const res = await handler(pub(`/api/share/${token}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.root).toMatchObject({ id: "w1", title: "Home", slug: "home" });
    expect(body.root.content).toEqual({ type: "doc", content: [] });
    const child = (body.root.children as Array<Record<string, unknown>>).find((c) => c.id === "w2");
    expect(child).toMatchObject({ title: "Child", slug: "child" });

    const unknown = await handler(pub("/api/share/nope"));
    expect(unknown.status).toBe(404);
    const u = await unknown.json();

    const expired = await handler(pub(`/api/share/${(await createLink("2020-01-01T00:00:00.000Z")).token}`));
    expect(expired.status).toBe(404);
    expect((await expired.json()).error.code).toBe(u.error.code);
    expect(u.error.code).toBe("SHARE_LINK_NOT_FOUND");

    const revokedLink = await createLink();
    expect((await handler(json("DELETE", `/api/projects/p1/wiki/share/${revokedLink.id}`))).status).toBe(204);
    const revoked = await handler(pub(`/api/share/${revokedLink.token}`));
    expect(revoked.status).toBe(404);
    expect((await revoked.json()).error.code).toBe("SHARE_LINK_NOT_FOUND");

    let saw429 = false;
    for (let i = 0; i < 45; i++) {
      const burst = await handler(pub("/api/share/nope"));
      if (burst.status === 429) {
        saw429 = true;
        break;
      }
      expect(burst.status).toBe(404);
    }
    expect(saw429).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Absorbed from http-teams.test.ts — teams + workspace + sessions endpoints,
// with its own tmp DB + session/cookie fixtures.
// ---------------------------------------------------------------------------

let tmDir: string;
let tmDbPath: string;
let tmHandler: (req: Request) => Promise<Response>;
let tmAuth: typeof AuthInstance;
const tmUserIds: Record<string, string> = {};
let tmMemberCookie: string; // u2 — becomes team admin of team-a
let tmPlainCookie: string; // u3 — plain member

describe("teams + workspace + sessions endpoints", () => {
  const tmCall = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
    tmHandler(
      new Request(`http://lexa.test${path}`, {
        method,
        headers: { "content-type": "application/json", ...headers },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      })
    );

  const tmWithKey = (method: string, path: string, body?: unknown) =>
    tmCall(method, path, { authorization: `Bearer ${ADMIN_KEY}` }, body);
  const tmWithCookie = (cookie: string, method: string, path: string, body?: unknown) =>
    tmCall(method, path, { cookie }, body);

  async function tmSignIn(email: string): Promise<string> {
    const res = (await tmAuth.api.signInEmail({
      body: { email, password: "password123" },
      returnHeaders: true,
    })) as unknown as { headers?: Headers };
    return (res.headers?.get("set-cookie") ?? "").split(";")[0]!;
  }

  // Full browser cookie jar: session_token AND the cached session_data cookie.
  // Tests that want the cookieCache path (stale role/session) must send both.
  async function tmSignInFull(email: string): Promise<string> {
    const res = (await tmAuth.api.signInEmail({
      body: { email, password: "password123" },
      returnHeaders: true,
    })) as unknown as { headers?: Headers };
    return (res.headers?.getSetCookie?.() ?? []).join("; ");
  }

  beforeAll(async () => {
    tmDir = mkdtempSync(join(tmpdir(), "lexa-teams-api-"));
    tmDbPath = join(tmDir, "test.db");
    // auth.ts caches one better-auth singleton per module registry, bound to
    // DATABASE_PATH at first use. Reset the registry so this block's sessions
    // bind to its own DB rather than the target file's already-initialized one.
    vi.resetModules();
    process.env.DATABASE_PATH = tmDbPath;
    process.env.LXK_PUBLIC_URL = "https://localhost:3000";
    const { runMigrations: tmRunMigrations } = await import("../db/migrate");
    const { createApiHandler: tmCreateApiHandler } = await import("./http");
    tmRunMigrations(tmDbPath, MIGRATIONS);
    ({ auth: tmAuth } = await import("../auth"));

    // Provision accounts through better-auth (real credential rows) so
    // sign-in works; then bind the admin key to the superadmin.
    const emails = ["sa@lexa.test", "member2@lexa.test", "member3@lexa.test", "member4@lexa.test", "ghostuser@lexa.test"];
    for (const email of emails) {
      const u = await tmAuth.api.createUser({
        body: { email, password: "password123", name: email.split("@")[0]!, data: { role: email.startsWith("sa") ? "superadmin" : "member" } },
      });
      tmUserIds[email] = u.user.id;
    }
    const adminHash = await sha256(ADMIN_KEY);
    const tdb = new Database(tmDbPath);
    tdb.prepare("INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k1', 'admin-key', ?, ?)").run(adminHash, tmUserIds["sa@lexa.test"]);
    tdb.prepare("INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k2', 'u3-key', ?, ?)").run("h".repeat(64), tmUserIds["member3@lexa.test"]);
    tdb.close();

    tmHandler = tmCreateApiHandler(tmDbPath);
  });

  afterAll(() => {
    rmSync(tmDir, { recursive: true, force: true });
  });

  it("create team (owner) / dup slug 409 / rename success, 403, 404, 422 + team-admin session rename", async () => {
    const res = await tmWithKey("POST", "/api/teams", { name: "Team A" });
    expect(res.status).toBe(201);
    const team = (await res.json()) as { id: string; name: string; slug: string; createdAt: string };
    expect(team.name).toBe("Team A");
    expect(team.slug).toMatch(/^team-a-[0-9a-f]{6}$/);
    const tdb = new Database(tmDbPath);
    const owner = tdb.prepare("SELECT role FROM member WHERE organizationId = ? AND userId = ?").get(team.id, tmUserIds["sa@lexa.test"]) as { role: string } | null;
    tdb.close();
    expect(owner?.role).toBe("owner");
    const denied = await tmWithCookie(await tmSignIn("member2@lexa.test"), "POST", "/api/teams", { name: "Nope" });
    expect(denied.status).toBe(403);

    const first = await tmWithKey("POST", "/api/teams", { name: "Alpha", slug: "alpha" });
    expect(first.status).toBe(201);
    const dup = await tmWithKey("POST", "/api/teams", { name: "Beta", slug: "alpha" });
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as { error: { code: string } }).error.code).toBe("SLUG_TAKEN");

    const created = await tmWithKey("POST", "/api/teams", { name: "Renamable" });
    expect(created.status).toBe(201);
    const renamable = (await created.json()) as { id: string; name: string; slug: string };
    const renamed = await tmWithKey("PATCH", `/api/teams/${renamable.id}`, { name: "Renamed Team" });
    expect(renamed.status).toBe(200);
    const renamedBody = (await renamed.json()) as { id: string; name: string; slug: string };
    expect(renamedBody.id).toBe(renamable.id);
    expect(renamedBody.name).toBe("Renamed Team");
    expect(renamedBody.slug).toBe(renamable.slug);
    const renameDenied = await tmWithCookie(await tmSignIn("member3@lexa.test"), "PATCH", `/api/teams/${renamable.id}`, { name: "Hijack" });
    expect(renameDenied.status).toBe(403);
    expect(((await renameDenied.json()) as { error: { code: string } }).error.code).toBe("FORBIDDEN");
    const renameMissing = await tmWithKey("PATCH", "/api/teams/does-not-exist", { name: "Ghost" });
    expect(renameMissing.status).toBe(404);
    expect(((await renameMissing.json()) as { error: { code: string } }).error.code).toBe("TEAM_NOT_FOUND");
    for (const name of ["   ", "x".repeat(81)]) {
      const bad = await tmWithKey("PATCH", `/api/teams/${renamable.id}`, { name });
      expect(bad.status).toBe(422);
      expect(((await bad.json()) as { error: { code: string } }).error.code).toBe("INVALID_NAME");
    }
    const promote = await tmWithKey("POST", `/api/teams/${renamable.id}/members`, { email: "member2@lexa.test", role: "admin" });
    expect(promote.status).toBe(201);
    const asAdmin = await tmWithCookie(await tmSignIn("member2@lexa.test"), "PATCH", `/api/teams/${renamable.id}`, { name: "Renamed by Team Admin" });
    expect(asAdmin.status).toBe(200);
    expect(((await asAdmin.json()) as { name: string }).name).toBe("Renamed by Team Admin");
  });

  it("cookieCache staleness closed: demoted superadmin 403 immediately; deleted account fails closed → 401", async () => {
    const cookie = await tmSignInFull("sa@lexa.test");
    const before = await tmWithCookie(cookie, "POST", "/api/projects", { name: "Demotion Probe", slug: "demotion-probe" });
    expect(before.status).toBe(201);
    const tdb = new Database(tmDbPath);
    tdb.prepare("UPDATE users SET role = 'member' WHERE id = ?").run(tmUserIds["sa@lexa.test"]);
    tdb.close();
    // The cached session still reports superadmin — proving the request above
    // took the cookieCache path, so the middleware's DB re-read is what denies.
    const stale = await tmAuth.api.getSession({ headers: new Headers({ cookie }) });
    expect((stale?.user as { role?: string } | undefined)?.role).toBe("superadmin");
    try {
      const after = await tmWithCookie(cookie, "POST", "/api/projects", { name: "Demotion Probe 2", slug: "demotion-probe-2" });
      expect(after.status).toBe(403);
      expect(((await after.json()) as { error: { code: string } }).error.code).toBe("FORBIDDEN");
    } finally {
      const restore = new Database(tmDbPath);
      restore.prepare("UPDATE users SET role = 'superadmin' WHERE id = ?").run(tmUserIds["sa@lexa.test"]);
      restore.close();
    }

    const ghostCookie = await tmSignInFull("ghostuser@lexa.test");
    const tdb2 = new Database(tmDbPath);
    tdb2.prepare("DELETE FROM users WHERE id = ?").run(tmUserIds["ghostuser@lexa.test"]);
    tdb2.close();
    // The cached session still resolves the user (cookieCache hit, no DB) —
    // the middleware's per-request role re-read finds no row → null identity.
    const cached = await tmAuth.api.getSession({ headers: new Headers({ cookie: ghostCookie }) });
    expect(cached?.user?.id).toBe(tmUserIds["ghostuser@lexa.test"]);
    expect((await tmWithCookie(ghostCookie, "GET", "/api/sessions")).status).toBe(401);
  });

  it("members: add/unknown 422/plain member; SOLE_OWNER last-owner demote+remove; remove revokes access; delete team blocked by projects then succeeds", async () => {
    tmMemberCookie = await tmSignIn("member2@lexa.test");
    const teams = (await (await tmWithKey("GET", "/api/teams")).json()) as { data: { id: string; name: string }[] };
    expect(teams.data.some((t) => t.name === "Team A")).toBe(true);
    const teamA = teams.data.find((t) => t.name === "Team A")!;
    const add = await tmWithKey("POST", `/api/teams/${teamA.id}/members`, { email: "member2@lexa.test", role: "admin" });
    expect(add.status).toBe(201);
    expect(((await add.json()) as { role: string }).role).toBe("admin");
    expect((await tmWithCookie(tmMemberCookie, "POST", `/api/teams/${teamA.id}/members`, { email: "member3@lexa.test", role: "member" })).status).toBe(201);
    expect((await tmWithCookie(tmMemberCookie, "POST", `/api/teams/${teamA.id}/members`, { email: "member4@lexa.test", role: "member" })).status).toBe(201);
    const bad = await tmWithKey("POST", `/api/teams/${teamA.id}/members`, { email: "ghost@lexa.test", role: "member" });
    expect(bad.status).toBe(422);
    const badBody = (await bad.json()) as { error: { code: string; details: { email: string; available: string[] } } };
    expect(badBody.error.code).toBe("NOT_WORKSPACE_MEMBER");
    expect(badBody.error.details.email).toBe("ghost@lexa.test");
    expect(Array.isArray(badBody.error.details.available)).toBe(true);
    tmPlainCookie = await tmSignIn("member3@lexa.test");
    const asPlain = await tmWithCookie(tmPlainCookie, "POST", `/api/teams/${teamA.id}/members`, { email: "sa@lexa.test", role: "member" });
    expect(asPlain.status).toBe(403);
    expect(await (await tmWithCookie(tmPlainCookie, "GET", "/api/teams")).json()).toEqual({ data: [] });
    const adminTeams = (await (await tmWithCookie(tmMemberCookie, "GET", "/api/teams")).json()) as { data: { id: string }[] };
    expect(adminTeams.data.some((t) => t.id === teamA.id)).toBe(true);

    const sole = await tmWithKey("PATCH", `/api/teams/${teamA.id}/members/${tmUserIds["sa@lexa.test"]}`, { role: "member" });
    expect(sole.status).toBe(403);
    expect(((await sole.json()) as { error: { code: string } }).error.code).toBe("SOLE_OWNER");
    expect((await tmWithKey("PATCH", `/api/teams/${teamA.id}/members/${tmUserIds["member2@lexa.test"]}`, { role: "member" })).status).toBe(200);
    const members = (await (await tmWithKey("GET", `/api/teams/${teamA.id}/members`)).json()) as { data: { userId: string }[] };
    expect(members.data.some((m) => m.userId === tmUserIds["member3@lexa.test"])).toBe(true);
    expect((await tmWithKey("DELETE", `/api/teams/${teamA.id}/members/${tmUserIds["member3@lexa.test"]}`)).status).toBe(204);
    const after = (await (await tmWithKey("GET", `/api/teams/${teamA.id}/members`)).json()) as { data: { userId: string }[] };
    expect(after.data.some((m) => m.userId === tmUserIds["member3@lexa.test"])).toBe(false);
    const lastOwner = await tmWithKey("DELETE", `/api/teams/${teamA.id}/members/${tmUserIds["sa@lexa.test"]}`);
    expect(lastOwner.status).toBe(403);
    expect(((await lastOwner.json()) as { error: { code: string } }).error.code).toBe("SOLE_OWNER");

    const tdb = new Database(tmDbPath);
    tdb.prepare("INSERT INTO projects (id, name, slug, team_id) VALUES ('p-owned', 'Owned', 'owned', ?)").run(teamA.id);
    tdb.close();
    const blocked = await tmWithKey("DELETE", `/api/teams/${teamA.id}`);
    expect(blocked.status).toBe(409);
    const blockedBody = (await blocked.json()) as { error: { code: string; details: { count: number } } };
    expect(blockedBody.error.code).toBe("TEAM_HAS_PROJECTS");
    expect(blockedBody.error.details.count).toBe(1);
    const tdb2 = new Database(tmDbPath);
    tdb2.prepare("DELETE FROM projects WHERE id = 'p-owned'").run();
    tdb2.close();
    expect((await tmWithKey("DELETE", `/api/teams/${teamA.id}`)).status).toBe(204);
    const tdb3 = new Database(tmDbPath);
    const membersLeft = tdb3.prepare("SELECT COUNT(*) c FROM member WHERE organizationId = ?").get(teamA.id) as { c: number };
    tdb3.close();
    expect(membersLeft.c).toBe(0);
  });

  it("workspace members carry teams+banned; deactivate kills sessions and blocks login; cannot delete self; delete revokes api keys", async () => {
    const list = await tmWithKey("GET", "/api/workspace/members");
    expect(list.status).toBe(200);
    const body = (await list.json()) as { data: { email: string; role: string; banned: boolean; teams: { teamName: string; role: string }[] }[] };
    const sa = body.data.find((m) => m.email === "sa@lexa.test");
    expect(sa?.role).toBe("superadmin");
    expect(sa?.banned).toBe(false);
    // sa owns the remaining team (Alpha — Team A was deleted above)
    expect(sa?.teams).toContainEqual(expect.objectContaining({ teamName: "Alpha", role: "owner" }));
    // H2: deactivation kills EXISTING sessions too (the ban hook only fires on
    // session CREATE) — sign in first, then deactivate.
    const preSignIn = (await tmAuth.api.signInEmail({
      body: { email: "member3@lexa.test", password: "password123" },
      returnHeaders: true,
    })) as unknown as { headers?: Headers };
    const preCookies = preSignIn.headers?.getSetCookie?.() ?? [];
    expect(preCookies.some((c) => c.startsWith("__Secure-better-auth.session_data="))).toBe(true);
    const preCookie = (preCookies.find((c) => c.startsWith("__Secure-better-auth.session_token=")) ?? "").split(";")[0]!;
    expect((await tmWithKey("PATCH", `/api/workspace/members/${tmUserIds["member3@lexa.test"]}`, { action: "deactivate" })).status).toBe(200);
    const listAfter = (await (await tmWithKey("GET", "/api/workspace/members")).json()) as { data: { email: string; banned: boolean }[] };
    expect(listAfter.data.find((m) => m.email === "member3@lexa.test")?.banned).toBe(true);
    expect(await tmAuth.api.getSession({ headers: new Headers({ cookie: preCookie }) })).toBeNull();
    const blocked = await tmAuth.api.signInEmail({ body: { email: "member3@lexa.test", password: "password123" } }).catch((e) => e);
    expect((blocked as { status?: string }).status ?? 200).not.toBe(200);
    expect((await tmWithKey("PATCH", `/api/workspace/members/${tmUserIds["member3@lexa.test"]}`, { action: "reactivate" })).status).toBe(200);
    const okLogin = await tmAuth.api.signInEmail({ body: { email: "member3@lexa.test", password: "password123" } });
    expect(okLogin.user.email).toBe("member3@lexa.test");

    const self = await tmWithKey("PATCH", `/api/workspace/members/${tmUserIds["sa@lexa.test"]}`, { action: "deactivate" });
    expect(self.status).toBe(403);
    expect(((await self.json()) as { error: { code: string } }).error.code).toBe("CANNOT_DELETE_SELF");
    expect((await tmWithKey("DELETE", `/api/workspace/members/${tmUserIds["sa@lexa.test"]}`)).status).toBe(403);

    expect((await tmWithKey("DELETE", `/api/workspace/members/${tmUserIds["member3@lexa.test"]}`)).status).toBe(204);
    const tdb = new Database(tmDbPath);
    const key = tdb.prepare("SELECT id FROM api_keys WHERE user_id = ?").get(tmUserIds["member3@lexa.test"]);
    tdb.close();
    expect(key).toBeNull();
    expect((await tmWithKey("DELETE", `/api/workspace/members/${tmUserIds["member3@lexa.test"]}`)).status).toBe(404);
  });

  it("invites create/dup/revoke/accepted; set-password-link; sessions own list/revoke, foreign revoke → 404", async () => {
    const created = await tmWithKey("POST", "/api/workspace/invites", { email: "newbie@lexa.dev" });
    expect(created.status).toBe(201);
    const { link } = (await created.json()) as { link: string };
    expect(link).toMatch(/^https:\/\/localhost:3000\/invite\?token=/);
    const token = link.split("token=")[1];
    const dup = await tmWithKey("POST", "/api/workspace/invites", { email: "newbie@lexa.dev" });
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as { error: { code: string } }).error.code).toBe("INVITE_PENDING");
    const listBody = (await (await tmWithKey("GET", "/api/workspace/invites")).json()) as { data: { id: string; email: string; expiresAt: string }[] };
    const listed = listBody.data.find((i) => i.email === "newbie@lexa.dev");
    expect(listed?.expiresAt).toBeTruthy();
    expect(listed?.id).toBeTruthy();
    expect((await tmWithCookie(tmMemberCookie, "GET", "/api/workspace/invites")).status).toBe(403);
    const tdb = new Database(tmDbPath);
    const row = tdb.prepare("SELECT id FROM workspace_invitations WHERE token = ?").get(token) as { id: string };
    tdb.close();
    expect((await tmWithKey("DELETE", `/api/workspace/invites/${row.id}`)).status).toBe(204);
    expect((await tmWithKey("DELETE", `/api/workspace/invites/${row.id}`)).status).toBe(404);

    const created2 = await tmWithKey("POST", "/api/workspace/invites", { email: "acceptee@lexa.dev" });
    const { link: link2 } = (await created2.json()) as { link: string };
    const token2 = link2.split("token=")[1];
    const acceptRes = await tmAuth.handler(new Request("http://localhost:3000/api/auth/invite/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: token2, name: "Acceptee", password: "password123" }),
    }));
    expect(acceptRes.status).toBe(200);
    const tdb2 = new Database(tmDbPath);
    const row2 = tdb2.prepare("SELECT id FROM workspace_invitations WHERE token = ?").get(token2) as { id: string };
    tdb2.close();
    expect((await tmWithKey("DELETE", `/api/workspace/invites/${row2.id}`)).status).toBe(409);
    const afterBody = (await (await tmWithKey("GET", "/api/workspace/invites")).json()) as { data: { email: string }[] };
    expect(afterBody.data.some((i) => i.email === "acceptee@lexa.dev")).toBe(false);
    const spRes = await tmWithKey("POST", `/api/workspace/members/${tmUserIds["member2@lexa.test"]}/set-password-link`);
    expect(spRes.status).toBe(201);
    expect(((await spRes.json()) as { link: string }).link).toMatch(/^https:\/\/localhost:3000\/set-password\?token=/);
    expect((await tmWithKey("POST", "/api/workspace/members/ghost/set-password-link")).status).toBe(404);

    const cookie = await tmSignIn("member2@lexa.test");
    const list = await tmWithCookie(cookie, "GET", "/api/sessions");
    expect(list.status).toBe(200);
    const sessions = (await list.json()) as { data: { id: string; ipAddress: string | null; userAgent: string | null; expiresAt: string }[] };
    expect(sessions.data.length).toBeGreaterThan(0);
    const [first] = sessions.data;
    expect(first!.id).toBeTruthy();
    expect(first!.expiresAt).toBeTruthy();
    expect((await tmWithCookie(cookie, "POST", "/api/sessions/not-mine/revoke")).status).toBe(404);
    expect((await tmWithCookie(cookie, "POST", `/api/sessions/${first!.id}/revoke`)).status).toBe(204);
    expect((await tmWithCookie(cookie, "GET", "/api/sessions")).status).toBe(401);
  });
});
