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
  return (res.headers?.get("set-cookie") ?? "").split(";")[0]!;
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
        name: email.split("@")[0]!!,
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

const doc = (text: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

describe("project access scoping on task mutations", () => {
  it("member gets 403 on every mutation of a project they cannot open", async () => {
    const cookie = await signIn("member2@lexa.test");
    const patch = await withCookie(cookie, "PATCH", "/api/projects/ghost-proj/tasks/t-ghost-1", { title: "hijack" });
    expect(patch.status).toBe(403);
    const move = await withCookie(cookie, "POST", "/api/projects/ghost-proj/tasks/t-ghost-1/move", { columnId: "c-g1", swimlaneId: "s-g1" });
    expect(move.status).toBe(403);
    const del = await withCookie(cookie, "DELETE", "/api/projects/ghost-proj/tasks/t-ghost-1");
    expect(del.status).toBe(403);
    const archive = await withCookie(cookie, "POST", "/api/projects/ghost-proj/tasks/t-ghost-1/archive");
    expect(archive.status).toBe(403);
    const restore = await withCookie(cookie, "POST", "/api/projects/ghost-proj/tasks/t-ghost-1/restore");
    expect(restore.status).toBe(403);
    const comment = await withCookie(cookie, "PATCH", "/api/projects/ghost-proj/tasks/t-ghost-1/comments/1", { body: doc("hijack") });
    expect(comment.status).toBe(403);
  });

  it("member cannot reach another project's task through their own project's slug", async () => {
    const cookie = await signIn("member2@lexa.test");
    const res = await withCookie(cookie, "PATCH", "/api/projects/team-proj/tasks/t-ghost-1", { title: "hijack" });
    expect(res.status).toBe(404);
    const db = new Database(dbPath);
    const row = db.query("SELECT title FROM tasks WHERE id = 't-ghost-1'").get() as { title: string };
    db.close();
    expect(row.title).toBe("Ghost 1");
  });

  it("same-project mutations still succeed for a plain member", async () => {
    const cookie = await signIn("member2@lexa.test");
    const patch = await withCookie(cookie, "PATCH", "/api/projects/team-proj/tasks/t-team-1", { title: "renamed" });
    expect(patch.status).toBe(200);
    const move = await withCookie(cookie, "POST", "/api/projects/team-proj/tasks/t-team-2/move", { columnId: "c-t1", swimlaneId: "s-t1" });
    expect(move.status).toBe(200);
    const archive = await withCookie(cookie, "POST", "/api/projects/team-proj/tasks/t-team-3/archive");
    expect(archive.status).toBe(200);
    const restore = await withCookie(cookie, "POST", "/api/projects/team-proj/tasks/t-team-3/restore");
    expect(restore.status).toBe(200);
    const del = await withCookie(cookie, "DELETE", "/api/projects/team-proj/tasks/t-team-4");
    expect(del.status).toBe(204);
    const created = await withCookie(cookie, "POST", "/api/projects/team-proj/tasks/t-team-1/comments", { body: doc("hello") });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { data: { comment: { id: number } } };
    const edited = await withCookie(cookie, "PATCH", `/api/projects/team-proj/tasks/t-team-1/comments/${createdBody.data.comment.id}`, { body: doc("edited") });
    expect(edited.status).toBe(200);
  });
});

describe("raw task-id path scoping (cross-project UUID → 404)", () => {
  it("getTask and task activity cannot read another project's task by id", async () => {
    const cookie = await signIn("member2@lexa.test");
    const task = await withCookie(cookie, "GET", "/api/projects/team-proj/tasks/t-ghost-1");
    expect(task.status).toBe(404);
    const activity = await withCookie(cookie, "GET", "/api/projects/team-proj/tasks/t-ghost-1/activity");
    expect(activity.status).toBe(404);
    const own = await withCookie(cookie, "GET", "/api/projects/team-proj/tasks/t-team-1");
    expect(own.status).toBe(200);
    const ownActivity = await withCookie(cookie, "GET", "/api/projects/team-proj/tasks/t-team-1/activity");
    expect(ownActivity.status).toBe(200);
  });

  it("createComment cannot write to another project's task", async () => {
    const cookie = await signIn("member2@lexa.test");
    const cross = await withCookie(cookie, "POST", "/api/projects/team-proj/tasks/t-ghost-1/comments", { body: doc("hijack") });
    expect(cross.status).toBe(404);
    const db = new Database(dbPath);
    const n = db.query("SELECT COUNT(*) c FROM task_comments WHERE task_id = 't-ghost-1'").get() as { c: number };
    db.close();
    expect(n.c).toBe(1);
    const own = await withCookie(cookie, "POST", "/api/projects/team-proj/tasks/t-team-1/comments", { body: doc("ok") });
    expect(own.status).toBe(201);
  });

  it("deleteComment cannot reach another project's task/comment", async () => {
    const cookie = await signIn("member2@lexa.test");
    const cross = await withCookie(cookie, "DELETE", "/api/projects/team-proj/tasks/t-ghost-1/comments/1");
    expect(cross.status).toBe(404);
    const db = new Database(dbPath);
    const row = db.query("SELECT deleted_at FROM task_comments WHERE id = 1").get() as { deleted_at: string | null };
    db.close();
    expect(row.deleted_at).toBeNull();
    const created = await withCookie(cookie, "POST", "/api/projects/team-proj/tasks/t-team-1/comments", { body: doc("bye") });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { data: { comment: { id: number } } };
    const own = await withCookie(cookie, "DELETE", `/api/projects/team-proj/tasks/t-team-1/comments/${createdBody.data.comment.id}`);
    expect(own.status).toBe(204);
  });

  it("GitHub link/unlink cannot target another project's task", async () => {
    const cookie = await signIn("member2@lexa.test");
    const link = await withCookie(cookie, "POST", "/api/projects/team-proj/tasks/t-ghost-1/github-link", { repo: "acme/x" });
    expect(link.status).toBe(404);
    const linkExisting = await withCookie(cookie, "POST", "/api/projects/team-proj/tasks/t-ghost-1/github-link-existing", { repo: "acme/x", issueNumber: 1 });
    expect(linkExisting.status).toBe(404);
    const unlink = await withCookie(cookie, "DELETE", "/api/projects/team-proj/tasks/t-ghost-1/github-link/1");
    expect(unlink.status).toBe(404);
    // Same-project reaches the service: no workspace repo configured → 502 GITHUB_API_ERROR.
    const ownLink = await withCookie(cookie, "POST", "/api/projects/team-proj/tasks/t-team-1/github-link", { repo: "acme/x" });
    expect(ownLink.status).toBe(502);
    const ownUnlink = await withCookie(cookie, "DELETE", "/api/projects/team-proj/tasks/t-team-1/github-link/999");
    expect(ownUnlink.status).toBe(200);
  });

  it("task-link list cannot read another project's task links", async () => {
    const cookie = await signIn("member2@lexa.test");
    const cross = await withCookie(cookie, "GET", "/api/projects/team-proj/tasks/t-ghost-1/links");
    expect(cross.status).toBe(404);
    const own = await withCookie(cookie, "GET", "/api/projects/team-proj/tasks/t-team-1/links");
    expect(own.status).toBe(200);
  });

  it("removeTaskLink cannot delete a foreign link through another project's task", async () => {
    const cookie = await signIn("member2@lexa.test");
    // True-UUID cross-project path task + foreign linkId → 404.
    const cross = await withCookie(cookie, "DELETE", "/api/projects/team-proj/tasks/11111111-1111-4111-8111-111111111111/links/ghost-link-1");
    expect(cross.status).toBe(404);
    // Same-project path task but the link belongs to another project → 404.
    const foreign = await withCookie(cookie, "DELETE", "/api/projects/team-proj/tasks/t-team-1/links/ghost-link-1");
    expect(foreign.status).toBe(404);
    const db = new Database(dbPath);
    const link = db.query("SELECT COUNT(*) c FROM task_links WHERE id = 'ghost-link-1'").get() as { c: number };
    db.close();
    expect(link.c).toBe(1);
  });

  it("addTaskLink via a cross-project task UUID path → 404", async () => {
    const cookie = await signIn("member2@lexa.test");
    const res = await withCookie(cookie, "POST", "/api/projects/team-proj/tasks/11111111-1111-4111-8111-111111111111/links", {
      toTaskId: "t-team-2",
      relation: "related_to",
    });
    expect(res.status).toBe(404);
  });

  it("same-project task links add + remove still work", async () => {
    const cookie = await signIn("member2@lexa.test");
    const added = await withCookie(cookie, "POST", "/api/projects/team-proj/tasks/t-team-1/links", {
      toTaskId: "t-team-2",
      relation: "related_to",
    });
    expect(added.status).toBe(201);
    const linkId = ((await added.json()) as { data: { id: string } }).data.id;
    const removed = await withCookie(cookie, "DELETE", `/api/projects/team-proj/tasks/t-team-1/links/${linkId}`);
    expect(removed.status).toBe(204);
  });
});

describe("cross-project document sources and attachments", () => {
  it("addSource cannot attach to another project's document", async () => {
    const cookie = await signIn("member2@lexa.test");
    const res = await withCookie(cookie, "POST", "/api/projects/team-proj/documents/task/11111111-1111-4111-8111-111111111111/sources", {
      kind: "external",
      ref: "https://example.com/x",
    });
    expect(res.status).toBe(404);
    const db = new Database(dbPath);
    const sources = db.query("SELECT COUNT(*) c FROM document_sources WHERE document_id = '11111111-1111-4111-8111-111111111111'").get() as { c: number };
    const activity = db.query("SELECT COUNT(*) c FROM task_activity WHERE task_id = '11111111-1111-4111-8111-111111111111' AND type = 'source_added'").get() as { c: number };
    db.close();
    expect(sources.c).toBe(0);
    expect(activity.c).toBe(0);
  });

  it("removeSource cannot delete another project's source; same project works", async () => {
    const cookie = await signIn("member2@lexa.test");
    const cross = await withCookie(cookie, "DELETE", "/api/projects/team-proj/documents/task/t-team-1/sources/ghost-src-1");
    expect(cross.status).toBe(404);
    const db = new Database(dbPath);
    const ghost = db.query("SELECT COUNT(*) c FROM document_sources WHERE id = 'ghost-src-1'").get() as { c: number };
    db.close();
    expect(ghost.c).toBe(1);
    const own = await withCookie(cookie, "DELETE", "/api/projects/team-proj/documents/task/t-team-1/sources/team-src-1");
    expect(own.status).toBe(204);
    const db2 = new Database(dbPath);
    const team = db2.query("SELECT COUNT(*) c FROM document_sources WHERE id = 'team-src-1'").get() as { c: number };
    db2.close();
    expect(team.c).toBe(0);
  });

  it("deleteAttachment cannot delete another project's attachment", async () => {
    const cookie = await signIn("member2@lexa.test");
    const cross = await withCookie(cookie, "DELETE", "/api/attachments/ghost-att-1");
    expect(cross.status).toBe(403);
    const db = new Database(dbPath);
    const row = db.query("SELECT COUNT(*) c FROM attachments WHERE id = 'ghost-att-1'").get() as { c: number };
    db.close();
    expect(row.c).toBe(1);
  });
});
