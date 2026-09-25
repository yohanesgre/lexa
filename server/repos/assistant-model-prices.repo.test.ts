import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer, Context } from "effect";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { Sqlite } from "../db/database";
import { DbBunLive } from "../db/db";
import { AssistantModelPricesRepo } from "./assistant-model-prices.repo";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

let dir: string;
let db: Database;
let repo: AssistantModelPricesRepo;

afterEach(() => { try { db?.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });

function setup() {
  dir = mkdtempSync(join(tmpdir(), "lexa-model-prices-repo-"));
  const path = join(dir, "test.db");
  runMigrations(path, MIGRATIONS);
  db = new Database(path);
  const layer = AssistantModelPricesRepo.Default.pipe(Layer.provide(Layer.mergeAll(Layer.succeed(Sqlite, db), DbBunLive(db))));
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  repo = Context.get(ctx, AssistantModelPricesRepo);
}

describe("AssistantModelPricesRepo", () => {
  it("upsert inserts then updates the same model without duplicating", async () => {
    setup();
    const created = await Effect.runPromise(repo.upsert({ model: "m1", promptPrice: 1, completionPrice: 2, cachedReadPrice: 0.5, cachedWritePrice: 0.25 }));
    expect(created).toMatchObject({ model: "m1", promptPrice: 1, completionPrice: 2, cachedReadPrice: 0.5, cachedWritePrice: 0.25 });
    expect(typeof created.updatedAt).toBe("string");

    const updated = await Effect.runPromise(repo.upsert({ model: "m1", promptPrice: 3, completionPrice: 4, cachedReadPrice: 0.75, cachedWritePrice: 0.5 }));
    expect(updated).toMatchObject({ model: "m1", promptPrice: 3, completionPrice: 4, cachedReadPrice: 0.75, cachedWritePrice: 0.5 });
    expect(updated.updatedAt >= created.updatedAt).toBe(true);

    expect(await Effect.runPromise(repo.list())).toHaveLength(1);
  });

  it("getByModel returns the row; unknown model is RowNotFound", async () => {
    setup();
    await Effect.runPromise(repo.upsert({ model: "m1", promptPrice: 1, completionPrice: 2, cachedReadPrice: 0.5, cachedWritePrice: 0.25 }));
    const found = await Effect.runPromise(repo.getByModel("m1"));
    expect(found).toEqual(expect.objectContaining({ model: "m1", promptPrice: 1, completionPrice: 2 }));

    const missing = await Effect.runPromise(Effect.either(repo.getByModel("nope")));
    expect(missing).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "RowNotFound" }) });
  });

  it("list orders by model ASC; empty before any upsert", async () => {
    setup();
    expect(await Effect.runPromise(repo.list())).toEqual([]);
    await Effect.runPromise(repo.upsert({ model: "zeta", promptPrice: 0, completionPrice: 0, cachedReadPrice: 0, cachedWritePrice: 0 }));
    await Effect.runPromise(repo.upsert({ model: "alpha", promptPrice: 0, completionPrice: 0, cachedReadPrice: 0, cachedWritePrice: 0 }));
    await Effect.runPromise(repo.upsert({ model: "mid", promptPrice: 0, completionPrice: 0, cachedReadPrice: 0, cachedWritePrice: 0 }));
    const list = await Effect.runPromise(repo.list());
    expect(list.map((p) => p.model)).toEqual(["alpha", "mid", "zeta"]);
  });
});
