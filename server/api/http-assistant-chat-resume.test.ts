import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { createAssistantApiHandler } from "./assistant-api";
import type { AssistantThreadRpcShape, ResumeBatchAck } from "../assistant/thread-rpc";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));
const MASTER_KEY = Buffer.from("q".repeat(32)).toString("base64");
const ADMIN_KEY = "lxk_" + "a".repeat(43);

async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

let dir: string;
let dbPath: string;
let db: Database;

// A DO-present RPC shape whose only meaningful method is `resumeBatch`; every
// other call resolves null so the shared handler keeps its D1 fallbacks.
function makeRpc(resumeBatch: AssistantThreadRpcShape["resumeBatch"]): AssistantThreadRpcShape {
  return {
    available: true,
    getTranscript: async () => null,
    resumeBatch,
    destroyThread: async () => null,
    resetThread: async () => null,
    enqueueRun: async () => null,
    abortRun: async () => null,
  };
}

function resumeReq(chatId: string, body: unknown = {}) {
  return new Request(`http://lexa.test/api/assistant/chat/${chatId}/resume`, {
    method: "POST",
    headers: { authorization: `Bearer ${ADMIN_KEY}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  process.env.LXK_SECRETS_MASTER_KEY = MASTER_KEY;
  dir = mkdtempSync(join(tmpdir(), "lexa-assistant-chat-resume-"));
  dbPath = join(dir, "test.db");
  runMigrations(dbPath, MIGRATIONS);
  const adminHash = await sha256(ADMIN_KEY);
  db = new Database(dbPath);
  db.exec(`
INSERT INTO users (id, email, name, role) VALUES ('u1', 'maria@lexa.test', 'Maria', 'superadmin');
INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k1', 'test-admin', '${adminHash}', 'u1');
INSERT INTO projects (id, name, slug) VALUES ('p1', 'P', 'p1');
INSERT INTO assistant_threads (document_type, document_id, project_id, owner_user_id, title, messages)
VALUES ('chat', 'chat-resume', 'p1', 'u1', 'Resume', '[]');
`);
});

afterAll(() => {
  delete process.env.LXK_SECRETS_MASTER_KEY;
  try { db.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

describe("POST /api/assistant/chat/:chatId/resume — DO handoff", () => {
  it("502s when the DO resume RPC rejects and never falls back to the in-process stream", async () => {
    const calls: Array<[string, string | null]> = [];
    const handler = createAssistantApiHandler(dbPath, undefined, {
      threadRpc: makeRpc(async (threadKey, batchId) => {
        calls.push([threadKey, batchId]);
        throw new Error("DO unreachable");
      }),
    });
    const res = await handler(resumeReq("chat-resume", { batchId: "b1" }));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: { code: "ASSISTANT_UNAVAILABLE", message: "Resume RPC failed" },
    });
    // The route forwarded the named batch before failing.
    expect(calls).toEqual([["chat:chat-resume", "b1"]]);
  });

  it("forwards the requested batchId and passes an executed ack through (202)", async () => {
    const calls: Array<[string, string | null]> = [];
    const handler = createAssistantApiHandler(dbPath, undefined, {
      threadRpc: makeRpc(async (threadKey, batchId): Promise<ResumeBatchAck> => {
        calls.push([threadKey, batchId]);
        return { ok: true, executed: true };
      }),
    });
    const res = await handler(resumeReq("chat-resume", { batchId: "b1" }));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true, executed: true });
    expect(calls).toEqual([["chat:chat-resume", "b1"]]);
  });

  it("passes a non-executed ack through so the client can keep the batch eligible (202)", async () => {
    const handler = createAssistantApiHandler(dbPath, undefined, {
      threadRpc: makeRpc(async () => ({ ok: true, executed: false, reason: "pending" })),
    });
    const res = await handler(resumeReq("chat-resume", { batchId: "b-pending" }));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true, executed: false, reason: "pending" });
  });

  it("an omitted batchId forwards null and keeps the DO's legacy walk (202)", async () => {
    const calls: Array<[string, string | null]> = [];
    const handler = createAssistantApiHandler(dbPath, undefined, {
      threadRpc: makeRpc(async (threadKey, batchId): Promise<ResumeBatchAck> => {
        calls.push([threadKey, batchId]);
        return { ok: true, executed: false, reason: "settled" };
      }),
    });
    const res = await handler(resumeReq("chat-resume"));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true, executed: false, reason: "settled" });
    expect(calls).toEqual([["chat:chat-resume", null]]);
  });
});
