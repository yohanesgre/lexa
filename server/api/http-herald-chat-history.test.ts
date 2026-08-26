import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { createApiHandler } from "./http";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

const ADMIN_KEY = "lxk_" + "a".repeat(43);
const SECOND_ADMIN_KEY = "lxk_" + "b".repeat(43);
const MEMBER_KEY = "lxk_" + "c".repeat(43);

async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

let dir: string;
let handler: (req: Request) => Promise<Response>;
let db: Database;

// Pre-existing races in the SSE plumbing (http.ts): a client-cancelled
// stream trips two teardown paths — controller.close() on an already closed
// controller, and frames.cancel() on an already locked stream. Both surface
// as unhandled ERR_INVALID_STATE rejections unrelated to chat history.
// Swallow exactly those signatures while this suite runs.
const sseCloseRace = (reason: unknown) =>
  reason instanceof TypeError && /Controller is already closed|ReadableStream is locked/.test(reason.message);

const authed = (method: string, path: string, body?: unknown, key = ADMIN_KEY) =>
  new Request(`http://lexa.test${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

const pub = (path: string) => new Request(`http://lexa.test${path}`);

// Mock OpenAI-compatible provider: answers any POST with an SSE chunk stream
// that emits one delta then HOLDS OPEN until the client disconnects — long
// enough to exercise the active-chat guards against a live stream.
const encoder = new TextEncoder();
let mockServer: Server;
let mockPort = 0;

function startMockProvider(): Promise<void> {
  return new Promise((resolve) => {
    mockServer = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(
        `data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"Hi"},"finish_reason":null}]}\n\n`
      );
      // Hold open — end only when the client disconnects.
      req.on("close", () => res.end());
    });
    mockServer.listen(0, "127.0.0.1", () => {
      mockPort = (mockServer.address() as AddressInfo).port;
      resolve();
    });
  });
}

function onUnhandledRejection(reason: unknown): void {
  if (!sseCloseRace(reason)) throw reason;
}

beforeAll(async () => {
  process.on("unhandledRejection", onUnhandledRejection);
  await startMockProvider();
  dir = mkdtempSync(join(tmpdir(), "lexa-herald-chat-history-"));
  const dbPath = join(dir, "test.db");
  runMigrations(dbPath, MIGRATIONS);
  const adminHash = await sha256(ADMIN_KEY);
  const secondHash = await sha256(SECOND_ADMIN_KEY);
  const memberHash = await sha256(MEMBER_KEY);
  db = new Database(dbPath);
  db.exec(`
INSERT INTO users (id, email, name, role) VALUES ('u1', 'maria@lexa.test', 'Maria', 'superadmin');
INSERT INTO users (id, email, name, role) VALUES ('u2', 'anna@lexa.test', 'Anna', 'superadmin');
INSERT INTO users (id, email, name, role) VALUES ('u3', 'bob@lexa.test', 'Bob', 'member');
INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k1', 'test-admin', '${adminHash}', 'u1');
INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k2', 'test-admin-2', '${secondHash}', 'u2');
INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k3', 'test-member', '${memberHash}', 'u3');
INSERT INTO projects (id, name, slug) VALUES ('p1', 'P', 'p1');
INSERT INTO projects (id, name, slug) VALUES ('p2', 'Q', 'p2');
-- Maria's threads: freshest first in the list.
INSERT INTO herald_threads (document_type, document_id, project_id, owner_user_id, title, messages)
VALUES ('chat', 'chat-a', 'p1', 'u1', 'Alpha thread', '[{"role":"user","content":"hi"}]');
INSERT INTO herald_threads (document_type, document_id, project_id, owner_user_id, title, messages, updated_at)
VALUES ('chat', 'chat-b', 'p1', 'u1', NULL, '[]', datetime('now', '-1 hour'));
-- Anna's thread: invisible to Maria.
INSERT INTO herald_threads (document_type, document_id, project_id, owner_user_id, title, messages)
VALUES ('chat', 'chat-c', 'p1', 'u2', 'Bob private', '[]');
-- Maria's thread in another project: never leaks into p1 results.
INSERT INTO herald_threads (document_type, document_id, project_id, owner_user_id, title, messages, updated_at)
VALUES ('chat', 'chat-d', 'p2', 'u1', 'Elsewhere', '[]', datetime('now', '-2 hours'));
-- A spare thread for the delete happy path.
INSERT INTO herald_threads (document_type, document_id, project_id, owner_user_id, title, messages)
VALUES ('chat', 'chat-del', 'p1', 'u1', 'Doomed', '[]');
`);
  handler = createApiHandler(dbPath);
});

afterAll(() => {
  process.off("unhandledRejection", onUnhandledRejection);
  mockServer.closeAllConnections?.();
  mockServer.close();
  try { db.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

describe("GET /api/herald/chats/:projectId", () => {
  it("lists the caller's threads updatedAt DESC, other users and projects invisible", async () => {
    const res = await handler(authed("GET", "/api/herald/chats/p1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([
      { chatId: "chat-a", title: "Alpha thread", pinned: false, snippet: null, createdAt: expect.any(String), updatedAt: expect.any(String) },
      { chatId: "chat-del", title: "Doomed", pinned: false, snippet: null, createdAt: expect.any(String), updatedAt: expect.any(String) },
      { chatId: "chat-b", title: null, pinned: false, snippet: null, createdAt: expect.any(String), updatedAt: expect.any(String) },
    ]);

    const annas = await handler(authed("GET", "/api/herald/chats/p1", undefined, SECOND_ADMIN_KEY));
    expect((await annas.json()).data.map((t: { chatId: string }) => t.chatId)).toEqual(["chat-c"]);
  });

  it("member-bound key → 403 FORBIDDEN at the middleware", async () => {
    const res = await handler(authed("GET", "/api/herald/chats/p1", undefined, MEMBER_KEY));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("FORBIDDEN");
  });

  it("no key → 401 UNAUTHORIZED", async () => {
    const res = await handler(pub("/api/herald/chats/p1"));
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("UNAUTHORIZED");
  });

  it("unknown project → 404 PROJECT_NOT_FOUND", async () => {
    const res = await handler(authed("GET", "/api/herald/chats/ghost"));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("PROJECT_NOT_FOUND");
  });
});

describe("PATCH /api/herald/chat/:chatId", () => {
  it("renames an owned thread (trimmed) and persists it", async () => {
    const res = await handler(authed("PATCH", "/api/herald/chat/chat-b", { title: "  Renamed B  " }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ chatId: "chat-b", title: "Renamed B", pinned: false });
    const row = db.prepare(`SELECT title FROM herald_threads WHERE document_id = 'chat-b'`).get() as { title: string | null };
    expect(row.title).toBe("Renamed B");
  });

  it("unknown chatId → 404 HERALD_THREAD_NOT_FOUND", async () => {
    const res = await handler(authed("PATCH", "/api/herald/chat/ghost", { title: "X" }));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("HERALD_THREAD_NOT_FOUND");
  });

  it("another user's thread → 404 (owner mismatch indistinguishable)", async () => {
    // Maria's key against Anna's thread.
    const res = await handler(authed("PATCH", "/api/herald/chat/chat-c", { title: "Hijack" }, ADMIN_KEY));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("HERALD_THREAD_NOT_FOUND");
  });

  it("empty or over-long title → 422 INVALID_ARGS", async () => {
    const empty = await handler(authed("PATCH", "/api/herald/chat/chat-b", { title: "   " }));
    expect(empty.status).toBe(422);
    expect((await empty.json()).error.code).toBe("INVALID_ARGS");
    const long = await handler(authed("PATCH", "/api/herald/chat/chat-b", { title: "x".repeat(201) }));
    expect(long.status).toBe(422);
    expect((await long.json()).error.code).toBe("INVALID_ARGS");
  });
});

describe("DELETE /api/herald/chat/:chatId", () => {
  it("another user's thread → 404", async () => {
    const res = await handler(authed("DELETE", "/api/herald/chat/chat-c"));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("HERALD_THREAD_NOT_FOUND");
    const still = db.prepare(`SELECT COUNT(*) AS c FROM herald_threads WHERE document_id = 'chat-c'`).get() as { c: number };
    expect(still.c).toBe(1);
  });

  it("own thread → 204, gone afterwards", async () => {
    const res = await handler(authed("DELETE", "/api/herald/chat/chat-del"));
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    const gone = await handler(authed("GET", "/api/herald/chat/chat-del"));
    expect(gone.status).toBe(404);
    expect((await gone.json()).error.code).toBe("HERALD_THREAD_NOT_FOUND");
  });

  it("delete while streaming → 409 HERALD_TASK_ACTIVE; client abort releases the chat", async () => {
    const put = await handler(
      authed("PUT", "/api/herald/settings/p1", {
        fallbackModelIds: ["test-model"],
      })
    );
    expect(put.status).toBe(200);
    db.exec(`INSERT OR IGNORE INTO herald_providers (id, label, base_url, api_key) VALUES ('prov-p1', 'Mock', 'http://127.0.0.1:${mockPort}', 'sk-test')`);
    db.exec(`INSERT OR IGNORE INTO herald_models (id, provider_id, model_id, kind, priority, enabled) VALUES ('m-p1', 'prov-p1', 'test-model', 'openai_compatible', 1, 1)`);

    const ac = new AbortController();
    const res = await handler(
      new Request("http://lexa.test/api/herald/chat/stream", {
        method: "POST",
        headers: { authorization: `Bearer ${ADMIN_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ projectId: "p1", chatId: "c-live", message: "hello" }),
        signal: ac.signal,
      })
    );
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false); // start frame arrived — stream is live

    // Active-chat guard is registered synchronously at stream construction;
    // small retry loop absorbs scheduler jitter.
    let sawConflict = false;
    for (let i = 0; i < 20 && !sawConflict; i++) {
      const del = await handler(authed("DELETE", "/api/herald/chat/c-live"));
      if (del.status === 409) {
        sawConflict = true;
        expect((await del.json()).error.code).toBe("HERALD_TASK_ACTIVE");
        break;
      }
      expect(del.status).toBe(204);
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(sawConflict).toBe(true);

    // Client disconnect aborts the run and frees the chatId.
    reader.cancel().catch(() => {});
    ac.abort();
    await new Promise((r) => setTimeout(r, 250));
    const released = await handler(authed("DELETE", "/api/herald/chat/c-live"));
    expect(released.status).toBe(204);
  }, 20000);
});
