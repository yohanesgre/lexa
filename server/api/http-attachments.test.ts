import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { Effect, Layer } from "effect";
import { runMigrations } from "../db/migrate";
import { Sqlite } from "../db/database";
import { AttachmentService } from "../services/attachment.service";
import { Storage, StorageConfig } from "../storage/storage";
import { resolveStorageConfig } from "../storage/config";
import { createApiHandler } from "./http";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

const ADMIN_KEY = "lxk_" + "a".repeat(43);
const MEMBER_KEY = "lxk_" + "b".repeat(43);

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
  const dbPath = join(dir, "test.db");
  runMigrations(dbPath, MIGRATIONS);
  // Resolved at createApiHandler time — 1 MB cap keeps the oversize case fast
  // without affecting the small fixtures below.
  process.env.LXK_MAX_UPLOAD_MB = "1";
  const adminHash = await sha256(ADMIN_KEY);
  const memberHash = await sha256(MEMBER_KEY);
  db = new Database(dbPath);
  db.exec(`
INSERT INTO users (id, email, name, role) VALUES ('u1', 'maria@lexa.test', 'Maria', 'superadmin');
INSERT INTO users (id, email, name, role) VALUES ('u2', 'bob@lexa.test', 'Bob', 'member');
-- Real row for task_activity.actor_user_id FK when the service-level guard
-- test deletes with an admin identity.
INSERT INTO users (id, email, name, role) VALUES ('u3', 'admin2@lexa.test', 'Admin2', 'member');
INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k1', 'test-admin', '${adminHash}', 'u1');
INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k2', 'test-member', '${memberHash}', 'u2');
INSERT INTO projects (id, name, slug, key, next_task_number) VALUES ('p1', 'P', 'p1', 'EG', 1);
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
    Layer.succeed(Sqlite, db),
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

  it("member-bound key → 403 FORBIDDEN at the middleware (member keys unsupported on REST)", async () => {
    const res = await handler(authed("DELETE", `/api/attachments/${id}`, undefined, MEMBER_KEY));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("FORBIDDEN");
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
