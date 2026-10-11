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
