// Cloudflare Workers entry — the workerd handler for the Workers flavor
// (see wrangler.jsonc's `main` and docs/CLOUDFLARE_WORKERS.md). Builds a
// per-request runtime from the workerd `env` binding: D1 over `env.DB`
// (DbD1Live), per-request env (RuntimeEnvLive via getEnvFromWorkers),
// per-request better-auth over D1 (session cookies + invites), and the
// full HttpApi app over the async Db driver (B6).
//
// Routes: /health + /api/health (D1 deep check) + the GitHub webhook route
// (HMAC verify before parse, ack 200 immediately, process in ctx.waitUntil
// — invariants #2/#3/#8) + /api/auth/* (better-auth handler: sign-in,
// session, invite acceptance) + every other /api/* (the full HttpApi app:
// Bearer keys AND session cookies, same middleware order/semantics as the
// Bun host) + scheduled handler (event prune + R2 backup-retention prune,
// cron */15 * * * * in wrangler.jsonc). Non-API GETs go to the TanStack
// Start SSR handler; in source `wrangler dev` that import is shimmed
// (Vite-virtuals are unresolvable outside the vite build) and non-API
// routes get the no-SSR fallback page — the vite workers build links the
// real handler and serves SSR pages (see workers-b6 report).
//
// Workers-only differences (platform, never behavior):
// - GITHUB_PRIVATE_KEY_FILE is impossible (no filesystem): the boot mirror
//   skips the file branch with a warn — set inline GITHUB_PRIVATE_KEY.
// - Session management endpoints (list/revoke login sessions) still hit the
//   Bun singleton and 500 here — session verification, sign-in/out,
//   setAdmin, and invites are D1-native.
// - Backup snapshot creation is impossible in-worker (D1 has no VACUUM
//   INTO, no fs): scheduled only prunes old snapshots by retention.
//   Snapshots come from D1 time-travel (`wrangler d1 time-travel`) or
//   `wrangler d1 export` — operator-run, never built in-worker.

import { Effect, Layer, ManagedRuntime } from "effect";
import type {
  D1Database,
  ExecutionContext,
  ExportedHandler,
  KVNamespace,
  R2Bucket,
  Request as WorkersRequest,
  Response as WorkersResponse,
  ScheduledController,
} from "@cloudflare/workers-types";
import { createStartHandler, defaultStreamHandler } from "@tanstack/react-start/server";
import { getEnvFromWorkers, type RuntimeEnv } from "./env";
import { RuntimeEnvLive, RuntimeEnvTag } from "./runtime-env";
import { Db, DbD1Live, batch as batchStmts, queryFirst } from "./db/db";
import { createD1Driver } from "./db/drivers/d1";
import type { DbDriver } from "./db/db";
import {
  d1DatabaseToD1Like,
  mirrorSettingsFromEnvAsync,
  stringEnvFromRuntimeEnv,
} from "./api/workers-ports";
import { createWorkersApiHandler } from "./api/http";
import { createAuth } from "./auth";
import { syncRateLimitFromDbAsync } from "./api/rate-limit";
import { DEFAULT_MAX_UPLOAD_MB } from "./storage/config";
import type { R2Bucket as NarrowR2Bucket, StorageConfigShape } from "./storage/config";
import { GitHubClient, syncGitHubConfigFromDbAsync } from "./github/client";
import { GitHubService } from "./services/github.service";

export interface WorkersEnv {
  DB?: D1Database;
  BLOB?: R2Bucket;
  KV?: KVNamespace;
  LXK_API_KEY?: string;
  LXK_ENV?: string;
  LXK_PUBLIC_URL?: string;
  LXK_ADMIN_EMAILS?: string;
  CRON_SECRET?: string;
  LXK_STORAGE_DRIVER?: string;
  GITHUB_APP_ID?: string;
  GITHUB_PRIVATE_KEY?: string;
  GITHUB_WEBHOOK_SECRET?: string;
  LXK_TRUSTED_ORIGINS?: string;
  LOG_LEVEL?: string;
  LXK_MAX_BODY_MB?: string;
  LXK_MAX_UPLOAD_MB?: string;
  LXK_RATE_LIMIT_MAX?: string;
  LXK_RATE_LIMIT_WINDOW_MS?: string;
  LXK_HEARTH_DAEMON_TOKEN?: string;
  LXK_HEARTH_REPO_CAP?: string;
  LXK_BACKUP_ENABLED?: string;
  LXK_BACKUP_RETENTION?: string;
}

type BaseLayers = Layer.Layer<Db | RuntimeEnvTag>;

const WEBHOOK_BODY_CAP = 10_000_000;

// ─── Per-isolate boot ────────────────────────────────────────────────────
// No boot phase exists on Workers: the first request (or tick) runs the
// same first-boot sequence the Bun host runs in server/entry.ts — env
// mirror (idempotent: absent keys only), rate-limit sync, GitHub holder
// sync. Concurrent cold-start requests share one boot promise.
let bootPromise: Promise<void> | null = null;

function requestLayers(env: WorkersEnv) {
  const runtimeEnv = getEnvFromWorkers(env as unknown as Record<string, unknown>);
  if (!env.DB) throw new Error("D1 binding missing — [d1_databases] not configured for this worker");
  const like = d1DatabaseToD1Like(env.DB);
  const driver = createD1Driver(like);
  const base: BaseLayers = Layer.mergeAll(DbD1Live(like), RuntimeEnvLive(runtimeEnv));
  return { runtimeEnv, driver, base };
}

function ensureBoot(env: WorkersEnv): Promise<void> {
  if (!bootPromise) {
    bootPromise = (async () => {
      const { runtimeEnv, driver } = requestLayers(env);
      await Effect.runPromise(
        Effect.gen(function* () {
          const mirrored = yield* mirrorSettingsFromEnvAsync(driver, stringEnvFromRuntimeEnv(runtimeEnv));
          if (mirrored.length > 0) console.log(`Settings mirrored from env: ${mirrored.join(", ")}`);
          yield* syncRateLimitFromDbAsync(driver);
          yield* syncGitHubConfigFromDbAsync(driver);
        }).pipe(Effect.catchAll((e) => Effect.sync(() => console.error("[Workers] boot sync failed:", String(e)))))
      );
    })().catch((e) => {
      console.error("[Workers] boot failed:", e instanceof Error ? e.message : String(e));
    });
  }
  return bootPromise;
}

// ─── Response helpers (same envelopes as the Bun host) ───────────────────

function securityHeaders(headers?: HeadersInit): Headers {
  const h = new Headers(headers);
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Cache-Control", "no-store");
  h.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  return h;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: securityHeaders({ "Content-Type": "application/json" }) });
}

// ─── Request routing ───────────────────────────────────────────────────
// /api/auth/* is served by the per-request better-auth handler directly
// (it owns its own cookie auth; the HttpApi middleware would 401 it).
// Every other /api/* goes through the full HttpApi app (B6a Workers
// factory: same groups, async Db, Bearer + session-cookie middleware).
// Non-API routes go to TanStack Start SSR (shimmed in source dev).

type BetterAuthApi = {
  api: {
    getSession: (opts: { headers: Headers }) => Promise<{ user?: { id: string; name: string; role?: string } | null } | null>;
    createUser: (opts: { body: { email: string; password: string; name: string; data: { role: string } } }) => Promise<unknown>;
  };
  handler: (req: Request) => Promise<Response>;
};

function r2StorageConfig(runtimeEnv: RuntimeEnv, blob: R2Bucket | undefined): StorageConfigShape {
  const parsed = Number(runtimeEnv.LXK_MAX_UPLOAD_MB);
  const maxUploadBytes = Math.round(
    (Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_UPLOAD_MB) * 1024 * 1024
  );
  return {
    driver: "r2",
    fsRoot: "",
    s3: null,
    r2: blob ? { binding: blob as unknown as NarrowR2Bucket, bucketName: "lexa-blobs" } : null,
    maxUploadBytes,
  };
}

async function handleApi(
  req: WorkersRequest,
  runtimeEnv: RuntimeEnv,
  driver: DbDriver,
  blob: R2Bucket | undefined
): Promise<Response> {
  const lexaAuth = createAuth(runtimeEnv) as unknown as { auth: BetterAuthApi };
  const handler = createWorkersApiHandler({
    driver,
    runtimeEnv,
    storage: r2StorageConfig(runtimeEnv, blob),
    authHooks: {
      createUser: (input) =>
        lexaAuth.auth.api.createUser({ body: { ...input, data: { role: "superadmin" } } }),
    },
    getSession: (headers) => lexaAuth.auth.api.getSession({ headers }),
  });
  return handler(req as unknown as Request);
}

let ssrFetch: ((req: Request) => Promise<Response>) | null = null;

async function handleSsr(req: WorkersRequest): Promise<Response> {
  try {
    ssrFetch ??= createStartHandler(defaultStreamHandler) as unknown as (req: Request) => Promise<Response>;
    return await ssrFetch(req as unknown as Request);
  } catch (e) {
    console.warn("[Workers] SSR unavailable, serving fallback page:", e instanceof Error ? e.message : String(e));
    return fallbackPage();
  }
}

async function handleWebhook(
  req: WorkersRequest,
  ctx: ExecutionContext,
  base: BaseLayers
): Promise<Response> {
  const headers = new Headers(req.headers as unknown as HeadersInit);
  const rawBody = await req.arrayBuffer();
  if (rawBody.byteLength > WEBHOOK_BODY_CAP) {
    return json({ error: { code: "BODY_TOO_LARGE", message: "Request body too large" } }, 413);
  }
  const signature = headers.get("x-hub-signature-256");
  const verifier = ManagedRuntime.make(Layer.provide(GitHubClient.Default, base));
  let valid = false;
  try {
    valid = await verifier.runPromise(
      Effect.gen(function* () {
        const client = yield* GitHubClient;
        return yield* client.verifyWebhookSignature(rawBody, signature);
      })
    );
  } catch (e) {
    console.error("[Webhook] verifier failed:", e instanceof Error ? e.message : String(e));
  } finally {
    await verifier.dispose();
  }
  if (!valid) {
    console.warn(
      `[Webhook] signature rejected delivery=${headers.get("x-github-delivery") ?? "unknown"} event=${headers.get("x-github-event") ?? "unknown"}`
    );
    return json({ error: { code: "GITHUB_WEBHOOK_ERROR", message: "Invalid signature" } }, 401);
  }
  const deliveryId = headers.get("x-github-delivery") ?? "";
  const event = headers.get("x-github-event") ?? "";
  const text = new TextDecoder().decode(rawBody);
  const runtime = ManagedRuntime.make(Layer.provide(GitHubService.Default, base));
  ctx.waitUntil(
    runtime
      .runPromise(
        Effect.gen(function* () {
          const service = yield* GitHubService;
          const payload = JSON.parse(text) as Parameters<typeof service.handleWebhook>[2];
          yield* service.handleWebhook(deliveryId, event, payload);
        })
      )
      .catch((e) => {
        console.error(`[Webhook] processing failed delivery=${deliveryId} event=${event}:`, e);
      })
      .finally(() => runtime.dispose())
  );
  return json({ ok: true });
}

function fallbackPage(): Response {
  return new Response(
    `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Lexa</title>
<style>body{font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#0f0f0f;color:#e0e0e0}main{max-width:480px;padding:2rem}h1{font-size:2rem;margin:0 0 .5rem}p{color:#888;line-height:1.6}code{background:#1a1a1a;padding:.2em .4em;border-radius:4px}a{color:#6c8aff}</style></head>
<body><main>
<h1>Lexa</h1>
<p>Self-hosted project management for small teams.</p>
<p>API: <a href="/api/health"><code>/api/health</code></a> · <a href="/api/projects"><code>/api/projects</code></a></p>
</main></body></html>`,
    { headers: securityHeaders({ "Content-Type": "text/html" }) }
  );
}

// ─── Scheduled (cron */15 * * * *): prune + backup retention ─────────────
// Same SQL as the Bun host's setInterval prune (server/entry.ts). R2
// retention uses the same stamp scheme as server/storage/backup.ts
// (backups/lexa-<stamp>.db.gz + -blobs/ companions, lexical ==
// chronological); snapshot creation itself is platform-impossible here.

function parseBackupStamp(key: string): string | null {
  const m = /^backups\/lexa-(.+)\.db\.gz$/.exec(key);
  return m ? m[1]! : null;
}

export async function pruneR2Backups(blob: R2Bucket, retention: number): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await blob.list(cursor === undefined ? { prefix: "backups/" } : { prefix: "backups/", cursor });
    for (const o of page.objects) keys.push(o.key);
    if (!page.truncated) break;
    cursor = page.cursor;
  }
  const stamps = Array.from(new Set(keys.map(parseBackupStamp).filter((s): s is string => s !== null)))
    .sort()
    .reverse();
  const doomed = new Set<string>();
  for (const stamp of stamps.slice(retention)) {
    doomed.add(`backups/lexa-${stamp}.db.gz`);
    for (const key of keys) {
      if (key.startsWith(`backups/lexa-${stamp}-blobs/`)) doomed.add(key);
    }
  }
  await Promise.all(Array.from(doomed, (key) => blob.delete(key)));
  return Array.from(doomed).sort();
}

async function runScheduled(env: WorkersEnv): Promise<void> {
  await ensureBoot(env);
  const { runtimeEnv, driver } = requestLayers(env);
  await runScheduledCore(driver, runtimeEnv, env.BLOB);
}

// Exported for tests: the scheduled tick minus boot/env plumbing.
export async function runScheduledCore(
  driver: DbDriver,
  runtimeEnv: RuntimeEnv,
  blob: R2Bucket | undefined
): Promise<void> {
  await Effect.runPromise(
    batchStmts(driver, [
      { sql: "DELETE FROM webhook_events WHERE received_at < datetime('now', '-7 days')", params: [] },
      {
        sql: "DELETE FROM runtime_events WHERE status IN ('completed', 'failed') AND finished_at < datetime('now', '-7 days')",
        params: [],
      },
    ]).pipe(Effect.catchAll((e) => Effect.sync(() => console.error("[Workers] scheduled prune failed:", String(e)))))
  );
  if (runtimeEnv.LXK_BACKUP_ENABLED === "1" && blob) {
    const parsed = Number(runtimeEnv.LXK_BACKUP_RETENTION);
    const retention = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 14;
    try {
      const deleted = await pruneR2Backups(blob, retention);
      if (deleted.length > 0) console.log(`[Workers] backup retention pruned ${deleted.length} key(s)`);
    } catch (e) {
      console.error("[Workers] backup retention prune failed:", e instanceof Error ? e.message : String(e));
    }
  }
}

// ─── Handler ─────────────────────────────────────────────────────────────

const handler: ExportedHandler<WorkersEnv> = {
  async fetch(req: WorkersRequest, env: WorkersEnv, ctx: ExecutionContext): Promise<WorkersResponse> {
    try {
      await ensureBoot(env);
      const { runtimeEnv, driver, base } = requestLayers(env);
      const url = new URL(req.url);
      const path = url.pathname;

      if (path === "/health") {
        return json({ ok: true, flavor: "workers" }) as unknown as WorkersResponse;
      }
      if (path === "/api/health") {
        try {
          await Effect.runPromise(queryFirst<{ one: 1 }>(driver, "SELECT 1 AS one"));
        } catch (e) {
          console.error("[Workers] D1 health check failed:", String(e));
          return json({ ok: false }, 500) as unknown as WorkersResponse;
        }
        return json({ ok: true }) as unknown as WorkersResponse;
      }
      if (path === "/api/webhooks/github") {
        return (await handleWebhook(req, ctx, base)) as unknown as WorkersResponse;
      }
      if (path.startsWith("/api/auth/")) {
        const lexaAuth = createAuth(runtimeEnv) as unknown as { auth: BetterAuthApi };
        return (await lexaAuth.auth.handler(req as unknown as Request)) as unknown as WorkersResponse;
      }
      if (path.startsWith("/api/")) {
        return (await handleApi(req, runtimeEnv, driver, env.BLOB)) as unknown as WorkersResponse;
      }
      return (await handleSsr(req)) as unknown as WorkersResponse;
    } catch (e) {
      console.error("[Workers] fetch failed:", e instanceof Error ? e.message : String(e));
      return json({ error: { code: "INTERNAL", message: "Internal error" } }, 500) as unknown as WorkersResponse;
    }
  },

  async scheduled(_event: ScheduledController, env: WorkersEnv, _ctx: ExecutionContext): Promise<void> {
    try {
      await runScheduled(env);
    } catch (e) {
      console.error("[Workers] scheduled failed:", e instanceof Error ? e.message : String(e));
    }
  },
};

export default handler;
