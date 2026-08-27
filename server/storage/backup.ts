import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { StorageConfigShape } from "./config";
import { createFsDriver, createS3Driver, type StorageDriver } from "./drivers";

export const DEFAULT_BACKUP_RETENTION = 14;

// backups/lexa-<ISO-stamp>.db.gz (+ lexa-<stamp>-blobs/** for the fs driver).
// Stamps are fixed-width ISO with ":"/"." replaced by "-" so lexical sort ==
// chronological sort for retention.
export function parseBackupStamp(key: string): string | null {
  const m = /^backups\/lexa-(.+)\.db\.gz$/.exec(key);
  return m ? m[1]! : null;
}

function stampNow(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function listBlobFiles(fsRoot: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    let entries: string[];
    try {
      entries = readdirSync(join(fsRoot, rel));
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = rel ? `${rel}/${entry}` : entry;
      if (statSync(join(fsRoot, child)).isDirectory()) walk(child);
      else out.push(child);
    }
  };
  walk("blobs");
  return out.sort();
}

// Retention: keep the newest `retention` snapshots; delete older .db.gz keys
// plus their -blobs/ companions. Returns the deleted keys.
export async function pruneBackups(driver: StorageDriver, retention: number): Promise<string[]> {
  const keys = await driver.list("backups/");
  const stamps = Array.from(new Set(keys.map(parseBackupStamp).filter((s): s is string => s !== null))).sort().reverse();
  const doomed = new Set<string>();
  for (const stamp of stamps.slice(retention)) {
    doomed.add(`backups/lexa-${stamp}.db.gz`);
    for (const key of keys) {
      if (key.startsWith(`backups/lexa-${stamp}-blobs/`)) doomed.add(key);
    }
  }
  for (const key of doomed) {
    await driver.delete(key);
  }
  return Array.from(doomed).sort();
}

export async function runBackup(
  dbPath: string,
  cfg: StorageConfigShape,
  driver: StorageDriver,
  opts?: { retention?: number }
): Promise<{ key: string }> {
  const retention = opts?.retention ?? DEFAULT_BACKUP_RETENTION;
  const stamp = stampNow();
  const name = `lexa-${stamp}`;
  const snapshot = join(tmpdir(), `lexa-backup-${process.pid}-${Date.now()}.db`);
  const db = new Database(dbPath);
  try {
    db.exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
  try {
    const gz = new Uint8Array(gzipSync(new Uint8Array(readFileSync(snapshot))));
    await driver.put(`backups/${name}.db.gz`, gz);
    // fs driver: the blobs live beside the DB — copy them into the backup set
    // so a restore is self-contained. s3 buckets hold their own copies.
    if (cfg.driver === "fs") {
      for (const rel of listBlobFiles(cfg.fsRoot)) {
        const data = new Uint8Array(readFileSync(join(cfg.fsRoot, rel)));
        await driver.put(`backups/${name}-blobs/${rel.slice("blobs/".length)}`, data);
      }
    }
    await pruneBackups(driver, retention);
    return { key: `backups/${name}.db.gz` };
  } finally {
    rmSync(snapshot, { force: true });
  }
}

// Plain-driver factory for the boot timer (no Effect runtime needed there).
export function createBackupDriver(cfg: StorageConfigShape): StorageDriver {
  if (cfg.driver === "s3" && cfg.s3) return createS3Driver(cfg.s3);
  mkdirSync(cfg.fsRoot, { recursive: true });
  return createFsDriver(cfg.fsRoot);
}
