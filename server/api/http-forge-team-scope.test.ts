import { describe, it, expect, beforeAll, afterAll } from "vitest";
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
let handler: (req: Request) => Promise<Response>;
let auth: typeof AuthInstance;
let teamAdminCookie: string;
const user: Record<string, string> = {};

const call = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
  handler(
    new Request(`http://lexa.test${path}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  );

const claim = (runtimeId: string) =>
  handler(new Request("http://lexa.test/api/forge/daemon/claim", {
    method: "POST",
    headers: { authorization: `Bearer ${ADMIN_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ runtimeId }),
  }));

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "lexa-forge-team-"));
  dbPath = join(dir, "test.db");
  runMigrations(dbPath, MIGRATIONS);
  process.env.DATABASE_PATH = dbPath;
  process.env.LXK_PUBLIC_URL = "http://localhost:3000";
  ({ auth } = await import("../auth"));
  const sa = await auth.api.createUser({ body: { email: "sa@lexa.test", password: "password123", name: "SA", data: { role: "superadmin" } } });
  const admin = await auth.api.createUser({ body: { email: "admin@lexa.test", password: "password123", name: "Admin", data: { role: "member" } } });
  user.sa = sa.user.id;
  user.admin = admin.user.id;
  const adminHash = await sha256(ADMIN_KEY);
  const db = new Database(dbPath);
  db.exec(`
INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k1', 'admin', '${adminHash}', '${user.sa}');
INSERT INTO machines (id, hostname) VALUES ('m1', 'host1');
INSERT INTO organization (id, name, slug, createdAt) VALUES ('team-a', 'Team A', 'team-a', '2026-01-01T00:00:00.000Z'), ('team-b', 'Team B', 'team-b', '2026-01-01T00:00:00.000Z');
INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES
  ('m1', 'team-a', '${user.sa}', 'owner', '2026-01-01T00:00:00.000Z'),
  ('m2', 'team-a', '${user.admin}', 'admin', '2026-01-01T00:00:00.000Z'),
  ('m3', 'team-b', '${user.sa}', 'owner', '2026-01-01T00:00:00.000Z');
INSERT INTO runtimes (id, name, provider, model, status, agent, print_logs, log_level, team_id) VALUES
  ('r-a', 'team runtime', 'opencode', 'claude', 'online', 'lexa', 0, 'INFO', 'team-a'),
  ('r-g', 'global runtime', 'opencode', 'claude', 'online', 'lexa', 0, 'INFO', NULL);
INSERT INTO projects (id, name, slug, key, next_task_number, team_id) VALUES ('p-a', 'PA', 'p-a', 'PA', 1, 'team-a'), ('p-b', 'PB', 'p-b', 'PB', 1, 'team-b'), ('p-g', 'PG', 'p-g', 'PG', 1, NULL);
INSERT INTO columns (id, project_id, name, position) VALUES ('c-a', 'p-a', 'Todo', 0), ('c-b', 'p-b', 'Todo', 0), ('c-g', 'p-g', 'Todo', 0);
INSERT INTO swimlanes (id, project_id, name, position, kind) VALUES ('s-a', 'p-a', 'Main', 0, 'backlog'), ('s-b', 'p-b', 'Main', 0, 'backlog'), ('s-g', 'p-g', 'Main', 0, 'backlog');
INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, created_at, key, number) VALUES
  ('ta', 'p-a', 'c-a', 's-a', 'TA', 'a0', '2026-01-01 10:00:00', 'PA-1', 1),
  ('tb', 'p-b', 'c-b', 's-b', 'TB', 'a0', '2026-01-01 10:00:00', 'PB-1', 1),
  ('tg', 'p-g', 'c-g', 's-g', 'TG', 'a0', '2026-01-01 10:00:00', 'PG-1', 1);
INSERT INTO forge_agents (id, name, description, instructions, is_builtin) VALUES ('a1', 'A', '', '', 0);
INSERT INTO forge_skills (id, name, description, instructions, is_builtin) VALUES ('sk1', 'S', '', '', 0);
INSERT INTO forge_tasks (id, project_id, document_type, document_id, agent_id, skill_id, selection, doc_context, status, created_at) VALUES
  ('ft-a', 'p-a', 'task', 'ta', 'a1', 'sk1', '', 'TA', 'queued', '2026-01-01 10:00:00'),
  ('ft-b', 'p-b', 'task', 'tb', 'a1', 'sk1', '', 'TB', 'queued', '2026-01-01 10:00:01'),
  ('ft-g', 'p-g', 'task', 'tg', 'a1', 'sk1', '', 'TG', 'queued', '2026-01-01 10:00:02');
`);
  db.close();
  const { createApiHandler } = await import("./http");
  handler = createApiHandler(dbPath);
  const signIn = (await auth.api.signInEmail({ body: { email: "admin@lexa.test", password: "password123" }, returnHeaders: true })) as unknown as { headers?: Headers };
  teamAdminCookie = (signIn.headers?.get("set-cookie") ?? "").split(";")[0];
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("forge runtime team scoping", () => {
  it("team runtime claims only own-team tasks", async () => {
    const res = await claim("r-a");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { task: { id: string } | null };
    expect(body.task?.id).toBe("ft-a");
    // next claim: no more team-a tasks → null (ft-b/ft-g are cross-team/unassigned)
    const second = (await (await claim("r-a")).json()) as { task: { id: string } | null };
    expect(second.task).toBeNull();
  });

  it("global runtime claims any team's task", async () => {
    const res = await claim("r-g");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { task: { id: string } | null };
    expect(["ft-b", "ft-g"]).toContain(body.task?.id);
  });

  it("register accepts teamId and reflects it on the payload", async () => {
    const res = await handler(new Request("http://lexa.test/api/forge/runtimes/register", {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ id: "r-new", name: "scoped", provider: "opencode", machineId: "m1", teamId: "team-b" }),
    }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { teamId: string | null };
    expect(body.teamId).toBe("team-b");
    const db = new Database(dbPath);
    const row = db.prepare("SELECT team_id FROM runtimes WHERE id = 'r-new'").get() as { team_id: string | null };
    db.close();
    expect(row.team_id).toBe("team-b");
  });

  it("listRuntimes: superadmin sees all; ?teamId= filters; team admin sees own team + global", async () => {
    const all = (await (await call("GET", "/api/forge/runtimes", { authorization: `Bearer ${ADMIN_KEY}` })).json()) as { data: { id: string }[] };
    expect(all.data.map((r) => r.id)).toEqual(expect.arrayContaining(["r-a", "r-g", "r-new"]));
    const filtered = (await (await call("GET", "/api/forge/runtimes?teamId=team-b", { authorization: `Bearer ${ADMIN_KEY}` })).json()) as { data: { id: string }[] };
    expect(filtered.data.map((r) => r.id)).toEqual(["r-new"]);
    // team-admin session (admin@lexa.test is team-a admin): own team + global
    const scoped = (await (await call("GET", "/api/forge/runtimes", { cookie: teamAdminCookie })).json()) as { data: { id: string }[] };
    expect(scoped.data.map((r) => r.id).sort()).toEqual(["r-a", "r-g"].sort());
  });
});

describe("project team assignment", () => {
  it("project payload carries teamId; team admin assigns own team only", async () => {
    const proj = (await (await call("GET", "/api/projects/p-g", { authorization: `Bearer ${ADMIN_KEY}` })).json()) as { teamId: string | null };
    expect(proj.teamId).toBeNull();
    // team admin (team-a admin) assigns their own team
    const ok = await call("PATCH", "/api/projects/p-g/team", { cookie: teamAdminCookie }, { teamId: "team-a" });
    expect(ok.status).toBe(200);
    const updated = (await ok.json()) as { teamId: string | null };
    expect(updated.teamId).toBe("team-a");
    // team admin cannot assign another team
    const forbidden = await call("PATCH", "/api/projects/p-g/team", { cookie: teamAdminCookie }, { teamId: "team-b" });
    expect(forbidden.status).toBe(403);
    // unassign = superadmin only (team admin gets 403)
    const unassignByAdmin = await call("PATCH", "/api/projects/p-g/team", { cookie: teamAdminCookie }, { teamId: null });
    expect(unassignByAdmin.status).toBe(403);
    const unassignBySa = await call("PATCH", "/api/projects/p-g/team", { authorization: `Bearer ${ADMIN_KEY}` }, { teamId: null });
    expect(unassignBySa.status).toBe(200);
    const after = (await unassignBySa.json()) as { teamId: string | null };
    expect(after.teamId).toBeNull();
    // unknown team → 404
    const missing = await call("PATCH", "/api/projects/p-g/team", { authorization: `Bearer ${ADMIN_KEY}` }, { teamId: "ghost-team" });
    expect(missing.status).toBe(404);
  });
});
