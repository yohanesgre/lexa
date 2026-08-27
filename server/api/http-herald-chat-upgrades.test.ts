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

const authed = (method: string, path: string, body?: unknown, key = ADMIN_KEY) =>
  new Request(`http://lexa.test${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

// Holding provider: one delta chunk, never finishes — keeps a chat active.
let holdServer: Server;
let holdPort = 0;
// Completing provider: delta + finish_reason stop + [DONE] — run completes
// and the terminal persist lands.
let doneServer: Server;
let donePort = 0;

const sseChunk = (delta: unknown, finish: string | null) =>
  `data: ${JSON.stringify({
    id: "1",
    object: "chat.completion.chunk",
    created: 1,
    model: "m",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;

function startServer(mode: "hold" | "complete"): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(sseChunk({ role: "assistant", content: "Hi" }, null));
      if (mode === "complete") {
        res.write(sseChunk({}, "stop"));
        res.write("data: [DONE]\n\n");
        res.end();
      }
      // hold: keep the socket open; node ends it when the client disconnects.
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: (server.address() as AddressInfo).port });
    });
  });
}

// Parse the SSE wire (`event: <type>\ndata: <json>\n\n`) into frame objects.
async function readSseFrames(res: Response, until?: string): Promise<Array<Record<string, unknown>>> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const frames: Array<Record<string, unknown>> = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dataLine = chunk.split("\n").find((l) => l.startsWith("data: "));
        if (!dataLine) continue;
        frames.push(JSON.parse(dataLine.slice(6)));
      }
      if (until && frames.some((f) => f.type === until)) break;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return frames;
}

beforeAll(async () => {
  const hold = await startServer("hold");
  holdServer = hold.server;
  holdPort = hold.port;
  const done = await startServer("complete");
  doneServer = done.server;
  donePort = done.port;

  dir = mkdtempSync(join(tmpdir(), "lexa-herald-chat-upgrades-"));
  const dbPath = join(dir, "test.db");
  runMigrations(dbPath, MIGRATIONS);
  const adminHash = await sha256(ADMIN_KEY);
  const secondHash = await sha256(SECOND_ADMIN_KEY);
  db = new Database(dbPath);
  db.exec(`
INSERT INTO users (id, email, name, role) VALUES ('u1', 'maria@lexa.test', 'Maria', 'superadmin');
INSERT INTO users (id, email, name, role) VALUES ('u2', 'anna@lexa.test', 'Anna', 'superadmin');
INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k1', 'test-admin', '${adminHash}', 'u1');
INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k2', 'test-admin-2', '${secondHash}', 'u2');
INSERT INTO projects (id, name, slug) VALUES ('p1', 'P', 'p1');
INSERT INTO projects (id, name, slug) VALUES ('p2', 'Q', 'p2');
-- Edit-flow fixture: [u0, a0, u1, a1].
INSERT INTO herald_threads (document_type, document_id, project_id, owner_user_id, title, messages)
VALUES ('chat', 'chat-edit', 'p2', 'u1', 'Edit me', '[{"role":"user","content":"q0"},{"role":"assistant","content":"a0"},{"role":"user","content":"q1"},{"role":"assistant","content":"a1"}]');
-- Retry-after-error fixture: [user, failed assistant].
INSERT INTO herald_threads (document_type, document_id, project_id, owner_user_id, title, messages)
VALUES ('chat', 'chat-err', 'p2', 'u1', 'Broken turn', '[{"role":"user","content":"hi"},{"role":"assistant","content":"","error":{"code":"HERALD_GENERATION_FAILED","message":"boom"}}]');
-- Export fixture with per-entry meta.
INSERT INTO herald_threads (document_type, document_id, project_id, owner_user_id, title, messages)
VALUES ('chat', 'chat-x', 'p1', 'u1', NULL, '[{"role":"user","content":"What is Lexa?","ts":"2026-08-22T10:00:00.000Z"},{"role":"assistant","content":"A project tool.","ts":"2026-08-22T10:00:05.000Z","citations":[{"title":"Lexa Docs","url":"https://lexa.example/guide"},{"title":null,"url":"https://raw.example/x"}]},{"role":"user","content":"continue"},{"role":"assistant","content":"par","error":{"code":"HERALD_GENERATION_FAILED","message":"boom"}}]');
-- List fixtures: pinned beats recency.
INSERT INTO herald_threads (document_type, document_id, project_id, owner_user_id, title, pinned, messages, updated_at)
VALUES ('chat', 'chat-pin', 'p1', 'u1', 'Old but pinned', 1, '[]', datetime('now', '-3 hours'));
INSERT INTO herald_threads (document_type, document_id, project_id, owner_user_id, title, messages, updated_at)
VALUES ('chat', 'chat-z', 'p1', 'u1', 'Unrelated', '[{"role":"user","content":"the needle in transcript"}]', datetime('now', '-2 hours'));
INSERT INTO herald_threads (document_type, document_id, project_id, owner_user_id, title, messages, updated_at)
VALUES ('chat', 'chat-rec', 'p1', 'u1', 'Recency', '[]', datetime('now', '-1 hour'));
-- Anna's thread: invisible to Maria.
INSERT INTO herald_threads (document_type, document_id, project_id, owner_user_id, title, messages)
VALUES ('chat', 'chat-u2', 'p1', 'u2', 'Anna private', '[]');
`);
  handler = createApiHandler(dbPath);
});

afterAll(() => {
  holdServer.closeAllConnections?.();
  holdServer.close();
  doneServer.closeAllConnections?.();
  doneServer.close();
  try { db.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

describe("GET /api/herald/chats/:projectId (q + pinned ordering)", () => {
  it("pins first, then recency; other users invisible", async () => {
    const res = await handler(authed("GET", "/api/herald/chats/p1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.map((t: { chatId: string }) => t.chatId)).toEqual([
      "chat-pin",
      "chat-x",
      "chat-rec",
      "chat-z",
    ]);
    expect(body.data[0]!.pinned).toBe(true);
    expect(body.data[1]!.pinned).toBe(false);

    const annas = await handler(authed("GET", "/api/herald/chats/p1", undefined, SECOND_ADMIN_KEY));
    expect((await annas.json()).data.map((t: { chatId: string }) => t.chatId)).toEqual(["chat-u2"]);
  });

  it("?q= matches transcript text and returns a snippet window", async () => {
    const res = await handler(authed("GET", "/api/herald/chats/p1?q=needle"));
    const body = await res.json();
    expect(body.data.map((t: { chatId: string }) => t.chatId)).toEqual(["chat-z"]);
    expect(body.data[0]!.snippet).toBe("the needle in transcript");
  });

  it("?q= title-only match → snippet null", async () => {
    const res = await handler(authed("GET", "/api/herald/chats/p1?q=Recency"));
    const body = await res.json();
    expect(body.data.map((t: { chatId: string }) => t.chatId)).toEqual(["chat-rec"]);
    expect(body.data[0]!.snippet).toBeNull();
  });
});

describe("PATCH /api/herald/chat/:chatId (meta)", () => {
  it("pins and unpins; persists", async () => {
    const pin = await handler(authed("PATCH", "/api/herald/chat/chat-rec", { pinned: true }));
    expect(pin.status).toBe(200);
    expect(await pin.json()).toEqual({ chatId: "chat-rec", title: "Recency", pinned: true });
    const row = db.prepare(`SELECT pinned FROM herald_threads WHERE document_id = 'chat-rec'`).get() as { pinned: number };
    expect(row.pinned).toBe(1);
    const unpin = await handler(authed("PATCH", "/api/herald/chat/chat-rec", { pinned: false }));
    expect((await unpin.json()).pinned).toBe(false);
  });

  it("updates title and pinned together", async () => {
    const res = await handler(authed("PATCH", "/api/herald/chat/chat-rec", { title: "  Renamed Rec  ", pinned: true }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ chatId: "chat-rec", title: "Renamed Rec", pinned: true });
  });

  it("empty payload or blank/over-long title → 422 INVALID_ARGS", async () => {
    for (const payload of [{}, { title: "   " }, { title: "x".repeat(201) }]) {
      const res = await handler(authed("PATCH", "/api/herald/chat/chat-rec", payload));
      expect(res.status).toBe(422);
      expect((await res.json()).error.code).toBe("INVALID_ARGS");
    }
  });
});

describe("GET /api/herald/chat/:chatId/export", () => {
  it("renders markdown attachment with template markers; untitled → chat-<date>.md", async () => {
    const res = await handler(authed("GET", "/api/herald/chat/chat-x/export"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    const day = db.prepare(`SELECT updated_at FROM herald_threads WHERE document_id = 'chat-x'`).get() as { updated_at: string };
    const stamp = day.updated_at.slice(0, 10).replaceAll("-", "");
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="chat-${stamp}.md"`);
    const md = await res.text();
    expect(md.startsWith("# chat\n")).toBe(true);
    expect(md).toContain("**You** · 2026-08-22T10:00:00.000Z\nWhat is Lexa?");
    expect(md).toContain("**Herald** · 2026-08-22T10:00:05.000Z\nA project tool.");
    expect(md).toContain("- [Lexa Docs](https://lexa.example/guide)");
    expect(md).toContain("- <https://raw.example/x>");
    expect(md).toContain("[failed turn: HERALD_GENERATION_FAILED]");
  });

  it("titled thread sanitizes into the filename and header", async () => {
    await handler(authed("PATCH", "/api/herald/chat/chat-x", { title: "My Chat!" }));
    const res = await handler(authed("GET", "/api/herald/chat/chat-x/export"));
    const disposition = res.headers.get("content-disposition")!;
    expect(disposition).toMatch(/^attachment; filename="My-Chat-\d{8}\.md"$/);
    expect((await res.text()).startsWith("# My Chat!\n")).toBe(true);
  });

  it("another user's thread → 404 HERALD_THREAD_NOT_FOUND", async () => {
    const res = await handler(authed("GET", "/api/herald/chat/chat-x/export", undefined, SECOND_ADMIN_KEY));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("HERALD_THREAD_NOT_FOUND");
  });
});

describe("POST /api/herald/chat/stream (fromIndex)", () => {
  it("edit flow: truncates to fromIndex, appends the new turn, persists ts meta", async () => {
    const put = await handler(
      authed("PUT", "/api/herald/settings/p2", {
        fallbackModelIds: ["test-model"],
      })
    );
    expect(put.status).toBe(200);
    db.exec(`INSERT OR IGNORE INTO herald_providers (id, label, base_url, api_key) VALUES ('prov-p2', 'MockDone', 'http://127.0.0.1:${donePort}', 'sk-test')`);
    db.exec(`INSERT OR IGNORE INTO herald_models (id, provider_id, model_id, kind, priority, enabled) VALUES ('m-p2', 'prov-p2', 'test-model', 'openai_compatible', 1, 1)`);

    const res = await handler(
      authed("POST", "/api/herald/chat/stream", {
        projectId: "p2",
        chatId: "chat-edit",
        message: "edited q1",
        fromIndex: 2,
      })
    );
    expect(res.status).toBe(200);
    const frames = await readSseFrames(res, "done");
    expect(frames[0]!.type).toBe("start");
    expect(frames.some((f) => f.type === "delta")).toBe(true);
    expect(frames.at(-1)!?.type).toBe("done");

    const transcript = await handler(authed("GET", "/api/herald/chat/chat-edit"));
    const { messages } = (await transcript.json()) as { messages: Array<Record<string, unknown>> };
    expect(messages).toHaveLength(4);
    expect(messages[0]!).toEqual({ role: "user", content: "q0" });
    expect(messages[1]!).toEqual({ role: "assistant", content: "a0" });
    expect(messages[2]!.role).toBe("user");
    expect(messages[2]!.content).toBe("edited q1");
    expect(typeof messages[2]!.ts).toBe("string");
    expect(messages[3]!.role).toBe("assistant");
    expect(messages[3]!.content).toBe("Hi");
    expect(typeof messages[3]!.ts).toBe("string");
  }, 20000);

  it("bad fromIndex → 422 INVALID_ARGS, transcript untouched", async () => {
    for (const fromIndex of [99, 1, 1.5]) {
      const res = await handler(
        authed("POST", "/api/herald/chat/stream", { projectId: "p2", chatId: "chat-edit", message: "nope", fromIndex })
      );
      expect(res.status).toBe(422);
      expect((await res.json()).error.code).toBe("INVALID_ARGS");
    }
    const row = db.prepare(`SELECT messages FROM herald_threads WHERE document_id = 'chat-edit'`).get() as { messages: string };
    expect(JSON.parse(row.messages)).toHaveLength(4); // unchanged by failed edits
  }, 20000);

  it("retry-after-error drops the failed entry", async () => {
    const res = await handler(
      authed("POST", "/api/herald/chat/stream", {
        projectId: "p2",
        chatId: "chat-err",
        message: "hi again",
        fromIndex: 0,
      })
    );
    expect(res.status).toBe(200);
    await readSseFrames(res, "done");

    const transcript = await handler(authed("GET", "/api/herald/chat/chat-err"));
    const { messages } = (await transcript.json()) as { messages: Array<Record<string, unknown>> };
    expect(messages).toHaveLength(2);
    expect(messages[0]!.role).toBe("user");
    expect(messages[0]!.content).toBe("hi again");
    expect(messages[1]!.role).toBe("assistant");
    expect(messages[1]!.content).toBe("Hi");
    expect(messages[1]!.error).toBeUndefined();
  }, 20000);

  it("second concurrent stream on an active chat → 409 HERALD_TASK_ACTIVE", async () => {
    const put = await handler(
      authed("PUT", "/api/herald/settings/p1", {
        fallbackModelIds: ["test-model"],
      })
    );
    expect(put.status).toBe(200);
    db.exec(`INSERT OR IGNORE INTO herald_providers (id, label, base_url, api_key) VALUES ('prov-p1', 'MockHold', 'http://127.0.0.1:${holdPort}', 'sk-test')`);
    db.exec(`INSERT OR IGNORE INTO herald_models (id, provider_id, model_id, kind, priority, enabled) VALUES ('m-p1', 'prov-p1', 'test-model', 'openai_compatible', 1, 1)`);

    const ac = new AbortController();
    const first = await handler(
      new Request("http://lexa.test/api/herald/chat/stream", {
        method: "POST",
        headers: { authorization: `Bearer ${ADMIN_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ projectId: "p1", chatId: "c-live", message: "hello" }),
        signal: ac.signal,
      })
    );
    expect(first!.status).toBe(200);
    const reader = first!.body!.getReader();
    await reader.read(); // start frame — chat registered active

    const second = await handler(
      authed("POST", "/api/herald/chat/stream", { projectId: "p1", chatId: "c-live", message: "again" })
    );
    expect(second.status).toBe(409);
    expect((await second.json()).error.code).toBe("HERALD_TASK_ACTIVE");

    // Release: client disconnect aborts the run; a fresh stream is accepted.
    reader.cancel().catch(() => {});
    ac.abort();
    await new Promise((r) => setTimeout(r, 250));
    const third = await handler(
      authed("POST", "/api/herald/chat/stream", { projectId: "p1", chatId: "c-live", message: "fresh" })
    );
    expect(third.status).toBe(200);
    await readSseFrames(third, "start");
  }, 20000);
});
