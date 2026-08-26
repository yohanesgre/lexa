// Cloudflare Workers entry — the workerd handler that the @cloudflare/vite-plugin
// emits as `dist/server/index.js` (see wrangler.jsonc's `main`). Phase 2 only
// proves the bundle is Workers-shaped. Phase 6 fills in the real fetch +
// scheduled handlers that wire D1 / R2 / KV into the per-request runtime.
//
// The stub returns 200 on `/health` so the wrangler dev smoke probe succeeds;
// every other path is a placeholder until Phase 6.
//
// The workerd `Request` and `Response` types are imported by name from
// @cloudflare/workers-types so the lib-checked DOM globals don't conflict.

import type {
  R2Bucket,
  D1Database,
  KVNamespace,
  ExecutionContext,
  ScheduledController,
  ExportedHandler,
  Request as WorkersRequest,
  Response as WorkersResponse,
} from "@cloudflare/workers-types";

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
  LXK_HEARTH_DAEMON_TOKEN?: string;
  LXK_HEARTH_REPO_CAP?: string;
  LXK_BACKUP_ENABLED?: string;
  LXK_BACKUP_RETENTION?: string;
}

const handler: ExportedHandler<WorkersEnv> = {
  async fetch(_req: WorkersRequest, _env: WorkersEnv, _ctx: ExecutionContext): Promise<WorkersResponse> {
    const url = new URL(_req.url);
    if (url.pathname === "/health" || url.pathname === "/api/health") {
      return new Response(JSON.stringify({ ok: true, flavor: "workers" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }) as unknown as WorkersResponse;
    }
    return new Response("Not Found", { status: 404 }) as unknown as WorkersResponse;
  },

  async scheduled(_event: ScheduledController, _env: WorkersEnv, _ctx: ExecutionContext): Promise<void> {
    // Phase 9 wires the prune + backup logic here.
  },
};

export default handler;
