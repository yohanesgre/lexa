import { describe, expect, it, afterEach } from "vitest";
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

let dirs: string[] = [];
let dbs: Database[] = [];

function tmpDb(): Database {
  const dir = mkdtempSync(join(tmpdir(), "lexa-project-memory-repo-"));
  dirs.push(dir);
  const path = join(dir, "test.db");
  runMigrations(path, MIGRATIONS);
  const ctx = Effect.runSync(Effect.scoped(Layer.build(initSqlite(path))));
  const db = Context.get(ctx, Sqlite);
  dbs.push(db);
  return db;
}

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

afterEach(() => {
  for (const db of dbs) {
    try { db.close(); } catch {}
  }
  dbs = [];
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("ProjectMemoryRepo CRUD", () => {
  it("create + get + list round-trips", () => {
    const db = tmpDb();
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
    const db = tmpDb();
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
    const db = tmpDb();
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
    const db = tmpDb();
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
    const db = tmpDb();
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        yield* repo.create({ id: "m1", projectId: "p1", content: "deploy uses cloudflared tunnel" });
        yield* repo.create({ id: "m2", projectId: "p1", content: "database is sqlite with WAL mode" });
        yield* repo.create({ id: "m3", projectId: "p1", content: "tunnel credentials live in cloudflare dashboard" });
        const hits = yield* repo.searchByProject("p1", ["tunnel", "cloudflared"]);
        expect(hits.length).toBeGreaterThanOrEqual(1);
        expect(hits[0]).toContain("cloudflared tunnel");
        expect(hits.some((h) => h.includes("sqlite"))).toBe(false);
      })
    );
  });

  it("scoped to project", () => {
    const db = tmpDb();
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
    const db = tmpDb();
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
    const db = tmpDb();
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
    const db = tmpDb();
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
    const db = tmpDb();
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
