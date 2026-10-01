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
// cron */15 * * * * in wrangler.jsonc). Non-API GETs: /share/* goes to the
// TanStack Start handler (server-rendered, OG meta); every other route is
// client-only and served the prerendered SPA shell. In source `wrangler dev`
// the Start import is shimmed (Vite-virtuals are unresolvable outside the
// vite build) and non-API routes get the fallback page — the vite workers
// build links the real handler.
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
  DurableObjectNamespace,
  ExecutionContext,
  ExportedHandler,
  KVNamespace,
  R2Bucket,
  Request as WorkersRequest,
  Response as WorkersResponse,
  ScheduledController,
} from "@cloudflare/workers-types";
import { getAgentByName } from "agents";
import { createStartHandler, defaultStreamHandler } from "@tanstack/react-start/server";
import { getEnvFromWorkers, type RuntimeEnv } from "./env";
import { RuntimeEnvLive, RuntimeEnvTag } from "./runtime-env";
import { Db, DbD1Live, RowNotFound, batch as batchStmts, queryFirst, run } from "./db/db";
import { createD1Driver } from "./db/drivers/d1";
import type { DbDriver } from "./db/db";
import {
  d1DatabaseToD1Like,
  mirrorSettingsFromEnvAsync,
  stringEnvFromRuntimeEnv,
} from "./api/workers-ports";
import { createWorkersApiHandler } from "./api/http";
import { createAuth, handleAuthSurface } from "./auth";
import { resolveMaxApiBody } from "./api/limits";
import { syncRateLimitFromDbAsync } from "./api/rate-limit";
import { DEFAULT_MAX_UPLOAD_MB } from "./storage/config";
import type { R2Bucket as NarrowR2Bucket, StorageConfigShape } from "./storage/config";
import { GitHubClient, syncGitHubConfigFromDbAsync } from "./github/client";
import { backfillProviderSecrets } from "./db/provider-secrets-backfill";
import { GitHubService } from "./services/github.service";
import { AuthorizationService } from "./services/authorization.service";
import { capabilitiesFromRuntimeEnv } from "./capabilities";
import {
  ASSISTANT_AGENT_ROUTE_PREFIX,
  INTERNAL_ASSISTANT_ROUTE_PREFIX,
  assistantGateErrorResponse,
  authorizeInternalRequest,
  handleAssistantAgentRequest,
  type AssistantThreadRow,
  type UpsertChatThreadInput,
} from "./assistant/agent-gate";
import { LexaAssistantAgent } from "./assistant/agent";
import { handleInternalAssistantRequest } from "./assistant/internal-routes";
import type { AssistantThreadRpcShape } from "./assistant/thread-rpc";
import type { AssistantThreadType } from "../shared/assistant";

export { LexaAssistantAgent };

type AssistantAgentNamespace = Parameters<typeof getAgentByName>[0];

// DO-backed thread RPC for the REST handlers (ADR-0003 §B.4). Built here (the
// only module allowed to import `agents`) and injected into the shared handler
// factory, which stays `agents`-free. Structure matches the DO's RPC surface
// in `server/assistant/agent.ts`.
function createDoThreadRpc(namespace: AssistantAgentNamespace): AssistantThreadRpcShape {
  interface Stub {
    getTranscript(): Promise<{ messages: unknown[]; summary: string | null; summarizedCount: number | null }>;
    resumeBatch(batchId: string | null): Promise<{ ok: true }>;
    destroyThread(): Promise<{ ok: true }>;
    resetThread(): Promise<{ ok: true }>;
    enqueueRun(projectId: string, taskId: string): Promise<{ ok: true }>;
    abortRun(taskId: string): Promise<{ ok: true }>;
  }
  const stubFor = async (threadKey: string): Promise<Stub> =>
    (await getAgentByName(namespace, threadKey)) as unknown as Stub;
  return {
    available: true,
    getTranscript: async (threadKey) => (await stubFor(threadKey)).getTranscript(),
    resumeBatch: async (threadKey, batchId) => (await stubFor(threadKey)).resumeBatch(batchId),
    destroyThread: async (threadKey) => (await stubFor(threadKey)).destroyThread(),
    resetThread: async (threadKey) => (await stubFor(threadKey)).resetThread(),
    enqueueRun: async (threadKey, projectId, taskId) => (await stubFor(threadKey)).enqueueRun(projectId, taskId),
    abortRun: async (threadKey, taskId) => (await stubFor(threadKey)).abortRun(taskId),
  };
}

export interface WorkersEnv {
  DB?: D1Database;
  ASSISTANT_AGENT?: AssistantAgentNamespace;
  BLOB?: R2Bucket;
  KV?: KVNamespace;
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
          yield* syncGitHubConfigFromDbAsync(driver, runtimeEnv);
          // Per-isolate first request is the Workers "boot": the one-way
          // provider-key backfill runs here, after the DB config sync.
          yield* backfillProviderSecrets(driver, runtimeEnv);
        }).pipe(Effect.catchAll((e) => Effect.sync(() => console.error("[Workers] boot sync failed:", String(e)))))
      );
    })().catch((e) => {
      console.error("[Workers] boot failed:", e instanceof Error ? e.message : String(e));
    });
  }
  return bootPromise;
}

// ─── Assistant gate data access (D1 + authorization) ─────────────────────
// The WS gate (server/assistant/agent-gate.ts) is IO-free; these are the
// dependency-injected implementations it runs in production.

interface AssistantThreadRowRaw {
  document_type: AssistantThreadType;
  document_id: string;
  project_id: string;
  owner_user_id: string | null;
}

async function loadAssistantThread(
  driver: DbDriver,
  documentType: AssistantThreadType,
  documentId: string
): Promise<AssistantThreadRow | null> {
  try {
    const row = await Effect.runPromise(
      queryFirst<AssistantThreadRowRaw>(
        driver,
        `SELECT document_type, document_id, project_id, owner_user_id
         FROM assistant_threads WHERE document_type = ? AND document_id = ?`,
        documentType,
        documentId
      )
    );
    return {
      documentType: row.document_type,
      documentId: row.document_id,
      projectId: row.project_id,
      ownerUserId: row.owner_user_id,
    };
  } catch (e) {
    if (e instanceof RowNotFound) return null;
    throw e;
  }
}

// Connect-upsert for a chat thread with no D1 row (ADR-0003 §B.2). DO NOTHING
// on conflict: project/owner never migrate, and a concurrent insert loses the
// race harmlessly — the gate re-reads and rejects a mismatched owner.
async function upsertChatThread(
  driver: DbDriver,
  input: UpsertChatThreadInput
): Promise<AssistantThreadRow | null> {
  try {
    await Effect.runPromise(
      run(
        driver,
        `INSERT INTO assistant_threads (document_type, document_id, project_id, owner_user_id, messages)
         VALUES ('chat', ?, ?, ?, '[]')
         ON CONFLICT(document_type, document_id) DO NOTHING`,
        input.documentId,
        input.projectId,
        input.ownerUserId
      )
    );
  } catch (e) {
    console.error("[Assistant] chat thread upsert failed:", e instanceof Error ? e.message : String(e));
    return null;
  }
  return loadAssistantThread(driver, "chat", input.documentId);
}

// Project read access via the shared authorization service (same decision as
// the REST middleware). A DB failure is a deny, never a bypass.
async function canReadProject(base: BaseLayers, userId: string, projectId: string): Promise<boolean> {
  const runtime = ManagedRuntime.make(Layer.provide(AuthorizationService.Default, base));
  try {
    const role = await runtime.runPromise(
      Effect.gen(function* () {
        const authz = yield* AuthorizationService;
        return yield* authz.projectAccess(userId, projectId);
      })
    );
    return role !== null;
  } catch (e) {
    console.error("[Assistant] project access check failed:", e instanceof Error ? e.message : String(e));
    return false;
  } finally {
    await runtime.dispose();
  }
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

function getRuntimeAuth(runtimeEnv: RuntimeEnv): { auth: BetterAuthApi } {
  const fingerprint = apiFingerprint(runtimeEnv);
  if (!authCache || authCache.fingerprint !== fingerprint) {
    authCache = { fingerprint, value: createAuth(runtimeEnv) as unknown as { auth: BetterAuthApi } };
  }
  return authCache.value;
}

async function handleApi(
  req: WorkersRequest,
  runtimeEnv: RuntimeEnv,
  driver: DbDriver,
  blob: R2Bucket | undefined,
  threadRpc: AssistantThreadRpcShape | undefined
): Promise<Response> {
  const fingerprint = apiFingerprint(runtimeEnv);
  if (!apiCache || apiCache.fingerprint !== fingerprint) {
    const lexaAuth = getRuntimeAuth(runtimeEnv);
    const handler = createWorkersApiHandler({
      driver,
      runtimeEnv,
      storage: r2StorageConfig(runtimeEnv, blob),
      threadRpc,
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
    ssrFetch ??= createStartHandler(defaultStreamHandler) as unknown as (req: Request) => Promise<Response>;
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

      await ensureBoot(env);
      const { runtimeEnv, driver, base } = requestLayers(env);

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
        // Same /api/auth/* middleware semantics as the Bun host (server/auth.ts):
        // per-IP throttle → body cap → sign-in email limiter → handler.
        const lexaAuth = createAuth(runtimeEnv) as unknown as { auth: BetterAuthApi };
        const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
        const res = await handleAuthSurface(req as unknown as Request, {
          ip,
          handler: (r) => lexaAuth.auth.handler(r),
          maxBodyBytes: resolveMaxApiBody(runtimeEnv),
        });
        return res as unknown as WorkersResponse;
      }
      // Assistant WebSocket gate (ADR-0003 §B.2): session cookie → thread ACL
      // (chat owner / project read) → stripped + HMAC-signed identity headers →
      // forward to the per-thread Durable Object. Mounted BEFORE the general
      // /api handler, whose API-key middleware would 401 the cookie path.
      if (path.startsWith(ASSISTANT_AGENT_ROUTE_PREFIX)) {
        const outcome = await handleAssistantAgentRequest(req as unknown as Request, {
          // Deny on error (middleware convention, server/api/middleware.ts): a
          // thrown session lookup is treated as "no session" → 401, never 500.
          getSession: async (headers) => {
            try {
              return await getRuntimeAuth(runtimeEnv).auth.api.getSession({ headers });
            } catch (e) {
              console.error("[Workers] assistant session lookup failed (deny):", String(e));
              return null;
            }
          },
          loadThread: (documentType, documentId) => loadAssistantThread(driver, documentType, documentId),
          canReadProject: (userId, projectId) => canReadProject(base, userId, projectId),
          upsertChatThread: (input) => upsertChatThread(driver, input),
          masterKey: runtimeEnv.LXK_SECRETS_MASTER_KEY,
        });
        if (outcome.kind === "error") {
          return assistantGateErrorResponse(outcome) as unknown as WorkersResponse;
        }
        if (!env.ASSISTANT_AGENT) {
          return json(
            { error: { code: "ASSISTANT_UNAVAILABLE", message: "Assistant binding missing" } },
            502
          ) as unknown as WorkersResponse;
        }
        // ADR-0003 §B.6: a rejected RPC or DO error is the assistant being
        // unavailable, not a generic Worker 500. Guard the forward so a thrown
        // getAgentByName/fetch still yields the 502 envelope.
        try {
          const agent = await getAgentByName(env.ASSISTANT_AGENT, outcome.threadKey);
          return (await agent.fetch(
            new Request(req as unknown as Request, { headers: outcome.headers })
          )) as unknown as WorkersResponse;
        } catch (e) {
          console.error("[Workers] assistant agent forward failed:", String(e));
          return json(
            { error: { code: "ASSISTANT_UNAVAILABLE", message: "Assistant unavailable" } },
            502
          ) as unknown as WorkersResponse;
        }
      }
      // Internal DO → Worker routes (ADR-0003 §B.2/B.3). The public middleware
      // would demand an API key, so this mount sits before it and accepts only
      // a valid signed identity. Handlers: the D1 transcript read (legacy
      // import) and the per-step mirror write.
      if (path.startsWith(INTERNAL_ASSISTANT_ROUTE_PREFIX)) {
        const outcome = await authorizeInternalRequest(req as unknown as Request, runtimeEnv.LXK_SECRETS_MASTER_KEY);
        if (outcome === "unavailable") {
          return json(
            { error: { code: "ASSISTANT_UNAVAILABLE", message: "Assistant not configured" } },
            502
          ) as unknown as WorkersResponse;
        }
        if (outcome === "unauthorized") {
          return json(
            { error: { code: "NO_USER_CONTEXT", message: "Invalid internal authentication" } },
            401
          ) as unknown as WorkersResponse;
        }
        let body: unknown = null;
        if (req.method === "POST") {
          try {
            body = await req.json();
          } catch {
            body = null;
          }
        }
        const result = await handleInternalAssistantRequest({
          method: req.method,
          path,
          body,
          driver,
        });
        return json(result.body, result.status) as unknown as WorkersResponse;
      }
      if (path.startsWith("/api/")) {
        return (await handleApi(
          req,
          runtimeEnv,
          driver,
          env.BLOB,
          env.ASSISTANT_AGENT ? createDoThreadRpc(env.ASSISTANT_AGENT) : undefined
        )) as unknown as WorkersResponse;
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
