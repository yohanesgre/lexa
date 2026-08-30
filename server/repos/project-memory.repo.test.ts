import { describe, expect, it, afterEach, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer, Context } from "effect";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { Sqlite, initSqlite } from "../db/database";
import { ProjectMemoryRepo, MEMORY_SEARCH_K, MEMORY_CHAR_CAP } from "./project-memory.repo";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

let dir: string;
let db: Database;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "lexa-project-memory-repo-"));
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


function seed(db: Database) {
  db.exec(`
    INSERT INTO projects (id, name, slug) VALUES ('p1', 'P', 'p1'), ('p2', 'Q', 'p2');
  `);
}

function makeRepo(db: Database) {
  const layer = ProjectMemoryRepo.Default.pipe(Layer.provide(Layer.succeed(Sqlite, db)));
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  return Context.get(ctx, ProjectMemoryRepo);
}

describe("ProjectMemoryRepo CRUD", () => {
  it("create + get + list round-trips", () => {
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        yield* repo.create({ id: "m1", projectId: "p1", content: "Prefer bun over node" });
        yield* repo.create({ id: "m2", projectId: "p1", content: "API keys rotate quarterly", source: "herald" });
        const got = yield* repo.get("m1");
        expect(got.projectId).toBe("p1");
        expect(got.content).toBe("Prefer bun over node");
        expect(got.source).toBe("manual");
        const list = yield* repo.list("p1");
        expect(list.map((m) => m.id)).toEqual(["m2", "m1"]);
      })
    );
  });

  it("list is project-scoped", () => {
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        yield* repo.create({ id: "m1", projectId: "p1", content: "one" });
        yield* repo.create({ id: "m2", projectId: "p2", content: "two" });
        const list = yield* repo.list("p1");
        expect(list.map((m) => m.id)).toEqual(["m1"]);
      })
    );
  });

  it("remove deletes; second remove fails RowNotFound", () => {
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        yield* repo.create({ id: "m1", projectId: "p1", content: "bye soon" });
        yield* repo.remove("m1");
        const err = yield* repo.remove("m1").pipe(Effect.flip);
        expect(err._tag).toBe("RowNotFound");
      })
    );
  });

  it("get fails RowNotFound when absent", () => {
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        const err = yield* repo.get("ghost").pipe(Effect.flip);
        expect(err._tag).toBe("RowNotFound");
      })
    );
  });
});

describe("ProjectMemoryRepo FTS searchByProject", () => {
  it("matches terms and ranks better matches first", () => {
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        yield* repo.create({ id: "m1", projectId: "p1", content: "deploy uses cloudflared tunnel" });
        yield* repo.create({ id: "m2", projectId: "p1", content: "database is sqlite with WAL mode" });
        yield* repo.create({ id: "m3", projectId: "p1", content: "tunnel credentials live in cloudflare dashboard" });
        const hits = yield* repo.searchByProject("p1", ["tunnel", "cloudflared"]);
        expect(hits.length).toBeGreaterThanOrEqual(1);
        expect(hits[0]!).toContain("cloudflared tunnel");
        expect(hits.some((h) => h.includes("sqlite"))).toBe(false);
      })
    );
  });

  it("scoped to project", () => {
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        yield* repo.create({ id: "m1", projectId: "p1", content: "kubernetes cluster notes" });
        yield* repo.create({ id: "m2", projectId: "p2", content: "kubernetes cluster secrets" });
        const hits = yield* repo.searchByProject("p1", ["kubernetes"]);
        expect(hits).toEqual(["kubernetes cluster notes"]);
      })
    );
  });

  it("caps hits at k=5 default", () => {
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        for (let i = 0; i < 8; i++) {
          yield* repo.create({ id: `m${i}`, projectId: "p1", content: `widget fact number ${i}` });
        }
        const hits = yield* repo.searchByProject("p1", ["widget"]);
        expect(hits).toHaveLength(MEMORY_SEARCH_K);
      })
    );
  });

  it("enforces cumulative char cap by truncating the crossing hit", () => {
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        yield* repo.create({ id: "big", projectId: "p1", content: "alpha ".repeat(500) }); // 3000 chars
        yield* repo.create({ id: "small", projectId: "p1", content: "beta detail" });
        const hits = yield* repo.searchByProject("p1", ["alpha", "beta"], { k: 5, charCap: MEMORY_CHAR_CAP });
        const total = hits.reduce((n, h) => n + h.length, 0);
        expect(total).toBeLessThanOrEqual(MEMORY_CHAR_CAP);
        expect(hits[0]!.length).toBe(MEMORY_CHAR_CAP);
        expect(hits).toHaveLength(1);
      })
    );
  });

  it("empty terms → no hits, no query", () => {
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        yield* repo.create({ id: "m1", projectId: "p1", content: "anything" });
        expect(yield* repo.searchByProject("p1", [])).toEqual([]);
      })
    );
  });

  it("FTS index stays in sync after delete", () => {
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        yield* repo.create({ id: "m1", projectId: "p1", content: "ephemeral note about zig" });
        yield* repo.remove("m1");
        const hits = yield* repo.searchByProject("p1", ["zig"]);
        expect(hits).toEqual([]);
      })
    );
  });
});
