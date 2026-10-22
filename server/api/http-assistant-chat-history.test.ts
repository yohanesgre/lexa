import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { createAssistantApiHandler } from "./assistant-api";
import type { RuntimeEnv } from "../env";
import { seedProviderSecret } from "../assistant/test-secrets";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));
const MASTER_KEY = Buffer.from("q".repeat(32)).toString("base64");

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
let dbPath: string;
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

// Mock OpenAI-compatible provider: answers any POST with an SSE chunk stream
// that emits one delta then HOLDS OPEN until the client disconnects — long
// enough to exercise the active-chat guards against a live stream.
let mockServer: Server;
let mockPort: number;
let mockProviderRequests = 0;

function startMockProvider(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  mockServer = createServer((req, res) => {
    mockProviderRequests += 1;
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
  return promise;
}

// Parse the SSE wire (`data: <json>\n\n`) into frame objects.
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

function onUnhandledRejection(reason: unknown): void {
  if (!sseCloseRace(reason)) throw reason;
}

beforeAll(async () => {
  process.on("unhandledRejection", onUnhandledRejection);
  process.env.LXK_SECRETS_MASTER_KEY = MASTER_KEY;
  await startMockProvider();
  dir = mkdtempSync(join(tmpdir(), "lexa-assistant-chat-history-"));
  dbPath = join(dir, "test.db");
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
-- p1 list fixtures: pinned beats recency; updated_at orders the rest.
INSERT INTO assistant_threads (document_type, document_id, project_id, owner_user_id, title, pinned, messages, updated_at)
VALUES ('chat', 'chat-pin', 'p1', 'u1', 'Old but pinned', 1, '[]', datetime('now', '-3 hours'));
INSERT INTO assistant_threads (document_type, document_id, project_id, owner_user_id, title, messages)
VALUES ('chat', 'chat-x', 'p1', 'u1', NULL, '[{"role":"user","content":"What is Lexa?","ts":"2026-08-22T10:00:00.000Z"},{"role":"assistant","content":"A project tool.","ts":"2026-08-22T10:00:05.000Z","citations":[{"title":"Lexa Docs","url":"https://lexa.example/guide"},{"title":null,"url":"https://raw.example/x"}]},{"role":"user","content":"continue"},{"role":"assistant","content":"par","error":{"code":"ASSISTANT_GENERATION_FAILED","message":"boom"}}]');
INSERT INTO assistant_threads (document_type, document_id, project_id, owner_user_id, title, messages, updated_at)
VALUES ('chat', 'chat-rec', 'p1', 'u1', 'Recency', '[]', datetime('now', '-1 hour'));
INSERT INTO assistant_threads (document_type, document_id, project_id, owner_user_id, title, messages, updated_at)
VALUES ('chat', 'chat-z', 'p1', 'u1', 'Unrelated', '[{"role":"user","content":"the needle in transcript"}]', datetime('now', '-2 hours'));
-- Anna's threads: invisible to Maria.
INSERT INTO assistant_threads (document_type, document_id, project_id, owner_user_id, title, messages)
VALUES ('chat', 'chat-u2', 'p1', 'u2', 'Anna private', '[]');
-- p2 hosts the ownership/rename/delete fixtures so p1 list ordering stays exact.
INSERT INTO assistant_threads (document_type, document_id, project_id, owner_user_id, title, messages)
VALUES ('chat', 'chat-c', 'p2', 'u2', 'Bob private', '[]');
INSERT INTO assistant_threads (document_type, document_id, project_id, owner_user_id, title, messages)
VALUES ('chat', 'chat-b', 'p2', 'u1', NULL, '[{"role":"user","content":"hi"}]');
INSERT INTO assistant_threads (document_type, document_id, project_id, owner_user_id, title, messages)
VALUES ('chat', 'chat-del', 'p2', 'u1', 'Doomed', '[]');
-- D3 mirror fixture: parts-shaped rows as the Workers mirror stores them,
-- incl. an attachment part and a pending-batch carrier.
INSERT INTO assistant_threads (document_type, document_id, project_id, owner_user_id, title, messages)
VALUES ('chat', 'chat-parts', 'p2', 'u1', 'Parts', '[{"id":"m1","role":"user","parts":[{"type":"text","text":"see file"},{"type":"data-attachment","data":{"storageKey":"blob-1","mimeType":"image/png","name":"shot.png"}}],"metadata":{"ts":"2026-08-22T10:00:00.000Z"}},{"id":"m2","role":"assistant","parts":[{"type":"text","text":"I can do that."},{"type":"data-assistant-approval","data":{"batchId":"b-parts","approvals":[{"approvalId":"ap-parts","seq":0,"name":"create_task","diff":{"type":"task_create","title":"New task","fields":{}}}]}}]}]');
-- Holding provider for the active-chat race guards.
INSERT INTO assistant_providers (id, label, base_url, api_key) VALUES ('prov-p1', 'MockHold', 'http://127.0.0.1:${mockPort}', '');
INSERT INTO assistant_models (id, provider_id, model_id, kind, priority, enabled) VALUES ('m-p1', 'prov-p1', 'test-model', 'openai_compatible', 0, 1);
INSERT INTO assistant_settings (project_id, write_tools, provider_id, primary_model_id) VALUES ('p1', '[]', 'prov-p1', 'm-p1');
INSERT INTO assistant_settings (project_id) VALUES ('p2');
`);
  await seedProviderSecret(db, "prov-p1", "sk-test", MASTER_KEY);
  handler = createAssistantApiHandler(dbPath);
});

afterAll(() => {
  process.off("unhandledRejection", onUnhandledRejection);
  delete process.env.LXK_SECRETS_MASTER_KEY;
  mockServer.closeAllConnections?.();
  mockServer.close();
  try { db.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

describe("GET /api/assistant/chats/:projectId (q + pinned ordering)", () => {
  it("pins first then recency (other users invisible) and ?q= matches transcript text with a snippet window", async () => {
    const res = await handler(authed("GET", "/api/assistant/chats/p1"));
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

    const annas = await handler(authed("GET", "/api/assistant/chats/p1", undefined, SECOND_ADMIN_KEY));
    expect((await annas.json()).data.map((t: { chatId: string }) => t.chatId)).toEqual(["chat-u2"]);

    const search = await handler(authed("GET", "/api/assistant/chats/p1?q=needle"));
    const searchBody = await search.json();
    expect(searchBody.data.map((t: { chatId: string }) => t.chatId)).toEqual(["chat-z"]);
    expect(searchBody.data[0]!.snippet).toBe("the needle in transcript");
  });
});

describe("PATCH / DELETE /api/assistant/chat/:chatId", () => {
  it("renames, pins/unpins, 422s bad input, and 404s owner mismatch; DELETE removes the owner's thread and 404s a foreign one", async () => {
    const renamed = await handler(authed("PATCH", "/api/assistant/chat/chat-b", { title: "  Renamed B  " }));
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toEqual({ chatId: "chat-b", title: "Renamed B", pinned: false });
    const renamedRow = db.prepare(`SELECT title FROM assistant_threads WHERE document_id = 'chat-b'`).get() as { title: string | null };
    expect(renamedRow.title).toBe("Renamed B");

    const pin = await handler(authed("PATCH", "/api/assistant/chat/chat-rec", { pinned: true }));
    expect(pin.status).toBe(200);
    expect(await pin.json()).toEqual({ chatId: "chat-rec", title: "Recency", pinned: true });
    const pinRow = db.prepare(`SELECT pinned FROM assistant_threads WHERE document_id = 'chat-rec'`).get() as { pinned: number };
    expect(pinRow.pinned).toBe(1);
    const unpin = await handler(authed("PATCH", "/api/assistant/chat/chat-rec", { pinned: false }));
    expect((await unpin.json()).pinned).toBe(false);

    // Owner mismatch is indistinguishable from absence.
    const foreignPatch = await handler(authed("PATCH", "/api/assistant/chat/chat-c", { title: "Hijack" }, ADMIN_KEY));
    expect(foreignPatch.status).toBe(404);
    expect((await foreignPatch.json()).error.code).toBe("ASSISTANT_THREAD_NOT_FOUND");

    for (const payload of [{}, { title: "   " }, { title: "x".repeat(201) }]) {
      const res = await handler(authed("PATCH", "/api/assistant/chat/chat-rec", payload));
      expect(res.status).toBe(422);
      expect((await res.json()).error.code).toBe("INVALID_ARGS");
    }

    const foreignDelete = await handler(authed("DELETE", "/api/assistant/chat/chat-c"));
    expect(foreignDelete.status).toBe(404);
    expect((await foreignDelete.json()).error.code).toBe("ASSISTANT_THREAD_NOT_FOUND");
    const still = db.prepare(`SELECT COUNT(*) AS c FROM assistant_threads WHERE document_id = 'chat-c'`).get() as { c: number };
    expect(still.c).toBe(1);

    const ownDelete = await handler(authed("DELETE", "/api/assistant/chat/chat-del"));
    expect(ownDelete.status).toBe(204);
    expect(await ownDelete.text()).toBe("");
    const gone = await handler(authed("GET", "/api/assistant/chat/chat-del"));
    expect(gone.status).toBe(404);
    expect((await gone.json()).error.code).toBe("ASSISTANT_THREAD_NOT_FOUND");
  });
});
describe("POST /api/assistant/chat/stream ownership", () => {
  it("hides a foreign transcript and leaves its owner, history, and permission mode unchanged", async () => {
    db.exec(`
INSERT INTO assistant_threads (document_type, document_id, project_id, owner_user_id, title, permission_mode, messages, summary)
VALUES ('chat', 'chat-private-owner-check', 'p2', 'u2', 'Private', 'write', '[{"role":"user","content":"owner history"}]', 'owner summary');
`);
    const response = await handler(authed("POST", "/api/assistant/chat/stream", {
      projectId: "p2",
      chatId: "chat-private-owner-check",
      message: "foreign send",
    }));
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("ASSISTANT_THREAD_NOT_FOUND");
    const thread = db.prepare(`
SELECT owner_user_id, messages, summary, permission_mode
FROM assistant_threads WHERE document_id = 'chat-private-owner-check'
`).get() as { owner_user_id: string; messages: string; summary: string; permission_mode: string };
    expect(thread).toEqual({
      owner_user_id: "u2",
      messages: '[{"role":"user","content":"owner history"}]',
      summary: "owner summary",
      permission_mode: "write",
    });
  });
});


describe("GET /api/assistant/chat/:chatId (D3 UIMessage parts + export)", () => {
  it("serves parts-shaped D1 mirror rows verbatim, and exports a markdown attachment with template markers", async () => {
    const res = await handler(authed("GET", "/api/assistant/chat/chat-parts"));
    expect(res.status).toBe(200);
    const { messages, chatId } = (await res.json()) as {
      chatId: string;
      messages: Array<{ role: string; parts: Array<{ type: string; text?: string; data?: unknown }>; metadata?: { ts?: string } }>;
    };
    expect(chatId).toBe("chat-parts");
    expect(messages).toHaveLength(2);
    expect(messages[0]!.role).toBe("user");
    expect(messages[0]!.parts).toContainEqual({
      type: "data-attachment",
      data: { storageKey: "blob-1", mimeType: "image/png", name: "shot.png" },
    });
    expect(messages[0]!.metadata?.ts).toBe("2026-08-22T10:00:00.000Z");
    expect(messages[1]!.parts).toContainEqual({
      type: "data-assistant-approval",
      data: {
        batchId: "b-parts",
        approvals: [
          {
            approvalId: "ap-parts",
            seq: 0,
            name: "create_task",
            diff: { type: "task_create", title: "New task", fields: {} },
          },
        ],
      },
    });

    // Export renders the untitled thread's markdown attachment with template markers.
    const exp = await handler(authed("GET", "/api/assistant/chat/chat-x/export"));
    expect(exp.status).toBe(200);
    expect(exp.headers.get("content-type")).toContain("text/markdown");
    const day = db.prepare(`SELECT updated_at FROM assistant_threads WHERE document_id = 'chat-x'`).get() as { updated_at: string };
    const stamp = day.updated_at.slice(0, 10).replaceAll("-", "");
    expect(exp.headers.get("content-disposition")).toBe(`attachment; filename="chat-${stamp}.md"`);
    const md = await exp.text();
    expect(md.startsWith("# chat\n")).toBe(true);
    expect(md).toContain("**You** · 2026-08-22T10:00:00.000Z\nWhat is Lexa?");
    expect(md).toContain("**Assistant** · 2026-08-22T10:00:05.000Z\nA project tool.");
    expect(md).toContain("- [Lexa Docs](https://lexa.example/guide)");
    expect(md).toContain("- <https://raw.example/x>");
    expect(md).toContain("[failed turn: ASSISTANT_GENERATION_FAILED]");
  });
});


describe("DELETE /api/assistant/chat/:chatId and concurrent streams (active-chat guard)", () => {
  it("refuses replay cursors on the in-process path without starting a generation", async () => {
    mockProviderRequests = 0;
    const replay = await handler(
      authed("POST", "/api/assistant/chat/stream", {
        projectId: "p1",
        chatId: "replay-unsafe",
        message: "create a task",
        replayFrom: 0,
      })
    );
    expect(replay.status).toBe(409);
    expect((await replay.json()).error.code).toBe("ASSISTANT_TASK_ACTIVE");
    expect(mockProviderRequests).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS count FROM assistant_threads WHERE document_id = 'replay-unsafe'").get()).toMatchObject({ count: 0 });
  });

  it("delete while streaming and a second concurrent stream both 409 ASSISTANT_TASK_ACTIVE; client abort releases the chat", async () => {
    const ac = new AbortController();
    const res = await handler(
      new Request("http://lexa.test/api/assistant/chat/stream", {
        method: "POST",
        headers: { authorization: `Bearer ${ADMIN_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ projectId: "p1", chatId: "c-del-live", message: "hello", fromIndex: 0 }),
        signal: ac.signal,
      })
    );
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false); // start frame arrived — stream is live
    try {
      const accepted = await handler(authed("GET", "/api/assistant/chat/c-del-live"));
      expect(accepted.status).toBe(200);
      expect((await accepted.json()).messages).toMatchObject([
        { role: "user", parts: [{ type: "text", text: "hello" }] },
      ]);
    } catch (error) {
      reader.cancel().catch(() => {});
      ac.abort();
      throw error;
    }

    // Active-chat guard is registered synchronously at stream construction;
    // small retry loop absorbs scheduler jitter. Deterministic fake timers
    // cannot drive the live HTTP SSE teardown or AbortController wiring, so a
    // real (bounded) clock is required here — integration-test exception.
    let sawConflict = false;
    for (let i = 0; i < 20 && !sawConflict; i++) {
      const del = await handler(authed("DELETE", "/api/assistant/chat/c-del-live"));
      if (del.status === 409) {
        sawConflict = true;
        expect((await del.json()).error.code).toBe("ASSISTANT_TASK_ACTIVE");
        break;
      }
      expect(del.status).toBe(204);
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(sawConflict).toBe(true);

    // A second concurrent stream on the same active chat is refused too.
    const second = await handler(
      authed("POST", "/api/assistant/chat/stream", { projectId: "p1", chatId: "c-del-live", message: "again" })
    );
    expect(second.status).toBe(409);
    expect((await second.json()).error.code).toBe("ASSISTANT_TASK_ACTIVE");

    // The first request's signal stays live after its stream is canceled. Aborting it after a newer run starts must not target the current controller.
    reader.cancel().catch(() => {});
    await new Promise((r) => setTimeout(r, 250));
    const released = await handler(authed("DELETE", "/api/assistant/chat/c-del-live"));
    expect(released.status).toBe(204);

    const nextRequest = new AbortController();
    const third = await handler(
      new Request("http://lexa.test/api/assistant/chat/stream", {
        method: "POST",
        headers: { authorization: `Bearer ${ADMIN_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ projectId: "p1", chatId: "c-del-live", message: "fresh" }),
        signal: nextRequest.signal,
      })
    );
    expect(third.status).toBe(200);
    const nextReader = third.body!.getReader();
    expect((await nextReader.read()).done).toBe(false);
    ac.abort();
    const stillActive = await handler(authed("DELETE", "/api/assistant/chat/c-del-live"));
    expect(stillActive.status).toBe(409);
    expect((await stillActive.json()).error.code).toBe("ASSISTANT_TASK_ACTIVE");
    nextReader.cancel().catch(() => {});
    nextRequest.abort();
  }, 20000);

  it("Stop cancels an in-process resume when supervision is enabled but owns no producer", async () => {
    db.exec(`
INSERT INTO assistant_threads (document_type, document_id, project_id, owner_user_id, messages)
VALUES ('chat', 'c-resume-stop', 'p1', 'u1', '[{"role":"user","content":"hello"},{"role":"assistant","content":"","pendingBatch":{"batchId":"b-resume-stop","approvals":[]}}]');
INSERT INTO assistant_pending_writes
  (id, project_id, document_type, document_id, owner_user_id, batch_id, seq, tool_name, args, diff, status, expires_at)
VALUES ('ap-resume-stop', 'p1', 'chat', 'c-resume-stop', 'u1', 'b-resume-stop', 0, 'create_task', '{"title":"Not approved"}', '{"type":"task_create","title":"Not approved","fields":{}}', 'rejected', datetime('now', '+1 hour'));
`);
    const supervised = createAssistantApiHandler(dbPath, {
      LXK_SECRETS_MASTER_KEY: MASTER_KEY,
      LXK_CHAT_SUPERVISOR: "1",
      CHAT_DO: {
        idFromName: () => ({}),
        get: () => ({ fetch: async () => Response.json({ ok: false }) }),
      } as unknown as RuntimeEnv["CHAT_DO"],
    });
    const response = await supervised(authed("POST", "/api/assistant/chat/c-resume-stop/resume", { batchId: "b-resume-stop" }));
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    const cancel = await supervised(authed("POST", "/api/assistant/chat/c-resume-stop/cancel"));
    expect(cancel.status).toBe(200);
    expect(await cancel.json()).toEqual({ ok: true });
    for (;;) {
      if ((await reader.read()).done) break;
    }
    const saved = db.prepare("SELECT messages FROM assistant_threads WHERE document_id = 'c-resume-stop'").get() as { messages: string };
    expect((JSON.parse(saved.messages) as Array<Record<string, unknown>>).at(-1)).toMatchObject({ stopped: true });
    const settledCancel = await supervised(authed("POST", "/api/assistant/chat/c-resume-stop/cancel"));
    expect(settledCancel.status).toBe(200);
    expect(await settledCancel.json()).toEqual({ ok: false });
  });
});

describe("POST /api/assistant/chat/:chatId/resume — in-process SSE (no DO handoff)", () => {
  it("a duplicate (already-claimed) batch no-ops to a terminal done frame", async () => {
    // ADR-0005 W4: the DO `resumeBatch` handoff (and its 202/502 acks) is gone.
    // A batch already claimed by a prior execution settles without a provider
    // turn (idempotent resume).
    db.exec(`
INSERT OR REPLACE INTO assistant_threads (document_type, document_id, project_id, owner_user_id, title, messages)
VALUES ('chat', 'chat-resume', 'p2', 'u1', 'Resume', '[{"role":"user","content":"go"},{"role":"assistant","content":"proposed","pendingBatch":{"batchId":"rb1","approvals":[]}}]');
INSERT OR REPLACE INTO assistant_resume_claims (batch_id) VALUES ('rb1');
`);
    const res = await handler(
      new Request("http://lexa.test/api/assistant/chat/chat-resume/resume", {
        method: "POST",
        headers: { authorization: `Bearer ${ADMIN_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ batchId: "rb1" }),
      })
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("event: done");
  });
});

describe("POST /api/assistant/threads/:documentType/:documentId/resume optional batchId", () => {
  // Contract A4: empty legacy body omits selection; a supplied non-marker ID is decoded and rejected.
  it("accepts a bodyless legacy resume and forwards an explicit batchId", async () => {
    db.exec(`INSERT OR REPLACE INTO assistant_threads (document_type, document_id, project_id, owner_user_id, title, messages)
      VALUES ('task', 'resume-thread', 'p2', 'u1', 'Resume', '[{"role":"assistant","content":"proposed","pendingBatch":{"batchId":"thread-b1","approvals":[]}}]');`);

    const legacy = await handler(authed("POST", "/api/assistant/threads/task/resume-thread/resume"));
    expect(legacy.status).toBe(200);
    expect(await legacy.text()).toContain("event: done");

    const explicit = await handler(authed("POST", "/api/assistant/threads/task/resume-thread/resume", { batchId: "not-in-thread" }));
    expect(explicit.status).toBe(404);
    expect((await explicit.json()).error.code).toBe("APPROVAL_NOT_FOUND");
  });
});
