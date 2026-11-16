import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { createApiHandler } from "./http";
import type { RuntimeEnv } from "../env";
import { encodeEmbedding } from "../../shared/assistant-chunks";
import { EMBEDDINGS_MODEL_DEFAULT } from "../assistant/embeddings-client";

// GET /api/projects/:slug/semantic-search contract (docs/API.md):
// 200 { results: [{kind,title,snippet,locator}] }, 503 EMBEDDINGS_UNCONFIGURED,
// 502 EMBEDDINGS_UPSTREAM, INVALID_ARGS for q/kinds/limit. Args are validated
// before the env gate.

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));
const DIMENSIONS = 768;

const API_KEY = "lxk_" + "s".repeat(43);

const CONFIGURED_ENV: RuntimeEnv = {
  LXK_PUBLIC_URL: "http://lexa.test",
  LXK_WORKERS_AI_ACCOUNT_ID: "acct-123",
  LXK_WORKERS_AI_API_TOKEN: "token-123",
};
const UNCONFIGURED_ENV: RuntimeEnv = { LXK_PUBLIC_URL: "http://lexa.test" };

async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function sparseVector(entries: Record<number, number>): number[] {
  const vector = new Array<number>(DIMENSIONS).fill(0);
  for (const [index, value] of Object.entries(entries)) vector[Number(index)] = value;
  return vector;
}

let dir: string;
let db: Database;
let configured: (req: Request) => Promise<Response>;
let unconfigured: (req: Request) => Promise<Response>;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "lexa-semantic-api-"));
  const dbPath = join(dir, "test.db");
  runMigrations(dbPath, MIGRATIONS);
  db = new Database(dbPath);
  const hash = await sha256(API_KEY);
  db.exec(`
INSERT INTO users (id, email, name, role) VALUES ('u1', 'root@lexa.test', 'Root', 'superadmin');
INSERT INTO api_keys (id, name, key_hash, user_id) VALUES ('k1', 'semantic', '${hash}', 'u1');
INSERT INTO projects (id, name, slug, key, next_task_number) VALUES ('p1', 'One', 'p1', 'EG', 1);
INSERT INTO columns (id, project_id, name, position) VALUES ('c1', 'p1', 'Todo', 0);
INSERT INTO swimlanes (id, project_id, name, position, kind) VALUES ('s1', 'p1', 'Backlog', 0, 'backlog');
INSERT INTO wiki_pages (id, project_id, title, slug, content, content_text, position)
  VALUES ('w1', 'p1', 'Release checklist', 'release-checklist', 'Ship on Friday', 'Ship on Friday', 0);
INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, key, number)
  VALUES ('t1', 'p1', 'c1', 's1', 'Deploy pipeline', 'a0', 'EG-1', 1);
`);
  const insert = db.prepare(
    `INSERT INTO assistant_embeddings (id, project_id, kind, ref_id, chunk_index, content, embedding, embedding_model)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  insert.run("e-wiki", "p1", "wiki", "w1", 0, "Release checklist\nShip on Friday", encodeEmbedding(Float32Array.from(sparseVector({ 0: 1 }))), EMBEDDINGS_MODEL_DEFAULT);
  insert.run("e-task", "p1", "task", "t1", 0, "Deploy pipeline\nRun the release job", encodeEmbedding(Float32Array.from(sparseVector({ 0: 0.6, 1: 0.8 }))), EMBEDDINGS_MODEL_DEFAULT);
  configured = createApiHandler(dbPath, CONFIGURED_ENV);
  unconfigured = createApiHandler(dbPath, UNCONFIGURED_ENV);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(() => {
  try { db.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

function search(path: string, key: string = API_KEY): Request {
  return new Request(`http://lexa.test${path}`, { headers: { authorization: `Bearer ${key}` } });
}

function stubEmbedding(queryVector: number[]): void {
  vi.stubGlobal("fetch", async () =>
    new Response(JSON.stringify({ data: [{ embedding: queryVector }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  );
}

describe("GET /api/projects/:slug/semantic-search", () => {
  it("validates q, kinds and limit before the env gate, then reports 503 unconfigured", async () => {
    const missingQ = await unconfigured(search("/api/projects/p1/semantic-search"));
    expect(missingQ.status).toBe(422);
    expect(((await missingQ.json()) as { error: { code: string } }).error.code).toBe("INVALID_ARGS");

    const badKinds = await unconfigured(search("/api/projects/p1/semantic-search?q=release&kinds=wiki,bogus"));
    expect(badKinds.status).toBe(422);
    expect(((await badKinds.json()) as { error: { code: string } }).error.code).toBe("INVALID_ARGS");

    const badLimit = await unconfigured(search("/api/projects/p1/semantic-search?q=release&limit=11"));
    expect(badLimit.status).toBe(422);
    expect(((await badLimit.json()) as { error: { code: string } }).error.code).toBe("INVALID_ARGS");

    const unset = await unconfigured(search("/api/projects/p1/semantic-search?q=release"));
    expect(unset.status).toBe(503);
    expect(((await unset.json()) as { error: { code: string } }).error.code).toBe("EMBEDDINGS_UNCONFIGURED");
  });

  it("returns ranked results without the score, honouring kinds and limit", async () => {
    stubEmbedding(sparseVector({ 0: 1 }));
    const res = await configured(search("/api/projects/p1/semantic-search?q=when%20do%20we%20ship"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: Array<Record<string, unknown>> };
    expect(body.results).toEqual([
      { kind: "wiki", title: "Release checklist", snippet: "Release checklist\nShip on Friday", locator: "release-checklist" },
      { kind: "task", title: "Deploy pipeline", snippet: "Deploy pipeline\nRun the release job", locator: "EG-1" },
    ]);
    expect(Object.keys(body.results[0]!).sort()).toEqual(["kind", "locator", "snippet", "title"]);

    const tasksOnly = await configured(search("/api/projects/p1/semantic-search?q=release&kinds=task"));
    expect(tasksOnly.status).toBe(200);
    const tasksBody = (await tasksOnly.json()) as { results: Array<{ kind: string }> };
    expect(tasksBody.results.map((result) => result.kind)).toEqual(["task"]);

    const limited = await configured(search("/api/projects/p1/semantic-search?q=release&limit=1"));
    expect(limited.status).toBe(200);
    const limitedBody = (await limited.json()) as { results: Array<{ title: string }> };
    expect(limitedBody.results).toHaveLength(1);
    expect(limitedBody.results[0]!.title).toBe("Release checklist");
  });

  it("returns 502 when the query embed fails", async () => {
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 500 }));
    const res = await configured(search("/api/projects/p1/semantic-search?q=release"));
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("EMBEDDINGS_UPSTREAM");
  });
});
