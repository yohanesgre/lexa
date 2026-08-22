import { describe, expect, it } from "vitest";
import { bodyCapFor, isAttachmentUploadPath, resolveStorageConfig, DEFAULT_MAX_UPLOAD_MB, MULTIPART_SLACK_BYTES } from "./config";

const MB = 1024 * 1024;

describe("resolveStorageConfig", () => {
  it("defaults to fs driver under the DB dir with the default upload cap", () => {
    const cfg = resolveStorageConfig({}, "/app/data");
    expect(cfg.driver).toBe("fs");
    expect(cfg.fsRoot).toBe("/app/data/blobs");
    expect(cfg.maxUploadBytes).toBe(DEFAULT_MAX_UPLOAD_MB * MB);
    expect(cfg.s3).toBeNull();
  });

  it("honours LXK_STORAGE_FS_ROOT and LXK_MAX_UPLOAD_MB", () => {
    const cfg = resolveStorageConfig({ LXK_STORAGE_FS_ROOT: "/vol/blobs", LXK_MAX_UPLOAD_MB: "7" }, "/app/data");
    expect(cfg.fsRoot).toBe("/vol/blobs");
    expect(cfg.maxUploadBytes).toBe(7 * MB);
  });

  it("invalid upload cap falls back to the default", () => {
    expect(resolveStorageConfig({ LXK_MAX_UPLOAD_MB: "nope" }, "/d").maxUploadBytes).toBe(DEFAULT_MAX_UPLOAD_MB * MB);
    expect(resolveStorageConfig({ LXK_MAX_UPLOAD_MB: "-3" }, "/d").maxUploadBytes).toBe(DEFAULT_MAX_UPLOAD_MB * MB);
  });

  it("s3 driver requires bucket + keys", () => {
    expect(() => resolveStorageConfig({ LXK_STORAGE_DRIVER: "s3" }, "/d")).toThrow(/LXK_S3_BUCKET/);
    const cfg = resolveStorageConfig({
      LXK_STORAGE_DRIVER: "s3",
      LXK_S3_ENDPOINT: "http://127.0.0.1:9000",
      LXK_S3_BUCKET: "lexa",
      LXK_S3_ACCESS_KEY_ID: "k",
      LXK_S3_SECRET_ACCESS_KEY: "s",
    }, "/d");
    expect(cfg.driver).toBe("s3");
    expect(cfg.s3).toEqual({ endpoint: "http://127.0.0.1:9000", bucket: "lexa", accessKeyId: "k", secretAccessKey: "s", region: "auto" });
  });
});

describe("bodyCapFor", () => {
  const cfg = { driver: "fs" as const, fsRoot: "/x", s3: null, maxUploadBytes: DEFAULT_MAX_UPLOAD_MB * MB };
  const smallCfg = { ...cfg, maxUploadBytes: 1 * MB };

  it("non-upload paths keep the global cap", () => {
    expect(bodyCapFor("/api/projects/p/tasks", cfg, 16 * MB)).toBe(16 * MB);
    expect(bodyCapFor("/api/attachments/x", cfg, 16 * MB)).toBe(16 * MB);
  });

  it("task + wiki upload paths get max(global, upload+slack)", () => {
    expect(bodyCapFor("/api/projects/p/tasks/t1/attachments", cfg, 16 * MB))
      .toBe(DEFAULT_MAX_UPLOAD_MB * MB + MULTIPART_SLACK_BYTES);
    expect(bodyCapFor("/api/projects/p/wiki/pages/home/attachments", cfg, 16 * MB))
      .toBe(DEFAULT_MAX_UPLOAD_MB * MB + MULTIPART_SLACK_BYTES);
    // Upload cap below the global cap → global stays.
    expect(bodyCapFor("/api/projects/p/tasks/t1/attachments", smallCfg, 16 * MB)).toBe(16 * MB);
  });

  it("upload path matcher rejects lookalikes", () => {
    expect(isAttachmentUploadPath("/api/projects/p/tasks/t1/attachments/extra")).toBe(false);
    expect(isAttachmentUploadPath("/api/share/tok/attachments/id")).toBe(false);
  });
});
