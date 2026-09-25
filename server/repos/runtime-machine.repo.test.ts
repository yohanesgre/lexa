import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer, Context } from "effect";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { DbBunLive } from "../db/db";
import { RuntimeMachineRepo } from "./runtime-machine.repo";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

let dir: string;
let db: Database;
let repo: RuntimeMachineRepo;

afterEach(() => { try { db?.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });

function setup() {
  dir = mkdtempSync(join(tmpdir(), "lexa-runtime-machine-repo-"));
  const path = join(dir, "test.db");
  runMigrations(path, MIGRATIONS);
  db = new Database(path);
  db.exec("PRAGMA foreign_keys = ON");
  const layer = RuntimeMachineRepo.Default.pipe(Layer.provide(DbBunLive(db)));
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  repo = Context.get(ctx, RuntimeMachineRepo);
}

describe("RuntimeMachineRepo", () => {
  it("register creates a bound machine (null lastSeen) storing the minted secret", async () => {
    setup();
    const res = await Effect.runPromise(repo.register({ id: "m1", hostname: "host-a", secret: "client", mintedSecret: "minted" }));
    expect(res._tag).toBe("created");
    if (res._tag !== "created") throw new Error("expected created");
    expect(res.machine.id).toBe("m1");
    expect(res.machine.hostname).toBe("host-a");
    expect(res.machine.lastSeen).toBeNull();
    expect(await Effect.runPromise(repo.findSecret("m1"))).toBe("minted");
  });

  it("register conflicts on hostname, legacy empty secret, and secret mismatch", async () => {
    setup();
    await Effect.runPromise(repo.register({ id: "m1", hostname: "host-a", secret: "client", mintedSecret: "minted" }));
    const registered = await Effect.runPromise(repo.register({ id: "m1", hostname: "host-a", secret: "minted", mintedSecret: "ignored" }));
    expect(registered._tag).toBe("registered");

    const wrongHost = await Effect.runPromise(repo.register({ id: "m1", hostname: "other", secret: "minted", mintedSecret: "x" }));
    expect(wrongHost).toMatchObject({ _tag: "conflict", reason: "hostname" });

    const wrongSecret = await Effect.runPromise(repo.register({ id: "m1", hostname: "host-a", secret: "bad", mintedSecret: "x" }));
    expect(wrongSecret).toMatchObject({ _tag: "conflict", reason: "secret_mismatch" });

    db.exec(`INSERT INTO machines (id, hostname, secret, last_seen) VALUES ('legacy','legacy-host','',NULL)`);
    const legacy = await Effect.runPromise(repo.register({ id: "legacy", hostname: "legacy-host", secret: "anything", mintedSecret: "x" }));
    expect(legacy).toMatchObject({ _tag: "conflict", reason: "legacy" });
  });

  it("heartbeat inserts then updates hostname, clis and last_seen", async () => {
    setup();
    const first = await Effect.runPromise(repo.heartbeat({ id: "hb1", hostname: "h1", clis: [{ provider: "opencode", version: "1.0" }] }));
    expect(first.lastSeen).not.toBeNull();
    expect(first.clis).toEqual([{ provider: "opencode", version: "1.0" }]);

    const second = await Effect.runPromise(repo.heartbeat({ id: "hb1", hostname: "h2", clis: [{ provider: "hermes", version: "2.0" }] }));
    expect(second.hostname).toBe("h2");
    expect(second.clis).toEqual([{ provider: "hermes", version: "2.0" }]);
    const rows = await Effect.runPromise(repo.list());
    expect(rows).toHaveLength(1);
  });

  it("findById returns the machine; unknown id → RowNotFound", async () => {
    setup();
    await Effect.runPromise(repo.heartbeat({ id: "hb1", hostname: "h1" }));
    const machine = await Effect.runPromise(repo.findById("hb1"));
    expect(machine.id).toBe("hb1");
    const missing = await Effect.runPromise(Effect.either(repo.findById("nope")));
    expect(missing).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "RowNotFound" }) });
  });

  it("list orders by last_seen DESC then created_at DESC", async () => {
    setup();
    db.exec(`INSERT INTO machines (id, hostname, secret, last_seen, created_at)
             VALUES ('old','old','s','2026-01-01 00:00:00','2026-01-01 00:00:00'),
                    ('new','new','s','2026-02-01 00:00:00','2026-01-01 00:00:00'),
                    ('unseen','unseen','s',NULL,'2026-03-01 00:00:00')`);
    const rows = await Effect.runPromise(repo.list());
    expect(rows.map((m) => m.id)).toEqual(["new", "old", "unseen"]);
  });

  it("markOffline clears lastSeen only for stale machines", async () => {
    setup();
    db.exec(`INSERT INTO machines (id, hostname, secret, last_seen)
             VALUES ('stale','stale','s','2000-01-01 00:00:00')`);
    await Effect.runPromise(repo.heartbeat({ id: "fresh", hostname: "fresh" }));
    await Effect.runPromise(repo.markOffline());
    const after = await Effect.runPromise(repo.list());
    const stale = after.find((m) => m.id === "stale");
    const fresh = after.find((m) => m.id === "fresh");
    expect(stale?.lastSeen).toBeNull();
    expect(fresh?.lastSeen).not.toBeNull();
  });

  it("delete removes an existing machine; unknown id → RowNotFound", async () => {
    setup();
    await Effect.runPromise(repo.heartbeat({ id: "hb1", hostname: "h1" }));
    await Effect.runPromise(repo.delete("hb1"));
    expect(await Effect.runPromise(repo.list())).toHaveLength(0);

    const missing = await Effect.runPromise(Effect.either(repo.delete("nope")));
    expect(missing).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "RowNotFound" }) });
  });
});
