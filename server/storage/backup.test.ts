import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { createFsDriver } from "./drivers";
import type { StorageConfigShape } from "./config";
import { parseBackupStamp, pruneBackups, runBackup } from "./backup";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

function makeCfg(fsRoot: string): StorageConfigShape {
  return { driver: "fs", fsRoot, s3: null, r2: null, maxUploadBytes: 25 * 1024 * 1024 };
}

function makeDb(dir: string): string {
  const dbPath = join(dir, "lexa.db");
  runMigrations(dbPath, MIGRATIONS);
  const db = new Database(dbPath);
  db.exec("INSERT INTO projects (id, name, slug) VALUES ('p1', 'P', 'p1')");
  db.close();
  return dbPath;
}

describe("runBackup (fs driver)", () => {
  it("snapshot gunzip round-trips to the DB content; blob dir copied; tmp cleaned up", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lexa-backup-"));
    const fsRoot = join(dir, "blobs");
    const cfg = makeCfg(fsRoot);
    const driver = createFsDriver(fsRoot);
    await driver.put("blobs/sha-a", new Uint8Array([1, 2, 3]));
    const dbPath = makeDb(dir);

    const { key } = await runBackup(dbPath, cfg, driver);
    expect(key).toMatch(/^backups\/lexa-.+\.db\.gz$/);

    const gz = await driver.get(key);
    const raw = Buffer.from(gunzipSync(Buffer.from(gz))).toString("utf8");
    expect(raw).toContain("CREATE TABLE projects");
    expect(raw).toContain("p1");

    expect(await driver.get("backups/" + key.split("/")[1]!.replace(".db.gz", "-blobs/sha-a")))
      .toEqual(new Uint8Array([1, 2, 3]));

    const leftovers = readdirSync(dir).filter((f) => f.startsWith("lexa-backup-"));
    expect(leftovers).toEqual([]);

    rmSync(dir, { recursive: true, force: true });
  });

  it("retention prunes beyond N snapshots including -blobs companions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lexa-backup-retain-"));
    const fsRoot = join(dir, "blobs");
    const cfg = makeCfg(fsRoot);
    const driver = createFsDriver(fsRoot);
    const dbPath = makeDb(dir);

    // Three snapshots with distinct stamps (stamp granularity is ms).
    const k1 = (await runBackup(dbPath, cfg, driver)).key;
    await new Promise((r) => setTimeout(r, 5));
    const k2 = (await runBackup(dbPath, cfg, driver)).key;
    await new Promise((r) => setTimeout(r, 5));
    const k3 = (await runBackup(dbPath, cfg, driver)).key;
    expect(new Set([k1, k2, k3]).size).toBe(3);

    const deleted = await pruneBackups(driver, 2);
    expect(deleted).toContain(k1);
    expect(deleted.length).toBeGreaterThanOrEqual(1);
    expect(deleted.every((k) => k.startsWith("backups/"))).toBe(true);
    expect(await driver.stat(k1)).toBeNull();
    expect(await driver.stat(k2)).not.toBeNull();
    expect(await driver.stat(k3)).not.toBeNull();
    // Companion blob files of the pruned snapshot are gone too (fs driver
    // deletes files only — empty dirs may linger).
    const stamp1 = parseBackupStamp(k1)!;
    const remaining = await driver.list("backups/");
    expect(remaining.every((k) => !k.startsWith(`backups/lexa-${stamp1}-blobs/`))).toBe(true);

    rmSync(dir, { recursive: true, force: true });
  });

  it("runBackup honors the retention override (keeps exactly N newest)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lexa-backup-override-"));
    const fsRoot = join(dir, "blobs");
    const cfg = makeCfg(fsRoot);
    const driver = createFsDriver(fsRoot);
    const dbPath = makeDb(dir);

    const k1 = (await runBackup(dbPath, cfg, driver, { retention: 2 })).key;
    await new Promise((r) => setTimeout(r, 5));
    const k2 = (await runBackup(dbPath, cfg, driver, { retention: 2 })).key;
    await new Promise((r) => setTimeout(r, 5));
    const k3 = (await runBackup(dbPath, cfg, driver, { retention: 2 })).key;

    expect(await driver.stat(k1)).toBeNull();
    expect(await driver.stat(k2)).not.toBeNull();
    expect(await driver.stat(k3)).not.toBeNull();
    expect((await driver.list("backups/")).filter((k) => k.endsWith(".db.gz"))).toEqual([k2, k3]);

    rmSync(dir, { recursive: true, force: true });
  });
});
