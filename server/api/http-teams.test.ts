import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import type { auth as AuthInstance } from "../auth";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));
const ADMIN_KEY = "lxk_" + "a".repeat(43);

async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

let dir: string;
let dbPath: string;
let handler: (req: Request) => Promise<Response>;
let auth: typeof AuthInstance;
let adminCookie: string;
let memberCookie: string; // u2 — becomes team admin of team-a
let plainCookie: string; // u3 — plain member
const userIds: Record<string, string> = {};

const call = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
  handler(
    new Request(`http://lexa.test${path}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  );

const withKey = (method: string, path: string, body?: unknown) => call(method, path, { authorization: `Bearer ${ADMIN_KEY}` }, body);
const withCookie = (cookie: string, method: string, path: string, body?: unknown) => call(method, path, { cookie }, body);

async function signIn(email: string): Promise<string> {
  const res = (await auth.api.signInEmail({
    body: { email, password: "password123" },
    returnHeaders: true,
  })) as unknown as { headers?: Headers };
  return (res.headers?.get("set-cookie") ?? "").split(";")[0];
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "lexa-teams-api-"));
  dbPath = join(dir, "test.db");
  runMigrations(dbPath, MIGRATIONS);
  process.env.DATABASE_PATH = dbPath;
  process.env.LXK_PUBLIC_URL = "https://localhost:3000";
  ({ auth } = await import("../auth"));

  // Provision accounts through better-auth (real credential rows) so
  // sign-in works; then bind the admin key to the superadmin.
  const emails = ["sa@lexa.test", "member2@lexa.test", "member3@lexa.test", "member4@lexa.test"];
  for (const email of emails) {
    const u = await auth.api.createUser({
      body: { email, password: "password123", name: email.split("@")[0], data: { role: email.startsWith("sa") ? "superadmin" : "member" } },
    });
    userIds[email] = u.user.id;
  }
  const adminHash = await sha256(ADMIN_KEY);
  const db = new Database(dbPath);
  db.prepare("INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k1', 'admin-key', ?, ?)").run(adminHash, userIds["sa@lexa.test"]);
  db.prepare("INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k2', 'u3-key', ?, ?)").run("h".repeat(64), userIds["member3@lexa.test"]);
  db.close();

  const { createApiHandler } = await import("./http");
  handler = createApiHandler(dbPath);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("teams + workspace + sessions endpoints", () => {
  it("team admin creates a team (key = superadmin), member sessions are denied team creation", async () => {
    const res = await withKey("POST", "/api/teams", { name: "Team A" });
    expect(res.status).toBe(201);
    const team = (await res.json()) as { id: string; name: string; slug: string; createdAt: string };
    expect(team.name).toBe("Team A");
    expect(team.slug).toMatch(/^team-a-[0-9a-f]{6}$/);
    const db = new Database(dbPath);
    const owner = db.prepare("SELECT role FROM member WHERE organizationId = ? AND userId = ?").get(team.id, userIds["sa@lexa.test"]) as { role: string } | null;
    expect(owner?.role).toBe("owner");
    db.close();
  });

  it("member session cannot create a team (403)", async () => {
    const cookie = await signIn("member2@lexa.test");
    const res = await withCookie(cookie, "POST", "/api/teams", { name: "Nope" });
    expect(res.status).toBe(403);
  });

  it("team list: superadmin sees all, outsider sees none", async () => {
    const all = await withKey("GET", "/api/teams");
    expect(all.status).toBe(200);
    const body = (await all.json()) as { data: { name: string }[] };
    expect(body.data.some((t) => t.name === "Team A")).toBe(true);
    const cookie = await signIn("member3@lexa.test");
    const own = await withCookie(cookie, "GET", "/api/teams");
    expect((await own.json())).toEqual({ data: [] });
  });

  it("duplicate explicit slug → 409 SLUG_TAKEN", async () => {
    const first = await withKey("POST", "/api/teams", { name: "Alpha", slug: "alpha" });
    expect(first.status).toBe(201);
    const dup = await withKey("POST", "/api/teams", { name: "Beta", slug: "alpha" });
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as { error: { code: string } }).error.code).toBe("SLUG_TAKEN");
  });

  it("team admin adds existing workspace members; unknown email → 422 with details.available", async () => {
    const cookie = await signIn("member2@lexa.test");
    const teams = (await (await withKey("GET", "/api/teams")).json()) as { data: { id: string; name: string }[] };
    const teamA = teams.data.find((t) => t.name === "Team A")!;
    // u2 becomes a team-admin of team-a (added by the superadmin key)
    const add = await withKey("POST", `/api/teams/${teamA.id}/members`, { email: "member2@lexa.test", role: "admin" });
    expect(add.status).toBe(201);
    const added = (await add.json()) as { role: string };
    expect(added.role).toBe("admin");
    // u2 (team admin) adds u3 as member
    const add3 = await withCookie(cookie, "POST", `/api/teams/${teamA.id}/members`, { email: "member3@lexa.test", role: "member" });
    expect(add3.status).toBe(201);
    // unknown email → 422 with details.available
    const bad = await withKey("POST", `/api/teams/${teamA.id}/members`, { email: "ghost@lexa.test", role: "member" });
    expect(bad.status).toBe(422);
    const badBody = (await bad.json()) as { error: { code: string; details: { email: string; available: string[] } } };
    expect(badBody.error.code).toBe("NOT_WORKSPACE_MEMBER");
    expect(badBody.error.details.email).toBe("ghost@lexa.test");
    expect(Array.isArray(badBody.error.details.available)).toBe(true);
    // u2 (team admin) adds a fresh member u4
    const add4 = await withCookie(cookie, "POST", `/api/teams/${teamA.id}/members`, { email: "member4@lexa.test", role: "member" });
    expect(add4.status).toBe(201);
  });

  it("plain member cannot manage the team; team admin can", async () => {
    const cookie = await signIn("member3@lexa.test");
    const teams = (await (await withKey("GET", "/api/teams")).json()) as { data: { id: string; name: string }[] };
    const teamA = teams.data.find((t) => t.name === "Team A")!;
    const asPlain = await withCookie(cookie, "POST", `/api/teams/${teamA.id}/members`, { email: "sa@lexa.test", role: "member" });
    expect(asPlain.status).toBe(403);
    // plain members see NO teams (FE derives isTeamAdmin from teams.length > 0)
    const asPlainTeams = await withCookie(cookie, "GET", "/api/teams");
    expect(await asPlainTeams.json()).toEqual({ data: [] });
    // team-admin promotion: u2 already admin on team-a; u4 is a plain member now
    const adminCookie2 = await signIn("member2@lexa.test");
    // team admin sees their team in the list
    const adminTeams = await withCookie(adminCookie2, "GET", "/api/teams");
    const adminBody = (await adminTeams.json()) as { data: { id: string; name: string }[] };
    expect(adminBody.data.some((t) => t.id === teamA.id)).toBe(true);
    const asAdmin = await withCookie(adminCookie2, "PATCH", `/api/teams/${teamA.id}/members/${userIds["member4@lexa.test"]}`, { role: "admin" });
    expect(asAdmin.status).toBe(200);
  });

  it("demoting the last owner → 403 SOLE_OWNER", async () => {
    const teams = (await (await withKey("GET", "/api/teams")).json()) as { data: { id: string; name: string }[] };
    const teamA = teams.data.find((t) => t.name === "Team A")!;
    const res = await withKey("PATCH", `/api/teams/${teamA.id}/members/${userIds["sa@lexa.test"]}`, { role: "member" });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("SOLE_OWNER");
    // but demoting the admin to member is fine (u2 was owner-only? no — u1 is owner)
    const demote = await withKey("PATCH", `/api/teams/${teamA.id}/members/${userIds["member2@lexa.test"]}`, { role: "member" });
    expect(demote.status).toBe(200);
  });

  it("removing a member revokes team access; removing the last owner is blocked", async () => {
    const teams = (await (await withKey("GET", "/api/teams")).json()) as { data: { id: string; name: string }[] };
    const teamA = teams.data.find((t) => t.name === "Team A")!;
    const members = (await (await withKey("GET", `/api/teams/${teamA.id}/members`)).json()) as { data: { userId: string; name: string }[] };
    const u3Id = members.data.find((m) => m.userId === userIds["member3@lexa.test"]);
    expect(u3Id).toBeTruthy();
    const remove = await withKey("DELETE", `/api/teams/${teamA.id}/members/${userIds["member3@lexa.test"]}`);
    expect(remove.status).toBe(204);
    const after = (await (await withKey("GET", `/api/teams/${teamA.id}/members`)).json()) as { data: { userId: string }[] };
    expect(after.data.some((m) => m.userId === userIds["member3@lexa.test"])).toBe(false);
    const lastOwner = await withKey("DELETE", `/api/teams/${teamA.id}/members/${userIds["sa@lexa.test"]}`);
    expect(lastOwner.status).toBe(403);
    expect(((await lastOwner.json()) as { error: { code: string } }).error.code).toBe("SOLE_OWNER");
  });

  it("delete team blocked while it owns projects (409 TEAM_HAS_PROJECTS), then succeeds", async () => {
    const teams = (await (await withKey("GET", "/api/teams")).json()) as { data: { id: string; name: string }[] };
    const teamA = teams.data.find((t) => t.name === "Team A")!;
    const db = new Database(dbPath);
    db.prepare("INSERT INTO projects (id, name, slug, team_id) VALUES ('p-owned', 'Owned', 'owned', ?)").run(teamA.id);
    db.close();
    const blocked = await withKey("DELETE", `/api/teams/${teamA.id}`);
    expect(blocked.status).toBe(409);
    const body = (await blocked.json()) as { error: { code: string; details: { count: number } } };
    expect(body.error.code).toBe("TEAM_HAS_PROJECTS");
    expect(body.error.details.count).toBe(1);
    const db2 = new Database(dbPath);
    db2.prepare("DELETE FROM projects WHERE id = 'p-owned'").run();
    db2.close();
    const ok = await withKey("DELETE", `/api/teams/${teamA.id}`);
    expect(ok.status).toBe(204);
    // memberships cascaded
    const db3 = new Database(dbPath);
    const membersLeft = db3.prepare("SELECT COUNT(*) c FROM member WHERE organizationId = ?").get(teamA.id) as { c: number };
    db3.close();
    expect(membersLeft.c).toBe(0);
  });

  it("workspace members list carries teams + banned; deactivate kills sessions and blocks login, reactivate restores", async () => {
    const list = await withKey("GET", "/api/workspace/members");
    expect(list.status).toBe(200);
    const body = (await list.json()) as { data: { email: string; role: string; banned: boolean; teams: { teamName: string; role: string }[] }[] };
    const sa = body.data.find((m) => m.email === "sa@lexa.test");
    expect(sa?.role).toBe("superadmin");
    expect(sa?.banned).toBe(false);
    // sa owns the remaining team (Alpha — Team A was deleted above); the
    // members list carries team memberships
    expect(sa?.teams).toContainEqual(expect.objectContaining({ teamName: "Alpha", role: "owner" }));
    // H2: deactivation kills EXISTING sessions too (the ban hook only fires
    // on session CREATE) — sign in first, then deactivate, then the session
    // must be gone and new logins blocked.
    const preSignIn = (await auth.api.signInEmail({
      body: { email: "member3@lexa.test", password: "password123" },
      returnHeaders: true,
    })) as unknown as { headers?: Headers };
    const preCookie = (preSignIn.headers?.get?.("set-cookie") ?? "").split(";")[0];
    expect(preCookie).toMatch(/^__Secure-better-auth\.session_token=/);
    const deactivate = await withKey("PATCH", `/api/workspace/members/${userIds["member3@lexa.test"]}`, { action: "deactivate" });
    expect(deactivate.status).toBe(200);
    const listAfter = await withKey("GET", "/api/workspace/members");
    const bodyAfter = (await listAfter.json()) as { data: { email: string; banned: boolean }[] };
    expect(bodyAfter.data.find((m) => m.email === "member3@lexa.test")?.banned).toBe(true);
    const liveSession = await auth.api.getSession({ headers: new Headers({ cookie: preCookie }) });
    expect(liveSession).toBeNull();
    const blocked = await auth.api.signInEmail({ body: { email: "member3@lexa.test", password: "password123" } }).catch((e) => e);
    expect((blocked as { status?: string }).status ?? 200).not.toBe(200);
    const reactivate = await withKey("PATCH", `/api/workspace/members/${userIds["member3@lexa.test"]}`, { action: "reactivate" });
    expect(reactivate.status).toBe(200);
    const ok = await auth.api.signInEmail({ body: { email: "member3@lexa.test", password: "password123" } });
    expect(ok.user.email).toBe("member3@lexa.test");
  });

  it("cannot deactivate/delete yourself (403)", async () => {
    const res = await withKey("PATCH", `/api/workspace/members/${userIds["sa@lexa.test"]}`, { action: "deactivate" });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("CANNOT_DELETE_SELF");
    const del = await withKey("DELETE", `/api/workspace/members/${userIds["sa@lexa.test"]}`);
    expect(del.status).toBe(403);
  });

  it("deleting a member revokes their bound api keys", async () => {
    const del = await withKey("DELETE", `/api/workspace/members/${userIds["member3@lexa.test"]}`);
    expect(del.status).toBe(204);
    const db = new Database(dbPath);
    const key = db.prepare("SELECT id FROM api_keys WHERE user_id = ?").get(userIds["member3@lexa.test"]);
    db.close();
    expect(key).toBeNull();
    const missing = await withKey("DELETE", `/api/workspace/members/${userIds["member3@lexa.test"]}`);
    expect(missing.status).toBe(404);
  });

  it("invites: create → link, duplicate → 409, revoke → 204; accepted invite cannot be revoked (409)", async () => {
    const created = await withKey("POST", "/api/workspace/invites", { email: "newbie@lexa.dev" });
    expect(created.status).toBe(201);
    const { link } = (await created.json()) as { link: string };
    expect(link).toMatch(/^https:\/\/localhost:3000\/invite\?token=/);
    const token = link.split("token=")[1];
    const dup = await withKey("POST", "/api/workspace/invites", { email: "newbie@lexa.dev" });
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as { error: { code: string } }).error.code).toBe("INVITE_PENDING");
    // pending list: the invite shows up; member sessions are denied
    const list = await withKey("GET", "/api/workspace/invites");
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { data: { id: string; email: string; expiresAt: string }[] };
    const listed = listBody.data.find((i) => i.email === "newbie@lexa.dev");
    expect(listed).toBeTruthy();
    expect(listed!.expiresAt).toBeTruthy();
    expect(listed!.id).toBeTruthy();
    const memberList = await withCookie(await signIn("member2@lexa.test"), "GET", "/api/workspace/invites");
    expect(memberList.status).toBe(403);
    // revoke the pending invite
    const db = new Database(dbPath);
    const row = db.prepare("SELECT id FROM workspace_invitations WHERE token = ?").get(token) as { id: string };
    db.close();
    const revoked = await withKey("DELETE", `/api/workspace/invites/${row.id}`);
    expect(revoked.status).toBe(204);
    const again = await withKey("DELETE", `/api/workspace/invites/${row.id}`);
    expect(again.status).toBe(404);
    // an accepted invite is not revocable
    const created2 = await withKey("POST", "/api/workspace/invites", { email: "acceptee@lexa.dev" });
    const { link: link2 } = (await created2.json()) as { link: string };
    const token2 = link2.split("token=")[1];
    const acceptRes = await auth.handler(new Request("http://localhost:3000/api/auth/invite/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: token2, name: "Acceptee", password: "password123" }),
    }));
    expect(acceptRes.status).toBe(200);
    const db2 = new Database(dbPath);
    const row2 = db2.prepare("SELECT id FROM workspace_invitations WHERE token = ?").get(token2) as { id: string };
    db2.close();
    const acceptedRevoke = await withKey("DELETE", `/api/workspace/invites/${row2.id}`);
    expect(acceptedRevoke.status).toBe(409);
    // accepted invites drop out of the pending list
    const afterAccept = await withKey("GET", "/api/workspace/invites");
    const afterBody = (await afterAccept.json()) as { data: { email: string }[] };
    expect(afterBody.data.some((i) => i.email === "acceptee@lexa.dev")).toBe(false);
  });

  it("set-password-link issues a single-use link", async () => {
    const res = await withKey("POST", `/api/workspace/members/${userIds["member2@lexa.test"]}/set-password-link`);
    expect(res.status).toBe(201);
    const { link } = (await res.json()) as { link: string };
    expect(link).toMatch(/^https:\/\/localhost:3000\/set-password\?token=/);
    const missing = await withKey("POST", "/api/workspace/members/ghost/set-password-link");
    expect(missing.status).toBe(404);
  });

  it("sessions: own list, own revoke, foreign revoke → 404", async () => {
    const cookie = await signIn("member2@lexa.test");
    const list = await withCookie(cookie, "GET", "/api/sessions");
    expect(list.status).toBe(200);
    const body = (await list.json()) as { data: { id: string; ipAddress: string | null; userAgent: string | null; expiresAt: string }[] };
    expect(body.data.length).toBeGreaterThan(0);
    const [first] = body.data;
    expect(first.id).toBeTruthy();
    expect(first.expiresAt).toBeTruthy();
    // foreign session id → 404
    const foreign = await withCookie(cookie, "POST", "/api/sessions/not-mine/revoke");
    expect(foreign.status).toBe(404);
    // revoke own → 204, then the cookie dies
    const revoked = await withCookie(cookie, "POST", `/api/sessions/${first.id}/revoke`);
    expect(revoked.status).toBe(204);
    const after = await withCookie(cookie, "GET", "/api/sessions");
    expect(after.status).toBe(401);
  });
});
