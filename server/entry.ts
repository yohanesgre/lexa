import { runMigrations } from "./db/migrate";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Database } from "bun:sqlite";
import { createApiHandler, createWebhookHandler, createWebhookVerifier } from "./api/http";
import { createMcpHandler } from "./mcp/server";
import { findOrCreateUser, findOrCreateUserByIdentity, adminEmails } from "./api/auth";
import { verifyAccessAssertion } from "./api/access-auth";
import { resolveApiKeyIdentity } from "./api/auth-key";
import { getSetting, setSetting } from "./db/settings";
import { createRateLimiter, isPrivateIp } from "./api/rate-limit";
import type { Server } from "bun";

const MAX_API_BODY = Number(process.env.LXK_MAX_BODY_MB ?? 16) * 1024 * 1024;

let ssrFetch: ((req: Request) => Promise<Response>) | null = null;
try {
  // @ts-expect-error built artifact (vite build emits dist/server/server.js); typed at the cast below
  const mod = await import("../dist/server/server.js");
  ssrFetch = (mod as any).default?.fetch ?? (mod as any).fetch ?? null;
} catch {
  console.warn("SSR handler not available — frontend will use fallback");
}

const PORT = parseInt(process.env.PORT || "3000", 10);
const DATABASE_PATH = process.env.DATABASE_PATH || "/app/data/lexa.db";

mkdirSync(dirname(DATABASE_PATH), { recursive: true });

runMigrations(DATABASE_PATH);
// FTS5 optimize merges deleted-row b-trees; table may be absent on a pre-0001 DB.
try {
  const db = new Database(DATABASE_PATH);
  db.exec("INSERT INTO wiki_fts(wiki_fts) VALUES('optimize')");
  db.close();
} catch {}
pruneWebhookEvents(DATABASE_PATH);
seedAdminKey(DATABASE_PATH);
autoLockSetupIfConfigured(DATABASE_PATH);
setInterval(() => {
  try {
    pruneWebhookEvents(DATABASE_PATH);
  } catch {}
}, 3600_000).unref();
// Sample data is the setup wizard's job (CLI `bun run setup` or web `/setup`).
// Boot-time seeding only for explicit dev opt-in (LXK_SEED_DEV=1).
if (process.env.LXK_SEED_DEV === "1") {
  seedDevData(DATABASE_PATH);
}

if (!process.env.LXK_ACCESS_AUD) {
  console.warn("Access JWT verification disabled (LXK_ACCESS_AUD unset) — Cf-Access-* headers trusted as-is");
}

const apiHandlerRaw = createApiHandler(DATABASE_PATH) as unknown as { handler?: (req: Request) => Promise<Response> } | ((req: Request) => Promise<Response>);
const apiHandler: (req: Request) => Promise<Response> = typeof apiHandlerRaw === "function" ? apiHandlerRaw : apiHandlerRaw.handler!;
const mcpHandler = createMcpHandler(DATABASE_PATH);
const verifyWebhook = createWebhookVerifier(DATABASE_PATH);
const webhookHandler = createWebhookHandler(DATABASE_PATH);
const rateLimiter = createRateLimiter();

function withSecurityHeaders(res: Response): Response {
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("Cache-Control", "no-store");
  return res;
}

function tooLargeResponse(): Response {
  return withSecurityHeaders(new Response(JSON.stringify({ error: { code: "BODY_TOO_LARGE", message: "Request body too large" } }), { status: 413, headers: { "Content-Type": "application/json" } }));
}

// Streams the request body up to maxBytes; ok:false → caller replies 413.
// A missing content-length (chunked) is allowed through but the stream is
// still capped — the total byte count is what matters.
async function readBodyWithLimit(req: Request, maxBytes: number): Promise<{ ok: true; bytes: ArrayBuffer } | { ok: false }> {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > maxBytes) return { ok: false };
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

function constantTimeTokenEqual(a: string, b: string): boolean {
  const hexA = createHash("sha256").update(a).digest("hex");
  const hexB = createHash("sha256").update(b).digest("hex");
  const bufA = Buffer.from(hexA, "hex");
  const bufB = Buffer.from(hexB, "hex");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// Instances configured entirely via env (LXK_ADMIN_EMAILS + a key, no web
// wizard) would leave /api/setup/* key-minting unlocked forever. Lock it at
// boot: setup_complete=1 iff a key exists AND merged admin emails are set.
function autoLockSetupIfConfigured(dbPath: string) {
  const db = new Database(dbPath);
  try {
    if (getSetting(db, "setup_complete") === "1") return;
    const apiKeyCount = (db.prepare("SELECT COUNT(*) c FROM api_keys").get() as { c: number } | null)?.c ?? 0;
    if (apiKeyCount === 0) return;
    if (adminEmails(db).length === 0) return;
    setSetting(db, "setup_complete", "1");
    console.log("Setup auto-locked (configured via env)");
  } finally {
    db.close();
  }
}

const server: Server<unknown> = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    const path = url.pathname;
    const isApiSurface = path === "/mcp" || path.startsWith("/api/");
    if (isApiSurface && !path.startsWith("/api/webhooks/")) {
      const socketIp = server.requestIP(req)?.address;
      const cfIp = req.headers.get("cf-connecting-ip");
      const ip = socketIp && isPrivateIp(socketIp) && cfIp ? cfIp : (socketIp ?? cfIp ?? "unknown");
      if (!rateLimiter.check(ip)) {
        const retryAfter = Math.ceil(rateLimiter.retryAfterMs(ip) / 1000);
        console.warn(`[API] rate limited ip=${ip} retryAfter=${retryAfter}s`);
        return withSecurityHeaders(
          new Response(JSON.stringify({ error: { code: "RATE_LIMITED", message: "Rate limit exceeded" } }), {
            status: 429,
            headers: { "Content-Type": "application/json", "Retry-After": String(retryAfter) },
          })
        );
      }
    }

    if (url.pathname === "/mcp") {
      if (req.method !== "POST") {
        return withSecurityHeaders(new Response(JSON.stringify({ error: { code: "METHOD_NOT_ALLOWED", message: "Only POST is accepted" } }), { status: 405, headers: { "Content-Type": "application/json" } }));
      }
      const read = await readBodyWithLimit(req, MAX_API_BODY);
      if (!read.ok) {
        console.warn(`[MCP] body too large path=${path} declared=${req.headers.get("content-length") ?? "unknown"} bytes`);
        return tooLargeResponse();
      }
      const mcpReq = new Request(req.url, { method: "POST", headers: req.headers, body: read.bytes });
      try {
        return withSecurityHeaders(await mcpHandler(mcpReq));
      } catch (err) {
        console.error("[MCP] Uncaught:", err);
        throw err;
      }
    }

    if (url.pathname.startsWith("/api/")) {
      // GitHub webhook: HMAC-SHA-256 is the auth (no API-key middleware).
      // Signature verified over the RAW body, constant-time, BEFORE any
      // parsing or processing — mismatch → 401. Ack 200 immediately, then
      // the handler processes fire-and-forget in the background.
      if (url.pathname === "/api/webhooks/github") {
        const read = await readBodyWithLimit(req, 1_000_000);
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
      const read = await readBodyWithLimit(req, MAX_API_BODY);
      if (!read.ok) {
        console.warn(`[API] body too large path=${path} declared=${req.headers.get("content-length") ?? "unknown"} bytes`);
        return tooLargeResponse();
      }
      // Reconstruct: the original req's stream is consumed — apiHandler must
      // see the buffered body, not an empty one.
      const apiReq = new Request(req.url, { method: req.method, headers: req.headers, body: read.bytes });
      const isSetup = url.pathname.startsWith("/api/setup");
      const isHealth = url.pathname === "/api/health";
      const isForgeDaemon = url.pathname.startsWith("/api/forge/daemon/") || url.pathname === "/api/forge/runtimes/register";
      // Forge daemon endpoints accept the daemon token (LXK_FORGE_DAEMON_TOKEN)
      // in place of the API key — the daemon may hold its own credential.
      // Constant-time comparison (sha256 digest length is fixed, so
      // timingSafeEqual never sees mismatched buffers).
      const daemonTokenOk = isForgeDaemon && process.env.LXK_FORGE_DAEMON_TOKEN
        ? constantTimeTokenEqual(req.headers.get("x-forge-token") ?? "", process.env.LXK_FORGE_DAEMON_TOKEN)
        : false;
      if (!isHealth && !isSetup && !daemonTokenOk) {
        const authHeader = req.headers.get("Authorization") ?? "";
        const identity = resolveApiKeyIdentity(authHeader, DATABASE_PATH);
        if (!identity) {
          const reason = authHeader.startsWith("Bearer ") ? "unknown key" : "missing or malformed key";
          console.warn(`[Auth] denied path=${path} reason=${reason}`);
          return withSecurityHeaders(new Response(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "Invalid or missing API key" } }), { status: 401, headers: { "Content-Type": "application/json" } }));
        }
        if (identity.userId !== null && identity.role !== "admin") {
          console.warn(`[Auth] denied path=${path} reason=member key`);
          return withSecurityHeaders(new Response(JSON.stringify({ error: { code: "FORBIDDEN", message: "Member API keys are not supported on the REST API yet" } }), { status: 403, headers: { "Content-Type": "application/json" } }));
        }
      }
      try {
        return withSecurityHeaders(await apiHandler(apiReq));
      } catch (err) {
        console.error("[API] Uncaught:", err);
        return withSecurityHeaders(new Response(JSON.stringify({ error: { code: "INTERNAL", message: err instanceof Error ? err.message : String(err) } }), { status: 500, headers: { "Content-Type": "application/json" } }));
      }
    }

    let user: ReturnType<typeof findOrCreateUser>;
    if (process.env.LXK_ACCESS_AUD) {
      const claims = await verifyAccessAssertion(req);
      if (!claims) {
        return withSecurityHeaders(new Response(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "Invalid Access assertion" } }), { status: 401, headers: { "Content-Type": "application/json" } }));
      }
      user = findOrCreateUserByIdentity(claims.email, claims.name, DATABASE_PATH);
    } else {
      user = findOrCreateUser(req, DATABASE_PATH);
    }

    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Static assets from dist/client/ — serve before SSR
    if (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/favicon")) {
      const file = Bun.file(`dist/client${url.pathname}`);
      if (await file.exists()) {
        return new Response(file);
      }
    }

    if (ssrFetch) {
      const res = await ssrFetch(req);
      // Inject the server's current API key into the HTML so the browser can
      // authenticate without a build-time baked key. This keeps :3000 working
      // even after `bun run setup` rotates the key in .env (the built bundle
      // would otherwise carry a stale key).
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
<p>MCP: <code>${url.hostname}:9000</code> (run locally)</p>
</main></body></html>`, { headers: { "Content-Type": "text/html", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
    }
    const filePath = url.pathname;
    const file = Bun.file(`dist/client${filePath}`);
    if (await file.exists()) {
      return new Response(file);
    }

    const index = Bun.file("dist/client/index.html");
    if (await index.exists()) {
      return new Response(index);
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
    } else {
      console.log(`\n⚡ Admin API key created: ${apiKey}\n`);
    }
  } finally {
    db.close();
  }
}

function seedDevData(dbPath: string) {
  const seedFile = join(import.meta.dir, "..", "scripts", "seed-dev.sql");
  if (!existsSync(seedFile)) return;

  const db = new Database(dbPath);
  try {
    const row = db.prepare("SELECT COUNT(*) as cnt FROM projects").get() as { cnt: number } | null;
    if (row && row.cnt > 0) return;

    console.log("Seeding dev data...");
    const sql = readFileSync(seedFile, "utf-8");
    db.exec(sql);
    console.log("Seed complete");
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
