import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, copyFileSync, readdirSync, readFileSync } from "node:fs";
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
    expect(appliedMigrations(dbPath)).toEqual(["0001_init.sql", "0002_project_repos.sql"]);
    const db = new Database(dbPath);
    expect(tableExists(db, "tasks")).toBe(true);
    expect(tableExists(db, "_migrations")).toBe(true);
    db.close();
  });

  it("is a no-op on the second run", () => {
    const dbPath = join(tmpDir(), "app.db");
    runMigrations(dbPath, MIGRATIONS);
    runMigrations(dbPath, MIGRATIONS);
    expect(appliedMigrations(dbPath)).toEqual(["0001_init.sql", "0002_project_repos.sql"]);
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
    expect(appliedMigrations(dbPath)).toEqual(["0001_init.sql", "0002_project_repos.sql"]);
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
});
