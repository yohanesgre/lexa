import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFsDriver, KeyNotFound, StorageError } from "./drivers";
import { storageKeyFor } from "./storage";

describe("storageKeyFor", () => {
  it("content-addresses blobs under blobs/", () => {
    expect(storageKeyFor("abc123")).toBe("blobs/abc123");
  });
});

describe("fs driver", () => {
  const make = () => createFsDriver(mkdtempSync(join(tmpdir(), "lexa-fs-driver-")));

  it("put/get round-trip is byte-identical", async () => {
    const d = make();
    const bytes = new Uint8Array([1, 2, 3, 250, 0, 99]);
    await d.put("blobs/x1", bytes);
    expect(Buffer.from(await d.get("blobs/x1")).equals(Buffer.from(bytes))).toBe(true);
  });

  it("get of a missing key → KeyNotFound", async () => {
    const d = make();
    await expect(d.get("blobs/nope")).rejects.toBeInstanceOf(KeyNotFound);
  });

  it("delete removes the object; stat reports size or null", async () => {
    const d = make();
    await d.put("blobs/x2", new Uint8Array([9, 9, 9, 9]));
    expect(await d.stat("blobs/x2")).toBe(4);
    await d.delete("blobs/x2");
    expect(await d.stat("blobs/x2")).toBeNull();
    await expect(d.get("blobs/x2")).rejects.toBeInstanceOf(KeyNotFound);
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

  it("root dir is created and used", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lexa-fs-root-"));
    const root = join(dir, "nested", "blobs");
    const d = createFsDriver(root);
    await d.put("blobs/z", new Uint8Array([7]));
    expect(existsSync(join(root, "blobs", "z"))).toBe(true);
    expect(readdirSync(root)).toContain("blobs");
    rmSync(dir, { recursive: true, force: true });
  });
});

// ─── r2 driver ─────────────────────────────────────────────────────────────
// The real R2 binding only exists inside workerd. These tests stand up an
// in-process stub that implements the same `R2Bucket` interface our driver
// consumes; end-to-end verification against workerd's R2 namespace happens
// via `bunx wrangler dev` in Phase 8.
import type { R2Bucket, R2ListPage, R2StorageOptions } from "./config";
import { createR2Driver } from "./drivers";

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

  it("get of a missing key → KeyNotFound", async () => {
    const { driver } = makeR2();
    await expect(driver.get("blobs/nope")).rejects.toBeInstanceOf(KeyNotFound);
  });

  it("delete is idempotent; stat reports size or null", async () => {
    const { driver } = makeR2();
    await driver.put("blobs/x2", new Uint8Array([9, 9, 9, 9]));
    expect(await driver.stat("blobs/x2")).toBe(4);
    await driver.delete("blobs/x2");
    expect(await driver.stat("blobs/x2")).toBeNull();
    await driver.delete("blobs/x2"); // missing key — no throw
    await expect(driver.get("blobs/x2")).rejects.toBeInstanceOf(KeyNotFound);
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

  it("put/get errors surface as StorageError; KeyNotFound propagates from get", async () => {
    const { driver, binding } = makeR2();
    // Force a storage error by making the binding's put throw.
    const origPut = binding.put.bind(binding);
    binding.put = async () => { throw new Error("network blip"); };
    await expect(driver.put("blobs/x", new Uint8Array([1]))).rejects.toBeInstanceOf(StorageError);
    binding.put = origPut;
  });
});
