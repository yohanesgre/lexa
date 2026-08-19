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
  dir = mkdtempSync(join(tmpdir(), "lexa-project-access-api-"));
  dbPath = join(dir, "test.db");
  runMigrations(dbPath, MIGRATIONS);
  process.env.DATABASE_PATH = dbPath;
  process.env.LXK_PUBLIC_URL = "http://localhost:3000";
  ({ auth } = await import("../auth"));

  // Provision accounts through better-auth so sign-in works.
  const emails = ["sa@lexa.test", "member2@lexa.test", "outsider@lexa.test"];
  for (const email of emails) {
    const u = await auth.api.createUser({
      body: {
        email,
        password: "password123",
        name: email.split("@")[0],
        data: { role: email.startsWith("sa") ? "superadmin" : "member" },
      },
    });
    userIds[email] = u.user.id;
  }
  const adminHash = await sha256(ADMIN_KEY);
  const db = new Database(dbPath);
  db.prepare("INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k1', 'admin-key', ?, ?)").run(adminHash, userIds["sa@lexa.test"]);

  // Team A with member2 as a member; project p-team owned by Team A.
  db.exec(`
INSERT INTO organization (id, name, slug, createdAt) VALUES ('team-a', 'Team A', 'team-a', '2026-01-01');
INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('m2', 'team-a', '${userIds["member2@lexa.test"]}', 'member', '2026-01-01');
INSERT INTO projects (id, name, slug, key, team_id, next_task_number) VALUES ('p-team', 'Team Project', 'team-proj', 'TP', 'team-a', 1);
INSERT INTO projects (id, name, slug, key, team_id, next_task_number) VALUES ('p-ghost', 'Ghost Project', 'ghost-proj', 'GP', NULL, 1);
INSERT INTO columns (id, project_id, name, position) VALUES ('c-t1', 'p-team', 'Todo', 0), ('c-g1', 'p-ghost', 'Todo', 0);
INSERT INTO swimlanes (id, project_id, name, position, kind) VALUES ('s-t1', 'p-team', 'Backlog', 0, 'backlog'), ('s-g1', 'p-ghost', 'Backlog', 0, 'backlog');
`);
  db.close();

  const { createApiHandler } = await import("./http");
  handler = createApiHandler(dbPath);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("project access scoping (team membership)", () => {
  it("superadmin key sees all projects; outsider member session sees none", async () => {
    const all = await withKey("GET", "/api/projects");
    expect(all.status).toBe(200);
    const allBody = (await all.json()) as { data: { slug: string }[] };
    expect(allBody.data.map((p) => p.slug)).toEqual(expect.arrayContaining(["team-proj", "ghost-proj"]));

    const outsiderCookie = await signIn("outsider@lexa.test");
    const none = await withCookie(outsiderCookie, "GET", "/api/projects");
    expect(none.status).toBe(200);
    expect((await none.json())).toEqual({ data: [], nextCursor: null });
  });

  it("team member sees only their team's project", async () => {
    const cookie = await signIn("member2@lexa.test");
    const res = await withCookie(cookie, "GET", "/api/projects");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { slug: string }[] };
    expect(body.data.map((p) => p.slug)).toEqual(["team-proj"]);
  });

  it("member session gets 403 PROJECT_ACCESS_DENIED on a project they cannot open", async () => {
    const cookie = await signIn("member2@lexa.test");
    const res = await withCookie(cookie, "GET", "/api/projects/ghost-proj");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("member session gets 403 on project-scoped reads of an inaccessible project", async () => {
    const cookie = await signIn("member2@lexa.test");
    const board = await withCookie(cookie, "GET", "/api/projects/ghost-proj/board");
    expect(board.status).toBe(403);
    const tasks = await withCookie(cookie, "GET", "/api/projects/ghost-proj/tasks");
    expect(tasks.status).toBe(403);
  });

  it("member session can read their own team's project", async () => {
    const cookie = await signIn("member2@lexa.test");
    const ok = await withCookie(cookie, "GET", "/api/projects/team-proj");
    expect(ok.status).toBe(200);
    const board = await withCookie(cookie, "GET", "/api/projects/team-proj/board");
    expect(board.status).toBe(200);
  });

  it("dashboard is filtered to visible projects for a member session", async () => {
    const cookie = await signIn("member2@lexa.test");
    const res = await withCookie(cookie, "GET", "/api/dashboard");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { projects: { project: { slug: string } }[]; stats: { activeProjects: number } };
    expect(body.projects.map((p) => p.project.slug)).toEqual(["team-proj"]);
    expect(body.stats.activeProjects).toBe(1);
  });
});
