import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, copyFileSync, readdirSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { runMigrations } from "./migrate";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

let dirs: string[] = [];

function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "lexa-migrate-test-"));
  dirs.push(d);
  return d;
}

function appliedMigrations(dbPath: string): string[] {
  const db = new Database(dbPath);
  const rows = db.prepare("SELECT name FROM _migrations ORDER BY name").all() as { name: string }[];
  db.close();
  return rows.map((r) => r.name);
}

function tableExists(db: Database, name: string): boolean {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("runMigrations", () => {
  it("applies the real migrations dir and records _migrations", () => {
    const dbPath = join(tmpDir(), "app.db");
    runMigrations(dbPath, MIGRATIONS);
    expect(appliedMigrations(dbPath)).toEqual(["0001_init.sql", "0002_project_repos.sql", "0003_forge_sessions.sql", "0004_auth_roles_teams.sql", "0005_milestones_sprints.sql", "0006_drop_mcp_connected.sql", "0007_task_keys.sql", "0008_wiki_share_links.sql", "0009_attachments.sql", "0010_herald.sql", "0011_chat_threads.sql", "0012_chat_pins.sql", "0013_hearth_engine.sql", "0014_herald_reasoning_effort.sql", "0015_hearth_rename.sql", "0016_herald_write_tools.sql", "0017_herald_gateway.sql", "0018_herald_gateway_fallback_and_priority.sql"]);
    const db = new Database(dbPath);
    expect(tableExists(db, "tasks")).toBe(true);
    expect(tableExists(db, "_migrations")).toBe(true);
    db.close();
  });

  it("is a no-op on the second run", () => {
    const dbPath = join(tmpDir(), "app.db");
    runMigrations(dbPath, MIGRATIONS);
    runMigrations(dbPath, MIGRATIONS);
    expect(appliedMigrations(dbPath)).toEqual(["0001_init.sql", "0002_project_repos.sql", "0003_forge_sessions.sql", "0004_auth_roles_teams.sql", "0005_milestones_sprints.sql", "0006_drop_mcp_connected.sql", "0007_task_keys.sql", "0008_wiki_share_links.sql", "0009_attachments.sql", "0010_herald.sql", "0011_chat_threads.sql", "0012_chat_pins.sql", "0013_hearth_engine.sql", "0014_herald_reasoning_effort.sql", "0015_hearth_rename.sql", "0016_herald_write_tools.sql", "0017_herald_gateway.sql", "0018_herald_gateway_fallback_and_priority.sql"]);
  });

  it("rolls back a failed migration atomically (no partial schema, no _migrations row)", () => {
    const dir = tmpDir();
    writeFileSync(join(dir, "0001_ok.sql"), "CREATE TABLE t1 (id TEXT PRIMARY KEY);");
    writeFileSync(
      join(dir, "0002_bad.sql"),
      "CREATE TABLE t2 (id TEXT PRIMARY KEY); CREATE TABLE t1 (id TEXT PRIMARY KEY);"
    );
    const dbPath = join(dir, "app.db");
    expect(() => runMigrations(dbPath, dir)).toThrow();
    const db = new Database(dbPath);
    expect(tableExists(db, "t1")).toBe(true); // 0001 committed
    expect(tableExists(db, "t2")).toBe(false); // 0002 rolled back
    db.close();
    // 0001 recorded, failed 0002 leaves no _migrations row.
    expect(appliedMigrations(dbPath)).toEqual(["0001_ok.sql"]);
    // Fix the dir → re-run succeeds cleanly.
    rmSync(join(dir, "0002_bad.sql"));
    expect(() => runMigrations(dbPath, dir)).not.toThrow();
    expect(appliedMigrations(dbPath)).toEqual(["0001_ok.sql"]);
  });

  it("keeps the default migrations dir (prod behavior)", () => {
    const dbPath = join(tmpDir(), "app.db");
    runMigrations(dbPath);
    expect(appliedMigrations(dbPath)).toEqual(["0001_init.sql", "0002_project_repos.sql", "0003_forge_sessions.sql", "0004_auth_roles_teams.sql", "0005_milestones_sprints.sql", "0006_drop_mcp_connected.sql", "0007_task_keys.sql", "0008_wiki_share_links.sql", "0009_attachments.sql", "0010_herald.sql", "0011_chat_threads.sql", "0012_chat_pins.sql", "0013_hearth_engine.sql", "0014_herald_reasoning_effort.sql", "0015_hearth_rename.sql", "0016_herald_write_tools.sql", "0017_herald_gateway.sql", "0018_herald_gateway_fallback_and_priority.sql"]);
  });

  it("0011 backfills chat titles from the first text message; image-array first messages stay NULL", () => {
    // Simulate a pre-0011 database: apply 0001–0010 from a staged dir, seed
    // chat rows, then run the real dir so ONLY 0011 applies over the data.
    const dir = tmpDir();
    const pre = join(dir, "pre");
    mkdirSync(pre);
    for (const name of readdirSync(MIGRATIONS).filter((n) => n < "0011")) {
      copyFileSync(join(MIGRATIONS, name), join(pre, name));
    }
    const dbPath = join(dir, "app.db");
    runMigrations(dbPath, pre);
    expect(appliedMigrations(dbPath)).not.toContain("0011_chat_threads.sql");

    const db = new Database(dbPath);
    db.exec(`
INSERT INTO projects (id, name, slug) VALUES ('p1', 'P', 'p1');
INSERT INTO users (id, email, name, role) VALUES ('u1', 'u1@x', 'U1', 'superadmin');
-- Text first message → title derived (newlines collapsed, ≤60 chars).
INSERT INTO herald_threads (document_type, document_id, project_id, owner_user_id, messages)
VALUES ('chat', 'c-text', 'p1', 'u1', '[{"role":"user","content":"Fix the login bug\r\nthen verify sessions"}]');
-- Image-ref array first message → title stays NULL.
INSERT INTO herald_threads (document_type, document_id, project_id, owner_user_id, messages)
VALUES ('chat', 'c-img', 'p1', 'u1', '[{"role":"user","content":[{"type":"image-ref","storageKey":"k","mimeType":"image/png"}]}]');
-- Empty transcript → NULL.
INSERT INTO herald_threads (document_type, document_id, project_id, owner_user_id, messages)
VALUES ('chat', 'c-empty', 'p1', 'u1', '[]');
-- Document threads are never touched by the chat backfill.
INSERT INTO herald_threads (document_type, document_id, project_id, agent_id, skill_id, messages)
VALUES ('task', 't1', 'p1', 'a1', 's1', '[{"role":"user","content":"should not be titled"}]');
`);
    db.close();

    runMigrations(dbPath, MIGRATIONS);
    expect(appliedMigrations(dbPath)).toContain("0011_chat_threads.sql");

    const migrated = new Database(dbPath);
    const rows = migrated.prepare(
      `SELECT document_id, title FROM herald_threads ORDER BY document_id`
    ).all() as { document_id: string; title: string | null }[];
    const byId = Object.fromEntries(rows.map((r) => [r.document_id, r.title]));
    // Backfill swaps CR and LF each for a space (CRLF → two spaces) — the
    // whitespace-collapse refinement happens only in deriveChatTitle.
    expect(byId["c-text"]).toBe("Fix the login bug  then verify sessions");
    expect(byId["c-img"]).toBeNull();
    expect(byId["c-empty"]).toBeNull();
    expect(byId["t1"]).toBeNull();
    // Chat list index exists (0012 later replaces the 0011 name — either
    // variant proves the partial index landed).
    const idx = migrated.prepare(
      `SELECT name FROM sqlite_master WHERE type='index' AND name IN ('idx_herald_threads_chat_owner','idx_herald_threads_chat_list')`
    ).get();
    expect(idx).toBeTruthy();
    const colNames = (migrated.prepare("PRAGMA table_info(herald_threads)").all() as { name: string }[]).map((c) => c.name);
    expect(colNames).toContain("title");
    migrated.close();
  });

  it("0012 adds the pinned column and swaps the chat list index", () => {
    const dbPath = join(tmpDir(), "app.db");
    runMigrations(dbPath, MIGRATIONS);
    const db = new Database(dbPath);
    const colNames = (db.prepare("PRAGMA table_info(herald_threads)").all() as { name: string }[]).map((c) => c.name);
    expect(colNames).toContain("pinned");
    // Fresh rows default to unpinned.
    db.exec(`
INSERT INTO projects (id, name, slug) VALUES ('p1', 'P', 'p1');
INSERT INTO users (id, email, name, role) VALUES ('u1', 'u1@x', 'U1', 'superadmin');
INSERT INTO herald_threads (document_type, document_id, project_id, owner_user_id, messages)
VALUES ('chat', 'c1', 'p1', 'u1', '[]');
`);
    const row = db.prepare(`SELECT pinned FROM herald_threads WHERE document_id = 'c1'`).get() as { pinned: number };
    expect(row.pinned).toBe(0);
    // New list index present, old owner index gone.
    const idxNames = (db.prepare("PRAGMA index_list(herald_threads)").all() as { name: string }[]).map((i) => i.name);
    expect(idxNames).toContain("idx_herald_threads_chat_list");
    expect(idxNames).not.toContain("idx_herald_threads_chat_owner");
    db.close();
  });

  it("0013 seeds exactly two builtin agents on a fresh database", () => {
    const dbPath = join(tmpDir(), "app.db");
    runMigrations(dbPath, MIGRATIONS);
    const db = new Database(dbPath);
    const cols = (db.prepare("PRAGMA table_info(herald_settings)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(
      expect.arrayContaining(["engine", "engine_switcher_enabled", "primary_supports_images", "reasoning_effort", "write_tools", "fallback_model_ids"])
    );
    expect(cols).not.toContain("vision_model");
    expect(cols).not.toContain("kind");
    expect(cols).not.toContain("base_url");
    expect(cols).not.toContain("api_key");
    expect(cols).not.toContain("model");
    const agents = db.prepare("SELECT id, name FROM lexa_agents WHERE is_builtin = 1 ORDER BY id").all() as Array<{ id: string; name: string }>;
    expect(agents).toEqual([
      { id: "hearth-blacksmith", name: "Blacksmith Agent" },
      { id: "hearth-herald", name: "Herald Agent" },
    ]);
    const heraldSkills = db
      .prepare("SELECT skill_id FROM lexa_agent_skills WHERE agent_id = 'hearth-herald' ORDER BY skill_id")
      .all() as Array<{ skill_id: string }>;
    const builtins = (db.prepare("SELECT id FROM lexa_skills WHERE is_builtin = 1 ORDER BY id").all() as Array<{ id: string }>).map((r) => r.id);
    expect(heraldSkills.map((r) => r.skill_id)).toEqual(builtins);
    const bsSkills = db
      .prepare("SELECT skill_id FROM lexa_agent_skills WHERE agent_id = 'hearth-blacksmith' ORDER BY skill_id")
      .all() as Array<{ skill_id: string }>;
    expect(bsSkills).toEqual([{ skill_id: "definition-of-done" }, { skill_id: "requirements" }, { skill_id: "review" }]);
    db.close();
  });

  it("0013 rebinds the lexa agent, its hearth tasks and junction rows to hearth-herald", () => {
    const dir = tmpDir();
    const pre = join(dir, "pre");
    mkdirSync(pre);
    for (const name of readdirSync(MIGRATIONS).filter((n) => n < "0013")) {
      copyFileSync(join(MIGRATIONS, name), join(pre, name));
    }
    const dbPath = join(dir, "app.db");
    runMigrations(dbPath, pre);
    expect(appliedMigrations(dbPath)).not.toContain("0013_hearth_engine.sql");

    const db = new Database(dbPath);
    db.exec(`
INSERT INTO projects (id, name, slug) VALUES ('p1', 'P', 'p1');
INSERT INTO lexa_agents (id, name, description, instructions) VALUES ('custom', 'Custom', '', 'x');
INSERT INTO lexa_skills (id, name, description, instructions) VALUES ('skill-x', 'X', '', 'x');
INSERT INTO lexa_agent_skills (agent_id, skill_id) VALUES ('lexa', 'skill-x'), ('custom', 'skill-x');
INSERT INTO forge_tasks (id, project_id, document_type, document_id, agent_id, skill_id)
VALUES ('ft1', 'p1', 'task', 't1', 'lexa', 'skill-x');
`);
    db.close();

    runMigrations(dbPath, MIGRATIONS);
    expect(appliedMigrations(dbPath)).toContain("0013_hearth_engine.sql");

    const m = new Database(dbPath);
    expect(m.prepare("SELECT COUNT(*) AS n FROM lexa_agents WHERE id = 'lexa'").get()).toEqual({ n: 0 });
    expect(m.prepare("SELECT agent_id FROM hearth_tasks WHERE id = 'ft1'").get()).toEqual({ agent_id: "hearth-herald" });
    const heraldHasCustom = m
      .prepare("SELECT COUNT(*) AS n FROM lexa_agent_skills WHERE agent_id = 'hearth-herald' AND skill_id = 'skill-x'")
      .get();
    expect(heraldHasCustom).toEqual({ n: 1 });
    const heraldBuiltinCount = m
      .prepare(
        "SELECT COUNT(*) AS n FROM lexa_agent_skills WHERE agent_id = 'hearth-herald' AND skill_id IN (SELECT id FROM lexa_skills WHERE is_builtin = 1)"
      )
      .get();
    expect(heraldBuiltinCount).toEqual({ n: 6 });
    // Non-lexa agents keep their bindings untouched.
    const customKept = m.prepare("SELECT COUNT(*) AS n FROM lexa_agent_skills WHERE agent_id = 'custom'").get();
    expect(customKept).toEqual({ n: 1 });
    m.close();
  });

  it("migrates legacy github_repo and task-linked repos into project_repos with roles", () => {
    // Simulate a pre-0002 database: schema 0001 applied + legacy data.
    const dir = tmpDir();
    const dbPath = join(dir, "app.db");
    const db = new Database(dbPath);
    db.exec(readFileSync(join(MIGRATIONS, "0001_init.sql"), "utf-8"));
    db.exec("CREATE TABLE _migrations (name TEXT PRIMARY KEY, applied_at TEXT DEFAULT (datetime('now')))");
    db.prepare("INSERT INTO _migrations (name) VALUES ('0001_init.sql')").run();
    const uuid = () => crypto.randomUUID();
    const p1 = uuid(), p2 = uuid();
    db.prepare("INSERT INTO projects (id, name, slug, description, github_repo) VALUES (?, ?, ?, ?, ?)").run(p1, "P1", "p1", "", "acme/api-server");
    db.prepare("INSERT INTO projects (id, name, slug, description, github_repo) VALUES (?, ?, ?, ?, ?)").run(p2, "P2", "p2", "", null);
    const c1 = uuid(), c2 = uuid();
    db.prepare("INSERT INTO columns (id, project_id, name, position) VALUES (?, ?, 'Todo', 0)").run(c1, p1);
    db.prepare("INSERT INTO columns (id, project_id, name, position) VALUES (?, ?, 'Todo', 0)").run(c2, p2);
    const s1 = uuid(), s2 = uuid();
    db.prepare("INSERT INTO swimlanes (id, project_id, name, position, kind) VALUES (?, ?, 'Backlog', 0, 'backlog')").run(s1, p1);
    db.prepare("INSERT INTO swimlanes (id, project_id, name, position, kind) VALUES (?, ?, 'Backlog', 0, 'backlog')").run(s2, p2);
    const t1 = uuid(), t2 = uuid(), t3 = uuid();
    db.prepare("INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position) VALUES (?, ?, ?, ?, 'T1', 'a0')").run(t1, p1, c1, s1);
    db.prepare("INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position) VALUES (?, ?, ?, ?, 'T2', 'a1')").run(t2, p1, c1, s1);
    db.prepare("INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position) VALUES (?, ?, ?, ?, 'T3', 'a0')").run(t3, p2, c2, s2);
    db.prepare("INSERT INTO task_github_issues (task_id, issue_id, issue_number, repo) VALUES (?, 'n1', 1, 'acme/api-server')").run(t1);
    db.prepare("INSERT INTO task_github_issues (task_id, issue_id, issue_number, repo) VALUES (?, 'n2', 2, 'acme/web-client')").run(t2);
    db.prepare("INSERT INTO task_github_issues (task_id, issue_id, issue_number, repo) VALUES (?, 'n3', 3, 'acme/web-client')").run(t3);
    db.close();

    runMigrations(dbPath, MIGRATIONS);

    const migrated = new Database(dbPath);
    const rows = migrated.prepare(
      "SELECT p.slug, pr.repo, pr.source_role, pr.workspace_role FROM project_repos pr JOIN projects p ON p.id = pr.project_id ORDER BY p.slug, pr.repo"
    ).all() as { slug: string; repo: string; source_role: number; workspace_role: number }[];
    expect(rows).toEqual([
      { slug: "p1", repo: "acme/api-server", source_role: 1, workspace_role: 1 }, // legacy github_repo → both roles
      { slug: "p1", repo: "acme/web-client", source_role: 0, workspace_role: 1 }, // task-linked → workspace only
      { slug: "p2", repo: "acme/web-client", source_role: 0, workspace_role: 1 }, // cross-project share
    ]);
    // github_repo column is gone; echo columns exist.
    const projectsCols = (migrated.prepare("PRAGMA table_info(projects)").all() as { name: string }[]).map((c) => c.name);
    expect(projectsCols).not.toContain("github_repo");
    const tgiCols = (migrated.prepare("PRAGMA table_info(task_github_issues)").all() as { name: string }[]).map((c) => c.name);
    expect(tgiCols).toEqual(expect.arrayContaining(["pushed_title", "pushed_body", "push_failed"]));
    migrated.close();
  });

  it("0005 upgrades a pre-sprint swimlanes table: milestone→sprint, loose lanes, columns.is_done", () => {
    // Simulate a pre-0005 database: full schema applied + legacy 'milestone'-kind lanes.
    const dir = tmpDir();
    const dbPath = join(dir, "app.db");
    const db = new Database(dbPath);
    db.exec(readFileSync(join(MIGRATIONS, "0001_init.sql"), "utf-8"));
    db.exec("CREATE TABLE _migrations (name TEXT PRIMARY KEY, applied_at TEXT DEFAULT (datetime('now')))");
    db.prepare("INSERT INTO _migrations (name) VALUES ('0001_init.sql')").run();
    db.prepare("INSERT INTO projects (id, name, slug, description) VALUES ('p1', 'P', 'p1', '')").run();
    db.prepare("INSERT INTO columns (id, project_id, name, position) VALUES ('c1', 'p1', 'Todo', 0)").run();
    // Pre-0005 shape: kind CHECK ('backlog','milestone'), no milestone_id/start_at.
    db.exec("DROP TABLE swimlanes");
    db.exec(`CREATE TABLE swimlanes (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '', position INTEGER NOT NULL,
      due_at TEXT, archived_at TEXT,
      kind TEXT NOT NULL DEFAULT 'milestone' CHECK (kind IN ('backlog','milestone'))
    )`);
    db.prepare("INSERT INTO swimlanes (id, project_id, name, position, kind, due_at) VALUES ('s1', 'p1', 'Sprint 7', 1, 'milestone', '2026-08-30')").run();
    db.prepare("INSERT INTO swimlanes (id, project_id, name, position, kind) VALUES ('b1', 'p1', 'Backlog', 0, 'backlog')").run();
    db.prepare("INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position) VALUES ('t1', 'p1', 'c1', 's1', 'T', 'a0')").run();
    db.close();

    runMigrations(dbPath, MIGRATIONS);

    const upgraded = new Database(dbPath);
    const lanes = upgraded.prepare("SELECT id, kind, milestone_id, start_at FROM swimlanes ORDER BY position").all() as { id: string; kind: string; milestone_id: string | null; start_at: string | null }[];
    expect(lanes).toEqual([
      { id: "b1", kind: "backlog", milestone_id: null, start_at: null },
      { id: "s1", kind: "sprint", milestone_id: null, start_at: null },
    ]);
    const colNames = (upgraded.prepare("PRAGMA table_info(columns)").all() as { name: string }[]).map((c) => c.name);
    expect(colNames).toContain("is_done");
    const idxNames = (upgraded.prepare("PRAGMA index_list(swimlanes)").all() as { name: string }[]).map((i) => i.name);
    expect(idxNames).toEqual(expect.arrayContaining(["idx_swimlanes_one_backlog", "idx_swimlanes_proj", "idx_swimlanes_milestone"]));
    // Task still references its lane (data survived the rebuild).
    const t = upgraded.prepare("SELECT swimlane_id FROM tasks WHERE id = 't1'").get() as { swimlane_id: string };
    expect(t.swimlane_id).toBe("s1");
    upgraded.close();
  });
});
