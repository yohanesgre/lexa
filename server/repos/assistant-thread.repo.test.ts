import { describe, expect, it, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer, Context } from "effect";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { Sqlite, initSqlite } from "../db/database";
import { Db, DbBunLive } from "../db/db";
import type { DbDriver, DbStmt, LexaRow, SqlParam } from "../db/db";
import { createBunSqliteDriver } from "../db/drivers/bun-sqlite";
import { AssistantThreadRepo } from "./assistant-thread.repo";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

let dir: string;
let dbPath: string;
let db: Database;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "lexa-assistant-thread-repo-"));
  dbPath = join(dir, "test.db");
  runMigrations(dbPath, MIGRATIONS);
  const ctx = Effect.runSync(Effect.scoped(Layer.build(initSqlite(dbPath))));
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
    INSERT INTO projects (id, name, slug) VALUES ('p1', 'P', 'p1');
    INSERT INTO users (id, email, name, role) VALUES ('u1', 'u1@x', 'U1', 'superadmin'), ('u2', 'u2@x', 'U2', 'member');
  `);
}

function makeRepo(db: Database) {
  const layer = AssistantThreadRepo.Default.pipe(Layer.provide(Layer.mergeAll(Layer.succeed(Sqlite, db), DbBunLive(db))));
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  return Context.get(ctx, AssistantThreadRepo);
}

/** Repo bound to an arbitrary driver — lets a test interleave a competing
 *  write between the repo's read and its CAS write. */
function makeRepoWithDriver(driver: DbDriver, sqlite: Database) {
  const layer = AssistantThreadRepo.Default.pipe(
    Layer.provide(Layer.mergeAll(Layer.succeed(Sqlite, sqlite), Layer.succeed(Db, driver)))
  );
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  return Context.get(ctx, AssistantThreadRepo);
}

/** Wrap the Bun driver so that every `first()` on a SELECT over
 *  `assistant_threads` runs `onRead` after the row is read — a deterministic
 *  way to simulate a concurrent writer landing between read and write. */
function makeStealDriver(sqlite: Database, onRead: () => void): DbDriver {
  const inner = createBunSqliteDriver(sqlite);
  return {
    ...inner,
    prepare(sql: string): DbStmt {
      const stmt = inner.prepare(sql);
      return {
        all<T extends LexaRow = LexaRow>(...p: SqlParam[]) {
          return stmt.all<T>(...p);
        },
        run(...p: SqlParam[]) {
          return stmt.run(...p);
        },
        first<T extends LexaRow = LexaRow>(...p: SqlParam[]): Promise<T | null> {
          return stmt.first<T>(...p).then((row): T | null => {
            if (sql.startsWith("SELECT * FROM assistant_threads")) onRead();
            return row;
          });
        },
        get columnNames(): string[] {
          return stmt.columnNames ?? [];
        },
      };
    },
  };
}

/** Second connection to the same DB file — a real concurrent writer. */
function openSecond(): Database {
  const second = new Database(dbPath);
  second.exec("PRAGMA busy_timeout = 5000");
  second.exec("PRAGMA foreign_keys = ON");
  return second;
}

describe("AssistantThreadRepo save/load", () => {
  it("upsert + load round-trips messages and metadata", async () => {
    seed(db);
    const repo = makeRepo(db);
    await Effect.runPromise(
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

  it("second save overwrites in place (single row) and bumps updated_at", async () => {
    seed(db);
    const repo = makeRepo(db);
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* repo.saveThread("wiki", "w1", { projectId: "p1", messages: [{ role: "user", content: "a" }] });
        db.exec(`UPDATE assistant_threads SET updated_at = datetime('now', '-1 hour') WHERE document_id = 'w1'`);
        yield* repo.saveThread("wiki", "w1", { projectId: "p1", messages: [{ role: "user", content: "b" }] });
        const thread = yield* repo.loadThread("wiki", "w1");
        expect(thread.messages).toEqual([{ role: "user", content: "b" }]);
        const raw = db.prepare(
          `SELECT updated_at > datetime('now', '-5 minutes') AS fresh FROM assistant_threads WHERE document_id = 'w1'`
        ).get() as { fresh: number };
        expect(raw.fresh).toBe(1);
      })
    );
  });

  it("summary + summarized_count update via saveThread", async () => {
    seed(db);
    const repo = makeRepo(db);
    await Effect.runPromise(
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

  it("loadThread fails RowNotFound when absent", async () => {
    seed(db);
    const repo = makeRepo(db);
    await Effect.runPromise(
      Effect.gen(function* () {
        const err = yield* repo.loadThread("task", "ghost").pipe(Effect.flip);
        expect(err._tag).toBe("RowNotFound");
      })
    );
  });

  it("resetThread deletes the row; second reset fails RowNotFound", async () => {
    seed(db);
    const repo = makeRepo(db);
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* repo.saveThread("chat", "c1", { projectId: "p1", ownerUserId: "u1", messages: [] });
        yield* repo.resetThread("chat", "c1");
        const err = yield* repo.resetThread("chat", "c1").pipe(Effect.flip);
        expect(err._tag).toBe("RowNotFound");
      })
    );
  });
});

describe("AssistantThreadRepo chat ownership", () => {
  it("loadChat returns thread for owner", async () => {
    seed(db);
    const repo = makeRepo(db);
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* repo.saveThread("chat", "c1", { projectId: "p1", ownerUserId: "u1", messages: [{ role: "user", content: "yo" }] });
        const thread = yield* repo.loadChat("c1", "u1");
        expect(thread.ownerUserId).toBe("u1");
        expect(thread.messages).toEqual([{ role: "user", content: "yo" }]);
      })
    );
  });

  it("owner mismatch → RowNotFound (404-equivalent)", async () => {
    seed(db);
    const repo = makeRepo(db);
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* repo.saveThread("chat", "c1", { projectId: "p1", ownerUserId: "u1", messages: [] });
        const err = yield* repo.loadChat("c1", "u2").pipe(Effect.flip);
        expect(err._tag).toBe("RowNotFound");
      })
    );
  });

  it("missing chat → RowNotFound", async () => {
    seed(db);
    const repo = makeRepo(db);
    await Effect.runPromise(
      Effect.gen(function* () {
        const err = yield* repo.loadChat("ghost", "u1").pipe(Effect.flip);
        expect(err._tag).toBe("RowNotFound");
      })
    );
  });

  it("appendChatMessage preserves prior messages; append by non-owner fails RowNotFound", async () => {
    seed(db);
    const repo = makeRepo(db);
    await Effect.runPromise(
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

describe("AssistantThreadRepo concurrent writes", () => {
  it("interleaved append from a second connection keeps both messages", async () => {
    seed(db);
    const repoA = makeRepo(db);
    const second = openSecond();
    try {
      const repoB = makeRepoWithDriver(createBunSqliteDriver(second), second);
      await Effect.runPromise(repoA.saveThread("chat", "c1", { projectId: "p1", ownerUserId: "u1", messages: [] }));
      await Effect.runPromise(
        Effect.all(
          [
            repoA.appendChatMessage("c1", "u1", { role: "user", content: "a" }),
            repoB.appendChatMessage("c1", "u1", { role: "assistant", content: "b" }),
          ],
          { concurrency: 2 }
        )
      );
      const thread = await Effect.runPromise(repoA.loadChat("c1", "u1"));
      expect(thread.messages).toHaveLength(2);
      expect(thread.messages).toEqual(
        expect.arrayContaining([
          { role: "user", content: "a" },
          { role: "assistant", content: "b" },
        ])
      );
    } finally {
      second.close();
    }
  });

  it("append replaces a malformed stored transcript with a valid array", async () => {
    seed(db);
    db.exec(`INSERT INTO assistant_threads (document_type, document_id, project_id, owner_user_id, messages) VALUES ('chat','c-bad','p1','u1','not-json')`);
    const repo = makeRepo(db);
    await Effect.runPromise(
      Effect.gen(function* () {
        const thread = yield* repo.appendChatMessage("c-bad", "u1", { role: "user", content: "m" });
        expect(thread.messages).toEqual([{ role: "user", content: "m" }]);
        const raw = db.prepare(`SELECT messages FROM assistant_threads WHERE document_id = 'c-bad'`).get() as { messages: string };
        expect(JSON.parse(raw.messages)).toEqual([{ role: "user", content: "m" }]);
      })
    );
  });

  it("truncate retries the CAS when a concurrent writer steals the version", async () => {
    seed(db);
    const msgs = [
      { role: "user", content: "q0" },
      { role: "assistant", content: "a0" },
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
    ];
    const seedRepo = makeRepo(db);
    await Effect.runPromise(seedRepo.saveThread("chat", "c1", { projectId: "p1", ownerUserId: "u1", messages: msgs }));

    let steals = 0;
    const driver = makeStealDriver(db, () => {
      if (steals > 0) return;
      steals++;
      db.exec(
        `UPDATE assistant_threads SET messages = json_insert(messages, '$[#]', json('{"role":"user","content":"interloper"}')) WHERE document_id = 'c1'`
      );
    });
    const repo = makeRepoWithDriver(driver, db);
    await Effect.runPromise(
      Effect.gen(function* () {
        const result = yield* repo.truncateChatFrom("c1", "u1", 2);
        expect(result.messages).toEqual([msgs[0]!, msgs[1]!]);
        const raw = db.prepare(`SELECT messages FROM assistant_threads WHERE document_id = 'c1'`).get() as { messages: string };
        expect(JSON.parse(raw.messages)).toEqual([msgs[0]!, msgs[1]!]);
      })
    );
    expect(steals).toBe(1);
  });
});

describe("AssistantThreadRepo chat titles + history", () => {
  it("saveThread COALESCE: rename survives later saves; NULL title backfills exactly once", async () => {
    seed(db);
    const repo = makeRepo(db);
    await Effect.runPromise(
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

  it("listChats orders updated_at DESC and is owner+project scoped", async () => {
    seed(db);
    db.exec(`INSERT INTO projects (id, name, slug) VALUES ('p2', 'Q', 'p2');`);
    const repo = makeRepo(db);
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* repo.saveThread("chat", "c-old", { projectId: "p1", ownerUserId: "u1", title: "Old", messages: [] });
        yield* repo.saveThread("chat", "c-new", { projectId: "p1", ownerUserId: "u1", title: "New", messages: [] });
        yield* repo.saveThread("chat", "c-u2", { projectId: "p1", ownerUserId: "u2", title: "Bob", messages: [] });
        yield* repo.saveThread("chat", "c-p2", { projectId: "p2", ownerUserId: "u1", title: "Elsewhere", messages: [] });
        yield* repo.saveThread("task", "doc-1", { projectId: "p1", agentId: "a1", skillId: "s1", messages: [] });
        // Stagger activity: c-new freshest, c-old oldest.
        db.exec(`UPDATE assistant_threads SET updated_at = datetime('now', '-2 hours') WHERE document_id = 'c-old'`);
        db.exec(`UPDATE assistant_threads SET updated_at = datetime('now', '-1 hour') WHERE document_id = 'c-p2'`);

        const mine = yield* repo.listChats("p1", "u1");
        expect(mine.map((t) => t.documentId)).toEqual(["c-new", "c-old"]);

        const bobs = yield* repo.listChats("p1", "u2");
        expect(bobs.map((t) => t.documentId)).toEqual(["c-u2"]);

        const otherProject = yield* repo.listChats("p2", "u1");
        expect(otherProject.map((t) => t.documentId)).toEqual(["c-p2"]);
      })
    );
  });

  it("updateChatMeta updates title and pinned; non-owner or missing chat → RowNotFound", async () => {
    seed(db);
    const repo = makeRepo(db);
    await Effect.runPromise(
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

  it("truncateChatFrom keeps messages[0..fromIndex); non-owner → RowNotFound", async () => {
    seed(db);
    const repo = makeRepo(db);
    await Effect.runPromise(
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
        expect(mid.messages).toEqual([msgs[0]!, msgs[1]!]);
        // fromIndex === length → no-op (nothing to drop).
        const atEnd = yield* repo.truncateChatFrom("c1", "u1", 2);
        expect(atEnd.messages).toEqual([msgs[0]!, msgs[1]!]);
        // fromIndex 0 → empty transcript.
        const zero = yield* repo.truncateChatFrom("c1", "u1", 0);
        expect(zero.messages).toEqual([]);

        const stranger = yield* repo.truncateChatFrom("c1", "u2", 0).pipe(Effect.flip);
        expect(stranger._tag).toBe("RowNotFound");
      })
    );
  });

  it("listChats orders pinned threads before recency; q prefilter matches title or transcript", async () => {
    seed(db);
    const repo = makeRepo(db);
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* repo.saveThread("chat", "c-fresh", { projectId: "p1", ownerUserId: "u1", title: "Fresh", messages: [{ role: "user", content: "latest chatter" }] });
        yield* repo.saveThread("chat", "c-old-pin", { projectId: "p1", ownerUserId: "u1", title: "Old but pinned", messages: [] });
        yield* repo.saveThread("chat", "c-zebra", { projectId: "p1", ownerUserId: "u1", title: "Unrelated", messages: [{ role: "user", content: "zebra crossing notes" }] });
        db.exec(`UPDATE assistant_threads SET updated_at = datetime('now', '-2 hours') WHERE document_id = 'c-old-pin'`);
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
