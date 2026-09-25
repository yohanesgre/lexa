import { describe, expect, it, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer, Context } from "effect";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { DbBunLive } from "../db/db";
import { WebhookEventRepo } from "./webhook-event.repo";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

let dir: string;
let db: Database;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "lexa-webhook-event-repo-"));
  const path = join(dir, "test.db");
  runMigrations(path, MIGRATIONS);
  db = new Database(path);
  db.exec("PRAGMA foreign_keys = ON");
});

afterAll(() => {
  try { db.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

function cleanDb(db: Database) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '_migrations' AND name NOT LIKE '%fts%'").all() as { name: string }[];
  for (const { name } of tables) {
    try { db.exec(`DELETE FROM "${name}"`); } catch {}
  }
}

beforeEach(() => {
  cleanDb(db);
});

function makeRepo(db: Database) {
  const layer = WebhookEventRepo.Default.pipe(Layer.provide(DbBunLive(db)));
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  return Context.get(ctx, WebhookEventRepo);
}

describe("WebhookEventRepo", () => {
  it("isSeen is false until the delivery is recorded", async () => {
    const repo = makeRepo(db);
    expect(await Effect.runPromise(repo.isSeen("d-1"))).toBe(false);
    await Effect.runPromise(repo.recordDelivery("d-1"));
    expect(await Effect.runPromise(repo.isSeen("d-1"))).toBe(true);
  });

  it("recording the same delivery id twice stays a single row (idempotent)", async () => {
    const repo = makeRepo(db);
    await Effect.runPromise(repo.recordDelivery("d-1"));
    await Effect.runPromise(repo.recordDelivery("d-1"));
    const count = db.query("SELECT COUNT(*) AS c FROM webhook_events WHERE delivery_id = 'd-1'").get() as { c: number };
    expect(count.c).toBe(1);
    expect(await Effect.runPromise(repo.isSeen("d-1"))).toBe(true);
  });

  it("records distinct deliveries independently", async () => {
    const repo = makeRepo(db);
    await Effect.runPromise(repo.recordDelivery("d-1"));
    await Effect.runPromise(repo.recordDelivery("d-2"));
    expect(await Effect.runPromise(repo.isSeen("d-1"))).toBe(true);
    expect(await Effect.runPromise(repo.isSeen("d-2"))).toBe(true);
    expect(await Effect.runPromise(repo.isSeen("d-3"))).toBe(false);
    const total = db.query("SELECT COUNT(*) AS c FROM webhook_events").get() as { c: number };
    expect(total.c).toBe(2);
  });

  it("prune drops deliveries older than the window and keeps recent ones", async () => {
    const repo = makeRepo(db);
    db.prepare("INSERT INTO webhook_events (delivery_id, received_at) VALUES ('old', datetime('now', '-60 days'))").run();
    db.prepare("INSERT INTO webhook_events (delivery_id, received_at) VALUES ('recent', datetime('now', '-1 days'))").run();
    await Effect.runPromise(repo.prune(30));
    const ids = (db.query("SELECT delivery_id FROM webhook_events ORDER BY delivery_id").all() as { delivery_id: string }[]).map((r) => r.delivery_id);
    expect(ids).toEqual(["recent"]);
  });
});
