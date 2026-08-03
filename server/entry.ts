import { runMigrations } from "./db/migrate";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { Database } from "bun:sqlite";
import { createApiHandler, createWebhookHandler } from "./api/http";
import { createMcpHandler } from "./mcp/server";
import { verifyApiKey } from "./api/auth-key";
import { findOrCreateUser } from "./api/auth";

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
pruneWebhookEvents(DATABASE_PATH);
seedAdminKey(DATABASE_PATH);
// Sample data is the setup wizard's job (CLI `bun run setup` or web `/setup`).
// Boot-time seeding only for explicit dev opt-in (LXK_SEED_DEV=1).
if (process.env.LXK_SEED_DEV === "1") {
  seedDevData(DATABASE_PATH);
}

const apiHandlerRaw = createApiHandler(DATABASE_PATH) as unknown as { handler?: (req: Request) => Promise<Response> } | ((req: Request) => Promise<Response>);
const apiHandler: (req: Request) => Promise<Response> = typeof apiHandlerRaw === "function" ? apiHandlerRaw : apiHandlerRaw.handler!;
const mcpHandler = createMcpHandler(DATABASE_PATH);
const webhookHandler = createWebhookHandler(DATABASE_PATH);

function withSecurityHeaders(res: Response): Response {
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("Cache-Control", "no-store");
  return res;
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/mcp") {
      return withSecurityHeaders(await mcpHandler(req));
    }

    if (url.pathname.startsWith("/api/")) {
      // GitHub webhook: HMAC-SHA-256 is the auth (no API-key middleware),
      // signature verified over the RAW body before any parsing.
      if (url.pathname === "/api/webhooks/github") {
        return withSecurityHeaders(await webhookHandler(req));
      }
      const isSetup = url.pathname.startsWith("/api/setup");
      const isHealth = url.pathname === "/api/health";
      const isForgeDaemon = url.pathname.startsWith("/api/forge/daemon/") || url.pathname.startsWith("/api/forge/runtimes/");
      // Forge daemon endpoints accept the daemon token (LXK_FORGE_DAEMON_TOKEN)
      // in place of the API key — the daemon may hold its own credential.
      const daemonTokenOk = isForgeDaemon && process.env.LXK_FORGE_DAEMON_TOKEN
        ? req.headers.get("x-forge-token") === process.env.LXK_FORGE_DAEMON_TOKEN
        : false;
      if (!isHealth && !isSetup && !daemonTokenOk && !verifyApiKey(req, DATABASE_PATH)) {
        return withSecurityHeaders(new Response(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "Invalid or missing API key" } }), { status: 401, headers: { "Content-Type": "application/json" } }));
      }
      try {
        return withSecurityHeaders(await apiHandler(req));
      } catch (err) {
        console.error("[API] Uncaught:", err);
        return withSecurityHeaders(new Response(JSON.stringify({ error: { code: "INTERNAL", message: err instanceof Error ? err.message : String(err) } }), { status: 500, headers: { "Content-Type": "application/json" } }));
      }
    }

    const user = findOrCreateUser(req, DATABASE_PATH);

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
        return new Response(injected, {
          status: res.status,
          headers: res.headers,
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
</main></body></html>`, { headers: { "Content-Type": "text/html" } });
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
