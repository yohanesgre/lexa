import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    expect(appliedMigrations(dbPath)).toEqual(["0001_init.sql", "0002_device_login.sql"]);
    const db = new Database(dbPath);
    expect(tableExists(db, "tasks")).toBe(true);
    expect(tableExists(db, "_migrations")).toBe(true);
    db.close();
  });

  it("is a no-op on the second run", () => {
    const dbPath = join(tmpDir(), "app.db");
    runMigrations(dbPath, MIGRATIONS);
    runMigrations(dbPath, MIGRATIONS);
    expect(appliedMigrations(dbPath)).toEqual(["0001_init.sql", "0002_device_login.sql"]);
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
    expect(appliedMigrations(dbPath)).toEqual(["0001_init.sql", "0002_device_login.sql"]);
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

  it("baseline folds the pre-release chain into its final shape", () => {
    const dbPath = join(tmpDir(), "app.db");
    runMigrations(dbPath, MIGRATIONS);
    const db = new Database(dbPath);
    const colNames = (table: string) =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
    // Hearth rename folded: hearth_* created directly, forge_* never existed.
    for (const t of ["hearth_tasks", "hearth_task_logs", "hearth_sessions"]) expect(tableExists(db, t)).toBe(true);
    for (const t of ["forge_tasks", "forge_task_logs", "forge_sessions"]) expect(tableExists(db, t)).toBe(false);
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
});
