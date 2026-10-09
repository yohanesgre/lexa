import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import type { DbDriver } from "../db/db";
import { claimResumeBatch, releaseResumeBatch } from "./resume-claim";

// Minimal fake driver: `prepare(sql).run()` is the only path `run()` uses.
function driverWith(run: () => Promise<{ changes: number }> | { changes: number }): DbDriver {
  const make = (): DbDriver => ({
    prepare: () => ({
      all: async () => [],
      first: async () => null,
      run: async () => await run(),
    }),
    batch: async () => [],
    transaction: async (fn: (tx: DbDriver) => Promise<unknown>) => fn(make()) as never,
    close: () => {},
  } as unknown as DbDriver);
  return make();
}

const claim = (db: DbDriver) => Effect.runPromise(claimResumeBatch(db, "b1"));

describe("claimResumeBatch degrade branches", () => {
  it("claimed when the INSERT OR IGNORE wrote a row", async () => {
    expect(await claim(driverWith(() => ({ changes: 1 })))).toBe("claimed");
  });

  it("duplicate when the claim already exists (0 rows)", async () => {
    expect(await claim(driverWith(() => ({ changes: 0 })))).toBe("duplicate");
  });

  it("unclaimed when the claim table is missing (migration not applied)", async () => {
    expect(await claim(driverWith(() => { throw new Error("no such table: assistant_resume_claims"); }))).toBe("unclaimed");
  });

  it("duplicate on any other DB error (refuse/no-op, never blanket-proceed)", async () => {
    expect(await claim(driverWith(() => { throw new Error("disk I/O error"); }))).toBe("duplicate");
  });
});

describe("releaseResumeBatch", () => {
  it("resolves without throwing even when the delete fails", async () => {
    await Effect.runPromise(releaseResumeBatch(driverWith(() => { throw new Error("no such table"); }), "b1"));
  });
});
