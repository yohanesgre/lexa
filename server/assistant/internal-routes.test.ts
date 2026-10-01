import { describe, expect, it, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { createBunSqliteDriver } from "../db/drivers/bun-sqlite";
import {
  handleInternalAssistantRequest,
  mirrorThread,
  readLegacyThread,
} from "./internal-routes";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

let dir: string;
let db: Database;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "lexa-assistant-internal-routes-"));
  runMigrations(join(dir, "test.db"), MIGRATIONS);
  db = new Database(join(dir, "test.db"));
  db.exec("PRAGMA foreign_keys = ON");
});

afterAll(() => {
  try { db.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  db.exec("DELETE FROM assistant_threads");
  db.exec("DELETE FROM projects");
  db.exec("INSERT INTO projects (id, name, slug) VALUES ('p1', 'P', 'p1')");
});

function seedThread(
  messages: unknown,
  overrides: { title?: string | null; summary?: string | null; summarizedCount?: number } = {}
) {
  db.prepare(
    `INSERT INTO assistant_threads (document_type, document_id, project_id, owner_user_id, title, summary, summarized_count, messages)
     VALUES ('chat', 'c1', 'p1', 'u1', ?, ?, ?, ?)`
  ).run(
    overrides.title ?? null,
    overrides.summary ?? null,
    overrides.summarizedCount ?? 0,
    JSON.stringify(messages)
  );
}

function row() {
  return db.prepare("SELECT messages, summary, summarized_count, title FROM assistant_threads WHERE document_id = 'c1'").get() as
    | { messages: string; summary: string | null; summarized_count: number; title: string | null }
    | null;
}

describe("readLegacyThread", () => {
  it("returns the parsed D1 messages for an existing transcript", async () => {
    const messages = [{ role: "user", content: "hello" }, { role: "assistant", content: "hi" }];
    seedThread(messages);
    await expect(
      Effect.runPromise(readLegacyThread(createBunSqliteDriver(db), "chat", "c1"))
    ).resolves.toEqual(messages);
  });

  it("returns null for a missing row and for an empty transcript", async () => {
    const driver = createBunSqliteDriver(db);
    await expect(Effect.runPromise(readLegacyThread(driver, "chat", "missing"))).resolves.toBeNull();
    seedThread([]);
    await expect(Effect.runPromise(readLegacyThread(driver, "chat", "c1"))).resolves.toBeNull();
  });
});

describe("mirrorThread", () => {
  it("writes messages/summary/count and backfills a NULL title", async () => {
    seedThread([{ role: "user", content: "old" }], { title: null, summary: null });
    const messages = [{ id: "m1", role: "user", parts: [{ type: "text", text: "new" }] }];
    await Effect.runPromise(
      mirrorThread(createBunSqliteDriver(db), {
        threadKey: "chat:c1",
        projectId: "p1",
        messages,
        summary: "condensed",
        summarizedCount: 4,
        title: "First Title",
      })
    );
    const updated = row();
    expect(JSON.parse(updated!.messages)).toEqual(messages);
    expect(updated!.summary).toBe("condensed");
    expect(updated!.summarized_count).toBe(4);
    expect(updated!.title).toBe("First Title");
  });

  it("keeps an existing title/summary/summarized_count when the mirror omits them (COALESCE, null-safe)", async () => {
    seedThread([], { title: "Renamed", summary: "keep me", summarizedCount: 7 });
    await Effect.runPromise(
      mirrorThread(createBunSqliteDriver(db), {
        threadKey: "chat:c1",
        projectId: "p1",
        messages: [{ id: "m1", role: "assistant", parts: [{ type: "text", text: "x" }] }],
        summary: null,
        summarizedCount: null,
        title: null,
      })
    );
    const updated = row();
    expect(updated!.title).toBe("Renamed");
    expect(updated!.summary).toBe("keep me");
    // The P2 defect: a literal 0 clobbered a real summarized_count on every
    // persist. `null` must preserve it.
    expect(updated!.summarized_count).toBe(7);
  });

  it("is a no-op for an unparseable thread key", async () => {
    await expect(
      Effect.runPromise(
        mirrorThread(createBunSqliteDriver(db), {
          threadKey: "not-a-thread",
          projectId: "p1",
          messages: [],
          summary: null,
          summarizedCount: 0,
          title: null,
        })
      )
    ).resolves.toEqual({ ok: true });
  });
});

describe("handleInternalAssistantRequest", () => {
  const driverOf = () => createBunSqliteDriver(db);

  it("POST /api/internal/assistant/mirror updates the D1 row", async () => {
    seedThread([{ role: "user", content: "old" }]);
    const result = await handleInternalAssistantRequest({
      method: "POST",
      path: "/api/internal/assistant/mirror",
      body: {
        threadKey: "chat:c1",
        projectId: "p1",
        messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "new" }] }],
        summary: null,
        summarizedCount: 1,
        title: null,
      },
      driver: driverOf(),
    });
    expect(result).toEqual({ status: 200, body: { ok: true } });
    expect(JSON.parse(row()!.messages)).toEqual([{ id: "m1", role: "user", parts: [{ type: "text", text: "new" }] }]);
  });

  it("rejects an invalid mirror payload with 400", async () => {
    const result = await handleInternalAssistantRequest({
      method: "POST",
      path: "/api/internal/assistant/mirror",
      body: { threadKey: "chat:c1" },
      driver: driverOf(),
    });
    expect(result.status).toBe(400);
  });

  it("GET /api/internal/assistant/legacy/:threadKey serves the D1 transcript", async () => {
    const messages = [{ role: "user", content: "hello" }];
    seedThread(messages);
    const result = await handleInternalAssistantRequest({
      method: "GET",
      path: "/api/internal/assistant/legacy/chat%3Ac1",
      body: null,
      driver: driverOf(),
    });
    expect(result).toEqual({ status: 200, body: { messages } });
  });

  it("404s a missing legacy thread and an unknown internal route", async () => {
    const missing = await handleInternalAssistantRequest({
      method: "GET",
      path: "/api/internal/assistant/legacy/chat%3Amissing",
      body: null,
      driver: driverOf(),
    });
    expect(missing.status).toBe(404);
    const unknown = await handleInternalAssistantRequest({
      method: "GET",
      path: "/api/internal/assistant/nope",
      body: null,
      driver: driverOf(),
    });
    expect(unknown.status).toBe(404);
  });
});
