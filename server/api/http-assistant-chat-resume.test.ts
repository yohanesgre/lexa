import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { createAssistantApiHandler } from "./assistant-api";

// ADR-0005 W4: chat resume runs in-process over SSE on both flavors — the DO
// `resumeBatch` handoff (and its 202/502 acks) is gone. A batch already claimed
// by a prior execution no-ops to a terminal `done` frame (idempotent resume).

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
INSERT INTO assistant_settings (project_id) VALUES ('p1');
INSERT INTO assistant_threads (document_type, document_id, project_id, owner_user_id, title, messages)
VALUES ('chat', 'chat-resume', 'p1', 'u1', 'Resume', '[{"role":"user","content":"go"},{"role":"assistant","content":"proposed","pendingBatch":{"batchId":"rb1","approvals":[]}}]');
INSERT INTO assistant_threads (document_type, document_id, project_id, owner_user_id, title, messages)
VALUES ('chat', 'chat-none', 'p1', 'u1', 'None', '[]');
`);
});

afterAll(() => {
  delete process.env.LXK_SECRETS_MASTER_KEY;
  try { db.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

describe("POST /api/assistant/chat/:chatId/resume — in-process SSE (no DO handoff)", () => {
  it("a duplicate (already-claimed) batch no-ops to a terminal done frame", async () => {
    // The claim is already present → the in-process lane treats the resume as a
    // duplicate and settles without a provider turn (idempotent across tabs).
    db.exec(`INSERT OR REPLACE INTO assistant_resume_claims (batch_id) VALUES ('rb1')`);
    const handler = createAssistantApiHandler(dbPath);
    const res = await handler(resumeReq("chat-resume", { batchId: "rb1" }));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("event: done");
  });

  it("a thread with no pending batch is refused with APPROVALS_PENDING (no 502 handoff)", async () => {
    const handler = createAssistantApiHandler(dbPath);
    const res = await handler(resumeReq("chat-none"));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("APPROVALS_PENDING");
  });
});
