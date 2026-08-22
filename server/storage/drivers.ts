import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Data } from "effect";
import type { S3StorageOptions } from "./config";

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
    endpoint: opts.endpoint ?? undefined,
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
          const page = await client.list({ prefix, maxKeys: 1000, continuationToken: token });
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
