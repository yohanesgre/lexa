import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer, Context } from "effect";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { Sqlite, initSqlite } from "../db/database";
import { HeraldThreadRepo } from "./herald-thread.repo";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

let dirs: string[] = [];
let dbs: Database[] = [];

function tmpDb(): Database {
  const dir = mkdtempSync(join(tmpdir(), "lexa-herald-thread-repo-"));
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
    INSERT INTO projects (id, name, slug) VALUES ('p1', 'P', 'p1');
    INSERT INTO users (id, email, name, role) VALUES ('u1', 'u1@x', 'U1', 'superadmin'), ('u2', 'u2@x', 'U2', 'member');
  `);
}

function makeRepo(db: Database) {
  const layer = HeraldThreadRepo.Default.pipe(Layer.provide(Layer.succeed(Sqlite, db)));
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  return Context.get(ctx, HeraldThreadRepo);
}

afterEach(() => {
  for (const db of dbs) {
    try { db.close(); } catch {}
  }
  dbs = [];
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("HeraldThreadRepo save/load", () => {
  it("upsert + load round-trips messages and metadata", () => {
    const db = tmpDb();
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        const msgs = [{ role: "user", content: "hello" }, { role: "assistant", content: "hi" }];
        yield* repo.saveThread("task", "t1", { projectId: "p1", agentId: "a1", skillId: "s1", messages: msgs });
        const thread = yield* repo.loadThread("task", "t1");
        expect(thread.documentType).toBe("task");
        expect(thread.projectId).toBe("p1");
        expect(thread.agentId).toBe("a1");
        expect(thread.skillId).toBe("s1");
        expect(thread.messages).toEqual(msgs);
        expect(thread.summary).toBeNull();
        expect(thread.summarizedCount).toBe(0);
      })
    );
  });

  it("second save overwrites in place (single row) and bumps updated_at", () => {
    const db = tmpDb();
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        yield* repo.saveThread("wiki", "w1", { projectId: "p1", messages: [{ role: "user", content: "a" }] });
        db.exec(`UPDATE herald_threads SET updated_at = datetime('now', '-1 hour') WHERE document_id = 'w1'`);
        yield* repo.saveThread("wiki", "w1", { projectId: "p1", messages: [{ role: "user", content: "b" }] });
        const thread = yield* repo.loadThread("wiki", "w1");
        expect(thread.messages).toEqual([{ role: "user", content: "b" }]);
        const raw = db.prepare(
          `SELECT updated_at > datetime('now', '-5 minutes') AS fresh FROM herald_threads WHERE document_id = 'w1'`
        ).get() as { fresh: number };
        expect(raw.fresh).toBe(1);
      })
    );
  });

  it("summary + summarized_count update via saveThread", () => {
    const db = tmpDb();
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        yield* repo.saveThread("task", "t1", { projectId: "p1", messages: Array.from({ length: 10 }, (_, i) => ({ role: "user", content: `m${i}` })) });
        const kept = [{ role: "user", content: "m8" }, { role: "user", content: "m9" }];
        yield* repo.saveThread("task", "t1", {
          projectId: "p1",
          messages: kept,
          summary: "earlier chatter",
          summarizedCount: 8,
        });
        const thread = yield* repo.loadThread("task", "t1");
        expect(thread.messages).toHaveLength(2);
        expect(thread.summary).toBe("earlier chatter");
        expect(thread.summarizedCount).toBe(8);
      })
    );
  });

  it("loadThread fails RowNotFound when absent", () => {
    const db = tmpDb();
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        const err = yield* repo.loadThread("task", "ghost").pipe(Effect.flip);
        expect(err._tag).toBe("RowNotFound");
      })
    );
  });

  it("resetThread deletes the row; second reset fails RowNotFound", () => {
    const db = tmpDb();
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        yield* repo.saveThread("chat", "c1", { projectId: "p1", ownerUserId: "u1", messages: [] });
        yield* repo.resetThread("chat", "c1");
        const err = yield* repo.resetThread("chat", "c1").pipe(Effect.flip);
        expect(err._tag).toBe("RowNotFound");
      })
    );
  });
});

describe("HeraldThreadRepo chat ownership", () => {
  it("loadChat returns thread for owner", () => {
    const db = tmpDb();
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        yield* repo.saveThread("chat", "c1", { projectId: "p1", ownerUserId: "u1", messages: [{ role: "user", content: "yo" }] });
        const thread = yield* repo.loadChat("c1", "u1");
        expect(thread.ownerUserId).toBe("u1");
        expect(thread.messages).toEqual([{ role: "user", content: "yo" }]);
      })
    );
  });

  it("owner mismatch → RowNotFound (404-equivalent)", () => {
    const db = tmpDb();
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        yield* repo.saveThread("chat", "c1", { projectId: "p1", ownerUserId: "u1", messages: [] });
        const err = yield* repo.loadChat("c1", "u2").pipe(Effect.flip);
        expect(err._tag).toBe("RowNotFound");
      })
    );
  });

  it("missing chat → RowNotFound", () => {
    const db = tmpDb();
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        const err = yield* repo.loadChat("ghost", "u1").pipe(Effect.flip);
        expect(err._tag).toBe("RowNotFound");
      })
    );
  });

  it("appendChatMessage preserves prior messages; append by non-owner fails RowNotFound", () => {
    const db = tmpDb();
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        yield* repo.saveThread("chat", "c1", { projectId: "p1", ownerUserId: "u1", messages: [{ role: "user", content: "q" }] });
        yield* repo.appendChatMessage("c1", "u1", { role: "assistant", content: "a" });
        const thread = yield* repo.loadChat("c1", "u1");
        expect(thread.messages).toEqual([
          { role: "user", content: "q" },
          { role: "assistant", content: "a" },
        ]);
        const err = yield* repo.appendChatMessage("c1", "u2", { role: "user", content: "sneak" }).pipe(Effect.flip);
        expect(err._tag).toBe("RowNotFound");
        const after = yield* repo.loadChat("c1", "u1");
        expect(after.messages).toHaveLength(2);
      })
    );
  });
});

describe("HeraldThreadRepo chat titles + history", () => {
  it("saveThread COALESCE: rename survives later saves; NULL title backfills exactly once", () => {
    const db = tmpDb();
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        // Renamed thread keeps its title across saves — even when the patch
        // carries a different title (stored value wins).
        yield* repo.saveThread("chat", "c1", { projectId: "p1", ownerUserId: "u1", title: "Renamed", messages: [{ role: "user", content: "a" }] });
        yield* repo.saveThread("chat", "c1", { projectId: "p1", ownerUserId: "u1", messages: [{ role: "user", content: "b" }] });
        let t = yield* repo.loadChat("c1", "u1");
        expect(t.title).toBe("Renamed");
        yield* repo.saveThread("chat", "c1", { projectId: "p1", ownerUserId: "u1", title: "Ignored", messages: [] });
        t = yield* repo.loadChat("c1", "u1");
        expect(t.title).toBe("Renamed");

        // NULL-title thread backfills from the next patch carrying a title,
        // then locks in the same way.
        yield* repo.saveThread("chat", "c2", { projectId: "p1", ownerUserId: "u1", messages: [] });
        t = yield* repo.loadChat("c2", "u1");
        expect(t.title).toBeNull();
        yield* repo.saveThread("chat", "c2", { projectId: "p1", ownerUserId: "u1", title: "Backfilled", messages: [{ role: "user", content: "x" }] });
        t = yield* repo.loadChat("c2", "u1");
        expect(t.title).toBe("Backfilled");

        // Document threads are untouched by the title plumbing.
        yield* repo.saveThread("task", "t1", { projectId: "p1", agentId: "a1", skillId: "s1", messages: [] });
        const doc = yield* repo.loadThread("task", "t1");
        expect(doc.title).toBeNull();
      })
    );
  });

  it("listChats orders updated_at DESC and is owner+project scoped", () => {
    const db = tmpDb();
    seed(db);
    db.exec(`INSERT INTO projects (id, name, slug) VALUES ('p2', 'Q', 'p2');`);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        yield* repo.saveThread("chat", "c-old", { projectId: "p1", ownerUserId: "u1", title: "Old", messages: [] });
        yield* repo.saveThread("chat", "c-new", { projectId: "p1", ownerUserId: "u1", title: "New", messages: [] });
        yield* repo.saveThread("chat", "c-u2", { projectId: "p1", ownerUserId: "u2", title: "Bob", messages: [] });
        yield* repo.saveThread("chat", "c-p2", { projectId: "p2", ownerUserId: "u1", title: "Elsewhere", messages: [] });
        yield* repo.saveThread("task", "doc-1", { projectId: "p1", agentId: "a1", skillId: "s1", messages: [] });
        // Stagger activity: c-new freshest, c-old oldest.
        db.exec(`UPDATE herald_threads SET updated_at = datetime('now', '-2 hours') WHERE document_id = 'c-old'`);
        db.exec(`UPDATE herald_threads SET updated_at = datetime('now', '-1 hour') WHERE document_id = 'c-p2'`);

        const mine = yield* repo.listChats("p1", "u1");
        expect(mine.map((t) => t.documentId)).toEqual(["c-new", "c-old"]);

        const bobs = yield* repo.listChats("p1", "u2");
        expect(bobs.map((t) => t.documentId)).toEqual(["c-u2"]);

        const otherProject = yield* repo.listChats("p2", "u1");
        expect(otherProject.map((t) => t.documentId)).toEqual(["c-p2"]);
      })
    );
  });

  it("updateChatMeta updates title and pinned; non-owner or missing chat → RowNotFound", () => {
    const db = tmpDb();
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        yield* repo.saveThread("chat", "c1", { projectId: "p1", ownerUserId: "u1", title: "Before", messages: [] });
        const renamed = yield* repo.updateChatMeta("c1", "u1", { title: "After" });
        expect(renamed.title).toBe("After");
        expect(renamed.pinned).toBe(false);
        const pinned = yield* repo.updateChatMeta("c1", "u1", { pinned: true });
        expect(pinned.pinned).toBe(true);
        expect(pinned.title).toBe("After");

        const stranger = yield* repo.updateChatMeta("c1", "u2", { title: "Hijack" }).pipe(Effect.flip);
        expect(stranger._tag).toBe("RowNotFound");
        const ghost = yield* repo.updateChatMeta("ghost", "u1", { pinned: false }).pipe(Effect.flip);
        expect(ghost._tag).toBe("RowNotFound");
        // Failed updates changed nothing.
        const unchanged = yield* repo.loadChat("c1", "u1");
        expect(unchanged.title).toBe("After");
        expect(unchanged.pinned).toBe(true);
      })
    );
  });

  it("truncateChatFrom keeps messages[0..fromIndex); non-owner → RowNotFound", () => {
    const db = tmpDb();
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        const msgs = [
          { role: "user", content: "q0" },
          { role: "assistant", content: "a0" },
          { role: "user", content: "q1" },
          { role: "assistant", content: "a1" },
        ];
        yield* repo.saveThread("chat", "c1", { projectId: "p1", ownerUserId: "u1", messages: msgs });

        // Mid truncation: keep [q0, a0], drop the rest.
        const mid = yield* repo.truncateChatFrom("c1", "u1", 2);
        expect(mid.messages).toEqual([msgs[0], msgs[1]]);
        // fromIndex === length → no-op (nothing to drop).
        const atEnd = yield* repo.truncateChatFrom("c1", "u1", 2);
        expect(atEnd.messages).toEqual([msgs[0], msgs[1]]);
        // fromIndex 0 → empty transcript.
        const zero = yield* repo.truncateChatFrom("c1", "u1", 0);
        expect(zero.messages).toEqual([]);

        const stranger = yield* repo.truncateChatFrom("c1", "u2", 0).pipe(Effect.flip);
        expect(stranger._tag).toBe("RowNotFound");
      })
    );
  });

  it("listChats orders pinned threads before recency; q prefilter matches title or transcript", () => {
    const db = tmpDb();
    seed(db);
    const repo = makeRepo(db);
    Effect.runSync(
      Effect.gen(function* () {
        yield* repo.saveThread("chat", "c-fresh", { projectId: "p1", ownerUserId: "u1", title: "Fresh", messages: [{ role: "user", content: "latest chatter" }] });
        yield* repo.saveThread("chat", "c-old-pin", { projectId: "p1", ownerUserId: "u1", title: "Old but pinned", messages: [] });
        yield* repo.saveThread("chat", "c-zebra", { projectId: "p1", ownerUserId: "u1", title: "Unrelated", messages: [{ role: "user", content: "zebra crossing notes" }] });
        db.exec(`UPDATE herald_threads SET updated_at = datetime('now', '-2 hours') WHERE document_id = 'c-old-pin'`);
        yield* repo.updateChatMeta("c-old-pin", "u1", { pinned: true });

        // Pinned beats recency.
        const all = yield* repo.listChats("p1", "u1");
        expect(all.map((t) => t.documentId)).toEqual(["c-old-pin", "c-fresh", "c-zebra"]);

        // q matches transcript text only.
        const zebra = yield* repo.listChats("p1", "u1", { q: "zebra" });
        expect(zebra.map((t) => t.documentId)).toEqual(["c-zebra"]);
        // q matches title only.
        const fresh = yield* repo.listChats("p1", "u1", { q: "Fresh" });
        expect(fresh.map((t) => t.documentId)).toEqual(["c-fresh"]);
        // LIKE wildcards in q are literal (escaped).
        const literal = yield* repo.listChats("p1", "u1", { q: "%_" });
        expect(literal).toEqual([]);
      })
    );
  });
});
