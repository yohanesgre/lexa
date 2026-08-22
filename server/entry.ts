import { runMigrations } from "./db/migrate";
import { backfillTaskKeys } from "./db/task-keys-backfill";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { Database } from "bun:sqlite";
import { createApiHandler, createWebhookHandler, createWebhookVerifier } from "./api/http";
import { getSetting, setSetting, mirrorSettingsFromEnv } from "./db/settings";
import { syncRateLimitFromDb } from "./api/rate-limit";
import { syncGitHubConfigFromDb } from "./github/client";
import { MAX_API_BODY, X_LEXA_REMOTE_IP } from "./api/limits";
import { bodyCapFor, resolveStorageConfig } from "./storage/config";
import { runBackup, createBackupDriver, DEFAULT_BACKUP_RETENTION } from "./storage/backup";
import { auth, loginLimiter, authIpLimiter } from "./auth";
import type { Server } from "bun";

let ssrFetch: ((req: Request) => Promise<Response>) | null = null;
try {
  // @ts-expect-error built artifact (vite build emits dist/server/server.js); typed at the cast below
  const mod = (await import("../dist/server/server.js")) as unknown as {
    default?: { fetch?: (req: Request) => Promise<Response> };
    fetch?: (req: Request) => Promise<Response>;
  };
  ssrFetch = mod.default?.fetch ?? mod.fetch ?? null;
} catch {
  console.warn("SSR handler not available — frontend will use fallback");
}

const rawPort = Number(process.env.PORT ?? 3000);
const PORT = Number.isInteger(rawPort) && rawPort > 0 ? rawPort : 3000;
if (PORT !== rawPort) console.warn(`Invalid PORT (${process.env.PORT}) — falling back to ${PORT}`);
const DATABASE_PATH = process.env.DATABASE_PATH || "/app/data/lexa.db";
const STORAGE_CFG = resolveStorageConfig(process.env, dirname(DATABASE_PATH));

mkdirSync(dirname(DATABASE_PATH), { recursive: true });

runMigrations(DATABASE_PATH);
// The settings DB is the single source of truth at runtime. Env is a
// first-boot bootstrap only: mirror it into the DB once (when keys are
// empty), THEN apply the DB-configured rate limits + GitHub credentials.
{
  const db = new Database(DATABASE_PATH);
  try {
    const mirrored = mirrorSettingsFromEnv(db, process.env, (p) => readFileSync(p, "utf8"));
    if (mirrored.length > 0) {
      console.log(`Settings mirrored from env: ${mirrored.join(", ")}`);
    }
    syncRateLimitFromDb(db);
    syncGitHubConfigFromDb(db);
  } finally {
    db.close();
  }
}
// FTS5 optimize merges deleted-row b-trees; table may be absent on a pre-0001 DB.
try {
  const db = new Database(DATABASE_PATH);
  db.exec("INSERT INTO wiki_fts(wiki_fts) VALUES('optimize')");
  db.close();
} catch {}
pruneWebhookEvents(DATABASE_PATH);
pruneRuntimeEvents(DATABASE_PATH);
seedAdminKey(DATABASE_PATH);
autoLockSetupIfConfigured(DATABASE_PATH);
setInterval(() => {
  try {
    pruneWebhookEvents(DATABASE_PATH);
    pruneRuntimeEvents(DATABASE_PATH);
  } catch {}
}, 3600_000).unref();
// DB backups (docs/BACKUPS.md): snapshot + gzip + blob-dir copy into the
// storage driver under backups/, retention-pruned. Opt-in via env; runs once
// at boot then every 24h. Failures never crash the server.
if (process.env.LXK_BACKUP_ENABLED === "1") {
  const backupDriver = createBackupDriver(STORAGE_CFG);
  const parsedRetention = Number(process.env.LXK_BACKUP_RETENTION);
  const retention =
    Number.isFinite(parsedRetention) && parsedRetention > 0
      ? Math.floor(parsedRetention)
      : DEFAULT_BACKUP_RETENTION;
  const runBackupSafe = () => {
    runBackup(DATABASE_PATH, STORAGE_CFG, backupDriver, { retention }).then(
      ({ key }) => console.log(`[Backup] wrote ${key}`),
      (e) => console.error("[Backup] failed:", e instanceof Error ? e.message : String(e))
    );
  };
  void runBackupSafe();
  setInterval(runBackupSafe, 24 * 3600_000).unref();
}
// Sample data is the setup wizard's job (CLI `bun run setup` or web `/setup`).
// Boot-time seeding only for explicit dev opt-in (LXK_SEED_DEV=1).
if (process.env.LXK_SEED_DEV === "1") {
  void seedDevData(DATABASE_PATH);
}
// Task ticket keys: backfill legacy + seeded rows (idempotent, NULL-only).
// Runs after seeding so dev sample data gets keys too.
{
  const db = new Database(DATABASE_PATH);
  try {
    backfillTaskKeys(db);
  } finally {
    db.close();
  }
}

const apiHandlerRaw = createApiHandler(DATABASE_PATH) as unknown as { handler?: (req: Request) => Promise<Response> } | ((req: Request) => Promise<Response>);
const apiHandler: (req: Request) => Promise<Response> = typeof apiHandlerRaw === "function" ? apiHandlerRaw : apiHandlerRaw.handler!;
const verifyWebhook = createWebhookVerifier(DATABASE_PATH);
const webhookHandler = createWebhookHandler(DATABASE_PATH);

function withSecurityHeaders(res: Response): Response {
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("Cache-Control", "no-store");
  res.headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  return res;
}

function tooLargeResponse(): Response {
  return withSecurityHeaders(new Response(JSON.stringify({ error: { code: "BODY_TOO_LARGE", message: "Request body too large" } }), { status: 413, headers: { "Content-Type": "application/json" } }));
}

// Streams the request body up to maxBytes; ok:false → caller replies 413.
// The declared content-length pre-check lives in the HttpApi middleware — here
// the stream itself is capped (chunked/CL-less bodies can't bypass the cap).
async function readBodyWithLimit(req: Request, maxBytes: number): Promise<{ ok: true; bytes: ArrayBuffer } | { ok: false }> {
  const reader = req.body?.getReader();
  if (!reader) return { ok: true, bytes: new ArrayBuffer(0) };
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) return { ok: false };
      chunks.push(value);
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes: out.buffer as ArrayBuffer };
}

// Instances configured entirely via env (LXK_ADMIN_EMAILS + a key, no web
// wizard) would leave /api/setup/* key-minting unlocked forever. Lock it at
// boot: setup_complete=1 iff a key exists AND a superadmin account exists.
// (LXK_ADMIN_EMAILS alone no longer counts — the superadmin password can only
// be set through the web wizard, so it must stay open until the account is
// created; the allow-list gates who may become superadmin.)
function autoLockSetupIfConfigured(dbPath: string) {
  const db = new Database(dbPath);
  try {
    if (getSetting(db, "setup_complete") === "1") return;
    const apiKeyCount = (db.prepare("SELECT COUNT(*) c FROM api_keys").get() as { c: number } | null)?.c ?? 0;
    if (apiKeyCount === 0) return;
    const superadminCount = (db.prepare("SELECT COUNT(*) c FROM users WHERE role = 'superadmin'").get() as { c: number } | null)?.c ?? 0;
    if (superadminCount === 0) return;
    setSetting(db, "setup_complete", "1");
    console.log("Setup auto-locked (configured via env)");
  } finally {
    db.close();
  }
}

const server: Server<unknown> = Bun.serve({
  port: PORT,
  // SSE streams go quiet between provider frames and heartbeats (15s) —
  // Bun's 10s default idle timeout would kill them mid-flight.
  idleTimeout: 60,
  async fetch(req) {
    const url = new URL(req.url);

    const path = url.pathname;

    if (url.pathname.startsWith("/api/")) {
      // Better Auth — mounted BEFORE the API-key middleware. The auth handler
      // is its own auth: keyless by design (session cookies). The keyless
      // surface still gets the per-IP throttle + body cap (unbounded JSON
      // parse + scrypt cost must not bypass the /api limits).
      if (url.pathname.startsWith("/api/auth/")) {
        const socketIp = server.requestIP(req)?.address ?? "";
        const ip = req.headers.get("cf-connecting-ip") || socketIp || "unknown";
        const ipVerdict = authIpLimiter(ip);
        if (!ipVerdict.ok) {
          return withSecurityHeaders(
            new Response(JSON.stringify({ error: { code: "RATE_LIMITED", message: "Too many requests — try again later" } }), {
              status: 429,
              headers: { "Content-Type": "application/json", "Retry-After": String(ipVerdict.retryAfterSec) },
            })
          );
        }
        const read = await readBodyWithLimit(req, MAX_API_BODY);
        if (!read.ok) {
          console.warn(`[Auth] body too large path=${path} declared=${req.headers.get("content-length") ?? "unknown"} bytes`);
          return tooLargeResponse();
        }
        const authReq = new Request(req.url, {
          method: req.method,
          headers: req.headers,
          // Never attach an empty body to bodyless requests — better-call
          // treats a present-but-empty body as a body and 415s GETs (e.g.
          // get-session) for missing Content-Type.
          body: req.body ? read.bytes : undefined,
        });
        // Login rate limiting (R17): 5 failed attempts / 60s per email, then
        // a 15-minute lockout — small in-process limiter (1.6.27 has no
        // rateLimit plugin; memory storage is fine for the single server
        // process). Counted on sign-in only; successes reset the budget.
        if (url.pathname === "/api/auth/sign-in/email" && req.method === "POST") {
          let email = "";
          try {
            email = String(((await authReq.clone().json()) as { email?: unknown })?.email ?? "");
          } catch {}
          if (email) {
            const verdict = loginLimiter.check(email);
            if (!verdict.ok) {
              return withSecurityHeaders(
                new Response(
                  JSON.stringify({ error: { code: "RATE_LIMITED", message: "Too many login attempts — try again later" } }),
                  { status: 429, headers: { "Content-Type": "application/json", "Retry-After": String(verdict.retryAfterSec) } }
                )
              );
            }
            const res = await auth.handler(authReq);
            if (res.status === 401) loginLimiter.recordFailure(email);
            else if (res.status === 200) loginLimiter.recordSuccess(email);
            return withSecurityHeaders(res);
          }
        }
        return withSecurityHeaders(await auth.handler(authReq));
      }
      // GitHub webhook: HMAC-SHA-256 is the auth (no API-key middleware).
      // Signature verified over the RAW body, constant-time, BEFORE any
      // parsing or processing — mismatch → 401. Ack 200 immediately, then
      // the handler processes fire-and-forget in the background.
      if (url.pathname === "/api/webhooks/github") {
        const read = await readBodyWithLimit(req, 10_000_000);
        if (!read.ok) {
          console.warn(`[Webhook] body too large path=${path} declared=${req.headers.get("content-length") ?? "unknown"} bytes`);
          return tooLargeResponse();
        }
        const rawBody = read.bytes;
        const signature = req.headers.get("x-hub-signature-256");
        const valid = await verifyWebhook(rawBody, signature);
        if (!valid) {
          console.warn(`[Webhook] signature rejected delivery=${req.headers.get("x-github-delivery") ?? "unknown"} event=${req.headers.get("x-github-event") ?? "unknown"}`);
          return withSecurityHeaders(
            new Response(JSON.stringify({ error: { code: "GITHUB_WEBHOOK_ERROR", message: "Invalid signature" } }), { status: 401, headers: { "Content-Type": "application/json" } })
          );
        }
        return withSecurityHeaders(webhookHandler(rawBody, req.headers.get("x-github-delivery") ?? "", req.headers.get("x-github-event") ?? ""));
      }
      // Stream-cap every other /api body — a chunked/CL-less request must not
      // bypass the cap (/api/setup/* is an unauthenticated surface).
      // Attachment-upload paths get the raised upload cap (route enforces the
      // exact per-file limit afterwards).
      const read = await readBodyWithLimit(req, bodyCapFor(path, STORAGE_CFG, MAX_API_BODY));
      if (!read.ok) {
        console.warn(`[API] body too large path=${path} declared=${req.headers.get("content-length") ?? "unknown"} bytes`);
        return tooLargeResponse();
      }
      // Reconstruct: the original req's stream is consumed — apiHandler must
      // see the buffered body, not an empty one. signal is forwarded so SSE
      // handlers observe client disconnects.
      const apiReq = new Request(req.url, { method: req.method, headers: req.headers, body: read.bytes, signal: req.signal });
      // The middleware resolves the caller IP from this header (socket IPs are
      // only visible here). Delete any inbound value first so clients can't
      // spoof a fresh bucket.
      const socketIp = server.requestIP(req)?.address ?? "";
      if (apiReq.headers.has(X_LEXA_REMOTE_IP)) apiReq.headers.delete(X_LEXA_REMOTE_IP);
      apiReq.headers.set(X_LEXA_REMOTE_IP, socketIp);
      try {
        // Security headers are applied by the HttpApi middleware; the
        // middleware also covers router 404s and its own short-circuits.
        return await apiHandler(apiReq);
      } catch (err) {
        console.error("[API] Uncaught:", err);
        return withSecurityHeaders(new Response(JSON.stringify({ error: { code: "INTERNAL", message: "Internal error" } }), { status: 500, headers: { "Content-Type": "application/json" } }));
      }
    }

    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Static assets from dist/client/ — serve before SSR. `..` is rejected
    // (defense in depth; Bun's file.exists already refuses deep traversal).
    if ((url.pathname.startsWith("/assets/") || url.pathname.startsWith("/favicon")) && !url.pathname.includes("..")) {
      const file = Bun.file(`dist/client${url.pathname}`);
      if (await file.exists()) {
        return new Response(file, { headers: { "X-Content-Type-Options": "nosniff", "Strict-Transport-Security": "max-age=31536000; includeSubDomains" } });
      }
    }

    if (ssrFetch) {
      let res: Response;
      try {
        res = await ssrFetch(req);
      } catch (err) {
        console.error("[SSR] Uncaught:", err);
        return withSecurityHeaders(new Response("Internal error", { status: 500, headers: { "Content-Type": "text/plain" } }));
      }
      // Inject the server's current API key into the HTML so the browser can
      // authenticate without a build-time baked key. This keeps :3000 working
      // even after `bun run setup` rotates the key in .env (the built bundle
      // would otherwise carry a stale key). (The x-lxk-user / lxk-logout meta
      // tags are removed with the Cloudflare Access flow — browser identity
      // comes from the session cookie.)
      if (process.env.LXK_API_KEY && res.headers.get("content-type")?.includes("text/html")) {
        const html = await res.text();
        const injected = html.replace(
          "<head>",
          `<head><meta name="lxk-api-key" content="${process.env.LXK_API_KEY}">`
        );
        // The key-bearing page must never be cached (browser or CDN).
        const injectedHeaders = new Headers(res.headers);
        injectedHeaders.set("Cache-Control", "no-store");
        injectedHeaders.set("X-Content-Type-Options", "nosniff");
        return new Response(injected, {
          status: res.status,
          headers: injectedHeaders,
        });
      }
      return res;
    }
    if (url.pathname === "/") {
      return new Response(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Lexa</title>
<style>body{font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#0f0f0f;color:#e0e0e0}main{max-width:480px;padding:2rem}h1{font-size:2rem;margin:0 0 .5rem}p{color:#888;line-height:1.6}code{background:#1a1a1a;padding:.2em .4em;border-radius:4px}a{color:#6c8aff}</style></head>
<body><main>
<h1>Lexa</h1>
<p>Self-hosted project management for small teams.</p>
<p>API: <a href="/api/health"><code>/api/health</code></a> · <a href="/api/projects"><code>/api/projects</code></a></p>
</main></body></html>`, { headers: { "Content-Type": "text/html", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
    }
    const filePath = url.pathname;
    const file = Bun.file(`dist/client${filePath}`);
    if (!url.pathname.includes("..") && await file.exists()) {
      return new Response(file, { headers: { "X-Content-Type-Options": "nosniff", "Strict-Transport-Security": "max-age=31536000; includeSubDomains" } });
    }

    const index = Bun.file("dist/client/index.html");
    if (await index.exists()) {
      return withSecurityHeaders(new Response(index));
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`Lexa running on http://0.0.0.0:${PORT}`);

function pruneWebhookEvents(dbPath: string) {
  const db = new Database(dbPath);
  try {
    db.exec("DELETE FROM webhook_events WHERE received_at < datetime('now', '-7 days')");
  } finally {
    db.close();
  }
}

function pruneRuntimeEvents(dbPath: string) {
  const db = new Database(dbPath);
  try {
    // Terminal-state setup events older than 7 days. Pending/claimed events
    // stay: a claimed event is reclaimable for 2 minutes after a crash.
    db.exec("DELETE FROM runtime_events WHERE status IN ('completed', 'failed') AND finished_at < datetime('now', '-7 days')");
  } finally {
    db.close();
  }
}

function seedAdminKey(dbPath: string) {
  const db = new Database(dbPath);
  try {
    const row = db.prepare("SELECT COUNT(*) as cnt FROM api_keys").get() as { cnt: number } | null;
    if (row && row.cnt > 0) return;

    const apiKey = process.env.LXK_API_KEY || generateRawKey();
    const keyHash = createHash("sha256").update(apiKey).digest("hex");
    const id = crypto.randomUUID();

    db.prepare("INSERT INTO api_keys (id, name, key_hash, user_id) VALUES (?, ?, ?, ?)")
      .run(id, "admin", keyHash, null);

    if (process.env.LXK_API_KEY) {
      console.log(`Seeded admin API key from LXK_API_KEY`);
    } else if (process.stdout.isTTY) {
      // Interactive boot only — container logs must not persist the raw key.
      console.log(`\n⚡ Admin API key created: ${apiKey}\n`);
    } else {
      console.log("Admin API key generated — set LXK_API_KEY for non-interactive boots (key not printed to logs)");
    }
  } finally {
    db.close();
  }
}

async function seedDevAccounts(db: Database): Promise<void> {
  // The SQL seed inserts users directly (no Better Auth account rows), so
  // they cannot sign in. Provision credential accounts for every seed user
  // with the documented dev password. Idempotent: skip users that already
  // have a credential account (re-running the seed must not clobber a
  // password the developer changed).
  const { hashPassword } = await import("better-auth/crypto");
  const rows = db
    .query("SELECT u.id, u.email FROM users u WHERE u.email LIKE '%@lexa.local'")
    .all() as { id: string; email: string }[];
  const missing = rows.filter((u) => !db.prepare("SELECT 1 FROM account WHERE providerId = 'credential' AND userId = ?").get(u.id));
  if (missing.length === 0) return;
  // All dev accounts get the same password — hash once, reuse for every row.
  const password = await hashPassword("password123");
  const insert = db.prepare(
    `INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt)
     VALUES (?, ?, 'credential', ?, ?, datetime('now'), datetime('now'))`
  );
  for (const u of missing) {
    insert.run(crypto.randomUUID(), u.id, u.id, password);
  }
  console.log(`Seeded ${missing.length} dev login account(s) (password: password123)`);
}

async function seedDevData(dbPath: string) {
  const seedFile = join(import.meta.dir, "..", "scripts", "seed-dev.sql");
  if (!existsSync(seedFile)) return;

  const db = new Database(dbPath);
  try {
    const row = db.prepare("SELECT COUNT(*) as cnt FROM projects").get() as { cnt: number } | null;
    if (!(row && row.cnt > 0)) {
      console.log("Seeding dev data...");
      const sql = readFileSync(seedFile, "utf-8");
      db.exec(sql);
      console.log("Seed complete");
    }
    // Provision login accounts for seed users even when the SQL seed was
    // skipped (existing dev DB): idempotent, never clobbers existing
    // passwords.
    await seedDevAccounts(db);
  } catch (err) {
    console.error("Seed failed:", (err as Error).message);
  } finally {
    db.close();
  }
}

function generateRawKey(): string {
  const raw = randomBytes(32);
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  let value = 0n;
  for (const b of raw) value = (value << 8n) | BigInt(b);
  let result = "";
  const base = 62n;
  while (value > 0n) { result = chars[Number(value % base)] + result; value /= base; }
  while (result.length < 43) result = chars[0] + result;
  return `lxk_${result}`;
}
