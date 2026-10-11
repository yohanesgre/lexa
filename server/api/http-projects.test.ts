import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { createApiHandler } from "./http";
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
let db: Database;
let handler: (req: Request) => Promise<Response>;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "lexa-projects-api-"));
  dbPath = join(dir, "test.db");
  runMigrations(dbPath, MIGRATIONS);
  const adminHash = await sha256(ADMIN_KEY);
  db = new Database(dbPath);
  db.exec(`
INSERT INTO users (id, email, name, role) VALUES ('u1', 'maria@lexa.test', 'Maria', 'member'), ('u3', 'pam@lexa.test', 'Pam', 'member');
INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k1', 'test-admin', '${adminHash}', NULL);
INSERT INTO organization (id, name, slug, createdAt) VALUES ('team-a', 'Team A', 'team-a', '2026-01-01T00:00:00.000Z');
INSERT INTO projects (id, name, slug, key, next_task_number) VALUES ('p1', 'P', 'p1', 'EG', 2);
INSERT INTO columns (id, project_id, name, position) VALUES ('c1', 'p1', 'Todo', 0), ('c2', 'p1', 'Done', 1);
INSERT INTO swimlanes (id, project_id, name, position, kind, due_at) VALUES ('s-backlog', 'p1', 'Backlog', 0, 'backlog', NULL);
INSERT INTO swimlanes (id, project_id, name, position, kind, due_at) VALUES ('m1', 'p1', 'Milestone 1', 1, 'sprint', '2026-06-01');
INSERT INTO milestones (id, project_id, name, position) VALUES ('ms-seed', 'p1', 'v0', 0);
INSERT INTO priority_options (id, project_id, label, color, position) VALUES ('prio-1', 'p1', 'Medium', '#888', 0), ('prio-2', 'p1', 'High', '#f00', 1);
INSERT INTO type_options (id, project_id, label, color, position) VALUES ('type-1', 'p1', 'Bug', '#f00', 0), ('type-2', 'p1', 'Feature', '#0f0', 1);
INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, due_at, created_at, key, number) VALUES ('t1', 'p1', 'c1', 'm1', 'T1', 'a0', '2026-06-15', '2026-01-01 10:00:00', 'EG-1', 1);
INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, created_at, key, number) VALUES ('t2', 'p1', 'c2', 's-backlog', 'T2', 'a0', '2026-01-01 10:00:00', 'EG-2', 2);
`);
  handler = createApiHandler(dbPath);
});

afterAll(() => {
  try { db.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

const json = (method: string, path: string, body?: unknown) =>
  new Request(`http://lexa.test${path}`, {
    method,
    headers: {
      authorization: `Bearer ${ADMIN_KEY}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

describe("projects routes", () => {
  it("list+create(201)+409 SLUG_TAKEN; GET/PATCH/DELETE lifecycle", async () => {
    const list = await handler(json("GET", "/api/projects"));
    expect(list.status).toBe(200);
    const listBody = await list.json();
    expect(listBody.data).toHaveLength(1);
    expect(listBody.data[0]!).toMatchObject({ id: "p1", slug: "p1", name: "P" });

    const created = await handler(json("POST", "/api/projects", { name: "Second", slug: "second" }));
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ name: "Second", slug: "second" });

    const dupe = await handler(json("POST", "/api/projects", { name: "Dupe", slug: "p1" }));
    expect(dupe.status).toBe(409);
    expect((await dupe.json()).error.code).toBe("SLUG_TAKEN");

    const ok = await handler(json("GET", "/api/projects/p1"));
    expect(ok.status).toBe(200);
    const missing = await handler(json("GET", "/api/projects/nope"));
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe("PROJECT_NOT_FOUND");

    const renamed = await handler(json("PATCH", "/api/projects/p1", { name: "Renamed" }));
    expect(renamed.status).toBe(200);
    expect((await renamed.json()).name).toBe("Renamed");

    const temp = await handler(json("POST", "/api/projects", { name: "Temp", slug: "tmp-del" }));
    expect(temp.status).toBe(201);
    const del = await handler(json("DELETE", "/api/projects/tmp-del"));
    expect(del.status).toBe(204);
    expect((await handler(json("GET", "/api/projects/tmp-del"))).status).toBe(404);
  });
});

describe("columns routes", () => {
  it("lists columns; POST appends (201); unknown project → 404; DELETE with tasks → 409 HAS_CHILDREN; empty → 204", async () => {
    const res = await handler(json("GET", "/api/projects/p1/columns"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.map((c: { id: string }) => c.id)).toEqual(["c1", "c2"]);

    const ok = await handler(json("POST", "/api/projects/p1/columns", { name: "Review" }));
    expect(ok.status).toBe(201);
    expect(await ok.json()).toMatchObject({ name: "Review", projectId: "p1", position: 2 });

    const missing = await handler(json("POST", "/api/projects/nope/columns", { name: "X" }));
    expect(missing.status).toBe(404);

    const blocked = await handler(json("DELETE", "/api/projects/p1/columns/c1"));
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).error.code).toBe("HAS_CHILDREN");
    const leaf = await handler(json("POST", "/api/projects/p1/columns", { name: "Empty" }));
    const { id } = await leaf.json();
    expect((await handler(json("DELETE", `/api/projects/p1/columns/${id}`))).status).toBe(204);
  });
});

describe("swimlane routes", () => {
  it("list/create, deadline guards, delete/archive/restore, and board includeArchived lane counts", async () => {
    const res = await handler(json("GET", "/api/projects/p1/swimlanes"));
    expect(res.status).toBe(200);
    expect((await res.json()).data.map((l: { id: string }) => l.id)).toEqual(["s-backlog", "m1"]);

    const ok = await handler(json("POST", "/api/projects/p1/swimlanes", { name: "M2", dueAt: "2026-08-01" }));
    expect(ok.status).toBe(201);
    expect((await ok.json()).kind).toBe("sprint");

    const res2 = await handler(json("PATCH", "/api/projects/p1/swimlanes/m1", { name: "Milestone 1", dueAt: "2026-06-10" }));
    expect(res2.status).toBe(409);
    expect((await res2.json()).error.code).toBe("DEADLINE_AFTER_LANE");
    expect((await handler(json("PATCH", "/api/projects/p1/swimlanes/m1", { name: "Milestone 1", dueAt: "2026-06-20" }))).status).toBe(200);

    const backlog = await handler(json("PATCH", "/api/projects/p1/swimlanes/s-backlog", { name: "Backlog", dueAt: "2026-01-01" }));
    expect(backlog.status).toBe(409);
    expect((await backlog.json()).error.code).toBe("BACKLOG_PROTECTED");

    const blocked = await handler(json("DELETE", "/api/projects/p1/swimlanes/m1"));
    expect(blocked.status).toBe(409);
    const created = await handler(json("POST", "/api/projects/p1/swimlanes", { name: "Empty" }));
    const { id } = await created.json();
    expect((await handler(json("DELETE", `/api/projects/p1/swimlanes/${id}`))).status).toBe(204);

    const archived = await handler(json("POST", "/api/projects/p1/swimlanes/m1/archive"));
    expect(archived.status).toBe(200);
    expect((await archived.json()).data.archivedAt).toBeTruthy();
    expect((await handler(json("POST", "/api/projects/p1/swimlanes/s-backlog/archive"))).status).toBe(409);

    const restored = await handler(json("POST", "/api/projects/p1/swimlanes/m1/restore"));
    expect(restored.status).toBe(200);
    expect((await restored.json()).data.archivedAt).toBeNull();

    const missing = await handler(json("POST", "/api/projects/p1/swimlanes/nope/archive"));
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe("SWIMLANE_NOT_FOUND");

    // board lane counts vs includeArchived (milestone aggregation contract)
    const seed = new Database(dbPath);
    seed.exec(`
      INSERT INTO projects (id, name, slug, key, next_task_number) VALUES ('p-arch', 'Arch', 'p-arch', 'AR', 1);
      INSERT INTO columns (id, project_id, name, position, is_done) VALUES ('ca1', 'p-arch', 'Todo', 0, 0), ('ca2', 'p-arch', 'Done', 1, 1);
      INSERT INTO milestones (id, project_id, name, position) VALUES ('ma1', 'p-arch', 'M1', 0);
      INSERT INTO swimlanes (id, project_id, name, position, kind, milestone_id, archived_at)
        VALUES ('sa1', 'p-arch', 'Sprint A', 0, 'sprint', 'ma1', '2026-03-01T00:00:00.000Z');
      INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, archived_at, created_at, key, number) VALUES
        ('ta1', 'p-arch', 'ca1', 'sa1', 'A', 'a0', '2026-03-01T00:00:00.000Z', '2026-01-01 10:00:00', 'AR-1', 1),
        ('ta2', 'p-arch', 'ca2', 'sa1', 'B', 'a1', NULL, '2026-01-01 10:00:00', 'AR-2', 2);
    `);
    seed.close();

    const live = await handler(json("GET", "/api/projects/p-arch/board"));
    expect(live.status).toBe(200);
    const liveBody = await live.json();
    expect(liveBody.swimlanes.map((l: { id: string }) => l.id)).not.toContain("sa1");
    expect(liveBody.milestones[0]).toMatchObject({ id: "ma1", tasksTotal: 2, tasksDone: 2 });

    const full = await handler(json("GET", "/api/projects/p-arch/board?includeArchived=true"));
    expect(full.status).toBe(200);
    const fullBody = await full.json();
    const lane = fullBody.swimlanes.find((l: { id: string }) => l.id === "sa1");
    expect(lane).toMatchObject({ tasksTotal: 2, tasksDone: 2 });
    expect(lane.tasksDone).toBe(lane.tasksTotal);
  });
});

describe("milestones routes", () => {
  it("DELETE with sprints → 409 HAS_CHILDREN; archive cascade/restore; startAt>dueAt → 422 INVALID_ARGS", async () => {
    const created = await handler(json("POST", "/api/projects/p1/milestones", { name: "with-sprints" }));
    const m = await created.json();
    db.prepare("INSERT INTO swimlanes (id, project_id, name, position, kind, milestone_id) VALUES ('sp1','p1','Sprint 1',1,'sprint',?)").run(m.id);
    const blocked = await handler(json("DELETE", `/api/projects/p1/milestones/${m.id}`));
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).error.code).toBe("HAS_CHILDREN");
    db.prepare("UPDATE swimlanes SET milestone_id = NULL WHERE id = 'sp1'").run();
    expect((await handler(json("DELETE", `/api/projects/p1/milestones/${m.id}`))).status).toBe(204);

    const created2 = await handler(json("POST", "/api/projects/p1/milestones", { name: "v2" }));
    const m2 = await created2.json();
    db.prepare("INSERT INTO swimlanes (id, project_id, name, position, kind, milestone_id) VALUES ('sp2','p1','Sprint 2',1,'sprint',?)").run(m2.id);
    db.prepare("INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, created_at, key, number) VALUES ('t-ar','p1','c1','sp2','T','a9','2026-01-01 10:00:00','EG-100',100)").run();
    const archived = await handler(json("POST", `/api/projects/p1/milestones/${m2.id}/archive`));
    expect(archived.status).toBe(200);
    expect((await archived.json()).data.archivedAt).not.toBeNull();
    const restored = await handler(json("POST", `/api/projects/p1/milestones/${m2.id}/restore`));
    expect((await restored.json()).data.archivedAt).toBeNull();

    const laneCreated = await handler(json("POST", "/api/projects/p1/swimlanes", { name: "Sprint A", startAt: "2026-08-10", dueAt: "2026-08-30", milestoneId: "ms-seed" }));
    expect(laneCreated.status).toBe(201);
    const lane = await laneCreated.json();
    expect(lane.startAt).toBe("2026-08-10");
    const patched = await handler(json("PATCH", `/api/projects/p1/swimlanes/${lane.id}`, { startAt: "2026-09-01", dueAt: "2026-08-01" }));
    expect(patched.status).toBe(422);
    expect((await patched.json()).error.code).toBe("INVALID_ARGS");
  });
});

// ---------------------------------------------------------------------------
// Absorbed from http-project-access.test.ts — team-scoped authorization
// boundary, with its own tmp DB + session/cookie fixtures.
// ---------------------------------------------------------------------------

let accDir: string;
let accDbPath: string;
let accHandler: (req: Request) => Promise<Response>;
let accAuth: typeof AuthInstance;
const accUserIds: Record<string, string> = {};

describe("project access scoping (team membership)", () => {
  const accCall = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
    accHandler(
      new Request(`http://lexa.test${path}`, {
        method,
        headers: { "content-type": "application/json", ...headers },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      })
    );

  const accWithKey = (method: string, path: string, body?: unknown) =>
    accCall(method, path, { authorization: `Bearer ${ADMIN_KEY}` }, body);
  const accWithCookie = (cookie: string, method: string, path: string, body?: unknown) =>
    accCall(method, path, { cookie }, body);

  async function accSignIn(email: string): Promise<string> {
    const res = (await accAuth.api.signInEmail({
      body: { email, password: "password123" },
      returnHeaders: true,
    })) as unknown as { headers?: Headers };
    return (res.headers?.get("set-cookie") ?? "").split(";")[0]!;
  }

  // Full browser cookie jar: session_token AND the cached session_data cookie,
  // so getSession takes the cookieCache path (stale role/session).
  async function accSignInFull(email: string): Promise<string> {
    const res = (await accAuth.api.signInEmail({
      body: { email, password: "password123" },
      returnHeaders: true,
    })) as unknown as { headers?: Headers };
    return (res.headers?.getSetCookie?.() ?? []).join("; ");
  }

  const accDoc = (text: string) => ({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  });

  beforeAll(async () => {
    accDir = mkdtempSync(join(tmpdir(), "lexa-project-access-api-"));
    accDbPath = join(accDir, "test.db");
    // auth.ts caches one better-auth singleton per module registry, bound to
    // DATABASE_PATH at first use. Reset the registry so this block's sessions
    // bind to its own DB rather than the target file's already-initialized one.
    vi.resetModules();
    process.env.DATABASE_PATH = accDbPath;
    process.env.LXK_PUBLIC_URL = "http://localhost:3000";
    const { runMigrations: accRunMigrations } = await import("../db/migrate");
    const { createApiHandler: accCreateApiHandler } = await import("./http");
    accRunMigrations(accDbPath, MIGRATIONS);
    ({ auth: accAuth } = await import("../auth"));

    // Provision accounts through better-auth so sign-in works.
    const emails = ["sa@lexa.test", "member2@lexa.test", "outsider@lexa.test"];
    for (const email of emails) {
      const u = await accAuth.api.createUser({
        body: {
          email,
          password: "password123",
          name: email.split("@")[0]!!,
          data: { role: email.startsWith("sa") ? "superadmin" : "member" },
        },
      });
      accUserIds[email] = u.user.id;
    }
    const adminHash = await sha256(ADMIN_KEY);
    const adb = new Database(accDbPath);
    adb.prepare("INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k1', 'admin-key', ?, ?)").run(adminHash, accUserIds["sa@lexa.test"]);

    // Team A with member2 as a member; project p-team owned by Team A.
    adb.exec(`
INSERT INTO organization (id, name, slug, createdAt) VALUES ('team-a', 'Team A', 'team-a', '2026-01-01');
INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('m2', 'team-a', '${accUserIds["member2@lexa.test"]}', 'member', '2026-01-01');
INSERT INTO projects (id, name, slug, key, team_id, next_task_number) VALUES ('p-team', 'Team Project', 'team-proj', 'TP', 'team-a', 5);
INSERT INTO projects (id, name, slug, key, team_id, next_task_number) VALUES ('p-ghost', 'Ghost Project', 'ghost-proj', 'GP', NULL, 2);
INSERT INTO columns (id, project_id, name, position) VALUES ('c-t1', 'p-team', 'Todo', 0), ('c-g1', 'p-ghost', 'Todo', 0);
INSERT INTO swimlanes (id, project_id, name, position, kind) VALUES ('s-t1', 'p-team', 'Backlog', 0, 'backlog'), ('s-g1', 'p-ghost', 'Backlog', 0, 'backlog');
INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, key, number) VALUES
 ('t-team-1', 'p-team', 'c-t1', 's-t1', 'Team 1', 'a0', 'TP-1', 1),
 ('t-team-2', 'p-team', 'c-t1', 's-t1', 'Team 2', 'a1', 'TP-2', 2),
 ('t-team-3', 'p-team', 'c-t1', 's-t1', 'Team 3', 'a2', 'TP-3', 3),
 ('t-team-4', 'p-team', 'c-t1', 's-t1', 'Team 4', 'a3', 'TP-4', 4),
 ('t-ghost-1', 'p-ghost', 'c-g1', 's-g1', 'Ghost 1', 'a0', 'GP-1', 1),
 ('11111111-1111-4111-8111-111111111111', 'p-ghost', 'c-g1', 's-g1', 'Ghost UUID', 'a1', 'GP-2', 2);
INSERT INTO task_links (id, project_id, from_task_id, to_task_id, relation) VALUES
 ('ghost-link-1', 'p-ghost', 't-ghost-1', '11111111-1111-4111-8111-111111111111', 'related_to');
INSERT INTO task_comments (id, task_id, author_kind, author_label, body) VALUES
 (1, 't-ghost-1', 'user', 'ghost', '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"ghost comment"}]}]}');
INSERT INTO document_sources (id, project_id, document_type, document_id, kind, title, ref) VALUES
 ('ghost-src-1', 'p-ghost', 'task', 't-ghost-1', 'external', 'Ghost source', 'https://example.com/ghost'),
 ('team-src-1', 'p-team', 'task', 't-team-1', 'external', 'Team source', 'https://example.com/team');
INSERT INTO attachments (id, project_id, task_id, filename, mime_type, size_bytes, sha256, storage_key, uploaded_by) VALUES
 ('ghost-att-1', 'p-ghost', 't-ghost-1', 'ghost.txt', 'text/plain', 3, 'deadbeef', 'ghost/storage/key', NULL);
`);
    adb.close();

    accHandler = accCreateApiHandler(accDbPath);
  });

  afterAll(() => {
    rmSync(accDir, { recursive: true, force: true });
  });

  it("project list + dashboard are scoped: superadmin sees all, team member only their team, outsider none", async () => {
    const all = await accWithKey("GET", "/api/projects");
    expect(all.status).toBe(200);
    const allBody = (await all.json()) as { data: { slug: string }[] };
    expect(allBody.data.map((p) => p.slug)).toEqual(expect.arrayContaining(["team-proj", "ghost-proj"]));

    const memberCookie = await accSignIn("member2@lexa.test");
    const own = (await (await accWithCookie(memberCookie, "GET", "/api/projects")).json()) as { data: { slug: string }[] };
    expect(own.data.map((p) => p.slug)).toEqual(["team-proj"]);
    // dashboard is filtered to visible projects
    const dash = (await (await accWithCookie(memberCookie, "GET", "/api/dashboard")).json()) as { projects: { project: { slug: string } }[]; stats: { activeProjects: number } };
    expect(dash.projects.map((p) => p.project.slug)).toEqual(["team-proj"]);
    expect(dash.stats.activeProjects).toBe(1);

    const outsiderCookie = await accSignIn("outsider@lexa.test");
    expect(await (await accWithCookie(outsiderCookie, "GET", "/api/projects")).json()).toEqual({ data: [], nextCursor: null });
  });

  it("demoted superadmin loses the project-read admin bypass immediately (cookieCache staleness closed)", async () => {
    // Full cookie jar: the cached session_data still reports superadmin after
    // demotion, so only the middleware's per-request D1 role re-read denies.
    const cookie = await accSignInFull("sa@lexa.test");
    const before = await accWithCookie(cookie, "GET", "/api/projects/ghost-proj");
    expect(before.status).toBe(200);
    const adb = new Database(accDbPath);
    adb.prepare("UPDATE users SET role = 'member' WHERE id = ?").run(accUserIds["sa@lexa.test"]);
    adb.close();
    const stale = await accAuth.api.getSession({ headers: new Headers({ cookie }) });
    expect((stale?.user as { role?: string } | undefined)?.role).toBe("superadmin");
    try {
      // No team membership / grant on ghost-proj → member scoping applies → 403.
      const after = await accWithCookie(cookie, "GET", "/api/projects/ghost-proj");
      expect(after.status).toBe(403);
    } finally {
      const restore = new Database(accDbPath);
      restore.prepare("UPDATE users SET role = 'superadmin' WHERE id = ?").run(accUserIds["sa@lexa.test"]);
      restore.close();
    }
  });

  it("member gets 403 on an inaccessible project and can read their own team's project", async () => {
    const cookie = await accSignIn("member2@lexa.test");
    const denied = await accWithCookie(cookie, "GET", "/api/projects/ghost-proj");
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { error: { code: string } }).error.code).toBe("FORBIDDEN");
    expect((await accWithCookie(cookie, "GET", "/api/projects/ghost-proj/board")).status).toBe(403);
    expect((await accWithCookie(cookie, "GET", "/api/projects/ghost-proj/tasks")).status).toBe(403);

    expect((await accWithCookie(cookie, "GET", "/api/projects/team-proj")).status).toBe(200);
    expect((await accWithCookie(cookie, "GET", "/api/projects/team-proj/board")).status).toBe(200);
  });

  it("foreign-project task mutations → 403; cross-project task-id path → 404; raw task-id IDOR; own-project mutations succeed", async () => {
    const cookie = await accSignIn("member2@lexa.test");
    // 403 — every mutation of a project they cannot open
    expect((await accWithCookie(cookie, "PATCH", "/api/projects/ghost-proj/tasks/t-ghost-1", { title: "hijack" })).status).toBe(403);
    expect((await accWithCookie(cookie, "POST", "/api/projects/ghost-proj/tasks/t-ghost-1/move", { columnId: "c-g1", swimlaneId: "s-g1" })).status).toBe(403);
    expect((await accWithCookie(cookie, "DELETE", "/api/projects/ghost-proj/tasks/t-ghost-1")).status).toBe(403);
    expect((await accWithCookie(cookie, "PATCH", "/api/projects/ghost-proj/tasks/t-ghost-1/comments/1", { body: accDoc("hijack") })).status).toBe(403);
    // 404 — cannot reach a foreign task through their own project's slug
    const cross = await accWithCookie(cookie, "PATCH", "/api/projects/team-proj/tasks/t-ghost-1", { title: "hijack" });
    expect(cross.status).toBe(404);
    const adb = new Database(accDbPath);
    expect(adb.query("SELECT title FROM tasks WHERE id = 't-ghost-1'").get()).toEqual({ title: "Ghost 1" });
    adb.close();
    // own-project mutations succeed
    expect((await accWithCookie(cookie, "PATCH", "/api/projects/team-proj/tasks/t-team-1", { title: "renamed" })).status).toBe(200);
    expect((await accWithCookie(cookie, "POST", "/api/projects/team-proj/tasks/t-team-2/move", { columnId: "c-t1", swimlaneId: "s-t1" })).status).toBe(200);
    expect((await accWithCookie(cookie, "POST", "/api/projects/team-proj/tasks/t-team-3/archive")).status).toBe(200);
    expect((await accWithCookie(cookie, "POST", "/api/projects/team-proj/tasks/t-team-3/restore")).status).toBe(200);
    expect((await accWithCookie(cookie, "DELETE", "/api/projects/team-proj/tasks/t-team-4")).status).toBe(204);
    const created = await accWithCookie(cookie, "POST", "/api/projects/team-proj/tasks/t-team-1/comments", { body: accDoc("hello") });
    expect(created.status).toBe(201);
    const commentId = ((await created.json()) as { data: { comment: { id: number } } }).data.comment.id;
    expect((await accWithCookie(cookie, "PATCH", `/api/projects/team-proj/tasks/t-team-1/comments/${commentId}`, { body: accDoc("edited") })).status).toBe(200);

    // raw task-id path scoping: reads/writes, comments, links cannot cross projects
    expect((await accWithCookie(cookie, "GET", "/api/projects/team-proj/tasks/t-ghost-1")).status).toBe(404);
    expect((await accWithCookie(cookie, "GET", "/api/projects/team-proj/tasks/t-ghost-1/activity")).status).toBe(404);
    expect((await accWithCookie(cookie, "GET", "/api/projects/team-proj/tasks/t-team-1")).status).toBe(200);
    expect((await accWithCookie(cookie, "GET", "/api/projects/team-proj/tasks/t-team-1/activity")).status).toBe(200);
    // createComment cannot write to another project's task
    expect((await accWithCookie(cookie, "POST", "/api/projects/team-proj/tasks/t-ghost-1/comments", { body: accDoc("hijack") })).status).toBe(404);
    const adb2 = new Database(accDbPath);
    expect(adb2.query("SELECT COUNT(*) c FROM task_comments WHERE task_id = 't-ghost-1'").get()).toEqual({ c: 1 });
    adb2.close();
    // deleteComment cannot reach another project's task/comment
    expect((await accWithCookie(cookie, "DELETE", "/api/projects/team-proj/tasks/t-ghost-1/comments/1")).status).toBe(404);
    const adb3 = new Database(accDbPath);
    expect(adb3.query("SELECT deleted_at FROM task_comments WHERE id = 1").get()).toEqual({ deleted_at: null });
    adb3.close();
    const ownComment = await accWithCookie(cookie, "POST", "/api/projects/team-proj/tasks/t-team-1/comments", { body: accDoc("bye") });
    const ownCommentId = ((await ownComment.json()) as { data: { comment: { id: number } } }).data.comment.id;
    expect((await accWithCookie(cookie, "DELETE", `/api/projects/team-proj/tasks/t-team-1/comments/${ownCommentId}`)).status).toBe(204);
    // GitHub link/unlink cannot target another project's task
    expect((await accWithCookie(cookie, "POST", "/api/projects/team-proj/tasks/t-ghost-1/github-link", { repo: "acme/x" })).status).toBe(404);
    expect((await accWithCookie(cookie, "POST", "/api/projects/team-proj/tasks/t-ghost-1/github-link-existing", { repo: "acme/x", issueNumber: 1 })).status).toBe(404);
    expect((await accWithCookie(cookie, "DELETE", "/api/projects/team-proj/tasks/t-ghost-1/github-link/1")).status).toBe(404);
    // same-project reaches the service (no workspace repo → 502 GITHUB_API_ERROR)
    expect((await accWithCookie(cookie, "POST", "/api/projects/team-proj/tasks/t-team-1/github-link", { repo: "acme/x" })).status).toBe(502);
    expect((await accWithCookie(cookie, "DELETE", "/api/projects/team-proj/tasks/t-team-1/github-link/999")).status).toBe(200);
    // task links
    expect((await accWithCookie(cookie, "GET", "/api/projects/team-proj/tasks/t-ghost-1/links")).status).toBe(404);
    expect((await accWithCookie(cookie, "GET", "/api/projects/team-proj/tasks/t-team-1/links")).status).toBe(200);
    expect((await accWithCookie(cookie, "DELETE", "/api/projects/team-proj/tasks/11111111-1111-4111-8111-111111111111/links/ghost-link-1")).status).toBe(404);
    expect((await accWithCookie(cookie, "DELETE", "/api/projects/team-proj/tasks/t-team-1/links/ghost-link-1")).status).toBe(404);
    expect((await accWithCookie(cookie, "POST", "/api/projects/team-proj/tasks/11111111-1111-4111-8111-111111111111/links", { toTaskId: "t-team-2", relation: "related_to" })).status).toBe(404);
    const adb4 = new Database(accDbPath);
    expect(adb4.query("SELECT COUNT(*) c FROM task_links WHERE id = 'ghost-link-1'").get()).toEqual({ c: 1 });
    adb4.close();
    // same-project links add + remove still work
    const added = await accWithCookie(cookie, "POST", "/api/projects/team-proj/tasks/t-team-1/links", { toTaskId: "t-team-2", relation: "related_to" });
    expect(added.status).toBe(201);
    const linkId = ((await added.json()) as { data: { id: string } }).data.id;
    expect((await accWithCookie(cookie, "DELETE", `/api/projects/team-proj/tasks/t-team-1/links/${linkId}`)).status).toBe(204);
  });

  it("sources/attachments cannot cross projects; same-project source delete works", async () => {
    const cookie = await accSignIn("member2@lexa.test");
    // addSource cannot attach to another project's document
    expect((await accWithCookie(cookie, "POST", "/api/projects/team-proj/documents/task/11111111-1111-4111-8111-111111111111/sources", { kind: "external", ref: "https://example.com/x" })).status).toBe(404);
    const adb = new Database(accDbPath);
    expect(adb.query("SELECT COUNT(*) c FROM document_sources WHERE document_id = '11111111-1111-4111-8111-111111111111'").get()).toEqual({ c: 0 });
    adb.close();
    // removeSource cannot delete another project's source; same project works
    expect((await accWithCookie(cookie, "DELETE", "/api/projects/team-proj/documents/task/t-team-1/sources/ghost-src-1")).status).toBe(404);
    const adb2 = new Database(accDbPath);
    expect(adb2.query("SELECT COUNT(*) c FROM document_sources WHERE id = 'ghost-src-1'").get()).toEqual({ c: 1 });
    adb2.close();
    expect((await accWithCookie(cookie, "DELETE", "/api/projects/team-proj/documents/task/t-team-1/sources/team-src-1")).status).toBe(204);
    // deleteAttachment cannot delete another project's attachment
    expect((await accWithCookie(cookie, "DELETE", "/api/attachments/ghost-att-1")).status).toBe(403);
    const adb3 = new Database(accDbPath);
    expect(adb3.query("SELECT COUNT(*) c FROM attachments WHERE id = 'ghost-att-1'").get()).toEqual({ c: 1 });
    adb3.close();
  });
});
