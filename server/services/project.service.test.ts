import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer, Context, Either } from "effect";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { Sqlite, initSqlite } from "../db/database";
import { ProjectService } from "./project.service";
import { ProjectNotFound, SlugTaken } from "../api/errors";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

let dirs: string[] = [];
let dbs: Database[] = [];

function tmpDb(): Database {
  const dir = mkdtempSync(join(tmpdir(), "lexa-project-svc-"));
  dirs.push(dir);
  const path = join(dir, "test.db");
  runMigrations(path, MIGRATIONS);
  const ctx = Effect.runSync(Effect.scoped(Layer.build(initSqlite(path))));
  const db = Context.get(ctx, Sqlite);
  dbs.push(db);
  return db;
}

function makeService(db: Database) {
  const layer = ProjectService.Default.pipe(Layer.provide(Layer.succeed(Sqlite, db)));
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  return Context.get(ctx, ProjectService);
}

afterEach(() => {
  for (const db of dbs) {
    try { db.close(); } catch {}
  }
  dbs = [];
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("ProjectService.create", () => {
  it("creates a project with an auto-slugified slug", () => {
    const db = tmpDb();
    const svc = makeService(db);
    const created = Effect.runSync(Effect.either(svc.create({ name: "Acme Widgets" })));
    expect(Either.isRight(created)).toBe(true);
    if (Either.isRight(created)) {
      expect(created.right.slug).toBe("acme-widgets");
      expect(created.right.name).toBe("Acme Widgets");
      expect(created.right.description).toBe("");
      expect(created.right.githubRepo).toBeNull();
    }
  });

  it("accepts an explicit slug, description, and githubRepo", () => {
    const db = tmpDb();
    const svc = makeService(db);
    const created = Effect.runSync(
      Effect.either(svc.create({ name: "Whatever", slug: "my-project", description: "d", githubRepo: "owner/repo" }))
    );
    expect(Either.isRight(created)).toBe(true);
    if (Either.isRight(created)) {
      expect(created.right.slug).toBe("my-project");
      expect(created.right.description).toBe("d");
      expect(created.right.githubRepo).toBe("owner/repo");
    }
  });

  it("duplicate slug → SlugTaken (derived and explicit)", () => {
    const db = tmpDb();
    const svc = makeService(db);
    Effect.runSync(svc.create({ name: "Acme" }));
    const dupName = Effect.runSync(Effect.either(svc.create({ name: "Acme" })));
    expect(Either.isLeft(dupName)).toBe(true);
    if (Either.isLeft(dupName)) expect(dupName.left).toBeInstanceOf(SlugTaken);
    const dupSlug = Effect.runSync(Effect.either(svc.create({ name: "Other", slug: "acme" })));
    expect(Either.isLeft(dupSlug)).toBe(true);
    if (Either.isLeft(dupSlug)) expect(dupSlug.left).toBeInstanceOf(SlugTaken);
  });

  it("seeds 5 default columns, one Backlog swimlane, and 4+4 field options", () => {
    const db = tmpDb();
    const svc = makeService(db);
    const created = Effect.runSync(svc.create({ name: "Acme" }));
    const columns = db.prepare("SELECT name, position FROM columns WHERE project_id = ? ORDER BY position").all(created.id) as { name: string; position: number }[];
    expect(columns.map((c) => c.name)).toEqual(["Todo", "In Progress", "Review", "Done", "Blocked"]);
    expect(columns.map((c) => c.position)).toEqual([1, 2, 3, 4, 5]);
    const lanes = db.prepare("SELECT name, kind, position FROM swimlanes WHERE project_id = ?").all(created.id) as { name: string; kind: string; position: number }[];
    expect(lanes).toEqual([{ name: "Backlog", kind: "backlog", position: 0 }]);
    const prios = db.prepare("SELECT label FROM priority_options WHERE project_id = ? ORDER BY position").all(created.id) as { label: string }[];
    expect(prios.map((p) => p.label)).toEqual(["Urgent", "High", "Medium", "Low"]);
    const types = db.prepare("SELECT label FROM type_options WHERE project_id = ? ORDER BY position").all(created.id) as { label: string }[];
    expect(types.map((t) => t.label)).toEqual(["Feature", "Bug", "Task", "Asset"]);
  });
});

describe("ProjectService.find", () => {
  it("findBySlug / findById / list return projects", () => {
    const db = tmpDb();
    const svc = makeService(db);
    const created = Effect.runSync(svc.create({ name: "Acme" }));
    const bySlug = Effect.runSync(Effect.either(svc.findBySlug("acme")));
    expect(Either.isRight(bySlug)).toBe(true);
    if (Either.isRight(bySlug)) expect(bySlug.right.id).toBe(created.id);
    const byId = Effect.runSync(Effect.either(svc.findById(created.id)));
    expect(Either.isRight(byId)).toBe(true);
    if (Either.isRight(byId)) expect(byId.right.slug).toBe("acme");
    const list = Effect.runSync(svc.list());
    expect(list.map((p) => p.id)).toEqual([created.id]);
  });

  it("missing slug/id → ProjectNotFound", () => {
    const db = tmpDb();
    const svc = makeService(db);
    const bySlug = Effect.runSync(Effect.either(svc.findBySlug("nope")));
    expect(Either.isLeft(bySlug)).toBe(true);
    if (Either.isLeft(bySlug)) expect(bySlug.left).toBeInstanceOf(ProjectNotFound);
    const byId = Effect.runSync(Effect.either(svc.findById("nope")));
    expect(Either.isLeft(byId)).toBe(true);
    if (Either.isLeft(byId)) expect(byId.left).toBeInstanceOf(ProjectNotFound);
  });
});

describe("ProjectService.update", () => {
  it("updates name/description/githubRepo without touching the slug", () => {
    const db = tmpDb();
    const svc = makeService(db);
    const created = Effect.runSync(svc.create({ name: "Acme" }));
    const updated = Effect.runSync(
      Effect.either(svc.update("acme", { name: "Acme 2", description: "new", githubRepo: "o/r" }))
    );
    expect(Either.isRight(updated)).toBe(true);
    if (Either.isRight(updated)) {
      expect(updated.right.name).toBe("Acme 2");
      expect(updated.right.description).toBe("new");
      expect(updated.right.githubRepo).toBe("o/r");
      expect(updated.right.slug).toBe("acme");
    }
    const cleared = Effect.runSync(Effect.either(svc.update("acme", { githubRepo: null })));
    expect(Either.isRight(cleared)).toBe(true);
    if (Either.isRight(cleared)) expect(cleared.right.githubRepo).toBeNull();
  });

  it("missing slug → ProjectNotFound", () => {
    const db = tmpDb();
    const svc = makeService(db);
    const res = Effect.runSync(Effect.either(svc.update("nope", { name: "X" })));
    expect(Either.isLeft(res)).toBe(true);
    if (Either.isLeft(res)) expect(res.left).toBeInstanceOf(ProjectNotFound);
  });
});

describe("ProjectService.delete", () => {
  it("cascades to columns, swimlanes, tasks, wiki, and field options", () => {
    const db = tmpDb();
    const svc = makeService(db);
    const created = Effect.runSync(svc.create({ name: "Acme" }));
    const col = db.prepare("SELECT id FROM columns WHERE project_id = ? LIMIT 1").get(created.id) as { id: string };
    const lane = db.prepare("SELECT id FROM swimlanes WHERE project_id = ? LIMIT 1").get(created.id) as { id: string };
    db.prepare("INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, created_at) VALUES ('t1', ?, ?, ?, 'T', 'a0', '2026-01-01 10:00:00')").run(created.id, col.id, lane.id);
    db.prepare("INSERT INTO wiki_pages (id, project_id, title, slug, content, content_text, position) VALUES ('w1', ?, 'Home', 'home', '{\"type\":\"doc\",\"content\":[]}', '', 0)").run(created.id);
    const res = Effect.runSync(Effect.either(svc.delete("acme")));
    expect(Either.isRight(res)).toBe(true);
    const count = (sql: string) => (db.prepare(sql).get(created.id) as { n: number }).n;
    expect(count("SELECT COUNT(*) AS n FROM projects WHERE id = ?")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM columns WHERE project_id = ?")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM swimlanes WHERE project_id = ?")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM tasks WHERE project_id = ?")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM wiki_pages WHERE project_id = ?")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM priority_options WHERE project_id = ?")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM type_options WHERE project_id = ?")).toBe(0);
  });

  it("missing slug → ProjectNotFound", () => {
    const db = tmpDb();
    const svc = makeService(db);
    const res = Effect.runSync(Effect.either(svc.delete("nope")));
    expect(Either.isLeft(res)).toBe(true);
    if (Either.isLeft(res)) expect(res.left).toBeInstanceOf(ProjectNotFound);
  });
});
