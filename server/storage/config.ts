export type StorageDriverKind = "fs" | "s3" | "r2";

// Narrow R2 binding surface — the methods we actually call. The real
// `R2Bucket` type from `cloudflare:workers` extends this; declaring the
// shape here keeps `server/storage/*` Workers-free at the type level and
// the entry on Workers narrows the `env.BLOB` binding to this interface.
export interface R2Bucket {
  put(key: string, value: ArrayBuffer | Uint8Array | string | null, options?: { onlyIf?: { etagMatches?: string; uploadedBefore?: Date } }): Promise<{ etag: string; uploaded: Date }>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; body: ReadableStream; etag: string } | null>;
  delete(key: string): Promise<void>;
  head(key: string): Promise<{ size: number; etag: string } | null>;
  list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<R2ListPage>;
}

export interface R2ListPage {
  objects: { key: string; size: number; etag: string }[];
  truncated: boolean;
  cursor?: string | undefined;
}

export interface S3StorageOptions {
  endpoint: string | null;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
}

export interface R2StorageOptions {
  binding: R2Bucket;
  bucketName: string;
}

export interface StorageConfigShape {
  driver: StorageDriverKind;
  fsRoot: string;
  s3: S3StorageOptions | null;
  r2: R2StorageOptions | null;
  maxUploadBytes: number;
}

export const DEFAULT_MAX_UPLOAD_MB = 25;

// Multipart framing overhead (boundary, part headers) on top of the raw file
// bytes — the entry stream cap and the middleware declared-length pre-check
// allow this slack so the route-level exact cap is what rejects oversize files.
export const MULTIPART_SLACK_BYTES = 1024 * 1024;

function parsePositiveMb(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_UPLOAD_MB;
}
export function resolveStorageConfig(
  env: Record<string, string | undefined>,
  dbDir: string
): StorageConfigShape {
  const rawDriver = env.LXK_STORAGE_DRIVER;
  const driver: StorageDriverKind = rawDriver === "s3" ? "s3" : rawDriver === "r2" ? "r2" : "fs";
  const maxUploadBytes = Math.round(parsePositiveMb(env.LXK_MAX_UPLOAD_MB) * 1024 * 1024);
  if (driver === "fs") {
    return { driver, fsRoot: env.LXK_STORAGE_FS_ROOT || joinPath(dbDir, "blobs"), s3: null, r2: null, maxUploadBytes };
  }
  if (driver === "r2") {
    // The native R2 binding is only available on Cloudflare Workers. The Bun
    // host that drives `bun run dev:full` / `lexa-cli deploy bun` must use
    // the S3 driver with `LXK_S3_ENDPOINT=https://<accountid>.r2.cloudflarestorage.com`
    // to talk to R2. Reject r2 here with a clear error so misconfiguration
    // is loud, not silent.
    throw new Error(
      "LXK_STORAGE_DRIVER=r2 is Workers-only. On the Bun host use LXK_STORAGE_DRIVER=s3 with " +
        "LXK_S3_ENDPOINT set to https://<accountid>.r2.cloudflarestorage.com.",
    );
  }
  const bucket = env.LXK_S3_BUCKET ?? "";
  const accessKeyId = env.LXK_S3_ACCESS_KEY_ID ?? "";
  const secretAccessKey = env.LXK_S3_SECRET_ACCESS_KEY ?? "";
  if (!bucket || !accessKeyId || !secretAccessKey) {
    throw new Error("LXK_STORAGE_DRIVER=s3 requires LXK_S3_BUCKET, LXK_S3_ACCESS_KEY_ID and LXK_S3_SECRET_ACCESS_KEY");
  }
  return {
    driver,
    fsRoot: joinPath(dbDir, "blobs"),
    s3: {
      endpoint: env.LXK_S3_ENDPOINT || null,
      bucket,
      accessKeyId,
      secretAccessKey,
      region: env.LXK_S3_REGION || "auto",
    },
    r2: null,
    maxUploadBytes,
  };
}

function joinPath(a: string, b: string): string {
  return a.endsWith("/") ? `${a}${b}` : `${a}/${b}`;
}

const UPLOAD_PATH_RE = /^\/api\/projects\/[^/]+\/(tasks\/[^/]+|wiki\/pages\/[^/]+)\/attachments$/;

export function isAttachmentUploadPath(path: string): boolean {
  return UPLOAD_PATH_RE.test(path);
}

// Body cap for one request path: upload routes get the upload cap + multipart
// slack (raised above the global JSON cap when larger); everything else keeps
// MAX_API_BODY. The route enforces the exact per-file cap afterwards.
export function bodyCapFor(path: string, cfg: StorageConfigShape, maxApiBodyBytes: number): number {
  if (!isAttachmentUploadPath(path)) return maxApiBodyBytes;
  return Math.max(maxApiBodyBytes, cfg.maxUploadBytes + MULTIPART_SLACK_BYTES);
}
