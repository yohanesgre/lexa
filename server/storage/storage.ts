import { Context, Effect } from "effect";
import { StorageConfigShape } from "./config";
import { createFsDriver, createR2Driver, createS3Driver, KeyNotFound, StorageError } from "./drivers";

export { KeyNotFound, StorageError };
export type { StorageDriver } from "./drivers";

// Content-addressed key for attachment blobs — global by sha256.
export function storageKeyFor(sha256: string): string {
  return `blobs/${sha256}`;
}

export class StorageConfig extends Context.Tag("Lexa/StorageConfig")<StorageConfig, StorageConfigShape>() {}

export class Storage extends Effect.Service<Storage>()("Lexa/Storage", {
  effect: Effect.gen(function* () {
    const cfg = yield* StorageConfig;
    const driver = cfg.driver === "r2" && cfg.r2 ? createR2Driver(cfg.r2) : cfg.driver === "s3" && cfg.s3 ? createS3Driver(cfg.s3) : createFsDriver(cfg.fsRoot);
    return {
      put: (key: string, data: Uint8Array): Effect.Effect<void, StorageError> =>
        Effect.tryPromise({
          try: () => driver.put(key, data),
          catch: (e) => (e instanceof StorageError ? e : new StorageError({ message: `put failed for ${key}`, cause: e })),
        }),
      get: (key: string): Effect.Effect<Uint8Array, StorageError | KeyNotFound> =>
        Effect.tryPromise({
          try: () => driver.get(key),
          catch: (e) => {
            if (e instanceof KeyNotFound) return e;
            if (e instanceof StorageError) return e;
            return new StorageError({ message: `get failed for ${key}`, cause: e });
          },
        }),
      delete: (key: string): Effect.Effect<void, StorageError> =>
        Effect.tryPromise({
          try: () => driver.delete(key),
          catch: (e) => (e instanceof StorageError ? e : new StorageError({ message: `delete failed for ${key}`, cause: e })),
        }),
      stat: (key: string): Effect.Effect<number | null, StorageError> =>
        Effect.tryPromise({
          try: () => driver.stat(key),
          catch: (e) => (e instanceof StorageError ? e : new StorageError({ message: `stat failed for ${key}`, cause: e })),
        }),
      list: (prefix: string): Effect.Effect<string[], StorageError> =>
        Effect.tryPromise({
          try: () => driver.list(prefix),
          catch: (e) => (e instanceof StorageError ? e : new StorageError({ message: `list failed under ${prefix}`, cause: e })),
        }),
    };
  }),
}) {}
