import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Data } from "effect";
import type { R2ListPage, R2StorageOptions, S3StorageOptions } from "./config";

export class StorageError extends Data.TaggedError("StorageError")<{ message: string; cause?: unknown }> {}
export class KeyNotFound extends Data.TaggedError("KeyNotFound")<{ key: string }> {}

export interface StorageDriver {
  put(key: string, data: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
  stat(key: string): Promise<number | null>;
  list(prefix: string): Promise<string[]>;
}

// Keys are generated internally (blobs/<sha256>, backups/<name>) — never raw
// user input — but resolveKey still refuses traversal as defense in depth.
function resolveKey(root: string, key: string): string {
  if (key.includes("..") || key.startsWith("/")) {
    throw new StorageError({ message: `invalid storage key: ${key}` });
  }
  return join(root, key);
}

export function createFsDriver(root: string): StorageDriver {
  mkdirSync(root, { recursive: true });
  return {
    async put(key, data) {
      const path = resolveKey(root, key);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, data);
    },
    async get(key) {
      try {
        return new Uint8Array(readFileSync(resolveKey(root, key)));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") {
          throw new KeyNotFound({ key });
        }
        throw new StorageError({ message: `fs get failed for ${key}`, cause: e });
      }
    },
    async delete(key) {
      try {
        rmSync(resolveKey(root, key), { force: true });
      } catch (e) {
        throw new StorageError({ message: `fs delete failed for ${key}`, cause: e });
      }
    },
    async stat(key) {
      try {
        return statSync(resolveKey(root, key)).size;
      } catch {
        return null;
      }
    },
    async list(prefix) {
      const dir = join(root, prefix.replace(/\/$/, ""));
      const out: string[] = [];
      const walk = (rel: string) => {
        let entries: string[];
        try {
          entries = readdirSync(join(root, rel));
        } catch {
          return;
        }
        for (const entry of entries) {
          const child = rel ? `${rel}/${entry}` : entry;
          if (statSync(join(root, child)).isDirectory()) walk(child);
          else out.push(child);
        }
      };
      walk(prefix.replace(/\/$/, ""));
      return out.sort();
    },
  };
}

// Bun.S3Client (bun-types 1.3.14 s3.d.ts). A missing object surfaces as an
// S3Error with "StatusCode" 404 / NoSuchKey — treated as KeyNotFound.
export function createS3Driver(opts: S3StorageOptions): StorageDriver {
  const client = new Bun.S3Client({
    ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
    bucket: opts.bucket,
    region: opts.region,
    accessKeyId: opts.accessKeyId,
    secretAccessKey: opts.secretAccessKey,
  });
  const isNotFound = (e: unknown): boolean => {
    const code = (e as { code?: unknown })?.code;
    const status = (e as { StatusCode?: unknown; statusCode?: unknown })?.StatusCode
      ?? (e as { statusCode?: unknown })?.statusCode;
    const msg = String((e as Error)?.message ?? "");
    return code === "NoSuchKey" || status === 404 || msg.includes("404") || msg.includes("NoSuchKey");
  };
  return {
    async put(key, data) {
      try {
        await client.write(key, data);
      } catch (e) {
        throw new StorageError({ message: `s3 put failed for ${key}`, cause: e });
      }
    },
    async get(key) {
      try {
        const buf = await client.file(key).arrayBuffer();
        return new Uint8Array(buf);
      } catch (e) {
        if (isNotFound(e)) throw new KeyNotFound({ key });
        throw new StorageError({ message: `s3 get failed for ${key}`, cause: e });
      }
    },
    async delete(key) {
      try {
        await client.delete(key);
      } catch (e) {
        throw new StorageError({ message: `s3 delete failed for ${key}`, cause: e });
      }
    },
    async stat(key) {
      try {
        return (await client.stat(key)).size;
      } catch (e) {
        if (isNotFound(e)) return null;
        throw new StorageError({ message: `s3 stat failed for ${key}`, cause: e });
      }
    },
    async list(prefix) {
      try {
        const out: string[] = [];
        let token: string | undefined;
        do {
          const page = await client.list({ prefix, maxKeys: 1000, ...(token !== undefined ? { continuationToken: token } : {}) });
          for (const item of page.contents ?? []) out.push(item.key);
          token = page.isTruncated ? page.nextContinuationToken : undefined;
        } while (token);
        return out.sort();
      } catch (e) {
        throw new StorageError({ message: `s3 list failed under ${prefix}`, cause: e });
      }
    },
  };
}
// R2 binding driver — Workers-only. The binding is provided by workerd via
// the `env.BLOB` binding declared in `wrangler.jsonc`. Mirrors the
// `StorageDriver` interface so callers are driver-agnostic.
export function createR2Driver(opts: R2StorageOptions): StorageDriver {
  const binding = opts.binding;
  return {
    async put(key, data) {
      try {
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
        await binding.put(key, bytes);
      } catch (e) {
        throw new StorageError({ message: `r2 put failed for ${key}`, cause: e });
      }
    },
    async get(key) {
      try {
        const obj = await binding.get(key);
        if (!obj) throw new KeyNotFound({ key });
        return new Uint8Array(await obj.arrayBuffer());
      } catch (e) {
        if (e instanceof KeyNotFound) throw e;
        throw new StorageError({ message: `r2 get failed for ${key}`, cause: e });
      }
    },
    async delete(key) {
      try {
        // R2 delete is idempotent — missing key is a no-op, no exception.
        await binding.delete(key);
      } catch (e) {
        throw new StorageError({ message: `r2 delete failed for ${key}`, cause: e });
      }
    },
    async stat(key) {
      try {
        const head = await binding.head(key);
        return head ? head.size : null;
      } catch (e) {
        throw new StorageError({ message: `r2 stat failed for ${key}`, cause: e });
      }
    },
    async list(prefix) {
      try {
        const out: string[] = [];
        let cursor: string | undefined;
        do {
          const page: R2ListPage = await binding.list({ prefix, ...(cursor !== undefined ? { cursor } : {}) });
          for (const obj of page.objects) out.push(obj.key);
          cursor = page.truncated ? page.cursor : undefined;
        } while (cursor);
        return out.sort();
      } catch (e) {
        throw new StorageError({ message: `r2 list failed under ${prefix}`, cause: e });
      }
    },
  };
}
