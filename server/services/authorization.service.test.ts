import { describe, it, expect, afterEach, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer, Context } from "effect";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { Sqlite, initSqlite } from "../db/database";
import { DbBunLive } from "../db/db";
import { AuthorizationService } from "./authorization.service";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

let dir: string;
let db: Database;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "lexa-authz-"));
  const path = join(dir, "test.db");
  runMigrations(path, MIGRATIONS);
  const ctx = Effect.runSync(Effect.scoped(Layer.build(initSqlite(path))));
  db = Context.get(ctx, Sqlite);
});

afterAll(() => {
  try { db.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

function cleanDb(db: Database) {
  db.exec("PRAGMA foreign_keys = OFF");
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '_migrations' AND name NOT LIKE '%fts%'").all() as { name: string }[];
  for (const { name } of tables) {
    try { db.exec(`DELETE FROM "${name}"`); } catch {}
  }
  try { db.exec("DELETE FROM sqlite_sequence"); } catch {}
  db.exec("PRAGMA foreign_keys = ON");
}

beforeEach(() => {
  cleanDb(db);
});


function makeAuthz(db: Database) {
  const layer = AuthorizationService.Default.pipe(Layer.provide(Layer.mergeAll(Layer.succeed(Sqlite, db), DbBunLive(db))));
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  return Context.get(ctx, AuthorizationService);
}

// World:
//  sa      — superadmin
//  owner   — owner of team-a
//  admin   — admin of team-a
//  member  — member of team-a
//  outsider— member of team-b
//  teams:  team-a (project p1), team-b (project p2)
//  p3     — unassigned (team_id NULL)
//  grantee— explicit user_project_roles admin on p2 (cross-team grant)
function seed(db: Database) {
  db.exec(`
INSERT INTO users (id, email, name, role) VALUES
  ('sa', 'sa@x.dev', 'SA', 'superadmin'),
  ('owner', 'owner@x.dev', 'Owner', 'member'),
  ('admin', 'admin@x.dev', 'Admin', 'member'),
  ('member', 'member@x.dev', 'Member', 'member'),
  ('outsider', 'out@x.dev', 'Outsider', 'member'),
  ('grantee', 'grantee@x.dev', 'Grantee', 'member');
INSERT INTO organization (id, name, slug, createdAt) VALUES
  ('team-a', 'Team A', 'team-a', '2026-01-01T00:00:00.000Z'),
  ('team-b', 'Team B', 'team-b', '2026-01-01T00:00:00.000Z');
INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES
  ('m1', 'team-a', 'owner', 'owner', '2026-01-01T00:00:00.000Z'),
  ('m2', 'team-a', 'admin', 'admin', '2026-01-01T00:00:00.000Z'),
  ('m3', 'team-a', 'member', 'member', '2026-01-01T00:00:00.000Z'),
  ('m4', 'team-b', 'outsider', 'owner', '2026-01-01T00:00:00.000Z');
INSERT INTO projects (id, name, slug, team_id) VALUES
  ('p1', 'P1', 'p1', 'team-a'),
  ('p2', 'P2', 'p2', 'team-b'),
  ('p3', 'P3', 'p3', NULL);
INSERT INTO user_project_roles (user_id, role, project_id) VALUES ('grantee', 'admin', 'p2');
`);
}

describe("AuthorizationService", () => {
  it("project access: superadmin > grant > team membership > deny", async () => {
    seed(db);
    const authz = makeAuthz(db);
    const access = async (userId: string, projectId: string) => await Effect.runPromise(authz.projectAccess(userId, projectId));

    // superadmin: everything, including unassigned
    expect(await access("sa", "p1")).toBe("admin");
    expect(await access("sa", "p2")).toBe("admin");
    expect(await access("sa", "p3")).toBe("admin");
    // team-a members: admin/member roles from org
    expect(await access("owner", "p1")).toBe("admin");
    expect(await access("admin", "p1")).toBe("admin");
    expect(await access("member", "p1")).toBe("member");
    // cross-team: no access (grantee exception below)
    expect(await access("outsider", "p1")).toBeNull();
    expect(await access("member", "p2")).toBeNull();
    // explicit grant beats team: grantee is team-b outsider but has admin grant on p2
    expect(await access("grantee", "p2")).toBe("admin");
    // unassigned project: superadmin only
    expect(await access("owner", "p3")).toBeNull();
    expect(await access("grantee", "p3")).toBeNull();
  });

  it("team gate: superadmin or org owner/admin; plain members and outsiders denied", async () => {
    seed(db);
    const authz = makeAuthz(db);
    const manage = async (userId: string, teamId: string) => await Effect.runPromise(authz.canManageTeam(userId, teamId));

    expect(await manage("sa", "team-a")).toBe(true);
    expect(await manage("owner", "team-a")).toBe(true);
    expect(await manage("admin", "team-a")).toBe(true);
    expect(await manage("member", "team-a")).toBe(false);
    expect(await manage("outsider", "team-a")).toBe(false);
    // team-b is outsider's team
    expect(await manage("outsider", "team-b")).toBe(true);
    expect(await manage("owner", "team-b")).toBe(false);
    // grant on a project does not grant team-admin authority
    expect(await manage("grantee", "team-b")).toBe(false);
  });

  it("isTeamAdmin reads comma-joined org roles (multi-role members)", async () => {
    seed(db);
    db.prepare("UPDATE member SET role = 'owner,admin' WHERE id = 'm4'").run();
    const authz = makeAuthz(db);
    expect(await Effect.runPromise(authz.isTeamAdmin("outsider", "team-b"))).toBe(true);
    expect(await Effect.runPromise(authz.isTeamAdmin("member", "team-a"))).toBe(false);
  });

  it("settings gate: superadmin only", async () => {
    seed(db);
    const authz = makeAuthz(db);
    expect(await Effect.runPromise(authz.canManageSettings("sa"))).toBe(true);
    expect(await Effect.runPromise(authz.canManageSettings("owner"))).toBe(false);
    expect(await Effect.runPromise(authz.canManageSettings("member"))).toBe(false);
  });

  it("unknown users get no access anywhere", async () => {
    seed(db);
    const authz = makeAuthz(db);
    expect(await Effect.runPromise(authz.projectAccess("ghost", "p1"))).toBeNull();
    expect(await Effect.runPromise(authz.canManageTeam("ghost", "team-a"))).toBe(false);
    expect(await Effect.runPromise(authz.isSuperadmin("ghost"))).toBe(false);
  });
});
