import { runMigrations } from "./db/migrate";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { Database } from "bun:sqlite";
import { createApiHandler, createWebhookHandler, createWebhookVerifier } from "./api/http";
import { createMcpHandler } from "./mcp/server";
import { findOrCreateUser, findOrCreateUserByIdentity, adminEmails } from "./api/auth";
import { verifyAccessAssertion } from "./api/access-auth";
import { getSetting, setSetting } from "./db/settings";
import { apiRateLimiter, isPrivateIp } from "./api/rate-limit";
import { MAX_API_BODY, X_LEXA_REMOTE_IP } from "./api/limits";
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

mkdirSync(dirname(DATABASE_PATH), { recursive: true });

runMigrations(DATABASE_PATH);
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

function withSecurityHeaders(res: Response): Response {
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("Cache-Control", "no-store");
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

    if (url.pathname === "/mcp") {
      // /api rate limiting lives in the HttpApi middleware; /mcp is not
      // HttpApi, so its limiter call stays here (shared bucket).
      const socketIp = server.requestIP(req)?.address;
      const cfIp = req.headers.get("cf-connecting-ip");
      const ip = socketIp && isPrivateIp(socketIp) && cfIp ? cfIp : (socketIp ?? cfIp ?? "unknown");
      if (!apiRateLimiter.check(ip)) {
        const retryAfter = Math.ceil(apiRateLimiter.retryAfterMs(ip) / 1000);
        console.warn(`[API] rate limited ip=${ip} retryAfter=${retryAfter}s`);
        return withSecurityHeaders(
          new Response(JSON.stringify({ error: { code: "RATE_LIMITED", message: "Rate limit exceeded" } }), {
            status: 429,
            headers: { "Content-Type": "application/json", "Retry-After": String(retryAfter) },
          })
        );
      }
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

    // Static assets from dist/client/ — serve before SSR. `..` is rejected
    // (defense in depth; Bun's file.exists already refuses deep traversal).
    if ((url.pathname.startsWith("/assets/") || url.pathname.startsWith("/favicon")) && !url.pathname.includes("..")) {
      const file = Bun.file(`dist/client${url.pathname}`);
      if (await file.exists()) {
        return new Response(file);
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
      // would otherwise carry a stale key).
      if (process.env.LXK_API_KEY && res.headers.get("content-type")?.includes("text/html")) {
        const html = await res.text();
        const userMeta = user
          ? (() => {
              // The serialized JSON goes into a single-quoted attribute: JSON
              // escapes `"` but not `'` — an Access-controlled display name
              // could otherwise break the attribute and inject markup into a
              // page that carries the API key meta (Access user → API-key
              // holder). Escape `&` first so the introduced entities survive;
              // the browser decodes them at attribute-parse time, so the
              // client's JSON.parse still sees the original email/name.
              const userJson = JSON.stringify({ email: user.email, name: user.name })
                .replace(/&/g, "&amp;")
                .replace(/'/g, "&#39;")
                .replace(/</g, "&lt;");
              return `<meta name="lxk-user" content='${userJson}'>`;
            })()
          : "";
        const injected = html.replace(
          "<head>",
          `<head><meta name="lxk-api-key" content="${process.env.LXK_API_KEY}">${userMeta}`
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
<p>MCP: <code>/mcp</code> (streamable HTTP, Bearer key)</p>
</main></body></html>`, { headers: { "Content-Type": "text/html", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
    }
    const filePath = url.pathname;
    const file = Bun.file(`dist/client${filePath}`);
    if (!url.pathname.includes("..") && await file.exists()) {
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
