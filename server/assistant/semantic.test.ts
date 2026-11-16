import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { createBunSqliteDriver } from "../db/drivers/bun-sqlite";
import type { DbDriver } from "../db/db";
import type { RuntimeEnv } from "../env";
import { encodeEmbedding } from "../../shared/assistant-chunks";
import { EMBEDDINGS_MODEL_DEFAULT } from "./embeddings-client";
import { semanticHint, semanticSearch } from "./semantic";

// Read-path contract (tech-design §5.2): query embed → project scan → cosine
// top-k → hits; the hint is top-1 above SEMANTIC_HINT_MIN_COSINE in the fixed
// labeled block. Unconfigured/embed/DB failures are null, never throws.

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));
const DIMENSIONS = 768;

const CONFIGURED_ENV: RuntimeEnv = {
  LXK_PUBLIC_URL: "http://lexa.test",
  LXK_WORKERS_AI_ACCOUNT_ID: "acct-123",
  LXK_WORKERS_AI_API_TOKEN: "token-123",
};
const UNCONFIGURED_ENV: RuntimeEnv = { LXK_PUBLIC_URL: "http://lexa.test" };

function sparseVector(entries: Record<number, number>): number[] {
  const vector = new Array<number>(DIMENSIONS).fill(0);
  for (const [index, value] of Object.entries(entries)) vector[Number(index)] = value;
  return vector;
}

// The query vector the fake Workers AI call returns; each case sets it.
let queryVector = sparseVector({ 0: 1 });
let fetchCalls = 0;

const fetchImpl = (async () => {
  fetchCalls += 1;
  return new Response(JSON.stringify({ data: [{ embedding: queryVector }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}) as unknown as typeof fetch;

let dir: string;
let sqlite: Database;
let driver: DbDriver;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "lexa-semantic-"));
  const dbPath = join(dir, "test.db");
  runMigrations(dbPath, MIGRATIONS);
  sqlite = new Database(dbPath);
  driver = createBunSqliteDriver(sqlite);
  sqlite.exec(`
INSERT INTO projects (id, name, slug, key, next_task_number) VALUES
  ('p1', 'One', 'p1', 'EG', 1),
  ('p2', 'Two', 'p2', 'P2', 0);
INSERT INTO columns (id, project_id, name, position) VALUES ('c1', 'p1', 'Todo', 0);
INSERT INTO swimlanes (id, project_id, name, position, kind) VALUES ('s1', 'p1', 'Backlog', 0, 'backlog');
INSERT INTO wiki_pages (id, project_id, title, slug, content, content_text, position)
  VALUES ('w1', 'p1', 'Release checklist', 'release-checklist', 'Ship on Friday', 'Ship on Friday', 0);
INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, key, number)
  VALUES ('t1', 'p1', 'c1', 's1', 'Deploy pipeline', 'a0', 'EG-1', 1);
INSERT INTO project_memory (id, project_id, content) VALUES ('m1', 'p1', 'Deploys happen on Fridays');
`);
  const insert = sqlite.prepare(
    `INSERT INTO assistant_embeddings (id, project_id, kind, ref_id, chunk_index, content, embedding, embedding_model)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const blob = (entries: Record<number, number>) => encodeEmbedding(Float32Array.from(sparseVector(entries)));
  // Orthonormal-ish seeds: scores against query e0 are 1.0, 0.6, 0.0.
  insert.run("e-wiki", "p1", "wiki", "w1", 0, "Release checklist\nShip on Friday", blob({ 0: 1 }), EMBEDDINGS_MODEL_DEFAULT);
  insert.run("e-task", "p1", "task", "t1", 0, "Deploy pipeline\nRun the release job", blob({ 0: 0.6, 1: 0.8 }), EMBEDDINGS_MODEL_DEFAULT);
  insert.run("e-memory", "p1", "memory", "m1", 0, "Deploys happen on Fridays", blob({ 1: 1 }), EMBEDDINGS_MODEL_DEFAULT);
  // Corrupt row: 3 bytes is not a float32 vector. It must be skipped, never
  // scored or thrown.
  insert.run("e-corrupt", "p1", "wiki", "w1", 1, "corrupt blob", new Uint8Array([1, 2, 3]), EMBEDDINGS_MODEL_DEFAULT);
});

afterAll(() => {
  try { sqlite.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

describe("semanticSearch", () => {
  it("ranks by cosine with live source titles and locators, skipping corrupt rows", async () => {
    queryVector = sparseVector({ 0: 1 });
    const hits = await semanticSearch(driver, CONFIGURED_ENV, "p1", "ship the release", 5, undefined, { fetchImpl });
    expect(hits).not.toBeNull();
    if (hits === null) return;
    expect(hits.map((hit) => hit.kind)).toEqual(["wiki", "task", "memory"]);
    expect(hits.map((hit) => hit.title)).toEqual(["Release checklist", "Deploy pipeline", "Project memory"]);
    expect(hits[0]!.locator).toBe("release-checklist");
    expect(hits[1]!.locator).toBe("EG-1");
    expect(hits[2]!.locator).toBe("Deploys happen on Fridays");
    expect(hits[0]!.score).toBeCloseTo(1, 5);
    expect(hits[1]!.score).toBeCloseTo(0.6, 5);
    expect(hits[2]!.score).toBeCloseTo(0, 5);
    // snippet is the capped chunk content; no dedupe, one hit per chunk.
    expect(hits[1]!.snippet).toBe("Deploy pipeline\nRun the release job");
    expect(hits.some((hit) => hit.snippet === "corrupt blob")).toBe(false);
  });

  it("honours the kinds filter and the limit", async () => {
    queryVector = sparseVector({ 0: 1 });
    const tasksOnly = await semanticSearch(driver, CONFIGURED_ENV, "p1", "release", 5, ["task"], { fetchImpl });
    expect(tasksOnly?.map((hit) => hit.kind)).toEqual(["task"]);
    const topOne = await semanticSearch(driver, CONFIGURED_ENV, "p1", "release", 1, undefined, { fetchImpl });
    expect(topOne).toHaveLength(1);
    expect(topOne?.[0]?.title).toBe("Release checklist");
  });

  it("returns [] when the project has no candidates", async () => {
    queryVector = sparseVector({ 0: 1 });
    const hits = await semanticSearch(driver, CONFIGURED_ENV, "p2", "anything", 5, undefined, { fetchImpl });
    expect(hits).toEqual([]);
  });

  it("returns null without calling the provider when the env is unconfigured", async () => {
    fetchCalls = 0;
    const hits = await semanticSearch(driver, UNCONFIGURED_ENV, "p1", "release", 5, undefined, { fetchImpl });
    expect(hits).toBeNull();
    expect(fetchCalls).toBe(0);
  });

  it("returns null when the query embed fails", async () => {
    const failing = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const hits = await semanticSearch(driver, CONFIGURED_ENV, "p1", "release", 5, undefined, { fetchImpl: failing });
    expect(hits).toBeNull();
  });
});

describe("semanticHint", () => {
  it("returns the fixed labeled block for a top hit above the threshold", async () => {
    queryVector = sparseVector({ 0: 1 });
    const hint = await semanticHint(driver, CONFIGURED_ENV, "p1", "when do we ship", { fetchImpl });
    expect(hint).toBe(
      "[Possibly relevant — auto-retrieved from project content; not authoritative]\n" +
        "Release checklist (wiki): Release checklist\nShip on Friday"
    );
  });

  it("returns null when the best hit is below the threshold", async () => {
    // e2 is orthogonal to every seeded vector: top score 0 < 0.58.
    queryVector = sparseVector({ 2: 1 });
    const hint = await semanticHint(driver, CONFIGURED_ENV, "p1", "unrelated wording", { fetchImpl });
    expect(hint).toBeNull();
  });

  it("returns null when unconfigured or when the embed fails", async () => {
    fetchCalls = 0;
    const unconfigured = await semanticHint(driver, UNCONFIGURED_ENV, "p1", "release", { fetchImpl });
    expect(unconfigured).toBeNull();
    expect(fetchCalls).toBe(0);
    const failing = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const failedEmbed = await semanticHint(driver, CONFIGURED_ENV, "p1", "release", { fetchImpl: failing });
    expect(failedEmbed).toBeNull();
  });
});
