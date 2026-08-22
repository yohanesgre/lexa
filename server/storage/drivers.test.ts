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
