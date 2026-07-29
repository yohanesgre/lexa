import { runMigrations } from "./db/migrate";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { Database } from "bun:sqlite";
import { createApiHandler } from "./api/http";
import { verifyApiKey } from "./api/auth-key";
import { findOrCreateUser } from "./api/auth";

let ssrFetch: ((req: Request) => Promise<Response>) | null = null;
try {
  const mod = await import("../dist/server/server.js");
  ssrFetch = (mod as any).default?.fetch ?? (mod as any).fetch ?? null;
} catch {
  console.warn("SSR handler not available — frontend will use fallback");
}

const PORT = parseInt(process.env.PORT || "3000", 10);
const DATABASE_PATH = process.env.DATABASE_PATH || "/app/data/lexa.db";

mkdirSync(dirname(DATABASE_PATH), { recursive: true });

runMigrations(DATABASE_PATH);
seedAdminKey(DATABASE_PATH);
seedDevData(DATABASE_PATH);

const apiHandlerRaw = createApiHandler(DATABASE_PATH) as unknown as { handler?: (req: Request) => Promise<Response> } | ((req: Request) => Promise<Response>);
const apiHandler: (req: Request) => Promise<Response> = typeof apiHandlerRaw === "function" ? apiHandlerRaw : apiHandlerRaw.handler!;

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname.startsWith("/api/")) {
      if (url.pathname !== "/api/health" && !verifyApiKey(req, DATABASE_PATH)) {
        return new Response(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "Invalid or missing API key" } }), { status: 401, headers: { "Content-Type": "application/json" } });
      }
      return apiHandler(req);
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
      return ssrFetch(req);
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
  const db = new Database(dbPath);
  try {
    const row = db.prepare("SELECT COUNT(*) as cnt FROM projects").get() as { cnt: number } | null;
    if (row && row.cnt > 0) return;

    const projId = crypto.randomUUID();
    db.prepare("INSERT INTO projects (id, name, slug, description) VALUES (?, ?, ?, ?)")
      .run(projId, "Emberfall", "emberfall", "Demo project for local development");

    const cols = ["Backlog", "To Do", "In Progress", "Review", "Done"];
    cols.forEach((name, i) => {
      db.prepare("INSERT INTO columns (id, project_id, name, position, color, wip_limit) VALUES (?, ?, ?, ?, ?, ?)")
        .run(crypto.randomUUID(), projId, name, i, "#6b7280", name === "Done" || name === "In Progress" ? 5 : null);
    });

    const lanes = ["Art", "Code", "Design"];
    lanes.forEach((name, i) => {
      db.prepare("INSERT INTO swimlanes (id, project_id, name, position) VALUES (?, ?, ?, ?)")
        .run(crypto.randomUUID(), projId, name, i);
    });

    console.log("Seeded dev data: project 'emberfall', 5 columns, 3 swimlanes");
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
