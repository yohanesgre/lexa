import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readdirSync, copyFileSync, readFileSync } from "node:fs";
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

// Copy 0001–0004 into a tmp dir so the DB looks like a real pre-rename
// install; 0005 is intentionally absent and applied by each test.
function stagePreRename(): string {
  const dir = tmpDir();
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql") && !f.startsWith("0005"))) {
    copyFileSync(join(MIGRATIONS, f), join(dir, f));
  }
  return dir;
}

const SEED_PRE_RENAME = `
  INSERT INTO projects (id, name, slug) VALUES ('p1', 'P', 'p1');
  INSERT INTO columns (id, project_id, name, position) VALUES ('c1', 'p1', 'Todo', 0);
  INSERT INTO swimlanes (id, project_id, name, position) VALUES ('s1', 'p1', 'Sprint 1', 0);
  INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position) VALUES ('t1', 'p1', 'c1', 's1', 'T', 'a');
  INSERT INTO hearth_tasks (id, project_id, document_type, document_id, agent_id, skill_id, status, created_at)
    VALUES ('ft1', 'p1', 'task', 't1', 'hearth-herald', 'requirements', 'queued', '2026-01-01'),
           ('ft2', 'p1', 'task', 't1', 'hearth-blacksmith', 'review', 'queued', '2026-01-01');
  INSERT INTO hearth_task_logs (id, task_id, message)
    VALUES ('log1', 'ft1', 'started'), ('log2', 'ft2', 'started');
  INSERT INTO hearth_sessions (document_type, document_id, runtime_id, runtime_session_id, provider, agent_id, skill_id)
    VALUES ('task', 't1', 'rt1', 'sess1', 'opencode', 'hearth-blacksmith', 'review'),
           ('task', 't1', 'rt2', 'sess2', 'opencode', 'hearth-herald', 'requirements');
  INSERT INTO task_activity (task_id, actor_kind, actor_label, type, message)
    VALUES ('t1', 'agent', 'Herald', 'hearth_completed', 'Hearth: Herald completed — result ready');
  INSERT INTO settings (key, value) VALUES ('hearth_repo_cap', '5');
  INSERT INTO herald_threads (document_type, document_id, project_id, agent_id, messages)
    VALUES ('chat', 'th1', 'p1', 'hearth-herald', '[]'),
           ('chat', 'th2', 'p1', 'hearth-blacksmith', '[]');
`;

// End state shared by the FK-OFF (Bun) and FK-ON (D1) paths — they must agree.
function assertPostRename(db: Database): void {
  for (const t of ["runtime_tasks", "runtime_task_logs", "runtime_sessions"]) expect(tableExists(db, t)).toBe(true);
  for (const t of ["hearth_tasks", "hearth_task_logs", "hearth_sessions"]) expect(tableExists(db, t)).toBe(false);

  // runtime_tasks: rows preserved, one rebind per agent.
  expect(db.prepare("SELECT COUNT(*) AS n FROM runtime_tasks").get()).toEqual({ n: 2 });
  expect(db.prepare("SELECT COUNT(*) AS n FROM runtime_tasks WHERE agent_id = 'herald'").get()).toEqual({ n: 1 });
  expect(db.prepare("SELECT COUNT(*) AS n FROM runtime_tasks WHERE agent_id = 'blacksmith'").get()).toEqual({ n: 1 });
  expect(db.prepare("SELECT agent_id, document_id FROM runtime_tasks WHERE id = 'ft1'").get()).toEqual({ agent_id: "herald", document_id: "t1" });
  // runtime_task_logs: FK to the renamed parent survived, rows untouched.
  expect(db.prepare("SELECT COUNT(*) AS n FROM runtime_task_logs").get()).toEqual({ n: 2 });
  expect(db.prepare("SELECT task_id FROM runtime_task_logs ORDER BY id").all()).toEqual([{ task_id: "ft1" }, { task_id: "ft2" }]);

  // runtime_sessions: one rebind per agent.
  expect(db.prepare("SELECT COUNT(*) AS n FROM runtime_sessions").get()).toEqual({ n: 2 });
  expect(db.prepare("SELECT agent_id FROM runtime_sessions WHERE runtime_id = 'rt1'").get()).toEqual({ agent_id: "blacksmith" });
  expect(db.prepare("SELECT agent_id FROM runtime_sessions WHERE runtime_id = 'rt2'").get()).toEqual({ agent_id: "herald" });

  // lexa_agent_skills: full builtin sets moved (Herald 6, Blacksmith 3).
  expect(db.prepare("SELECT COUNT(*) AS n FROM lexa_agent_skills WHERE agent_id = 'herald'").get()).toEqual({ n: 6 });
  expect(db.prepare("SELECT COUNT(*) AS n FROM lexa_agent_skills WHERE agent_id = 'blacksmith'").get()).toEqual({ n: 3 });

  // herald_threads: one rebind per agent.
  expect(db.prepare("SELECT COUNT(*) AS n FROM herald_threads WHERE agent_id = 'herald'").get()).toEqual({ n: 1 });
  expect(db.prepare("SELECT COUNT(*) AS n FROM herald_threads WHERE agent_id = 'blacksmith'").get()).toEqual({ n: 1 });

  // lexa_agents: exactly the two builtins, original display names restored.
  expect(db.prepare("SELECT id, name FROM lexa_agents ORDER BY id").all()).toEqual([
    { id: "blacksmith", name: "Blacksmith Agent" },
    { id: "herald", name: "Herald Agent" },
  ]);

  // No old id remains in any of the five tables that carry an agent id.
  const stale = db
    .prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT id AS v FROM lexa_agents
         UNION ALL SELECT agent_id FROM runtime_tasks
         UNION ALL SELECT agent_id FROM runtime_sessions
         UNION ALL SELECT agent_id FROM lexa_agent_skills
         UNION ALL SELECT agent_id FROM herald_threads
       ) WHERE v LIKE 'hearth-%'`
    )
    .get() as { n: number };
  expect(stale.n).toBe(0);
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("runMigrations", () => {
  it("applies the real migrations dir and records _migrations", () => {
    const dbPath = join(tmpDir(), "app.db");
    runMigrations(dbPath, MIGRATIONS);
    expect(appliedMigrations(dbPath)).toEqual(["0001_init.sql", "0002_device_login.sql", "0003_herald_prices_1m_cached.sql", "0004_ui_gaps_w4.sql", "0005_runtime_rename.sql"]);
    const db = new Database(dbPath);
    expect(tableExists(db, "tasks")).toBe(true);
    expect(tableExists(db, "_migrations")).toBe(true);
    db.close();
  });

  it("is a no-op on the second run", () => {
    const dbPath = join(tmpDir(), "app.db");
    runMigrations(dbPath, MIGRATIONS);
    runMigrations(dbPath, MIGRATIONS);
    expect(appliedMigrations(dbPath)).toEqual(["0001_init.sql", "0002_device_login.sql", "0003_herald_prices_1m_cached.sql", "0004_ui_gaps_w4.sql", "0005_runtime_rename.sql"]);
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
    expect(appliedMigrations(dbPath)).toEqual(["0001_init.sql", "0002_device_login.sql", "0003_herald_prices_1m_cached.sql", "0004_ui_gaps_w4.sql", "0005_runtime_rename.sql"]);
  });

  it("runtime_events.team_id uses ON DELETE SET NULL (0004)", () => {
    const dbPath = join(tmpDir(), "app.db");
    runMigrations(dbPath, MIGRATIONS);
    const db = new Database(dbPath);
    db.exec("PRAGMA foreign_keys = ON");
    const fks = db.prepare("PRAGMA foreign_key_list(runtime_events)").all() as Array<{ from: string; table: string; on_delete: string }>;
    const teamFk = fks.find((f) => f.from === "team_id");
    expect(teamFk?.table).toBe("organization");
    expect(teamFk?.on_delete).toBe("SET NULL");

    db.exec(`
      INSERT INTO organization (id, name, slug, createdAt) VALUES ('org1','Team','team','2026-01-01');
      INSERT INTO machines (id, hostname) VALUES ('m1','host');
      INSERT INTO runtime_events (id, machine_id, action, agent_cli, team_id, status)
      VALUES ('e1','m1','install','opencode','org1','pending');
    `);
    db.prepare("DELETE FROM organization WHERE id = 'org1'").run();
    const row = db.prepare("SELECT team_id FROM runtime_events WHERE id = 'e1'").get() as { team_id: string | null };
    expect(row.team_id).toBeNull();
    db.close();
  });



  it("baseline seeds herald_threads with title, pinned, and the chat list index", () => {
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

  it("baseline seeds exactly two builtin agents on a fresh database", () => {
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
      { id: "blacksmith", name: "Blacksmith Agent" },
      { id: "herald", name: "Herald Agent" },
    ]);
    const heraldSkills = db
      .prepare("SELECT skill_id FROM lexa_agent_skills WHERE agent_id = 'herald' ORDER BY skill_id")
      .all() as Array<{ skill_id: string }>;
    const builtins = (db.prepare("SELECT id FROM lexa_skills WHERE is_builtin = 1 ORDER BY id").all() as Array<{ id: string }>).map((r) => r.id);
    expect(heraldSkills.map((r) => r.skill_id)).toEqual(builtins);
    const bsSkills = db
      .prepare("SELECT skill_id FROM lexa_agent_skills WHERE agent_id = 'blacksmith' ORDER BY skill_id")
      .all() as Array<{ skill_id: string }>;
    expect(bsSkills).toEqual([{ skill_id: "definition-of-done" }, { skill_id: "requirements" }, { skill_id: "review" }]);
    db.close();
  });

  it("baseline folds the pre-release chain into its final shape", () => {
    const dbPath = join(tmpDir(), "app.db");
    runMigrations(dbPath, MIGRATIONS);
    const db = new Database(dbPath);
    const colNames = (table: string) =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
    // 0001 baseline creates hearth_*; 0005 renames them to runtime_*.
    // forge_* never existed (folded into the 0001 baseline).
    for (const t of ["runtime_tasks", "runtime_task_logs", "runtime_sessions"]) expect(tableExists(db, t)).toBe(true);
    for (const t of ["hearth_tasks", "hearth_task_logs", "hearth_sessions", "forge_tasks", "forge_task_logs", "forge_sessions"]) expect(tableExists(db, t)).toBe(false);
    // Dropped MCP-link column and legacy github_repo column never created.
    expect(colNames("runtimes")).not.toContain("mcp_connected");
    expect(colNames("projects")).not.toContain("github_repo");
    expect(tableExists(db, "project_repos")).toBe(true);
    // Chat threads carry title + pinned with fresh-row defaults.
    expect(colNames("herald_threads")).toEqual(expect.arrayContaining(["title", "pinned"]));
    // Sprint-lane shape with the Backlog guard and done columns.
    expect(colNames("swimlanes")).toEqual(expect.arrayContaining(["milestone_id", "start_at"]));
    expect(colNames("columns")).toContain("is_done");
    const swimIndexes = (db.prepare("PRAGMA index_list(swimlanes)").all() as { name: string }[]).map((i) => i.name);
    expect(swimIndexes).toContain("idx_swimlanes_one_backlog");
    // Gateway tables exist; provider models sync at runtime, not at migrate time.
    expect(tableExists(db, "herald_models")).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS n FROM herald_models").get()).toEqual({ n: 0 });
    db.close();
  });

  it("0005 fresh database: runtime_* tables + indexes, no hearth_*", () => {
    const dbPath = join(tmpDir(), "app.db");
    runMigrations(dbPath, MIGRATIONS);
    const db = new Database(dbPath);
    for (const t of ["runtime_tasks", "runtime_task_logs", "runtime_sessions"]) expect(tableExists(db, t)).toBe(true);
    for (const t of ["hearth_tasks", "hearth_task_logs", "hearth_sessions"]) expect(tableExists(db, t)).toBe(false);
    const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[]).map((r) => r.name);
    for (const i of ["idx_runtime_tasks_created", "idx_runtime_tasks_status", "idx_runtime_task_logs_task", "idx_runtime_tasks_kind_status"]) {
      expect(idx).toContain(i);
    }
    expect(idx.some((n) => n.startsWith("idx_hearth"))).toBe(false);
    db.close();
  });

  it("0005 upgrades a seeded pre-rename database: data preserved, ids rebound", () => {
    // Stage only 0001-0004 so the DB looks like a real pre-rename install.
    const dir = stagePreRename();
    const dbPath = join(dir, "app.db");
    runMigrations(dbPath, dir);
    expect(appliedMigrations(dbPath)).toEqual(["0001_init.sql", "0002_device_login.sql", "0003_herald_prices_1m_cached.sql", "0004_ui_gaps_w4.sql"]);

    const seed = new Database(dbPath);
    seed.exec("PRAGMA foreign_keys = OFF");
    seed.exec(SEED_PRE_RENAME);
    seed.close();

    // Full real dir → only 0005 is new, so it applies on top of the seeded rows.
    runMigrations(dbPath, MIGRATIONS);

    const after = new Database(dbPath);
    assertPostRename(after);
    // Activity values + settings key rebind.
    expect(after.prepare("SELECT type FROM task_activity WHERE task_id = 't1'").get()).toEqual({ type: "runtime_completed" });
    expect(after.prepare("SELECT value FROM settings WHERE key = 'runtime_repo_cap'").get()).toEqual({ value: "5" });
    // Indexes renamed.
    const idx = (after.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[]).map((r) => r.name);
    expect(idx).toContain("idx_runtime_tasks_created");
    expect(idx.some((n) => n.startsWith("idx_hearth"))).toBe(false);
    after.close();
  });

  // The Bun runner disables FK enforcement, but the Workers/D1 runner applies
  // the file as one batch with enforcement ON. 0005 must therefore survive an
  // FK-ON apply with the identical end state (no FK violation on the rebind).
  it("0005 is FK-safe with foreign_keys=ON (Workers/D1 runner)", () => {
    const dir = stagePreRename();
    const dbPath = join(dir, "app.db");
    runMigrations(dbPath, dir);

    const db = new Database(dbPath);
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(SEED_PRE_RENAME);

    const sql = readFileSync(join(MIGRATIONS, "0005_runtime_rename.sql"), "utf-8");
    db.exec("BEGIN");
    try {
      db.exec(sql);
      db.prepare("INSERT INTO _migrations (name) VALUES (?)").run("0005_runtime_rename.sql");
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }

    assertPostRename(db);
    expect(appliedMigrations(dbPath)).toContain("0005_runtime_rename.sql");
    db.close();
  });

  // bun:sqlite `exec()` parses the whole file and the surrounding BEGIN/COMMIT
  // rolls back on any later statement's failure. Failure injection is an FK
  // violation (the path the Workers/D1 runner can fail on), not a missing
  // table. Note: bun:sqlite 1.4.2 silently rolls back an FK violation when
  // BEGIN/COMMIT are embedded inside the SAME exec() string; the runner issues
  // them as separate exec() calls and migration files contain no BEGIN/COMMIT,
  // so the error surfaces and ROLLBACK runs (asserted below). No partial-commit
  // anomaly is observable on the runner path.
  it("0005 rolls back atomically with foreign_keys=ON (no partial rebind)", () => {
    const dir = stagePreRename();
    const dbPath = join(dir, "app.db");
    runMigrations(dbPath, dir);

    const db = new Database(dbPath);
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(SEED_PRE_RENAME);

    const sql = readFileSync(join(MIGRATIONS, "0005_runtime_rename.sql"), "utf-8");
    // Append an FK-violating statement so the failure lands after the parent
    // INSERTs, the child rebinds, and the old-parent DELETE.
    const broken = `${sql}\nUPDATE runtime_tasks SET agent_id = 'ghost' WHERE id = 'ft1';\n`;
    db.exec("BEGIN");
    let threw = false;
    try {
      db.exec(broken);
      db.prepare("INSERT INTO _migrations (name) VALUES (?)").run("0005_runtime_rename.sql");
      db.exec("COMMIT");
    } catch {
      threw = true;
      db.exec("ROLLBACK");
    }
    expect(threw).toBe(true);

    // Pre-rename state is untouched: no rename, no new parent rows, names intact.
    expect(tableExists(db, "hearth_tasks")).toBe(true);
    expect(tableExists(db, "runtime_tasks")).toBe(false);
    expect(db.prepare("SELECT COUNT(*) AS n FROM lexa_agents WHERE id IN ('herald', 'blacksmith')").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM lexa_agents WHERE id IN ('hearth-herald', 'hearth-blacksmith')").get()).toEqual({ n: 2 });
    expect(db.prepare("SELECT name FROM lexa_agents WHERE id = 'hearth-herald'").get()).toEqual({ name: "Herald Agent" });
    expect(appliedMigrations(dbPath)).not.toContain("0005_runtime_rename.sql");
    db.close();
  });
});
