import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, readdirSync, existsSync } from "node:fs";
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
// Distinct content per target — dedupe is per-project by sha256, so reusing
// bytes across targets would collide into one row.
const WIKI_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 1, 1, 14]);
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
-- the cross-user isolation cases below.
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
const blobCount = () => (existsSync(blobDir()) ? readdirSync(blobDir()).length : 0);

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

describe("POST /api/projects/:slug/tasks/:taskId/attachments", () => {
  it("uploads → 201 attachment + attachment_added activity row", async () => {
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
  });

  it("dedupe: identical bytes → same row id, empty activity, no second blob", async () => {
    const first = await uploadToTask(PNG_BYTES, "again.png");
    expect(first!.res.status).toBe(201);
    const second = await uploadToTask(PNG_BYTES, "third-name.png");
    expect(second.res.status).toBe(201);
    expect(second.body.data.id).toBe(first!.body.data.id);
    expect(second.body.activity).toEqual([]);
    expect(blobCount()).toBe(1);
  });

  it("oversize (cap 1 MB via LXK_MAX_UPLOAD_MB) → 413 PAYLOAD_TOO_LARGE", async () => {
    const big = new Uint8Array(2 * 1024 * 1024);
    const { res, body } = await uploadToTask(big, "big.bin");
    expect(res.status).toBe(413);
    expect(body.error.code).toBe("PAYLOAD_TOO_LARGE");
  });
});

describe("GET /api/attachments/:id", () => {
  it("serves byte-identical bytes with sniffed type + inline disposition + nosniff", async () => {
    const created = await uploadToTask(PNG_BYTES, "photo.png");
    const id = created.body.data.id;
    const res = await handler(authed("GET", `/api/attachments/${id}`));
    expect(res.status).toBe(200);
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(Buffer.from(buf).equals(Buffer.from(PNG_BYTES))).toBe(true);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect((res.headers.get("content-disposition") ?? "").startsWith("inline")).toBe(true);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("lying extension: SVG bytes named .png sniff svg+xml → forced download", async () => {
    const { body } = await uploadToTask(SVG_TEXT, "innocent.png");
    expect(body.data.mimeType).toBe("image/svg+xml");
    const res = await handler(authed("GET", `/api/attachments/${body.data.id}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect((res.headers.get("content-disposition") ?? "").startsWith("attachment")).toBe(true);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("unknown id → 404 ATTACHMENT_NOT_FOUND", async () => {
    const res = await handler(authed("GET", "/api/attachments/nope"));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("ATTACHMENT_NOT_FOUND");
  });
});

describe("POST /api/projects/:slug/wiki/pages/:pageSlug/attachments", () => {
  it("uploads to a wiki page → 201, NO activity emitted", async () => {
    const before = (db.prepare("SELECT COUNT(*) AS c FROM task_activity").get() as { c: number }).c;
    const res = await handler(uploadReq("/api/projects/p1/wiki/pages/home/attachments", WIKI_BYTES, "wiki-pic.png"));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data).toMatchObject({ wikiPageId: "w1", taskId: null, filename: "wiki-pic.png" });
    const after = (db.prepare("SELECT COUNT(*) AS c FROM task_activity").get() as { c: number }).c;
    expect(after).toBe(before);
  });
});

describe("DELETE /api/attachments/:id", () => {
  let id: string;
  let sha: string;

  beforeAll(async () => {
    const { body } = await uploadToTask(DOOMED_TEXT, "doomed.txt");
    id = body.data.id;
    sha = body.data.sha256;
  });

  it("member-bound key passes middleware but is still denied by the service guard (AttachmentDeleteForbidden)", async () => {
    const res = await handler(authed("DELETE", `/api/attachments/${id}`, undefined, MEMBER_KEY));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("ATTACHMENT_DELETE_FORBIDDEN");
  });

  it("service guard: non-uploader non-admin identity → AttachmentDeleteForbidden", async () => {
    const verdict = await runServiceRemove(id, {
      keyId: "k2", keyName: "Bob", userId: "u2", userName: "Bob", role: "member",
    });
    expect(verdict.outcome).toBe("Left");
    expect(verdict.errorTag).toBe("AttachmentDeleteForbidden");
    // Row still there.
    expect(db.prepare("SELECT id FROM attachments WHERE id = ?").get(id)).toBeTruthy();
  });

  it("uploader → 204, blob gone; repeat → 404", async () => {
    const del = await handler(authed("DELETE", `/api/attachments/${id}`));
    expect(del.status).toBe(204);
    expect(existsSync(join(blobDir(), sha))).toBe(false);
    const again = await handler(authed("DELETE", `/api/attachments/${id}`));
    expect(again.status).toBe(404);
    expect((await again.json()).error.code).toBe("ATTACHMENT_NOT_FOUND");
  });

  it("service guard: admin identity may delete another user's attachment", async () => {
    const { body } = await uploadToTask(SVG_TEXT, "admin-del.svg");
    const verdict = await runServiceRemove(body.data.id, {
      keyId: "k3", keyName: "Admin2", userId: "u3", userName: "Admin2", role: "admin",
    });
    expect(verdict.outcome).toBe("Right");
    expect(db.prepare("SELECT id FROM attachments WHERE id = ?").get(body.data.id)).toBeNull();
  });
});

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

describe("GET /api/projects/:slug/tasks/:taskId/attachments", () => {
  it("lists uploads oldest-first with resolved labels", async () => {
    // Fresh fixtures — earlier describes may have deduped/deleted theirs.
    await handler(uploadReq("/api/projects/p1/tasks/t1/attachments", new TextEncoder().encode("list-a"), "list-a.txt"));
    await handler(uploadReq("/api/projects/p1/tasks/t1/attachments", new TextEncoder().encode("list-b"), "list-b.txt"));
    const res = await handler(authed("GET", "/api/projects/p1/tasks/t1/attachments"));
    expect(res.status).toBe(200);
    const { data } = await res.json();
    const names = data.map((a: { filename: string }) => a.filename);
    expect(names).toContain("list-a.txt");
    expect(names).toContain("list-b.txt");
    const aRow = data.find((a: { filename: string }) => a.filename === "list-a.txt");
    expect(aRow.uploadedBy).toBe("u1");
    expect(aRow.uploadedByLabel).toBe("Maria");
    expect(aRow.wikiPageId).toBeNull();
    // created_at ASC, id ASC ordering is stable (non-decreasing keys)
    for (let i = 1; i < data.length; i++) {
      const prev = `${data[i - 1].createdAt}|${data[i - 1].id}`;
      const curr = `${data[i].createdAt}|${data[i].id}`;
      expect(prev <= curr || data[i - 1].createdAt < data[i].createdAt).toBe(true);
    }
  });

  it("unknown task → 404 TASK_NOT_FOUND", async () => {
    const res = await handler(authed("GET", "/api/projects/p1/tasks/nope/attachments"));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("TASK_NOT_FOUND");
  });

  it("member-bound key → 403 FORBIDDEN at the middleware (consistent with DELETE)", async () => {
    const res = await handler(authed("GET", "/api/projects/p1/tasks/t1/attachments", undefined, MEMBER_KEY));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("FORBIDDEN");
  });
});

describe("GET /api/projects/:slug/wiki/pages/:pageSlug/attachments", () => {
  it("empty list for untouched page, then lists after upload", async () => {
    const empty = await handler(authed("GET", "/api/projects/p1/wiki/pages/child/attachments"));
    expect(empty.status).toBe(200);
    expect((await empty.json()).data).toEqual([]);

    await handler(uploadReq("/api/projects/p1/wiki/pages/child/attachments", new TextEncoder().encode("child-bytes"), "child-pic.png"));
    const child = await handler(authed("GET", "/api/projects/p1/wiki/pages/child/attachments"));
    expect(child.status).toBe(200);
    const { data } = await child.json();
    expect(data).toHaveLength(1);
    expect(data[0]!).toMatchObject({ filename: "child-pic.png", taskId: null });
  });

  it("unknown page → 404 PAGE_NOT_FOUND", async () => {
    const res = await handler(authed("GET", "/api/projects/p1/wiki/pages/nope/attachments"));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("PAGE_NOT_FOUND");
  });
});

describe("GET /api/share/:token/attachments/:id", () => {
  let wikiAttachmentId: string;
  let liveToken: string;
  let liveLinkId: string;
  let expiredToken: string;
  let childToken: string;

  beforeAll(async () => {
    const res = await handler(uploadReq("/api/projects/p1/wiki/pages/home/attachments", SHARE_PNG, "shared.png"));
    wikiAttachmentId = (await res.json()).data.id;
    const live = await createShareLink("home");
    liveToken = live.token;
    liveLinkId = live.id;
    expiredToken = (await createShareLink("home", "2020-01-01T00:00:00.000Z")).token;
    childToken = (await createShareLink("child")).token;
  });

  it("happy path: serves bytes unauthenticated inside the shared subtree", async () => {
    const res = await handler(pub(`/api/share/${liveToken}/attachments/${wikiAttachmentId}`));
    expect(res.status).toBe(200);
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(Buffer.from(buf).equals(Buffer.from(SHARE_PNG))).toBe(true);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("expired token → SHARE_LINK_NOT_FOUND", async () => {
    const res = await handler(pub(`/api/share/${expiredToken}/attachments/${wikiAttachmentId}`));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("SHARE_LINK_NOT_FOUND");
  });

  it("revoked token kills access → SHARE_LINK_NOT_FOUND", async () => {
    const del = await handler(authed("DELETE", `/api/projects/p1/wiki/share/${liveLinkId}`));
    expect(del.status).toBe(204);
    const res = await handler(pub(`/api/share/${liveToken}/attachments/${wikiAttachmentId}`));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("SHARE_LINK_NOT_FOUND");
  });

  it("attachment outside the shared subtree → ATTACHMENT_NOT_FOUND", async () => {
    // childToken shares only w2; the attachment lives on w1.
    const res = await handler(pub(`/api/share/${childToken}/attachments/${wikiAttachmentId}`));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("ATTACHMENT_NOT_FOUND");
  });

  it("burst beyond the dedicated share bucket → 429 RATE_LIMITED", async () => {
    let saw429 = false;
    for (let i = 0; i < 45; i++) {
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

describe("Chat attachments — upload/list/serve/delete", () => {
  const CHAT = "/api/projects/p1/assistant/chat/c1/attachments";
  const mdBytes = new TextEncoder().encode("# Notes\n\nhello world");
  let uploadedId = "";
  let uploadedSha = "";

  it("uploads a markdown document → 201, server-sniffed text/markdown, thread created lazily", async () => {
    const activityBefore = (db.prepare("SELECT COUNT(*) AS n FROM task_activity").get() as { n: number }).n;
    const res = await handler(uploadReq(CHAT, mdBytes, "notes.md"));
    expect(res.status).toBe(201);
    const { data } = await res.json();
    uploadedId = data.id;
    uploadedSha = data.sha256;
    expect(data).toMatchObject({
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
  });

  it("accepts an image and lists both, oldest-first fields present", async () => {
    const img = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7, 7]);
    const up = await handler(uploadReq(CHAT, img, "shot.png"));
    expect(up.status).toBe(201);
    expect((await up.json()).data.mimeType).toBe("image/png");

    const list = await handler(authed("GET", CHAT));
    expect(list.status).toBe(200);
    const { data } = await list.json();
    const names = data.map((a: { filename: string }) => a.filename);
    expect(names).toContain("notes.md");
    expect(names).toContain("shot.png");
    expect(data.every((a: { chatId: string }) => a.chatId === "c1")).toBe(true);
  });

  it("zero-byte file → 422 INVALID_ARGS naming it as empty", async () => {
    const res = await handler(uploadReq(CHAT, new Uint8Array(0), "empty.txt"));
    expect(res.status).toBe(422);
    const { error } = await res.json();
    expect(error.code).toBe("INVALID_ARGS");
    expect(error.message).toContain("empty.txt");
    expect(error.message).toContain("empty");
  });

  it("sniffed-but-unsupported type (SVG) → 422 INVALID_ARGS", async () => {
    const res = await handler(uploadReq(CHAT, SVG_TEXT, "logo.svg"));
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("INVALID_ARGS");
  });

  it("per-file oversize → 413 PAYLOAD_TOO_LARGE naming the file (5 MB chat cap)", async () => {
    const big = new Uint8Array(CHAT_ATTACHMENT_MAX_UPLOAD_BYTES + 1024);
    const res = await handler(uploadReq(CHAT, big, "big.txt"));
    expect(res.status).toBe(413);
    const { error } = await res.json();
    expect(error.code).toBe("PAYLOAD_TOO_LARGE");
    expect(error.message).toContain("big.txt");
  });

  it("GET /api/chat-attachments/:id serves byte-identical bytes; text downloads (not inline)", async () => {
    const res = await handler(authed("GET", `/api/chat-attachments/${uploadedId}`));
    expect(res.status).toBe(200);
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(Buffer.from(buf).equals(Buffer.from(mdBytes))).toBe(true);
    expect(res.headers.get("content-type")).toBe("text/markdown");
    expect((res.headers.get("content-disposition") ?? "").startsWith("attachment")).toBe(true);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("unknown id → 404 ATTACHMENT_NOT_FOUND", async () => {
    const res = await handler(authed("GET", "/api/chat-attachments/nope"));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("ATTACHMENT_NOT_FOUND");
  });

  it("member-bound key → 403 AttachmentDeleteForbidden; direct service guard agrees", async () => {
    const mid = await handler(authed("DELETE", `/api/chat-attachments/${uploadedId}`, undefined, MEMBER_KEY));
    expect(mid.status).toBe(403);
    expect((await mid.json()).error.code).toBe("ATTACHMENT_DELETE_FORBIDDEN");

    const verdict = await runServiceRemoveChat(uploadedId, {
      keyId: "k2", keyName: "Bob", userId: "u2", userName: "Bob", role: "member",
    });
    expect(verdict.outcome).toBe("Left");
    expect(verdict.errorTag).toBe("AttachmentDeleteForbidden");
    expect(db.prepare("SELECT id FROM chat_attachments WHERE id = ?").get(uploadedId)).toBeTruthy();
  });

  it("uploader delete → 204, blob gone; repeat → 404", async () => {
    const del = await handler(authed("DELETE", `/api/chat-attachments/${uploadedId}`));
    expect(del.status).toBe(204);
    expect(existsSync(join(blobDir(), uploadedSha))).toBe(false);
    const again = await handler(authed("DELETE", `/api/chat-attachments/${uploadedId}`));
    expect(again.status).toBe(404);
    expect((await again.json()).error.code).toBe("ATTACHMENT_NOT_FOUND");
  });
});

describe("Chat attachments — kill switch (LXK_DISABLE_CHAT_ATTACHMENTS=1)", () => {
  it("refuses an upload with 403 CHAT_ATTACHMENTS_DISABLED", async () => {
    // On the Bun host `currentEnv` resolves from process.env (no RuntimeEnv
    // layer); set the operator flag for the duration of this one request.
    process.env.LXK_DISABLE_CHAT_ATTACHMENTS = "1";
    try {
      const res = await handler(
        uploadReq("/api/projects/p1/assistant/chat/c1/attachments", new TextEncoder().encode("x"), "x.txt")
      );
      expect(res.status).toBe(403);
      expect((await res.json()).error.code).toBe("CHAT_ATTACHMENTS_DISABLED");
    } finally {
      delete process.env.LXK_DISABLE_CHAT_ATTACHMENTS;
    }
  });
});

// Threads are owner-scoped: knowing a chatId must not grant a project member
// access to another member's files. u4 is a real project member (explicit
// grant) but not the owner of chat c1 (owned by u1).
describe("Chat attachments — cross-user isolation", () => {
  const CHAT = "/api/projects/p1/assistant/chat/c1/attachments";
  let victimId = "";

  beforeAll(async () => {
    const res = await handler(uploadReq(CHAT, new TextEncoder().encode("victim secret"), "victim.txt"));
    expect(res.status).toBe(201);
    victimId = (await res.json()).data.id;
  });

  it("a different project member cannot list another member's thread", async () => {
    const res = await handler(authed("GET", CHAT, undefined, MEMBER2_KEY));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("ASSISTANT_THREAD_NOT_FOUND");
  });

  it("a different project member cannot download another member's attachment", async () => {
    const res = await handler(authed("GET", `/api/chat-attachments/${victimId}`, undefined, MEMBER2_KEY));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("ASSISTANT_THREAD_NOT_FOUND");
  });

  it("a different project member cannot bind an upload into another member's thread", async () => {
    const res = await handler(uploadReq(CHAT, new TextEncoder().encode("intruder"), "intruder.txt", MEMBER2_KEY));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("ASSISTANT_THREAD_NOT_FOUND");
  });

  it("a different project member cannot delete another member's attachment", async () => {
    const res = await handler(authed("DELETE", `/api/chat-attachments/${victimId}`, undefined, MEMBER2_KEY));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("ATTACHMENT_DELETE_FORBIDDEN");
  });

  it("a non-member is denied by project access before the thread gate", async () => {
    const res = await handler(authed("GET", CHAT, undefined, MEMBER_KEY));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("FORBIDDEN");
  });

  it("the owner still lists and serves their own attachment", async () => {
    const list = await handler(authed("GET", CHAT));
    expect(list.status).toBe(200);
    const serve = await handler(authed("GET", `/api/chat-attachments/${victimId}`));
    expect(serve.status).toBe(200);
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
