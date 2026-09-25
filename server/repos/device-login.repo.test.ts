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
import { DeviceLoginRepo, storeDeviceRawKey, takeDeviceRawKey } from "./device-login.repo";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

let dir: string;
let db: Database;
let repo: DeviceLoginRepo;

afterEach(() => { try { db?.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });

function setup() {
  dir = mkdtempSync(join(tmpdir(), "lexa-device-login-repo-"));
  const path = join(dir, "test.db");
  runMigrations(path, MIGRATIONS);
  db = new Database(path);
  db.exec("PRAGMA foreign_keys = ON");
  const layer = DeviceLoginRepo.Default.pipe(Layer.provide(Layer.mergeAll(Layer.succeed(Sqlite, db), DbBunLive(db))));
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  repo = Context.get(ctx, DeviceLoginRepo);
  db.exec(`INSERT INTO users (id, email, name) VALUES ('u1','u1@example.com','User One')`);
  db.exec(`INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k1','cli-host','h1','u1')`);
}

const create = (over: Partial<{ id: string; tokenHash: string; code: string; clientName: string }> = {}) =>
  repo.create({ id: "d1", tokenHash: "th-1", code: "ABCD1234", clientName: "cli-host", ...over });

describe("DeviceLoginRepo", () => {
  it("create stores a pending request with a hashed token and 10-minute expiry", async () => {
    setup();
    const row = await Effect.runPromise(create());
    expect(row.id).toBe("d1");
    expect(row.status).toBe("pending");
    expect(row.token_hash).toBe("th-1");
    expect(row.code).toBe("ABCD1234");
    expect(row.client_name).toBe("cli-host");
    expect(row.is_expired).toBe(0);
    expect(row.expires_at_iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(row.approver_user_id).toBeNull();
    expect(row.api_key_id).toBeNull();
    expect(row.key_name).toBeNull();
    expect(row.approver_name).toBeNull();
  });

  it("findById returns the row and fails RowNotFound for an unknown id", async () => {
    setup();
    await Effect.runPromise(create());
    const found = await Effect.runPromise(repo.findById("d1"));
    expect(found.code).toBe("ABCD1234");

    const missing = await Effect.runPromise(Effect.either(repo.findById("nope")));
    expect(missing).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "RowNotFound" }) });
  });

  it("reports expiry lexically and formats expires_at as RFC-3339 Z", async () => {
    setup();
    await Effect.runPromise(create());
    db.exec(`UPDATE device_login_requests SET expires_at = datetime('now','-1 minute') WHERE id = 'd1'`);
    const expired = await Effect.runPromise(repo.findById("d1"));
    expect(expired.is_expired).toBe(1);

    db.exec(`UPDATE device_login_requests SET expires_at = '2099-01-02 03:04:05' WHERE id = 'd1'`);
    const fixed = await Effect.runPromise(repo.findById("d1"));
    expect(fixed.expires_at_iso).toBe("2099-01-02T03:04:05Z");
    expect(fixed.is_expired).toBe(0);
  });

  it("rejects a duplicate token_hash", async () => {
    setup();
    await Effect.runPromise(create({ id: "d1", tokenHash: "same" }));
    const dup = await Effect.runPromise(Effect.either(create({ id: "d2", tokenHash: "same" })));
    expect(dup).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "ConstraintViolation" }) });
  });

  it("setApproved transitions pending → approved and is one-shot", async () => {
    setup();
    await Effect.runPromise(create());
    await Effect.runPromise(repo.setApproved("d1", "u1", "k1"));
    const row = await Effect.runPromise(repo.findById("d1"));
    expect(row.status).toBe("approved");
    expect(row.approver_user_id).toBe("u1");
    expect(row.api_key_id).toBe("k1");
    expect(row.approver_name).toBe("User One");
    expect(row.key_name).toBe("cli-host");

    const again = await Effect.runPromise(Effect.either(repo.setApproved("d1", "u1", "k1")));
    expect(again).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "RowNotFound" }) });
  });

  it("setApproved on an unknown id fails RowNotFound", async () => {
    setup();
    const res = await Effect.runPromise(Effect.either(repo.setApproved("nope", "u1", "k1")));
    expect(res).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "RowNotFound" }) });
  });

  it("setDenied transitions pending → denied and rejects a second/foreign transition", async () => {
    setup();
    await Effect.runPromise(create());
    await Effect.runPromise(repo.setDenied("d1"));
    const denied = await Effect.runPromise(repo.findById("d1"));
    expect(denied.status).toBe("denied");
    expect(denied.approver_user_id).toBeNull();
    expect(denied.api_key_id).toBeNull();

    const again = await Effect.runPromise(Effect.either(repo.setDenied("d1")));
    expect(again).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "RowNotFound" }) });
    const foreign = await Effect.runPromise(Effect.either(repo.setApproved("d1", "u1", "k1")));
    expect(foreign).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "RowNotFound" }) });
  });

  it("deleteById removes the row and is idempotent", async () => {
    setup();
    await Effect.runPromise(create());
    await Effect.runPromise(repo.deleteById("d1"));
    await Effect.runPromise(repo.deleteById("d1"));
    const gone = await Effect.runPromise(Effect.either(repo.findById("d1")));
    expect(gone).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "RowNotFound" }) });
  });

  it("api_key delete nulls api_key_id on an approved request", async () => {
    setup();
    await Effect.runPromise(create());
    await Effect.runPromise(repo.setApproved("d1", "u1", "k1"));
    db.exec(`DELETE FROM api_keys WHERE id = 'k1'`);
    const row = await Effect.runPromise(repo.findById("d1"));
    expect(row.api_key_id).toBeNull();
    expect(row.key_name).toBeNull();
  });

  it("raw key store hands the key out exactly once", () => {
    storeDeviceRawKey("raw-1", "lxk_secret");
    expect(takeDeviceRawKey("raw-1")).toBe("lxk_secret");
    expect(takeDeviceRawKey("raw-1")).toBeNull();
  });
});
