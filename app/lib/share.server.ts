import { Effect, Layer, ManagedRuntime } from "effect";
import { DbBunLive, DbD1Live } from "../../server/db/db";
import type { D1Like } from "../../server/db/drivers/d1";
import { WikiShareService } from "../../server/services/wiki-share.service";
import { getEnv, resolveDatabasePath, RUNTIME_IS_WORKERS } from "../../server/env";
import type { SharedTree } from "./share";

// Server-only share read. Resolves the token through WikiShareService directly
// (Effect runtime) — no HTTP hop. The old server branch self-fetched
// /api/share/:token with an origin guess, which cannot work on Workers (no
// request URL to derive an origin) and is wasteful on Bun.
//
// Flavor-selected live layer (same shape as the API entry points):
//   Bun     → bun:sqlite at DATABASE_PATH (WAL, second connection to the same
//             file is safe alongside server/entry.ts)
//   Workers → the D1 binding, read from the workerd `cloudflare:workers`
//             module (canonical per docs/CLOUDFLARE_WORKERS.md §TanStack Start)
// The runtime is built once per isolate/process and reused.

type ShareRuntime = ManagedRuntime.ManagedRuntime<WikiShareService, never>;

let runtimePromise: Promise<ShareRuntime> | null = null;

async function getWorkersD1(): Promise<D1Like | null> {
  try {
    // Variable-held specifier: the Bun build must never try to resolve
    // `cloudflare:workers`; workerd resolves it at runtime.
    const pkg = "cloudflare:workers";
    const mod = (await import(/* @vite-ignore */ pkg)) as { env?: { DB?: D1Like } };
    return mod.env?.DB ?? null;
  } catch {
    return null;
  }
}

async function buildRuntime(): Promise<ShareRuntime> {
  if (RUNTIME_IS_WORKERS) {
    const d1 = await getWorkersD1();
    if (!d1) throw new Error("D1 binding unavailable for share SSR");
    return ManagedRuntime.make(WikiShareService.Default.pipe(Layer.provide(DbD1Live(d1))));
  }
  const sqlitePkg = "bun:sqlite";
  const { Database } = (await import(/* @vite-ignore */ sqlitePkg)) as typeof import("bun:sqlite");
  const db = new Database(resolveDatabasePath(getEnv()));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  return ManagedRuntime.make(WikiShareService.Default.pipe(Layer.provide(DbBunLive(db))));
}

async function getRuntime(): Promise<ShareRuntime> {
  if (!runtimePromise) {
    runtimePromise = buildRuntime().catch((e: unknown) => {
      // Bindings are isolate-stable, but don't poison the cache on a transient
      // build failure — let the next request retry.
      runtimePromise = null;
      throw e;
    });
  }
  return runtimePromise;
}

export async function fetchSharedTreeServer(token: string): Promise<SharedTree | null> {
  try {
    const runtime = await getRuntime();
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const service = yield* WikiShareService;
        return yield* service.resolvePublic(token);
      }).pipe(Effect.either)
    );
    if (result._tag === "Left") return null;
    return result.right as SharedTree;
  } catch {
    return null;
  }
}
