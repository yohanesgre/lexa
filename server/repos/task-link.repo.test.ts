import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer, Context } from "effect";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { Sqlite } from "../db/database";
import { TaskLinkRepo } from "./task-link.repo";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

const SEED = `
INSERT INTO projects (id, name, slug) VALUES ('p1', 'P', 'p1');
INSERT INTO columns (id, project_id, name, position) VALUES ('c1', 'p1', 'Todo', 0);
INSERT INTO swimlanes (id, project_id, name, position) VALUES ('s1', 'p1', 'Main', 0);
INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position) VALUES
  ('t1','p1','c1','s1','Progress 50% done','a0'),
  ('t2','p1','c1','s1','under_score name','a1'),
  ('t3','p1','c1','s1','plain title','a2'),
  ('t4','p1','c1','s1','back\\slash name','a3');
`;

let dirs: string[] = [];

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "lexa-link-test-"));
  dirs.push(dir);
  const path = join(dir, "test.db");
  runMigrations(path, MIGRATIONS);
  const db = new Database(path);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SEED);
  const layer = TaskLinkRepo.Default.pipe(Layer.provide(Layer.succeed(Sqlite, db)));
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  const repo = Context.get(ctx, TaskLinkRepo);
  const search = (...args: Parameters<typeof repo.search>) => Effect.runSync(repo.search(...args));
  return { search, close: () => db.close() };
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("TaskLinkRepo.search LIKE escaping", () => {
  it("treats % as a literal character — does not match all rows", () => {
    const repo = makeRepo();
    try {
      const rows = repo.search("p1", "%", "none");
      expect(rows.map((r) => r.title)).toEqual(["Progress 50% done"]);
    } finally { repo.close(); }
  });

  it("treats _ as a literal character — does not match all rows", () => {
    const repo = makeRepo();
    try {
      const rows = repo.search("p1", "_", "none");
      expect(rows.map((r) => r.title)).toEqual(["under_score name"]);
    } finally { repo.close(); }
  });

  it("treats backslash as a literal character", () => {
    const repo = makeRepo();
    try {
      const rows = repo.search("p1", "\\", "none");
      expect(rows.map((r) => r.title)).toEqual(["back\\slash name"]);
    } finally { repo.close(); }
  });

  it("plain substring search still works", () => {
    const repo = makeRepo();
    try {
      const rows = repo.search("p1", "plain", "none");
      expect(rows.map((r) => r.title)).toEqual(["plain title"]);
    } finally { repo.close(); }
  });

  it("excludes the given task id", () => {
    const repo = makeRepo();
    try {
      const rows = repo.search("p1", "plain", "t3");
      expect(rows).toEqual([]);
    } finally { repo.close(); }
  });
});
