// Cloudflare Workers entry — the workerd handler for the Workers flavor
// (see wrangler.jsonc's `main` and docs/CLOUDFLARE_WORKERS.md). Builds a
// per-isolate runtime from the workerd `env` binding (rebuilt only when the
// env fingerprint changes): D1 over `env.DB` (DbD1Live), env
// (RuntimeEnvLive via getEnvFromWorkers), better-auth over D1 (session
// cookies + invites), and the full HttpApi app over the async Db driver (B6).
//
// Routes: /health + /api/health (D1 deep check) + the GitHub webhook route
// (HMAC verify before parse, ack 200 immediately, process in ctx.waitUntil
// — invariants #2/#3/#8) + /api/auth/* (better-auth handler: sign-in,
// session, invite acceptance) + every other /api/* (the full HttpApi app:
// Bearer keys AND session cookies, same middleware order/semantics as the
// Bun host) + scheduled handler (event prune + R2 backup-retention prune,
// cron `*/15 * * * *` in wrangler.jsonc; the assistant schedule drain that once
// rode this cron is gone — ADR-0005 D2). Non-API GETs: /share/* goes to the
// TanStack Start handler (server-rendered, OG meta); every other route is
// client-only and served the prerendered SPA shell. In source `wrangler dev`
// the Start import is shimmed (Vite-virtuals are unresolvable outside the
// vite build) and non-API routes get the fallback page — the vite workers
// build links the real handler.
//
// Workers-only differences (platform, never behavior):
// - Legacy GITHUB_* bindings are ignored with a boot warn: GitHub config is
//   written only by the web app (Settings → Workspace → Integrations).
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
import { getEnvFromWorkers, legacyGithubEnvVars, type RuntimeEnv } from "./env";
import { RuntimeEnvLive, RuntimeEnvTag } from "./runtime-env";
import { Db, DbD1Live, batch as batchStmts, queryFirst, run } from "./db/db";
import { createD1Driver } from "./db/drivers/d1";
import type { DbDriver } from "./db/db";
import {
  d1DatabaseToD1Like,
  mirrorSettingsFromEnvAsync,
  stringEnvFromRuntimeEnv,
} from "./api/workers-ports";
import { createWorkersApiHandler } from "./api/assistant-api";
import { createAuth, handleAuthSurface } from "./auth";
import { resolveMaxApiBody } from "./api/limits";
import { syncRateLimitFromDbAsync } from "./api/rate-limit";
import { DEFAULT_MAX_UPLOAD_MB } from "./storage/config";
import type { R2Bucket as NarrowR2Bucket, StorageConfigShape } from "./storage/config";
import { GitHubClient, syncGitHubConfigFromDbAsync } from "./github/client";
import { backfillProviderSecrets } from "./db/provider-secrets-backfill";
import { GitHubService } from "./services/github.service";
import { capabilitiesFromRuntimeEnv } from "./capabilities";
import { sweepStaleAssistantTasks } from "./assistant/stale-runs";

export interface WorkersEnv {
  DB?: D1Database;
  BLOB?: R2Bucket;
  KV?: KVNamespace;
  LXK_ENV?: string;
  LXK_PUBLIC_URL?: string;
  LXK_ADMIN_EMAILS?: string;
  CRON_SECRET?: string;
  LXK_STORAGE_DRIVER?: string;
  LXK_TRUSTED_ORIGINS?: string;
  LOG_LEVEL?: string;
  LXK_MAX_BODY_MB?: string;
  LXK_MAX_UPLOAD_MB?: string;
  LXK_RATE_LIMIT_MAX?: string;
  LXK_RATE_LIMIT_WINDOW_MS?: string;
  LXK_ASSISTANT_REPO_CAP?: string;
  // Managed secrets: the AES-GCM envelope key pair shared by MCP tokens,
  // provider keys, and Jev. Optional — an unset active key disables managed
  // secrets and leaves env:/file: refs as-is.
  LXK_SECRETS_MASTER_KEY?: string;
  LXK_SECRETS_MASTER_KEY_PREV?: string;
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

function buildRequestLayers(env: WorkersEnv, runtimeEnv: RuntimeEnv) {
  if (!env.DB) throw new Error("D1 binding missing — [d1_databases] not configured for this worker");
  const like = d1DatabaseToD1Like(env.DB);
  const driver = createD1Driver(like);
  const base: BaseLayers = Layer.mergeAll(DbD1Live(like), RuntimeEnvLive(runtimeEnv));
  return { runtimeEnv, driver, base };
}

// Same isolate-stability contract as apiCache/getRuntimeAuth below: bindings
// and env vars don't change within an isolate, so build the layers once per
// env fingerprint. Construction is synchronous at first use and memoized
// before any query runs, so no async lazy-layer promise can be left pending
// and wedge the isolate (docs/CLOUDFLARE_WORKERS.md).
let requestLayersCache: { fingerprint: string; value: ReturnType<typeof buildRequestLayers> } | null = null;

export function requestLayers(env: WorkersEnv) {
  const runtimeEnv = getEnvFromWorkers(env as unknown as Record<string, unknown>);
  const fingerprint = apiFingerprint(runtimeEnv);
  if (!requestLayersCache || requestLayersCache.fingerprint !== fingerprint) {
    requestLayersCache = { fingerprint, value: buildRequestLayers(env, runtimeEnv) };
  }
  return requestLayersCache.value;
}

// Test-only: drop the per-isolate caches so a test can observe a rebuild.
export function resetRequestLayersCache(): void {
  requestLayersCache = null;
}

function ensureBoot(env: WorkersEnv): Promise<void> {
  if (!bootPromise) {
    bootPromise = (async () => {
      const legacyGithub = legacyGithubEnvVars(env as unknown as Record<string, string | undefined>);
      if (legacyGithub.length > 0) {
        console.warn(`[GitHub] legacy env config ignored (${legacyGithub.join(", ")}) — configure GitHub sync in Settings → Workspace → Integrations → GitHub Sync`);
      }
      const { runtimeEnv, driver } = requestLayers(env);
      await Effect.runPromise(
        Effect.gen(function* () {
          const mirrored = yield* mirrorSettingsFromEnvAsync(driver, stringEnvFromRuntimeEnv(runtimeEnv));
          if (mirrored.length > 0) console.log(`Settings mirrored from env: ${mirrored.join(", ")}`);
          yield* syncRateLimitFromDbAsync(driver);
          yield* syncGitHubConfigFromDbAsync(driver, runtimeEnv);
          // Per-isolate first request is the Workers "boot": the one-way
          // provider-key backfill runs here, after the DB config sync.
          yield* backfillProviderSecrets(driver, runtimeEnv);
        }).pipe(Effect.catchAll((e) => Effect.sync(() => console.error("[Workers] boot sync failed:", String(e)))))
      );
      // Boot-time stale assistant-task sweep (ADR-0005 §Reliability backstop):
      // fail `assistant_tasks` rows stranded `running` by a crash/eviction so
      // reset/resume is never blocked. Fire-and-forget — never blocks boot.
      void Effect.runPromise(sweepStaleAssistantTasks(driver))
        .then(({ failed }) => {
          if (failed > 0) console.log(`[Assistant] failed ${failed} stale running task(s)`);
        })
        .catch((e) => console.error("[Assistant] stale-task sweep failed:", e instanceof Error ? e.message : String(e)));
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
// /api/auth/* is served by the per-isolate better-auth handler directly
// (it owns its own cookie auth; the HttpApi middleware would 401 it).
// Every other /api/* goes through the full HttpApi app (B6a Workers
// factory: same groups, async Db, Bearer + session-cookie middleware).
// Non-API routes: /share/* goes to the TanStack Start server handler
// (server-rendered); every other route is client-only and served the
// prerendered SPA shell (shimmed in source dev).

type BetterAuthApi = {
  api: {
    getSession: (opts: { headers: Headers }) => Promise<{ user?: { id: string; name: string; role?: string } | null } | null>;
    createUser: (opts: { body: { email: string; password: string; name: string; data: { role: string } } }) => Promise<unknown>;
    listSessions: (opts: { headers: Headers }) => Promise<ReadonlyArray<{ id: string; token: string; ipAddress?: string | null; userAgent?: string | null; expiresAt: string | Date; createdAt: string | Date }>>;
    revokeSession: (opts: { body: { token: string }; headers: Headers }) => Promise<unknown>;
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

// The full API stack (better-auth + service graph + web handler) is
// isolate-stable: bindings and env vars don't change within an isolate.
// Rebuilding it per request costs tens of ms of CPU — far over the free
// plan's 10ms budget. Cache on first build; a changed env fingerprint
// (redeploy/new isolate) rebuilds once.
let apiCache: { fingerprint: string; handler: (req: Request) => Promise<Response> } | null = null;

function apiFingerprint(runtimeEnv: RuntimeEnv): string {
  return JSON.stringify([runtimeEnv.LXK_ENV ?? "", runtimeEnv.LXK_PUBLIC_URL ?? ""]);
}

// better-auth is isolate-stable the same way the API stack is: build once per
// env fingerprint. Shared by the REST handler and the assistant WS gate so the
// session call is byte-for-byte the one the API middleware uses.
let authCache: { fingerprint: string; value: { auth: BetterAuthApi } } | null = null;

export function getRuntimeAuth(runtimeEnv: RuntimeEnv): { auth: BetterAuthApi } {
  const fingerprint = apiFingerprint(runtimeEnv);
  if (!authCache || authCache.fingerprint !== fingerprint) {
    authCache = { fingerprint, value: createAuth(runtimeEnv) as unknown as { auth: BetterAuthApi } };
  }
  return authCache.value;
}

// Test-only: drop the per-isolate auth cache so a test can observe a rebuild.
export function resetAuthCache(): void {
  authCache = null;
}

async function handleApi(
  req: WorkersRequest,
  runtimeEnv: RuntimeEnv,
  driver: DbDriver,
  blob: R2Bucket | undefined
): Promise<Response> {
  const fingerprint = apiFingerprint(runtimeEnv);
  if (!apiCache || apiCache.fingerprint !== fingerprint) {
    const lexaAuth = getRuntimeAuth(runtimeEnv);
    const handler = createWorkersApiHandler({
      driver,
      runtimeEnv,
      storage: r2StorageConfig(runtimeEnv, blob),
      authHooks: {
        createUser: (input) =>
          lexaAuth.auth.api.createUser({ body: { ...input, data: { role: "superadmin" } } }),
        listSessions: (headers) => lexaAuth.auth.api.listSessions({ headers }),
        revokeSession: ({ token, headers }) => lexaAuth.auth.api.revokeSession({ body: { token }, headers }),
      },
      getSession: (headers) => lexaAuth.auth.api.getSession({ headers }),
    });
    apiCache = { fingerprint, handler };
  }
  return apiCache.handler(req as unknown as Request);
}

let ssrFetch: ((req: Request) => Promise<Response>) | null = null;

// TanStack Start's server handler is needed only for /share/* SSR (and the
// non-share shell fallback). Lazy-loaded so `@tanstack/react-start/server`
// stays off the per-request static import graph; promise-memo per module,
// reset on rejection so a failed import can retry (same pattern as
// tiktoken.ts).
type StartServerModule = typeof import("@tanstack/react-start/server");

let startServerModule: Promise<StartServerModule> | null = null;

function importStartServer(): Promise<StartServerModule> {
  startServerModule ??= import("@tanstack/react-start/server").catch((e: unknown) => {
    startServerModule = null;
    throw e;
  });
  return startServerModule;
}

// Non-share HTML: the prerendered SPA shell. Fetched once per isolate from the
// static-assets binding when present (asset hit — assets are served before the
// worker, so this does not recurse), then patched per response. When the
// binding is absent or the fetch fails, callers fall back to handleSsr (the
// Start handler emits the full root document for client-only routes).
let shellHtml: string | null = null;
let shellUnavailable = false;

export function injectEntryScript(html: string): string {
  if (/<script[^>]+type="module"/.test(html)) return html;
  const entry = html.match(/src:"(\/assets\/index-[^"]+\.js)"/)?.[1];
  if (!entry) return html;
  return `${html}<script type="module" async src="${entry}"></script>`;
}

interface AssetsFetcher {
  fetch(input: Request | string): Promise<Response>;
}

async function getShellHtml(env: WorkersEnv, req: WorkersRequest): Promise<string | null> {
  if (shellHtml !== null || shellUnavailable) return shellHtml;
  const assets = (env as { ASSETS?: AssetsFetcher }).ASSETS;
  if (!assets) {
    shellUnavailable = true;
    return null;
  }
  try {
    const res = await assets.fetch(new Request(new URL("/_shell.html", req.url).toString()));
    if (!res.ok) {
      shellUnavailable = true;
      return null;
    }
    shellHtml = injectEntryScript(await res.text());
    return shellHtml;
  } catch (e) {
    console.warn("[Workers] shell asset fetch failed:", e instanceof Error ? e.message : String(e));
    shellUnavailable = true;
    return null;
  }
}

async function handleNonShare(req: WorkersRequest, env: WorkersEnv): Promise<Response> {
  const shell = await getShellHtml(env, req);
  if (shell !== null) {
    return new Response(shell, {
      status: 200,
      headers: securityHeaders({ "Content-Type": "text/html; charset=utf-8" }),
    });
  }
  return handleSsr(req);
}

async function handleSsr(req: WorkersRequest): Promise<Response> {
  try {
    if (ssrFetch === null) {
      const { createStartHandler, defaultStreamHandler } = await importStartServer();
      ssrFetch = createStartHandler(defaultStreamHandler) as unknown as (req: Request) => Promise<Response>;
    }
    const res = await ssrFetch(req as unknown as Request);
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("text/html")) return res;
    // Per response — never a module-global cache: a share SSR document must not
    // be served to a non-share route (or vice versa).
    const patched = injectEntryScript(await res.text());
    const headers = new Headers(res.headers);
    headers.delete("content-length");
    headers.set("Cache-Control", "no-store");
    headers.set("X-Content-Type-Options", "nosniff");
    return new Response(patched, { status: res.status, headers });
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
  // One ManagedRuntime per delivery: verify and process share a single Layer
  // build, disposed once in the waitUntil's finally. Never cached across
  // deliveries — the webhook config holder is mutable so a Settings save
  // applies without a rebuild.
  const runtime = ManagedRuntime.make(
    Layer.provide(Layer.merge(GitHubClient.Default, GitHubService.Default), base)
  );
  let valid = false;
  try {
    valid = await runtime.runPromise(
      Effect.gen(function* () {
        const client = yield* GitHubClient;
        return yield* client.verifyWebhookSignature(rawBody, signature);
      })
    );
  } catch (e) {
    console.error("[Webhook] verifier failed:", e instanceof Error ? e.message : String(e));
  }
  if (!valid) {
    await runtime.dispose();
    console.warn(
      `[Webhook] signature rejected delivery=${headers.get("x-github-delivery") ?? "unknown"} event=${headers.get("x-github-event") ?? "unknown"}`
    );
    return json({ error: { code: "GITHUB_WEBHOOK_ERROR", message: "Invalid signature" } }, 401);
  }
  const deliveryId = headers.get("x-github-delivery") ?? "";
  const event = headers.get("x-github-event") ?? "";
  const text = new TextDecoder().decode(rawBody);
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
// Same SQL as the Bun host's setInterval prune (server/entry.ts):
// webhook_events older than 7 days + device_login_requests past expires_at.
// R2 retention uses the same stamp scheme as server/storage/backup.ts
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

// ADR-0005 D2: scheduled assistant runs are dropped. The retired DO executor
// was the only consumer of `assistant_schedules`; the tables and REST CRUD stay
// inert. This tick keeps the platform prune + backup retention only.
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
      { sql: "DELETE FROM device_login_requests WHERE expires_at < datetime('now')", params: [] },
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
      const url = new URL(req.url);
      const path = url.pathname;

      // Capability discovery (ADR-0003 §B.4): unauthenticated, no DB read, and
      // served BEFORE boot — a probe must not pay the first-request sync cost.
      if (path === "/api/capabilities") {
        return json(
          capabilitiesFromRuntimeEnv("workers", getEnvFromWorkers(env as unknown as Record<string, unknown>))
        ) as unknown as WorkersResponse;
      }

      // Health probes are served BEFORE boot: requestLayers is memoized per
      // env fingerprint and independent of bootPromise, and /api/health's D1
      // deep check needs no boot state — a probe must not queue behind the
      // four sequential first-request D1 syncs in ensureBoot.
      if (path === "/health") {
        return json({ ok: true, flavor: "workers" }) as unknown as WorkersResponse;
      }
      if (path === "/api/health") {
        const { driver } = requestLayers(env);
        try {
          await Effect.runPromise(queryFirst<{ one: 1 }>(driver, "SELECT 1 AS one"));
        } catch (e) {
          console.error("[Workers] D1 health check failed:", String(e));
          return json({ ok: false }, 503) as unknown as WorkersResponse;
        }
        return json({ ok: true }) as unknown as WorkersResponse;
      }

      await ensureBoot(env);
      const { runtimeEnv, driver, base } = requestLayers(env);

      if (path === "/api/webhooks/github") {
        return (await handleWebhook(req, ctx, base)) as unknown as WorkersResponse;
      }
      if (path.startsWith("/api/auth/")) {
        // Same /api/auth/* middleware semantics as the Bun host (server/auth.ts):
        // per-IP throttle → body cap → sign-in email limiter → handler. The
        // better-auth instance is the cached per-isolate one; `ip` and the body
        // cap stay per request.
        const lexaAuth = getRuntimeAuth(runtimeEnv);
        const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
        const res = await handleAuthSurface(req as unknown as Request, {
          ip,
          handler: (r) => lexaAuth.auth.handler(r),
          maxBodyBytes: resolveMaxApiBody(runtimeEnv),
        });
        return res as unknown as WorkersResponse;
      }
      // ADR-0005 W6: the assistant runs in-process through the HttpApi app
      // below — no WebSocket gate, no `/api/internal/assistant/*` HMAC surface,
      // no Durable Object. The DO modules are deleted.
      if (path.startsWith("/api/")) {
        return (await handleApi(req, runtimeEnv, driver, env.BLOB)) as unknown as WorkersResponse;
      }
      // Only /share/* is server-rendered; every other route is client-only and
      // served the prerendered SPA shell (per-response entry-script patch).
      if (path.startsWith("/share/")) {
        return (await handleSsr(req)) as unknown as WorkersResponse;
      }
      return (await handleNonShare(req, env)) as unknown as WorkersResponse;
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
