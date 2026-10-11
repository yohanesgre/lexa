import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { Effect, Layer } from "effect";
import { runMigrations } from "../db/migrate";
import { Sqlite } from "../db/database";
import { DbBunLive } from "../db/db";
import { AttachmentService } from "../services/attachment.service";
import { Storage, StorageConfig } from "../storage/storage";
import { resolveStorageConfig, CHAT_ATTACHMENT_MAX_UPLOAD_BYTES } from "../storage/config";
import { createApiHandler } from "./http";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

const ADMIN_KEY = "lxk_" + "a".repeat(43);
const MEMBER_KEY = "lxk_" + "b".repeat(43);
const MEMBER2_KEY = "lxk_" + "c".repeat(43);

async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const SVG_TEXT = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="4" height="4"/></svg>';
const DOOMED_TEXT = "doomed attachment body";
const SHARE_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 2, 2, 2, 15]);

let dir: string;
let dbPath: string;
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

const pub = (path: string) => new Request(`http://lexa.test${path}`);

function uploadReq(path: string, bytes: Uint8Array | string, filename: string, key = ADMIN_KEY) {
  const form = new FormData();
  const payload = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  form.append("file", new Blob([payload as unknown as BlobPart]), filename);
  return new Request(`http://lexa.test${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}` },
    body: form,
  });
}

async function createShareLink(pageSlug: string, expiresAt?: string): Promise<{ id: string; token: string }> {
  const res = await handler(authed("POST", `/api/projects/p1/wiki/pages/${pageSlug}/share`, expiresAt ? { expiresAt } : {}));
  expect(res.status).toBe(201);
  const body = await res.json();
  const token = (body.link.url as string).split("/share/")[1]!;
  return { id: body.link.id, token };
}

async function uploadToTask(bytes: Uint8Array | string, filename: string) {
  const res = await handler(uploadReq("/api/projects/p1/tasks/t1/attachments", bytes, filename));
  return { res, body: await res.json() };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "lexa-attachments-api-"));
  dbPath = join(dir, "test.db");
  runMigrations(dbPath, MIGRATIONS);
  // Resolved at createApiHandler time — 1 MB cap keeps the oversize case fast
  // without affecting the small fixtures below.
  process.env.LXK_MAX_UPLOAD_MB = "1";
  const adminHash = await sha256(ADMIN_KEY);
  const memberHash = await sha256(MEMBER_KEY);
  const member2Hash = await sha256(MEMBER2_KEY);
  db = new Database(dbPath);
  db.exec(`
INSERT INTO users (id, email, name, role) VALUES ('u1', 'maria@lexa.test', 'Maria', 'superadmin');
INSERT INTO users (id, email, name, role) VALUES ('u2', 'bob@lexa.test', 'Bob', 'member');
-- Real row for task_activity.actor_user_id FK when the service-level guard
-- test deletes with an admin identity.
INSERT INTO users (id, email, name, role) VALUES ('u3', 'admin2@lexa.test', 'Admin2', 'member');
-- Fourth user: project member (explicit grant) but NOT the chat-thread owner —
-- the cross-user isolation assertion below.
INSERT INTO users (id, email, name, role) VALUES ('u4', 'carol@lexa.test', 'Carol', 'member');
INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k1', 'test-admin', '${adminHash}', 'u1');
INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k2', 'test-member', '${memberHash}', 'u2');
INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k4', 'test-member2', '${member2Hash}', 'u4');
INSERT INTO projects (id, name, slug, key, next_task_number) VALUES ('p1', 'P', 'p1', 'EG', 1);
INSERT INTO user_project_roles (user_id, role, project_id) VALUES ('u4', 'member', 'p1');
INSERT INTO columns (id, project_id, name, position) VALUES ('c1', 'p1', 'Todo', 0);
INSERT INTO swimlanes (id, project_id, name, position, kind, due_at) VALUES ('s-backlog', 'p1', 'Backlog', 0, 'backlog', NULL);
INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, created_at, key, number) VALUES ('t1', 'p1', 'c1', 's-backlog', 'T1', 'a0', '2026-01-01 10:00:00', 'EG-1', 1);
INSERT INTO wiki_pages (id, project_id, title, slug, content, content_text, position) VALUES ('w1', 'p1', 'Home', 'home', '{"type":"doc","content":[]}', 'hello world', 0);
INSERT INTO wiki_pages (id, project_id, title, slug, parent_id, content, content_text, position) VALUES ('w2', 'p1', 'Child', 'child', 'w1', '{"type":"doc","content":[]}', 'child page', 0);
`);
  handler = createApiHandler(dbPath);
  buildServiceTestLayer();
});

afterAll(() => {
  try { db.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

const blobDir = () => join(dir, "blobs", "blobs");

// Service-level test layer: same DB handle + fs storage under the tmp dir.
let serviceTestLayer: Layer.Layer<AttachmentService>;
function buildServiceTestLayer() {
  const cfg = resolveStorageConfig(process.env, dir);
  const deps = Layer.mergeAll(
    Layer.mergeAll(Layer.succeed(Sqlite, db), DbBunLive(db)),
    Layer.succeed(StorageConfig, cfg),
    Storage.Default.pipe(Layer.provide(Layer.succeed(StorageConfig, cfg)))
  );
  serviceTestLayer = Layer.provide(AttachmentService.Default, deps);
}

// Direct service invocation — the HTTP surface cannot reach the
// AttachmentDeleteForbidden branch today because the middleware rejects
// member-bound keys before routing. Exercises the authority rule itself.
async function runServiceRemove(
  attachmentId: string,
  identity: { keyId: string; keyName: string; userId: string | null; userName: string | null; role: "admin" | "member" }
): Promise<{ outcome: "Left" | "Right"; errorTag?: string | undefined }> {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const svc = yield* AttachmentService;
      return yield* svc.remove(attachmentId, identity);
    }).pipe(Effect.provide(serviceTestLayer!), Effect.either)
  );
  if (result._tag === "Left") {
    return { outcome: "Left", errorTag: (result.left as { _tag?: string })._tag };
  }
  return { outcome: "Right" };
}

// Direct service invocation — the middleware rejects member-bound keys before
// routing, so the removeChat authority rule is exercised on the service itself.
async function runServiceRemoveChat(
  attachmentId: string,
  identity: { keyId: string; keyName: string; userId: string | null; userName: string | null; role: "admin" | "member" }
): Promise<{ outcome: "Left" | "Right"; errorTag?: string | undefined }> {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const svc = yield* AttachmentService;
      return yield* svc.removeChat(attachmentId, identity);
    }).pipe(Effect.provide(serviceTestLayer!), Effect.either)
  );
  if (result._tag === "Left") {
    return { outcome: "Left", errorTag: (result.left as { _tag?: string })._tag };
  }
  return { outcome: "Right" };
}

describe("POST /api/projects/:slug/tasks/:taskId/attachments", () => {
  it("upload → 201 + attachment_added activity; concurrent identical uploads dedupe to one row/one activity/same id; oversize → 413", async () => {
    const { res, body } = await uploadToTask(PNG_BYTES, "photo.png");
    expect(res.status).toBe(201);
    expect(body.data).toMatchObject({
      projectId: "p1",
      taskId: "t1",
      wikiPageId: null,
      filename: "photo.png",
      mimeType: "image/png",
      sizeBytes: PNG_BYTES.byteLength,
    });
    expect(body.data.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(body.activity).toHaveLength(1);
    expect(body.activity[0]!.type).toBe("attachment_added");
    expect(body.activity[0]!.message).toContain("photo.png");
    const rows = db.prepare("SELECT type FROM task_activity WHERE task_id = 't1'").all() as { type: string }[];
    expect(rows.map((r) => r.type)).toContain("attachment_added");

    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9, 9]);
    const [ra, rb] = await Promise.all([
      handler(uploadReq("/api/projects/p1/tasks/t1/attachments", bytes, "race-a.png")),
      handler(uploadReq("/api/projects/p1/tasks/t1/attachments", bytes, "race-b.png")),
    ]);
    expect(ra.status).toBe(201);
    expect(rb.status).toBe(201);
    const [ba, bb] = [await ra.json(), await rb.json()];
    expect(ba.data.id).toBe(bb.data.id);

    const deduped = db.prepare("SELECT COUNT(*) AS n FROM attachments WHERE sha256 = ?").get(ba.data.sha256) as { n: number };
    expect(deduped.n).toBe(1);
    // Exactly one winner emits attachment_added; the loser's activity insert is
    // gated on its own row existing, so it can never emit an orphan row.
    const acts = db.prepare(
      "SELECT COUNT(*) AS n FROM task_activity WHERE task_id = 't1' AND type = 'attachment_added' AND message LIKE '%race-%'"
    ).get() as { n: number };
    expect(acts.n).toBe(1);
    const empty = [ba.activity, bb.activity].filter((a: unknown[]) => a.length === 0);
    expect(empty).toHaveLength(1);

    const big = new Uint8Array(2 * 1024 * 1024);
    const oversize = await uploadToTask(big, "big.bin");
    expect(oversize.res.status).toBe(413);
    expect(oversize.body.error.code).toBe("PAYLOAD_TOO_LARGE");
  });
});

describe("GET /api/attachments/:id", () => {
  it("serves byte-identical bytes with sniffed type + inline disposition + nosniff; lying extension forces download", async () => {
    const created = await uploadToTask(PNG_BYTES, "photo.png");
    const res = await handler(authed("GET", `/api/attachments/${created.body.data.id}`));
    expect(res.status).toBe(200);
    expect(Buffer.from(new Uint8Array(await res.arrayBuffer())).equals(Buffer.from(PNG_BYTES))).toBe(true);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect((res.headers.get("content-disposition") ?? "").startsWith("inline")).toBe(true);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");

    const lying = await uploadToTask(SVG_TEXT, "innocent.png");
    expect(lying.body.data.mimeType).toBe("image/svg+xml");
    const lieRes = await handler(authed("GET", `/api/attachments/${lying.body.data.id}`));
    expect(lieRes.status).toBe(200);
    expect(lieRes.headers.get("content-type")).toBe("image/svg+xml");
    expect((lieRes.headers.get("content-disposition") ?? "").startsWith("attachment")).toBe(true);
    expect(lieRes.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("DELETE /api/attachments/:id", () => {
  it("non-uploader non-admin → AttachmentDeleteForbidden; uploader → 204 (blob gone) then repeat 404; admin may delete another's", async () => {
    const { body } = await uploadToTask(DOOMED_TEXT, "doomed.txt");
    const id = body.data.id;
    const sha = body.data.sha256;

    const verdict = await runServiceRemove(id, {
      keyId: "k2", keyName: "Bob", userId: "u2", userName: "Bob", role: "member",
    });
    expect(verdict.outcome).toBe("Left");
    expect(verdict.errorTag).toBe("AttachmentDeleteForbidden");
    expect(db.prepare("SELECT id FROM attachments WHERE id = ?").get(id)).toBeTruthy();

    const del = await handler(authed("DELETE", `/api/attachments/${id}`));
    expect(del.status).toBe(204);
    expect(existsSync(join(blobDir(), sha))).toBe(false);
    const again = await handler(authed("DELETE", `/api/attachments/${id}`));
    expect(again.status).toBe(404);
    expect((await again.json()).error.code).toBe("ATTACHMENT_NOT_FOUND");

    const other = await uploadToTask(SVG_TEXT, "admin-del.svg");
    const adminVerdict = await runServiceRemove(other.body.data.id, {
      keyId: "k3", keyName: "Admin2", userId: "u3", userName: "Admin2", role: "admin",
    });
    expect(adminVerdict.outcome).toBe("Right");
    expect(db.prepare("SELECT id FROM attachments WHERE id = ?").get(other.body.data.id)).toBeNull();
  });
});

describe("GET /api/share/:token/attachments/:id", () => {
  it("serves inside subtree; expired/revoked are indistinguishable 404; outside subtree 404; dedicated 429 bucket", async () => {
    const up = await handler(uploadReq("/api/projects/p1/wiki/pages/home/attachments", SHARE_PNG, "shared.png"));
    const wikiAttachmentId = (await up.json()).data.id;
    const live = await createShareLink("home");
    const expiredToken = (await createShareLink("home", "2020-01-01T00:00:00.000Z")).token;
    const childToken = (await createShareLink("child")).token;

    const good = await handler(pub(`/api/share/${live.token}/attachments/${wikiAttachmentId}`));
    expect(good.status).toBe(200);
    expect(Buffer.from(new Uint8Array(await good.arrayBuffer())).equals(Buffer.from(SHARE_PNG))).toBe(true);
    expect(good.headers.get("x-content-type-options")).toBe("nosniff");

    const expired = await handler(pub(`/api/share/${expiredToken}/attachments/${wikiAttachmentId}`));
    expect(expired.status).toBe(404);
    expect((await expired.json()).error.code).toBe("SHARE_LINK_NOT_FOUND");

    const revoke = await handler(authed("DELETE", `/api/projects/p1/wiki/share/${live.id}`));
    expect(revoke.status).toBe(204);
    const revoked = await handler(pub(`/api/share/${live.token}/attachments/${wikiAttachmentId}`));
    expect(revoked.status).toBe(404);
    expect((await revoked.json()).error.code).toBe("SHARE_LINK_NOT_FOUND");

    // childToken shares only w2; the attachment lives on w1.
    const outside = await handler(pub(`/api/share/${childToken}/attachments/${wikiAttachmentId}`));
    expect(outside.status).toBe(404);
    expect((await outside.json()).error.code).toBe("ATTACHMENT_NOT_FOUND");

    let saw429 = false;
    for (let i = 0; i < 60; i++) {
      const res = await handler(pub("/api/share/nope/attachments/also-nope"));
      if (res.status === 429) {
        saw429 = true;
        break;
      }
      expect(res.status).toBe(404);
    }
    expect(saw429).toBe(true);
  });
});

describe("Chat attachments — upload/serve/caps/authority/kill switch/isolation", () => {
  const CHAT = "/api/projects/p1/assistant/chat/c1/attachments";

  it("upload+sniff+oversize+serve+delete-forbidden+kill-switch+isolation", async () => {
    const mdBytes = new TextEncoder().encode("# Notes\n\nhello world");
    const activityBefore = (db.prepare("SELECT COUNT(*) AS n FROM task_activity").get() as { n: number }).n;
    const up = await handler(uploadReq(CHAT, mdBytes, "notes.md"));
    expect(up.status).toBe(201);
    const uploaded = (await up.json()).data;
    expect(uploaded).toMatchObject({
      projectId: "p1",
      chatId: "c1",
      filename: "notes.md",
      mimeType: "text/markdown",
      sizeBytes: mdBytes.byteLength,
      uploadedBy: "u1",
      uploadedByLabel: "Maria",
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM assistant_threads WHERE document_type = 'chat' AND document_id = 'c1'").get()).toEqual({ n: 1 });
    // Chat attachments emit no activity rows.
    expect((db.prepare("SELECT COUNT(*) AS n FROM task_activity").get() as { n: number }).n).toBe(activityBefore);

    // Serve bytes; text downloads (not inline).
    const served = await handler(authed("GET", `/api/chat-attachments/${uploaded.id}`));
    expect(served.status).toBe(200);
    expect(Buffer.from(new Uint8Array(await served.arrayBuffer())).equals(Buffer.from(mdBytes))).toBe(true);
    expect(served.headers.get("content-type")).toBe("text/markdown");
    expect((served.headers.get("content-disposition") ?? "").startsWith("attachment")).toBe(true);
    expect(served.headers.get("x-content-type-options")).toBe("nosniff");

    // Sniffed-but-unsupported type (SVG) → 422.
    const svg = await handler(uploadReq(CHAT, SVG_TEXT, "logo.svg"));
    expect(svg.status).toBe(422);
    expect((await svg.json()).error.code).toBe("INVALID_ARGS");

    // Per-file oversize → 413 naming the file (5 MB chat cap).
    const big = new Uint8Array(CHAT_ATTACHMENT_MAX_UPLOAD_BYTES + 1024);
    const oversize = await handler(uploadReq(CHAT, big, "big.txt"));
    expect(oversize.status).toBe(413);
    const overErr = (await oversize.json()).error;
    expect(overErr.code).toBe("PAYLOAD_TOO_LARGE");
    expect(overErr.message).toContain("big.txt");

    // Member-bound key → 403; direct service guard agrees.
    const mid = await handler(authed("DELETE", `/api/chat-attachments/${uploaded.id}`, undefined, MEMBER_KEY));
    expect(mid.status).toBe(403);
    expect((await mid.json()).error.code).toBe("ATTACHMENT_DELETE_FORBIDDEN");
    const verdict = await runServiceRemoveChat(uploaded.id, {
      keyId: "k2", keyName: "Bob", userId: "u2", userName: "Bob", role: "member",
    });
    expect(verdict.outcome).toBe("Left");
    expect(verdict.errorTag).toBe("AttachmentDeleteForbidden");
    expect(db.prepare("SELECT id FROM chat_attachments WHERE id = ?").get(uploaded.id)).toBeTruthy();

    // Kill switch: on the Bun host `currentEnv` resolves from process.env.
    process.env.LXK_DISABLE_CHAT_ATTACHMENTS = "1";
    try {
      const off = await handler(uploadReq(CHAT, new TextEncoder().encode("x"), "x.txt"));
      expect(off.status).toBe(403);
      expect((await off.json()).error.code).toBe("CHAT_ATTACHMENTS_DISABLED");
    } finally {
      delete process.env.LXK_DISABLE_CHAT_ATTACHMENTS;
    }

    // Threads are owner-scoped: u4 is a project member but not owner of c1 (u1).
    const victim = await handler(uploadReq(CHAT, new TextEncoder().encode("victim secret"), "victim.txt"));
    expect(victim.status).toBe(201);
    const isolation = await handler(authed("GET", CHAT, undefined, MEMBER2_KEY));
    expect(isolation.status).toBe(404);
    expect((await isolation.json()).error.code).toBe("ASSISTANT_THREAD_NOT_FOUND");
  });
});

// Regression for the shared blob refcount: task/wiki remove must count
// `chat_attachments` too, or deleting a task artifact deletes a blob that a
// chat message still points at (serve 404 / extraction failure).
describe("Shared blob refcount (task + chat)", () => {
  const CHAT = "/api/projects/p1/assistant/chat/c1/attachments";
  const SHARED = new TextEncoder().encode("shared blob body");

  it("deleting a task attachment keeps a blob still referenced by a chat attachment", async () => {
    const chatUp = await handler(uploadReq(CHAT, SHARED, "shared-chat.txt"));
    expect(chatUp.status).toBe(201);
    const chatAttachmentId = (await chatUp.json()).data.id;

    const taskUp = await handler(uploadReq("/api/projects/p1/tasks/t1/attachments", SHARED, "shared-task.txt"));
    expect(taskUp.status).toBe(201);
    const taskBody = await taskUp.json();
    const sha = taskBody.data.sha256 as string;
    expect(existsSync(join(blobDir(), sha))).toBe(true);

    const del = await handler(authed("DELETE", `/api/attachments/${taskBody.data.id}`));
    expect(del.status).toBe(204);
    expect(existsSync(join(blobDir(), sha))).toBe(true);

    const serve = await handler(authed("GET", `/api/chat-attachments/${chatAttachmentId}`));
    expect(serve.status).toBe(200);
    expect(Buffer.from(new Uint8Array(await serve.arrayBuffer())).equals(Buffer.from(SHARED))).toBe(true);
  });
});
