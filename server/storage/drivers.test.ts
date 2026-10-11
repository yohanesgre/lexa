import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { Database } from "bun:sqlite";
import { createFsDriver, StorageError } from "./drivers";
import {
  bodyCapFor,
  resolveStorageConfig,
  CHAT_ATTACHMENT_MAX_UPLOAD_BYTES,
  DEFAULT_MAX_UPLOAD_MB,
  MULTIPART_SLACK_BYTES,
  type R2Bucket,
  type R2ListPage,
  type R2StorageOptions,
  type StorageConfigShape,
} from "./config";
import { createR2Driver } from "./drivers";
import { runMigrations } from "../db/migrate";
import { parseBackupStamp, pruneBackups, runBackup } from "./backup";
import {
  isChatAttachmentMime,
  isChatImageMime,
  isInlineMime,
  resolveChatAttachmentMime,
  sniffMime,
} from "./mime";

describe("fs driver", () => {
  const make = () => createFsDriver(mkdtempSync(join(tmpdir(), "lexa-fs-driver-")));

  it("put/get round-trip is byte-identical", async () => {
    const d = make();
    const bytes = new Uint8Array([1, 2, 3, 250, 0, 99]);
    await d.put("blobs/x1", bytes);
    expect(Buffer.from(await d.get("blobs/x1")).equals(Buffer.from(bytes))).toBe(true);
  });

  it("list returns keys under a prefix, nested included", async () => {
    const d = make();
    await d.put("backups/a.db.gz", new Uint8Array([1]));
    await d.put("backups/b-blobs/sha", new Uint8Array([2]));
    await d.put("blobs/c", new Uint8Array([3]));
    expect(await d.list("backups/")).toEqual(["backups/a.db.gz", "backups/b-blobs/sha"]);
    expect(await d.list("blobs/")).toEqual(["blobs/c"]);
    expect(await d.list("missing/")).toEqual([]);
  });

  it("traversal keys are rejected", async () => {
    const d = make();
    await expect(d.put("../escape", new Uint8Array([1]))).rejects.toBeInstanceOf(StorageError);
    await expect(d.get("/abs")).rejects.toBeInstanceOf(StorageError);
  });
});

// ─── r2 driver ─────────────────────────────────────────────────────────────
// The real R2 binding only exists inside workerd. These tests stand up an
// in-process stub that implements the same `R2Bucket` interface our driver
// consumes; end-to-end verification against workerd's R2 namespace happens
// via `bunx wrangler dev`.
function makeStubR2(): R2Bucket {
  const store = new Map<string, Uint8Array>();
  return {
    async put(key, value) {
      if (value == null) store.delete(key);
      else store.set(key, value instanceof Uint8Array ? value : new TextEncoder().encode(String(value)));
      return { etag: `etag-${store.size}`, uploaded: new Date() };
    },
    async get(key) {
      const v = store.get(key);
      if (!v) return null;
      return {
        arrayBuffer: async () => v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer,
        body: new ReadableStream(),
        etag: `etag-${key}`,
      };
    },
    async delete(key) { store.delete(key); },
    async head(key) {
      const v = store.get(key);
      return v ? { size: v.byteLength, etag: `etag-${key}` } : null;
    },
    async list({ prefix, cursor } = {}): Promise<R2ListPage> {
      const all = Array.from(store.keys())
        .filter((k) => !prefix || k.startsWith(prefix))
        .sort();
      const start = cursor ? Number(cursor) : 0;
      const limit = 2; // small page to exercise pagination
      const page = all.slice(start, start + limit);
      const truncated = start + limit < all.length;
      return { objects: page.map((key) => ({ key, size: store.get(key)!.byteLength, etag: `etag-${key}` })), truncated, cursor: truncated ? String(start + limit) : undefined };
    },
  };
}

function makeR2(): { driver: ReturnType<typeof createR2Driver>; binding: R2Bucket; opts: R2StorageOptions } {
  const binding = makeStubR2();
  const opts: R2StorageOptions = { binding, bucketName: "lexa-blobs-test" };
  return { driver: createR2Driver(opts), binding, opts };
}

describe("r2 driver", () => {
  it("put/get round-trip is byte-identical", async () => {
    const { driver } = makeR2();
    const bytes = new Uint8Array([1, 2, 3, 250, 0, 99]);
    await driver.put("blobs/x1", bytes);
    const got = await driver.get("blobs/x1");
    expect(Buffer.from(got).equals(Buffer.from(bytes))).toBe(true);
  });

  it("list returns keys under a prefix, paginated", async () => {
    const { driver } = makeR2();
    await driver.put("backups/a", new Uint8Array([1]));
    await driver.put("backups/b", new Uint8Array([2]));
    await driver.put("backups/c", new Uint8Array([3]));
    await driver.put("blobs/d", new Uint8Array([4]));
    const keys = await driver.list("backups/");
    expect(keys).toEqual(["backups/a", "backups/b", "backups/c"]);
    expect(await driver.list("blobs/")).toEqual(["blobs/d"]);
    expect(await driver.list("missing/")).toEqual([]);
  });
});

// ─── mime ──────────────────────────────────────────────────────────────────
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const GIF = new TextEncoder().encode("GIF89a....");
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

describe("sniffMime", () => {
  it("detects image formats by magic bytes", () => {
    expect(sniffMime(PNG)).toBe("image/png");
    expect(sniffMime(JPEG)).toBe("image/jpeg");
    expect(sniffMime(GIF)).toBe("image/gif");
    expect(sniffMime(WEBP)).toBe("image/webp");
  });

});

describe("isInlineMime", () => {
  it("image/* (except SVG) and application/pdf render inline; everything else downloads", () => {
    expect(isInlineMime("image/png")).toBe(true);
    expect(isInlineMime("image/svg+xml")).toBe(false);
    expect(isInlineMime("application/pdf")).toBe(true);
    expect(isInlineMime("text/html")).toBe(false);
    expect(isInlineMime("text/csv")).toBe(false);
    expect(isInlineMime("application/octet-stream")).toBe(false);
  });
});

describe("chat attachment mime", () => {
  it("allowlist and image predicate agree with the resolver", () => {
    for (const m of ["image/png", "image/jpeg", "image/webp", "image/gif", "application/pdf", "text/markdown", "text/plain"]) {
      expect(isChatAttachmentMime(m), m).toBe(true);
    }
    expect(isChatAttachmentMime("image/svg+xml")).toBe(false);
    expect(isChatAttachmentMime("image/bmp")).toBe(false);
    expect(isChatImageMime("image/gif")).toBe(true);
    expect(isChatImageMime("application/pdf")).toBe(false);
    expect(isChatImageMime("text/markdown")).toBe(false);
  });

  it("resolver: magic bytes win, sniffed-but-unsupported reject outright, text classifies by extension", () => {
    const enc = new TextEncoder();
    expect(resolveChatAttachmentMime("x.bin", PNG)).toBe("image/png");
    expect(resolveChatAttachmentMime("paper.pdf", enc.encode("%PDF-1.7 ..."))).toBe("application/pdf");
    // never text-probed: an SVG masquerading as .png, plus other non-allowlisted sniffed types
    expect(resolveChatAttachmentMime("lie.png", enc.encode('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
    expect(resolveChatAttachmentMime("logo.bmp", new Uint8Array([0x42, 0x4d, 0, 0]))).toBeNull();
    expect(resolveChatAttachmentMime("book.xlsx", new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0]))).toBeNull();
    // unsigned UTF-8 text classifies by extension; binary and empty reject
    expect(resolveChatAttachmentMime("notes.md", enc.encode("# Title\n\nsome body text"))).toBe("text/markdown");
    expect(resolveChatAttachmentMime("readme.MD", enc.encode("plain words"))).toBe("text/markdown");
    expect(resolveChatAttachmentMime("binary.txt", new Uint8Array([0x61, 0x00, 0x62, 0x63]))).toBeNull();
    expect(resolveChatAttachmentMime("empty.txt", new Uint8Array(0))).toBeNull();
  });
});

// ─── storage config ────────────────────────────────────────────────────────
const MB = 1024 * 1024;

describe("resolveStorageConfig", () => {
  it("defaults to fs driver under the DB dir with the default upload cap", () => {
    const cfg = resolveStorageConfig({}, "/app/data");
    expect(cfg.driver).toBe("fs");
    expect(cfg.fsRoot).toBe("/app/data/blobs");
    expect(cfg.maxUploadBytes).toBe(DEFAULT_MAX_UPLOAD_MB * MB);
    expect(cfg.s3).toBeNull();
  });
});

describe("bodyCapFor", () => {
  const cfg = { driver: "fs" as const, fsRoot: "/x", s3: null, r2: null, maxUploadBytes: DEFAULT_MAX_UPLOAD_MB * MB };
  const smallCfg = { ...cfg, maxUploadBytes: 1 * MB };

  it("task + wiki upload paths get max(global, upload+slack)", () => {
    expect(bodyCapFor("/api/projects/p/tasks/t1/attachments", cfg, 16 * MB))
      .toBe(DEFAULT_MAX_UPLOAD_MB * MB + MULTIPART_SLACK_BYTES);
    expect(bodyCapFor("/api/projects/p/wiki/pages/home/attachments", cfg, 16 * MB))
      .toBe(DEFAULT_MAX_UPLOAD_MB * MB + MULTIPART_SLACK_BYTES);
    // Upload cap below the global cap → global stays.
    expect(bodyCapFor("/api/projects/p/tasks/t1/attachments", smallCfg, 16 * MB)).toBe(16 * MB);
    // Chat attachment uploads have their own fixed cap, independent of maxUploadBytes.
    expect(bodyCapFor("/api/projects/p/assistant/chat/c1/attachments", smallCfg, 1 * MB))
      .toBe(CHAT_ATTACHMENT_MAX_UPLOAD_BYTES + MULTIPART_SLACK_BYTES);
    // A lookalike path is not an upload path.
    expect(bodyCapFor("/api/projects/p/tasks/t1/attachments-archive", cfg, 16 * MB)).toBe(16 * MB);
  });
});

// ─── backup (absorbed from backup.test.ts) ─────────────────────────────────
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
});
