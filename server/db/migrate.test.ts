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
// install; 0005 and 0006 are intentionally absent and applied by each test.
function stagePreRename(): string {
  const dir = tmpDir();
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql") && f < "0005")) {
    copyFileSync(join(MIGRATIONS, f), join(dir, f));
  }
  return dir;
}

// Copy 0001–0005 into a tmp dir: the DB is post-0005 (runtime rename) but
// pre-0006 (assistant rename) — the exact shape 0006 must upgrade.
function stagePreAssistant(): string {
  const dir = tmpDir();
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql") && f < "0006")) {
    copyFileSync(join(MIGRATIONS, f), join(dir, f));
  }
  return dir;
}

// Copy every migration before 0007 so the DB is exactly the shape 0007 must
// upgrade (runtimes.team_id still ON DELETE SET NULL).
function stagePre0007(): string {
  const dir = tmpDir();
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql") && f < "0007")) {
    copyFileSync(join(MIGRATIONS, f), join(dir, f));
  }
  return dir;
}

// A team-scoped runtime (r1), a queued runtime task linked to it (rt1), and a
// team-less project whose task is queued but unlinked. Used by 0007's rebuild
// tests to prove the parent FK flips to RESTRICT and the child link survives.
const SEED_0007 = `
  INSERT INTO organization (id, name, slug, createdAt) VALUES ('org1', 'Team', 'team', '2026-01-01');
  INSERT INTO machines (id, hostname) VALUES ('m1', 'host');
  INSERT INTO runtimes (id, name, provider, machine_id, team_id) VALUES ('r1', 'R', 'opencode', 'm1', 'org1');
  INSERT INTO projects (id, name, slug) VALUES ('p1', 'P', 'p1');
  INSERT INTO columns (id, project_id, name, position) VALUES ('c1', 'p1', 'Todo', 0);
  INSERT INTO swimlanes (id, project_id, name, position, kind) VALUES ('s1', 'p1', 'Main', 0, 'backlog');
  INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position) VALUES ('t1', 'p1', 'c1', 's1', 'T', 'a0');
  INSERT INTO lexa_agents (id, name, description, instructions, is_builtin) VALUES ('a1', 'A', '', '', 0);
  INSERT INTO lexa_skills (id, name, description, instructions, is_builtin) VALUES ('sk1', 'S', '', '', 0);
  INSERT INTO runtime_tasks (id, project_id, document_type, document_id, agent_id, skill_id, status, runtime_id)
    VALUES ('rt1', 'p1', 'task', 't1', 'a1', 'sk1', 'queued', 'r1');
`;

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
// Parameterized on the thread table + agent identity because the 0005-only
// path stops at `herald`, while the full chain (0005+0006) ends at `assistant`.
function assertPostRename(
  db: Database,
  threadTable: string,
  agentId: string,
  agentName: string
): void {
  for (const t of ["runtime_tasks", "runtime_task_logs", "runtime_sessions"]) expect(tableExists(db, t)).toBe(true);
  for (const t of ["hearth_tasks", "hearth_task_logs", "hearth_sessions"]) expect(tableExists(db, t)).toBe(false);

  // runtime_tasks: rows preserved, one rebind per agent.
  expect(db.prepare("SELECT COUNT(*) AS n FROM runtime_tasks").get()).toEqual({ n: 2 });
  expect(db.prepare(`SELECT COUNT(*) AS n FROM runtime_tasks WHERE agent_id = '${agentId}'`).get()).toEqual({ n: 1 });
  expect(db.prepare("SELECT COUNT(*) AS n FROM runtime_tasks WHERE agent_id = 'blacksmith'").get()).toEqual({ n: 1 });
  expect(db.prepare("SELECT agent_id, document_id FROM runtime_tasks WHERE id = 'ft1'").get()).toEqual({ agent_id: agentId, document_id: "t1" });
  // runtime_task_logs: FK to the renamed parent survived, rows untouched.
  expect(db.prepare("SELECT COUNT(*) AS n FROM runtime_task_logs").get()).toEqual({ n: 2 });
  expect(db.prepare("SELECT task_id FROM runtime_task_logs ORDER BY id").all()).toEqual([{ task_id: "ft1" }, { task_id: "ft2" }]);

  // runtime_sessions: one rebind per agent.
  expect(db.prepare("SELECT COUNT(*) AS n FROM runtime_sessions").get()).toEqual({ n: 2 });
  expect(db.prepare("SELECT agent_id FROM runtime_sessions WHERE runtime_id = 'rt1'").get()).toEqual({ agent_id: "blacksmith" });
  expect(db.prepare("SELECT agent_id FROM runtime_sessions WHERE runtime_id = 'rt2'").get()).toEqual({ agent_id: agentId });

  // lexa_agent_skills: full builtin sets moved — the path's agentId carries 6
  // skills, Blacksmith 3. The 0005-only path asserts agentId='herald', the full
  // 0005+0006 chain 'assistant'.
  expect(db.prepare(`SELECT COUNT(*) AS n FROM lexa_agent_skills WHERE agent_id = '${agentId}'`).get()).toEqual({ n: 6 });
  expect(db.prepare("SELECT COUNT(*) AS n FROM lexa_agent_skills WHERE agent_id = 'blacksmith'").get()).toEqual({ n: 3 });

  // thread table: one rebind per agent.
  expect(db.prepare(`SELECT COUNT(*) AS n FROM ${threadTable} WHERE agent_id = '${agentId}'`).get()).toEqual({ n: 1 });
  expect(db.prepare(`SELECT COUNT(*) AS n FROM ${threadTable} WHERE agent_id = 'blacksmith'`).get()).toEqual({ n: 1 });

  // lexa_agents: exactly the two builtins, original display names restored.
  // ORDER BY id, so the expected order follows the id lexicographically
  // (assistant < blacksmith, but blacksmith < herald).
  expect(db.prepare("SELECT id, name FROM lexa_agents ORDER BY id").all()).toEqual(
    [
      { id: agentId, name: agentName },
      { id: "blacksmith", name: "Blacksmith Agent" },
    ].sort((a, b) => a.id.localeCompare(b.id))
  );

  // No old id remains in any of the five tables that carry an agent id.
  const stale = db
    .prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT id AS v FROM lexa_agents
         UNION ALL SELECT agent_id FROM runtime_tasks
         UNION ALL SELECT agent_id FROM runtime_sessions
         UNION ALL SELECT agent_id FROM lexa_agent_skills
         UNION ALL SELECT agent_id FROM ${threadTable}
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
    expect(appliedMigrations(dbPath)).toEqual(["0001_init.sql", "0002_device_login.sql", "0003_herald_prices_1m_cached.sql", "0004_ui_gaps_w4.sql", "0005_runtime_rename.sql", "0006_assistant_rename.sql", "0007_runtimes_team_restrict.sql"]);
    const db = new Database(dbPath);
    expect(tableExists(db, "tasks")).toBe(true);
    expect(tableExists(db, "_migrations")).toBe(true);
    db.close();
  });

  it("is a no-op on the second run", () => {
    const dbPath = join(tmpDir(), "app.db");
    runMigrations(dbPath, MIGRATIONS);
    runMigrations(dbPath, MIGRATIONS);
    expect(appliedMigrations(dbPath)).toEqual(["0001_init.sql", "0002_device_login.sql", "0003_herald_prices_1m_cached.sql", "0004_ui_gaps_w4.sql", "0005_runtime_rename.sql", "0006_assistant_rename.sql", "0007_runtimes_team_restrict.sql"]);
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
    expect(appliedMigrations(dbPath)).toEqual(["0001_init.sql", "0002_device_login.sql", "0003_herald_prices_1m_cached.sql", "0004_ui_gaps_w4.sql", "0005_runtime_rename.sql", "0006_assistant_rename.sql", "0007_runtimes_team_restrict.sql"]);
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



  it("baseline seeds assistant_threads with title, pinned, and the chat list index", () => {
    const dbPath = join(tmpDir(), "app.db");
    runMigrations(dbPath, MIGRATIONS);
    const db = new Database(dbPath);
    const colNames = (db.prepare("PRAGMA table_info(assistant_threads)").all() as { name: string }[]).map((c) => c.name);
    expect(colNames).toContain("pinned");
    // Fresh rows default to unpinned.
    db.exec(`
INSERT INTO projects (id, name, slug) VALUES ('p1', 'P', 'p1');
INSERT INTO users (id, email, name, role) VALUES ('u1', 'u1@x', 'U1', 'superadmin');
INSERT INTO assistant_threads (document_type, document_id, project_id, owner_user_id, messages)
VALUES ('chat', 'c1', 'p1', 'u1', '[]');
`);
    const row = db.prepare(`SELECT pinned FROM assistant_threads WHERE document_id = 'c1'`).get() as { pinned: number };
    expect(row.pinned).toBe(0);
    // New list index present, old owner index gone.
    const idxNames = (db.prepare("PRAGMA index_list(assistant_threads)").all() as { name: string }[]).map((i) => i.name);
    expect(idxNames).toContain("idx_assistant_threads_chat_list");
    expect(idxNames).not.toContain("idx_assistant_threads_chat_owner");
    db.close();
  });

  it("baseline seeds exactly two builtin agents on a fresh database", () => {
    const dbPath = join(tmpDir(), "app.db");
    runMigrations(dbPath, MIGRATIONS);
    const db = new Database(dbPath);
    const cols = (db.prepare("PRAGMA table_info(assistant_settings)").all() as { name: string }[]).map((c) => c.name);
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
      { id: "assistant", name: "Assistant Agent" },
      { id: "blacksmith", name: "Blacksmith Agent" },
    ]);
    const assistantSkills = db
      .prepare("SELECT skill_id FROM lexa_agent_skills WHERE agent_id = 'assistant' ORDER BY skill_id")
      .all() as Array<{ skill_id: string }>;
    const builtins = (db.prepare("SELECT id FROM lexa_skills WHERE is_builtin = 1 ORDER BY id").all() as Array<{ id: string }>).map((r) => r.id);
    expect(assistantSkills.map((r) => r.skill_id)).toEqual(builtins);
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
    expect(colNames("assistant_threads")).toEqual(expect.arrayContaining(["title", "pinned"]));
    // Sprint-lane shape with the Backlog guard and done columns.
    expect(colNames("swimlanes")).toEqual(expect.arrayContaining(["milestone_id", "start_at"]));
    expect(colNames("columns")).toContain("is_done");
    const swimIndexes = (db.prepare("PRAGMA index_list(swimlanes)").all() as { name: string }[]).map((i) => i.name);
    expect(swimIndexes).toContain("idx_swimlanes_one_backlog");
    // Gateway tables exist; provider models sync at runtime, not at migrate time.
    expect(tableExists(db, "assistant_models")).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS n FROM assistant_models").get()).toEqual({ n: 0 });
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
    assertPostRename(after, "assistant_threads", "assistant", "Assistant Agent");
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

    assertPostRename(db, "herald_threads", "herald", "Herald Agent");
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

  it("0006 fresh database: assistant_* tables, via_assistant columns, no herald_*", () => {
    const dbPath = join(tmpDir(), "app.db");
    runMigrations(dbPath, MIGRATIONS);
    const db = new Database(dbPath);

    for (const t of ["assistant_threads", "assistant_pending_writes", "assistant_settings", "assistant_providers", "assistant_model_prices", "assistant_provider_health", "assistant_models", "assistant_call_logs"]) {
      expect(tableExists(db, t)).toBe(true);
    }
    for (const t of ["herald_threads", "herald_pending_writes", "herald_settings", "herald_providers", "herald_model_prices", "herald_provider_health", "herald_models", "herald_call_logs"]) {
      expect(tableExists(db, t)).toBe(false);
    }

    const commentCols = (db.prepare("PRAGMA table_info(task_comments)").all() as { name: string }[]).map((c) => c.name);
    expect(commentCols).toContain("via_assistant");
    expect(commentCols).not.toContain("via_herald");
    const activityCols = (db.prepare("PRAGMA table_info(task_activity)").all() as { name: string }[]).map((c) => c.name);
    expect(activityCols).toContain("via_assistant");
    expect(activityCols).not.toContain("via_herald");

    const settingsSql = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'assistant_settings'").get() as { sql: string }).sql;
    expect(settingsSql).toContain("DEFAULT 'assistant'");
    expect(settingsSql).toContain("IN ('assistant','blacksmith')");

    expect(db.prepare("SELECT id, name FROM lexa_agents ORDER BY id").all()).toEqual([
      { id: "assistant", name: "Assistant Agent" },
      { id: "blacksmith", name: "Blacksmith Agent" },
    ]);

    db.close();
  });

  it("0006 upgrades a seeded herald database: data preserved, values remapped, ids rebound", () => {
    // Stage 0001–0005: the DB is post-runtime-rename but pre-assistant-rename.
    const dir = stagePreAssistant();
    const dbPath = join(dir, "app.db");
    runMigrations(dbPath, dir);
    expect(appliedMigrations(dbPath)).toEqual(["0001_init.sql", "0002_device_login.sql", "0003_herald_prices_1m_cached.sql", "0004_ui_gaps_w4.sql", "0005_runtime_rename.sql"]);

    const seed = new Database(dbPath);
    seed.exec("PRAGMA foreign_keys = OFF");
    seed.exec(`
      INSERT INTO projects (id, name, slug) VALUES ('p1', 'P', 'p1');
      INSERT INTO users (id, email, name, role) VALUES ('u1', 'u1@x', 'U1', 'superadmin');
      INSERT INTO columns (id, project_id, name, position) VALUES ('c1', 'p1', 'Todo', 0);
      INSERT INTO swimlanes (id, project_id, name, position) VALUES ('s1', 'p1', 'Sprint 1', 0);
      INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position) VALUES ('t1', 'p1', 'c1', 's1', 'T', 'a');
      INSERT INTO runtime_tasks (id, project_id, document_type, document_id, agent_id, skill_id, status, kind, created_at)
        VALUES ('rt1', 'p1', 'task', 't1', 'herald', 'requirements', 'queued', 'herald', '2026-01-01');
      INSERT INTO runtime_sessions (document_type, document_id, runtime_id, runtime_session_id, provider, agent_id, skill_id)
        VALUES ('task', 't1', 'r1', 's1', 'opencode', 'herald', 'requirements');
      INSERT INTO project_memory (id, project_id, content, source) VALUES ('m1', 'p1', 'note', 'herald');
      INSERT INTO herald_settings (project_id, engine) VALUES ('p1', 'herald');
      INSERT INTO task_comments (task_id, author_kind, author_label, body, via_herald) VALUES
        ('t1', 'agent', 'herald', '{}', 1),
        ('t1', 'agent', 'herald', '{}', 1),
        ('t1', 'agent', 'herald', '{}', 1),
        ('t1', 'agent', 'herald', '{}', 1),
        ('t1', 'agent', 'herald', '{}', 1);
      DELETE FROM task_comments WHERE id IN (4, 5);
      INSERT INTO task_activity (task_id, actor_kind, actor_label, type, message, via_herald) VALUES
        ('t1', 'agent', 'herald', 'created', 'm', 1),
        ('t1', 'agent', 'herald', 'created', 'm', 1),
        ('t1', 'agent', 'herald', 'created', 'm', 1),
        ('t1', 'agent', 'herald', 'created', 'm', 1),
        ('t1', 'agent', 'herald', 'created', 'm', 1),
        ('t1', 'agent', 'herald', 'created', 'm', 1),
        ('t1', 'agent', 'herald', 'created', 'm', 1);
      DELETE FROM task_activity WHERE id = 7;
      INSERT INTO herald_threads (document_type, document_id, project_id, agent_id, messages) VALUES ('chat', 'th1', 'p1', 'herald', '[]');
      INSERT INTO herald_pending_writes (id, project_id, document_type, document_id, owner_user_id, batch_id, seq, tool_name, args, diff, expires_at)
        VALUES ('pw1', 'p1', 'chat', 'th1', 'u1', 'b1', 1, 'write_file', '{}', '{}', '2099-01-01');
    `);
    seed.close();

    // Full real dir → only 0006 is new, so it applies on top of the seeded rows.
    runMigrations(dbPath, MIGRATIONS);

    const after = new Database(dbPath);
    // Value remaps (engine, kind, source).
    expect(after.prepare("SELECT kind FROM runtime_tasks WHERE id = 'rt1'").get()).toEqual({ kind: "assistant" });
    expect(after.prepare("SELECT source FROM project_memory WHERE id = 'm1'").get()).toEqual({ source: "assistant" });
    expect(after.prepare("SELECT engine FROM assistant_settings WHERE project_id = 'p1'").get()).toEqual({ engine: "assistant" });
    // via_herald → via_assistant, data preserved.
    expect(after.prepare("SELECT via_assistant FROM task_comments WHERE task_id = 't1'").get()).toEqual({ via_assistant: 1 });
    expect(after.prepare("SELECT via_assistant FROM task_activity WHERE task_id = 't1'").get()).toEqual({ via_assistant: 1 });
    // Agent-id rebind across every referencing table; thread continuity preserved.
    expect(after.prepare("SELECT agent_id FROM runtime_tasks WHERE id = 'rt1'").get()).toEqual({ agent_id: "assistant" });
    expect(after.prepare("SELECT agent_id FROM runtime_sessions WHERE runtime_id = 'r1'").get()).toEqual({ agent_id: "assistant" });
    expect(after.prepare("SELECT agent_id FROM assistant_threads WHERE document_id = 'th1'").get()).toEqual({ agent_id: "assistant" });
    expect(after.prepare("SELECT COUNT(*) AS n FROM lexa_agent_skills WHERE agent_id = 'assistant'").get()).toEqual({ n: 6 });
    // Pending write preserved; its FK now targets assistant_threads.
    expect(after.prepare("SELECT COUNT(*) AS n FROM assistant_pending_writes").get()).toEqual({ n: 1 });
    const fks = after.prepare("PRAGMA foreign_key_list(assistant_pending_writes)").all() as Array<{ table: string }>;
    expect(fks.map((f) => f.table)).toContain("assistant_threads");
    // Agents exactly {assistant, blacksmith}; persona text carried over.
    expect(after.prepare("SELECT id, name FROM lexa_agents ORDER BY id").all()).toEqual([
      { id: "assistant", name: "Assistant Agent" },
      { id: "blacksmith", name: "Blacksmith Agent" },
    ]);
    const instructions = (after.prepare("SELECT instructions FROM lexa_agents WHERE id = 'assistant'").get() as { instructions: string }).instructions;
    expect(instructions).toContain("You are the Assistant Agent");
    // The AUTOINCREMENT high-water mark survives the rebuild: seq is above the
    // surviving max (comments: seq 5 > max 3; activity: seq 7 > max 6), so new
    // rows must continue past the deleted top rows. Fails if 0006's
    // sqlite_sequence carries are dropped.
    after.prepare("INSERT INTO task_comments (task_id, author_kind, author_label, body) VALUES ('t1', 'system', 'sys', '{}')").run();
    expect((after.prepare("SELECT id FROM task_comments ORDER BY id DESC LIMIT 1").get() as { id: number }).id).toBe(6);
    after.prepare("INSERT INTO task_activity (task_id, actor_kind, actor_label, type, message) VALUES ('t1', 'system', 'sys', 'created', 'm')").run();
    expect((after.prepare("SELECT id FROM task_activity ORDER BY id DESC LIMIT 1").get() as { id: number }).id).toBe(8);
    after.close();
  });

  // 0006's rebind must survive an FK-ON apply (Workers/D1 runner): insert the
  // new parent row, repoint every child, then delete the old parent.
  it("0006 is FK-safe with foreign_keys=ON (Workers/D1 runner)", () => {
    const dir = stagePreAssistant();
    const dbPath = join(dir, "app.db");
    runMigrations(dbPath, dir);

    const db = new Database(dbPath);
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(`
      INSERT INTO projects (id, name, slug) VALUES ('p1', 'P', 'p1');
      INSERT INTO users (id, email, name, role) VALUES ('u1', 'u1@x', 'U1', 'superadmin');
      INSERT INTO runtime_tasks (id, project_id, document_type, document_id, agent_id, skill_id, status, kind, created_at)
        VALUES ('rt1', 'p1', 'task', 't1', 'herald', 'requirements', 'queued', 'herald', '2026-01-01');
      INSERT INTO runtime_sessions (document_type, document_id, runtime_id, runtime_session_id, provider, agent_id, skill_id)
        VALUES ('task', 't1', 'r1', 's1', 'opencode', 'herald', 'requirements');
      INSERT INTO herald_threads (document_type, document_id, project_id, agent_id, messages) VALUES ('chat', 'th1', 'p1', 'herald', '[]');
    `);

    const sql = readFileSync(join(MIGRATIONS, "0006_assistant_rename.sql"), "utf-8");
    db.exec("BEGIN");
    try {
      db.exec(sql);
      db.prepare("INSERT INTO _migrations (name) VALUES (?)").run("0006_assistant_rename.sql");
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }

    expect(tableExists(db, "assistant_threads")).toBe(true);
    expect(tableExists(db, "herald_threads")).toBe(false);
    expect(db.prepare("SELECT agent_id FROM runtime_tasks WHERE id = 'rt1'").get()).toEqual({ agent_id: "assistant" });
    expect(db.prepare("SELECT agent_id FROM runtime_sessions WHERE runtime_id = 'r1'").get()).toEqual({ agent_id: "assistant" });
    expect(db.prepare("SELECT agent_id FROM assistant_threads WHERE document_id = 'th1'").get()).toEqual({ agent_id: "assistant" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM lexa_agent_skills WHERE agent_id = 'assistant'").get()).toEqual({ n: 6 });
    expect(db.prepare("SELECT id, name FROM lexa_agents ORDER BY id").all()).toEqual([
      { id: "assistant", name: "Assistant Agent" },
      { id: "blacksmith", name: "Blacksmith Agent" },
    ]);
    db.close();
  });

  it("0007 flips runtimes.team_id to ON DELETE RESTRICT (raw org delete fails) and keeps indexes", () => {
    const dbPath = join(tmpDir(), "app.db");
    runMigrations(dbPath, MIGRATIONS);
    const db = new Database(dbPath);
    db.exec("PRAGMA foreign_keys = ON");
    const fks = db.prepare("PRAGMA foreign_key_list(runtimes)").all() as Array<{ from: string; table: string; on_delete: string }>;
    const teamFk = fks.find((f) => f.from === "team_id");
    expect(teamFk?.table).toBe("organization");
    expect(teamFk?.on_delete).toBe("RESTRICT");

    db.exec(SEED_0007);
    expect(() => db.prepare("DELETE FROM organization WHERE id = 'org1'").run()).toThrow(/FOREIGN KEY constraint failed/i);
    expect(db.prepare("SELECT team_id FROM runtimes WHERE id = 'r1'").get()).toEqual({ team_id: "org1" });
    expect(db.prepare("SELECT runtime_id FROM runtime_tasks WHERE id = 'rt1'").get()).toEqual({ runtime_id: "r1" });
    const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[]).map((r) => r.name);
    expect(idx).toContain("idx_runtimes_machine");
    expect(idx).toContain("idx_runtimes_team");
    db.close();
  });

  it("0007 is FK-safe with foreign_keys=ON (Workers/D1 runner): parent + child links survive the rebuild", () => {
    const dir = stagePre0007();
    const dbPath = join(dir, "app.db");
    runMigrations(dbPath, dir);

    const db = new Database(dbPath);
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(SEED_0007);

    const sql = readFileSync(join(MIGRATIONS, "0007_runtimes_team_restrict.sql"), "utf-8");
    db.exec("BEGIN");
    try {
      db.exec(sql);
      db.prepare("INSERT INTO _migrations (name) VALUES (?)").run("0007_runtimes_team_restrict.sql");
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }

    const fks = db.prepare("PRAGMA foreign_key_list(runtimes)").all() as Array<{ from: string; table: string; on_delete: string }>;
    expect(fks.find((f) => f.from === "team_id")?.on_delete).toBe("RESTRICT");
    // The DROP's implicit DELETE must not have nulled the child link.
    expect(db.prepare("SELECT runtime_id FROM runtime_tasks WHERE id = 'rt1'").get()).toEqual({ runtime_id: "r1" });
    expect(db.prepare("SELECT team_id FROM runtimes WHERE id = 'r1'").get()).toEqual({ team_id: "org1" });
    expect(() => db.prepare("DELETE FROM organization WHERE id = 'org1'").run()).toThrow(/FOREIGN KEY constraint failed/i);
    // The child FK action is still SET NULL after the rebuild.
    db.prepare("INSERT INTO runtimes (id, name, provider, team_id) VALUES ('r2', 'R2', 'opencode', 'org1')").run();
    db.prepare("INSERT INTO runtime_tasks (id, project_id, document_type, document_id, agent_id, skill_id, status, runtime_id) VALUES ('rt2', 'p1', 'task', 't1', 'a1', 'sk1', 'queued', 'r2')").run();
    db.prepare("DELETE FROM runtimes WHERE id = 'r2'").run();
    expect(db.prepare("SELECT runtime_id FROM runtime_tasks WHERE id = 'rt2'").get()).toEqual({ runtime_id: null });
    db.close();
  });
});
