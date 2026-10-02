import { describe, expect, it, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer } from "effect";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { createBunSqliteDriver } from "../db/drivers/bun-sqlite";
import { DbBunLive } from "../db/db";
import { RuntimeEnvLive, type RuntimeEnv } from "../runtime-env";
import {
  executeAssistantWriteTool,
  handleInternalAssistantRequest,
  mirrorThread,
  readLegacyThread,
  type HarnessTurnContext,
} from "./internal-routes";
import { applyAssistantWrite, type AssistantWriteApplyCtx } from "./write-execution";
import { resolveWorkerHarnessContext } from "./worker-tools";
import type { RegistryModelConfig } from "./model-factory";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));
const baseLayer = () => Layer.mergeAll(DbBunLive(db), RuntimeEnvLive({} as RuntimeEnv));

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
  db.exec("DELETE FROM assistant_call_logs");
  db.exec("DELETE FROM task_activity");
  db.exec("DELETE FROM assistant_tasks");
  db.exec("DELETE FROM assistant_pending_writes");
  db.exec("DELETE FROM assistant_threads");
  db.exec("DELETE FROM assistant_settings");
  db.exec("DELETE FROM tasks");
  db.exec("DELETE FROM columns");
  db.exec("DELETE FROM swimlanes");
  db.exec("DELETE FROM projects");
  db.exec("INSERT OR IGNORE INTO users (id, email, name) VALUES ('u1', 'u1@test.dev', 'U One')");
  db.exec("INSERT INTO projects (id, name, slug) VALUES ('p1', 'P', 'p1')");
});

// A minimal board + task + thread so both write-tool snapshot resolution and
// the pending-write FK (document_type, document_id) are satisfiable.
function seedTask() {
  db.exec("INSERT INTO columns (id, project_id, name, position) VALUES ('c1', 'p1', 'Todo', 1)");
  db.exec("INSERT INTO swimlanes (id, project_id, name, position, kind) VALUES ('s1', 'p1', 'Backlog', 1, 'backlog')");
  db.exec(
    `INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, priority, type, position, key, number)
     VALUES ('t1', 'p1', 'c1', 's1', 'Old title', 'medium', 'task', 'a0', 'P-1', 1)`
  );
  db.exec(
    `INSERT INTO assistant_threads (document_type, document_id, project_id, owner_user_id, messages)
     VALUES ('chat', 'c1', 'p1', 'u1', '[]')`
  );
}

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

const IDENTITY = { actorUserId: "u1", projectId: "p1", threadKey: "chat:c1" };

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

describe("write-tool proposals (POST /api/internal/assistant/write-tool)", () => {
  const driverOf = () => createBunSqliteDriver(db);

  it("persists a pending row and returns the proposal", async () => {
    seedTask();
    const result = await handleInternalAssistantRequest({
      method: "POST",
      path: "/api/internal/assistant/write-tool",
      body: {
        name: "update_task",
        args: { ref: "P-1", title: "New title" },
        batchId: "b1",
        seq: 0,
        projectId: "p1",
        documentType: "chat",
        documentId: "c1",
        ownerUserId: "u1",
      },
      driver: driverOf(),
      identity: IDENTITY,
    });
    expect(result.status).toBe(200);
    const body = result.body as { proposed?: unknown; approvalId?: unknown };
    expect(body.proposed).toBe(true);
    expect(typeof body.approvalId).toBe("string");

    const row = db
      .prepare("SELECT tool_name, args, diff, status, batch_id, seq FROM assistant_pending_writes WHERE id = ?")
      .get(body.approvalId as string) as
      | { tool_name: string; args: string; diff: string; status: string; batch_id: string; seq: number }
      | null;
    expect(row).not.toBeNull();
    expect(row!.tool_name).toBe("update_task");
    expect(row!.status).toBe("pending");
    expect(row!.batch_id).toBe("b1");
    expect(row!.seq).toBe(0);
    expect(JSON.parse(row!.diff)).toMatchObject({ type: "task_update", taskRef: "P-1", taskTitle: "Old title" });
  });

  it("returns the tool's domain refusal without writing a row", async () => {
    seedTask();
    const result = await handleInternalAssistantRequest({
      method: "POST",
      path: "/api/internal/assistant/write-tool",
      body: {
        name: "update_task",
        args: { ref: "MISSING", title: "x" },
        batchId: "b1",
        seq: 0,
        projectId: "p1",
        documentType: "chat",
        documentId: "c1",
        ownerUserId: "u1",
      },
      driver: driverOf(),
      identity: IDENTITY,
    });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ proposed: false });
    const count = db.prepare("SELECT COUNT(*) AS n FROM assistant_pending_writes").get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("rejects an unknown write tool and a malformed payload", async () => {
    seedTask();
    const unknown = await executeAssistantWriteTool(driverOf(), {
      name: "not_a_tool",
      args: {},
      batchId: "b1",
      seq: 0,
      projectId: "p1",
      documentType: "chat",
      documentId: "c1",
      ownerUserId: "u1",
    });
    expect(unknown.status).toBe(400);
    const malformed = await handleInternalAssistantRequest({
      method: "POST",
      path: "/api/internal/assistant/write-tool",
      body: { name: "update_task" },
      driver: driverOf(),
    });
    expect(malformed.status).toBe(400);
  });

  it("403s a body project/owner that does not match the signed identity", async () => {
    seedTask();
    const result = await handleInternalAssistantRequest({
      method: "POST",
      path: "/api/internal/assistant/write-tool",
      body: {
        name: "update_task",
        args: { ref: "P-1", title: "New title" },
        batchId: "b1",
        seq: 0,
        projectId: "other",
        documentType: "chat",
        documentId: "c1",
        ownerUserId: "u1",
      },
      driver: driverOf(),
      identity: IDENTITY,
    });
    expect(result.status).toBe(403);
  });

  it("caps proposals per turn at MAX_WRITES_PER_TURN with the Bun path's error copy", async () => {
    seedTask();
    const call = (seq: number) =>
      handleInternalAssistantRequest({
        method: "POST",
        path: "/api/internal/assistant/write-tool",
        body: {
          name: "update_task",
          args: { ref: "P-1", title: `title-${seq}` },
          batchId: "budget-batch",
          seq,
          projectId: "p1",
          documentType: "chat",
          documentId: "c1",
          ownerUserId: "u1",
        },
        driver: driverOf(),
        identity: IDENTITY,
      });
    for (let seq = 0; seq < 8; seq++) {
      const ok = await call(seq);
      expect(ok.status).toBe(200);
      expect((ok.body as { proposed?: boolean }).proposed).toBe(true);
    }
    const over = await call(8);
    expect(over.body).toMatchObject({ proposed: false });
    expect((over.body as { error?: string }).error).toContain("write budget exceeded");
    const count = db.prepare("SELECT COUNT(*) AS n FROM assistant_pending_writes WHERE batch_id = 'budget-batch'").get() as { n: number };
    expect(count.n).toBe(8);
  });
});

describe("auto-mode write execution (POST /api/internal/assistant/write-execute)", () => {
  const driverOf = () => createBunSqliteDriver(db);

  it("calls the injected executor, returns the result, and inserts no pending row", async () => {
    seedTask();
    const seen: Array<{ name: string; args: Record<string, unknown>; projectId: string; ownerUserId: string }> = [];
    const result = await handleInternalAssistantRequest({
      method: "POST",
      path: "/api/internal/assistant/write-execute",
      body: { name: "update_task", args: { ref: "P-1", title: "New title" }, projectId: "p1", ownerUserId: "u1" },
      driver: driverOf(),
      identity: IDENTITY,
      deps: {
        executeWriteTool: async (input) => {
          seen.push(input);
          return { ok: true, applied: true, result: { id: "t1" } };
        },
      },
    });
    expect(result).toEqual({ status: 200, body: { ok: true, applied: true, result: { id: "t1" } } });
    expect(seen).toEqual([
      { name: "update_task", args: { ref: "P-1", title: "New title" }, projectId: "p1", ownerUserId: "u1" },
    ]);
    // Auto never takes the proposal path: no pending row exists.
    const count = db.prepare("SELECT COUNT(*) AS n FROM assistant_pending_writes").get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("forwards a partial bulk result unchanged", async () => {
    seedTask();
    const partial = { applied: 1, failed: 1, errors: ["TASK_NOT_FOUND: missing"] };
    const result = await handleInternalAssistantRequest({
      method: "POST",
      path: "/api/internal/assistant/write-execute",
      body: { name: "archive_task", args: { refs: ["P-1", "NOPE"] }, projectId: "p1", ownerUserId: "u1" },
      driver: driverOf(),
      identity: IDENTITY,
      deps: { executeWriteTool: async () => ({ ok: true, applied: true, result: { applied: ["P-1"], failed: [] }, partial }) },
    });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, applied: true, partial });
  });

  it("forwards a zero-applied failure unchanged", async () => {
    seedTask();
    const result = await handleInternalAssistantRequest({
      method: "POST",
      path: "/api/internal/assistant/write-execute",
      body: { name: "update_task", args: { ref: "NOPE", title: "x" }, projectId: "p1", ownerUserId: "u1" },
      driver: driverOf(),
      identity: IDENTITY,
      deps: { executeWriteTool: async () => ({ ok: false, applied: false, error: "TASK_NOT_FOUND: nope" }) },
    });
    expect(result).toEqual({ status: 200, body: { ok: false, applied: false, error: "TASK_NOT_FOUND: nope" } });
  });

  it("403s an identity mismatch, 400s a malformed/unknown tool, 502s unwired", async () => {
    seedTask();
    const mismatch = await handleInternalAssistantRequest({
      method: "POST",
      path: "/api/internal/assistant/write-execute",
      body: { name: "update_task", args: {}, projectId: "other", ownerUserId: "u1" },
      driver: driverOf(),
      identity: IDENTITY,
      deps: { executeWriteTool: async () => ({ ok: true, applied: true }) },
    });
    expect(mismatch.status).toBe(403);

    const malformed = await handleInternalAssistantRequest({
      method: "POST",
      path: "/api/internal/assistant/write-execute",
      body: { args: {} },
      driver: driverOf(),
      identity: IDENTITY,
    });
    expect(malformed.status).toBe(400);

    const unknown = await handleInternalAssistantRequest({
      method: "POST",
      path: "/api/internal/assistant/write-execute",
      body: { name: "not_a_tool", args: {}, projectId: "p1", ownerUserId: "u1" },
      driver: driverOf(),
      identity: IDENTITY,
      deps: { executeWriteTool: async () => ({ ok: true, applied: true }) },
    });
    expect(unknown.status).toBe(400);

    const unwired = await handleInternalAssistantRequest({
      method: "POST",
      path: "/api/internal/assistant/write-execute",
      body: { name: "update_task", args: {}, projectId: "p1", ownerUserId: "u1" },
      driver: driverOf(),
      identity: IDENTITY,
    });
    expect(unwired.status).toBe(502);
  });
});

describe("applyAssistantWrite authorization", () => {
  it("denies before any service call when the owner has no project access", async () => {
    const ctx = {
      authz: { projectAccess: () => Effect.succeed(null) },
    } as unknown as AssistantWriteApplyCtx;
    const outcome = await Effect.runPromise(
      Effect.either(
        applyAssistantWrite(
          { toolName: "update_task", args: { ref: "P-1", title: "x" }, projectId: "p1", ownerUserId: "u1" },
          ctx
        )
      )
    );
    expect(outcome._tag).toBe("Left");
    if (outcome._tag === "Left") {
      expect((outcome.left as { _tag: string })._tag).toBe("Forbidden");
    }
  });
});

describe("provider config (GET /api/internal/assistant/provider-config)", () => {
  const driverOf = () => createBunSqliteDriver(db);
  const configs: RegistryModelConfig[] = [{ kind: "openai_compatible", baseUrl: "https://p.test/v1", apiKey: "sk", model: "m" }];

  it("returns the config chain and forwards the signed project", async () => {
    const seen: string[] = [];
    const result = await handleInternalAssistantRequest({
      method: "GET",
      path: "/api/internal/assistant/provider-config",
      query: { projectId: "p1" },
      body: null,
      driver: driverOf(),
      identity: IDENTITY,
      deps: {
        resolveProviderConfigs: async (projectId) => {
          seen.push(projectId);
          return configs;
        },
      },
    });
    expect(result).toEqual({ status: 200, body: { configs } });
    expect(seen).toEqual(["p1"]);
  });

  it("403s a query project that does not match the signed identity, 400s a missing identity", async () => {
    const mismatch = await handleInternalAssistantRequest({
      method: "GET",
      path: "/api/internal/assistant/provider-config",
      query: { projectId: "other" },
      body: null,
      driver: driverOf(),
      identity: IDENTITY,
      deps: { resolveProviderConfigs: async () => configs },
    });
    expect(mismatch.status).toBe(403);

    const missing = await handleInternalAssistantRequest({
      method: "GET",
      path: "/api/internal/assistant/provider-config",
      query: { projectId: "p1" },
      body: null,
      driver: driverOf(),
      deps: { resolveProviderConfigs: async () => configs },
    });
    expect(missing.status).toBe(400);
  });
});

describe("read-tool execution (POST /api/internal/assistant/tool)", () => {
  const driverOf = () => createBunSqliteDriver(db);
  const IDENTITY = { actorUserId: "u1", projectId: "p1", threadKey: "chat:c1" };

  it("returns the injected executor's result and forwards the identity", async () => {
    const seen: Array<{ name: string; args: Record<string, unknown>; projectId: string; actorUserId: string }> = [];
    const result = await handleInternalAssistantRequest({
      method: "POST",
      path: "/api/internal/assistant/tool",
      body: { name: "get_task", args: { ref: "P-1" } },
      driver: driverOf(),
      identity: IDENTITY,
      deps: {
        executeReadTool: async (input) => {
          seen.push(input);
          return { ok: true, result: { name: input.name, args: input.args } };
        },
      },
    });
    expect(result).toEqual({ status: 200, body: { ok: true, result: { name: "get_task", args: { ref: "P-1" } } } });
    expect(seen).toEqual([{ name: "get_task", args: { ref: "P-1" }, projectId: "p1", actorUserId: "u1" }]);
  });

  it("502s when the read-tool executor is not wired", async () => {
    const result = await handleInternalAssistantRequest({
      method: "POST",
      path: "/api/internal/assistant/tool",
      body: { name: "get_task", args: {} },
      driver: driverOf(),
      identity: IDENTITY,
    });
    expect(result.status).toBe(502);
  });

  it("400s a missing tool name", async () => {
    const result = await handleInternalAssistantRequest({
      method: "POST",
      path: "/api/internal/assistant/tool",
      body: {},
      driver: driverOf(),
    });
    expect(result.status).toBe(400);
  });

  it("400s a missing internal project identity", async () => {
    const result = await handleInternalAssistantRequest({
      method: "POST",
      path: "/api/internal/assistant/tool",
      body: { name: "get_task", args: {} },
      driver: driverOf(),
    });
    expect(result.status).toBe(400);
  });
});

describe("turn context (POST /api/internal/assistant/turn-context)", () => {
  const driverOf = () => createBunSqliteDriver(db);
  const bundle = (over: Partial<HarnessTurnContext> = {}): HarnessTurnContext => ({
    projectId: "p1",
    threadKey: "chat:c1",
    documentType: "chat",
    agent: { id: "assistant", name: "Assistant Agent", instructions: "AGENT RULES" },
    skillMarkdowns: [],
    skillCatalog: null,
    memoryBlock: null,
    docContext: null,
    repoContent: [],
    mentionContext: null,
    advisory: null,
    threadSummary: null,
    readTools: ["get_task"],
    mcpTools: [],
    writeTools: ["create_task"],
    primarySupportsImages: false,
    hasSearchKey: true,
    jevConfigured: false,
    delegation: { enabled: false, maxConcurrentRuns: 0 },
    ...over,
  });

  const call = (body: unknown, identity?: typeof IDENTITY) =>
    handleInternalAssistantRequest({
      method: "POST",
      path: "/api/internal/assistant/turn-context",
      body,
      driver: driverOf(),
      ...(identity ? { identity } : {}),
      deps: { resolveHarnessTurnContext: async () => bundle() },
    });

  it("400s a missing signed identity", async () => {
    const res = await call({ threadKey: "chat:c1", userText: "hi", mode: "turn" });
    expect(res.status).toBe(400);
  });

  it("400s a malformed payload (missing userText / bad mode / missing threadKey)", async () => {
    for (const body of [
      { threadKey: "chat:c1", mode: "turn" },
      { threadKey: "chat:c1", userText: "hi", mode: "bogus" },
      { userText: "hi", mode: "turn" },
    ]) {
      const res = await call(body, IDENTITY);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it("403s a body threadKey that does not match the signed identity", async () => {
    const res = await call({ threadKey: "chat:other", userText: "hi", mode: "turn" }, IDENTITY);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: { code: "NO_USER_CONTEXT" } });
  });

  it("502s when the harness resolver is not wired", async () => {
    const res = await handleInternalAssistantRequest({
      method: "POST",
      path: "/api/internal/assistant/turn-context",
      body: { threadKey: "chat:c1", userText: "hi", mode: "turn" },
      driver: driverOf(),
      identity: IDENTITY,
    });
    expect(res.status).toBe(502);
  });

  it("returns the resolved context", async () => {
    const res = await call({ threadKey: "chat:c1", userText: "hi", mode: "turn" }, IDENTITY);
    expect(res).toEqual({ status: 200, body: { context: bundle() } });
  });

  it("forwards threadKey/runId/userText/mode and the signed project — never a body projectId", async () => {
    const seen: unknown[] = [];
    const res = await handleInternalAssistantRequest({
      method: "POST",
      path: "/api/internal/assistant/turn-context",
      body: { threadKey: "chat:c1", runId: "run-9", userText: "hi", mode: "resume", projectId: "attacker" },
      driver: driverOf(),
      identity: IDENTITY,
      deps: {
        resolveHarnessTurnContext: async (input) => {
          seen.push(input);
          return bundle();
        },
      },
    });
    expect(res.status).toBe(200);
    expect(seen).toEqual([{ projectId: "p1", threadKey: "chat:c1", runId: "run-9", userText: "hi", mode: "resume" }]);
  });

  it("maps a resolver failure to 500", async () => {
    const res = await handleInternalAssistantRequest({
      method: "POST",
      path: "/api/internal/assistant/turn-context",
      body: { threadKey: "chat:c1", userText: "hi", mode: "turn" },
      driver: driverOf(),
      identity: IDENTITY,
      deps: {
        resolveHarnessTurnContext: async () => {
          throw new Error("boom");
        },
      },
    });
    expect(res.status).toBe(500);
  });

  it("redacts: the response carries booleans and tool names, never the Exa key or allowlist", async () => {
    db.prepare(
      `INSERT INTO assistant_settings (project_id, search_api_key, url_allowlist, write_tools, primary_supports_images)
       VALUES ('p1', ?, ?, 'create_task', 0)`
    ).run("exa-SUPER-SECRET", "https://only.example");
    const res = await handleInternalAssistantRequest({
      method: "POST",
      path: "/api/internal/assistant/turn-context",
      body: { threadKey: "chat:c1", userText: "hi", mode: "turn" },
      driver: driverOf(),
      identity: IDENTITY,
      deps: {
        resolveHarnessTurnContext: (input) =>
          resolveWorkerHarnessContext({ driver: driverOf(), base: baseLayer() }, input),
      },
    });
    expect(res.status).toBe(200);
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain("exa-SUPER-SECRET");
    expect(raw).not.toContain("only.example");
    expect(raw).not.toContain("searchApiKey");
    expect(raw).not.toContain("urlAllowlist");
    const context = (res.body as { context: HarnessTurnContext }).context;
    expect(context.hasSearchKey).toBe(true);
    expect(context.jevConfigured).toBe(false);
    expect(context.writeTools).toEqual(["create_task"]);
  });
});

describe("call-log writes (POST /api/internal/assistant/call-log)", () => {
  const driverOf = () => createBunSqliteDriver(db);

  it("writes one row and rejects a malformed kind/status", async () => {
    const ok = await handleInternalAssistantRequest({
      method: "POST",
      path: "/api/internal/assistant/call-log",
      body: {
        projectId: "p1",
        providerId: null,
        model: "test-model",
        kind: "openai_compatible",
        status: "done",
        usageIn: 3,
        usageOut: 2,
        cachedIn: 1,
        latencyMs: 42,
        costCents: 0,
        estimated: true,
      },
      driver: driverOf(),
    });
    expect(ok.status).toBe(200);
    const row = db
      .prepare("SELECT model, kind, status, usage_in, usage_out, cached_in, latency_ms, estimated FROM assistant_call_logs")
      .get() as { model: string; kind: string; status: string; usage_in: number; usage_out: number; cached_in: number; latency_ms: number; estimated: number };
    expect(row).toMatchObject({
      model: "test-model",
      kind: "openai_compatible",
      status: "done",
      usage_in: 3,
      usage_out: 2,
      cached_in: 1,
      latency_ms: 42,
      estimated: 1,
    });

    const bad = await handleInternalAssistantRequest({
      method: "POST",
      path: "/api/internal/assistant/call-log",
      body: { model: "m", kind: "bogus", status: "done" },
      driver: driverOf(),
    });
    expect(bad.status).toBe(400);
  });
});

describe("terminal run status (POST /api/internal/assistant/run-status)", () => {
  const driverOf = () => createBunSqliteDriver(db);

  function seedRun(documentType: "task" | "wiki") {
    db.exec("INSERT OR IGNORE INTO lexa_agents (id, name, instructions, is_builtin) VALUES ('asst', 'Assistant', '', 1)");
    db.exec("INSERT OR IGNORE INTO lexa_skills (id, name, instructions, is_builtin) VALUES ('sk', 'Skill', '', 1)");
    db.prepare(
      `INSERT INTO assistant_tasks (id, project_id, document_type, document_id, agent_id, skill_id, status)
       VALUES ('run-1', 'p1', ?, ?, 'asst', 'sk', 'running')`
    ).run(documentType, documentType === "task" ? "t1" : "w1");
  }

  it("transitions a task run and emits one terminal activity row", async () => {
    seedTask();
    seedRun("task");
    const result = await handleInternalAssistantRequest({
      method: "POST",
      path: "/api/internal/assistant/run-status",
      body: { runId: "run-1", status: "completed", result: "done" },
      driver: driverOf(),
    });
    expect(result).toEqual({ status: 200, body: { ok: true, emitted: true } });
    const run = db.prepare("SELECT status, result, finished_at FROM assistant_tasks WHERE id = 'run-1'").get() as {
      status: string;
      result: string | null;
      finished_at: string | null;
    };
    expect(run.status).toBe("completed");
    expect(run.result).toBe("done");
    expect(run.finished_at).not.toBeNull();
    const activity = db.prepare("SELECT type, message, via_assistant FROM task_activity WHERE task_id = 't1'").get() as {
      type: string;
      message: string;
      via_assistant: number;
    };
    expect(activity.type).toBe("assistant_completed");
    expect(activity.message).toContain("Assistant");
    expect(activity.via_assistant).toBe(0);
  });

  it("a second transition to the same terminal status is a no-op (no duplicate activity)", async () => {
    seedTask();
    seedRun("task");
    const transition = (status: string, result?: string) =>
      handleInternalAssistantRequest({
        method: "POST",
        path: "/api/internal/assistant/run-status",
        body: { runId: "run-1", status, ...(result !== undefined ? { result } : {}) },
        driver: driverOf(),
      });

    expect(await transition("completed", "done")).toEqual({ status: 200, body: { ok: true, emitted: true } });
    // The DO's `postInternal` retries once on a lost response, so the exact
    // same terminal transition can arrive twice; it must not emit again.
    expect(await transition("completed", "done")).toEqual({ status: 200, body: { ok: true, emitted: false } });
    const count = db.prepare("SELECT COUNT(*) AS n FROM task_activity WHERE task_id = 't1'").get() as { n: number };
    expect(count.n).toBe(1);
  });

  it("a late completed after a failed run no-ops and never overwrites the failure", async () => {
    seedTask();
    seedRun("task");
    const failed = await handleInternalAssistantRequest({
      method: "POST",
      path: "/api/internal/assistant/run-status",
      body: { runId: "run-1", status: "failed", error: "boom" },
      driver: driverOf(),
    });
    expect(failed).toEqual({ status: 200, body: { ok: true, emitted: true } });

    const late = await handleInternalAssistantRequest({
      method: "POST",
      path: "/api/internal/assistant/run-status",
      body: { runId: "run-1", status: "completed", result: "late" },
      driver: driverOf(),
    });
    expect(late).toEqual({ status: 200, body: { ok: true, emitted: false } });
    const run = db.prepare("SELECT status, result FROM assistant_tasks WHERE id = 'run-1'").get() as {
      status: string;
      result: string | null;
    };
    expect(run.status).toBe("failed");
    expect(run.result).toBeNull();
    const count = db.prepare("SELECT COUNT(*) AS n FROM task_activity WHERE task_id = 't1'").get() as { n: number };
    expect(count.n).toBe(1);
  });

  it("does not emit a task activity row for a wiki run", async () => {
    seedRun("wiki");
    const result = await handleInternalAssistantRequest({
      method: "POST",
      path: "/api/internal/assistant/run-status",
      body: { runId: "run-1", status: "failed", error: "boom" },
      driver: driverOf(),
    });
    expect(result).toEqual({ status: 200, body: { ok: true, emitted: false } });
    const count = db.prepare("SELECT COUNT(*) AS n FROM task_activity").get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("404s an unknown run and 400s a malformed status", async () => {
    const missing = await handleInternalAssistantRequest({
      method: "POST",
      path: "/api/internal/assistant/run-status",
      body: { runId: "nope", status: "completed" },
      driver: driverOf(),
    });
    expect(missing.status).toBe(404);
    const malformed = await handleInternalAssistantRequest({
      method: "POST",
      path: "/api/internal/assistant/run-status",
      body: { runId: "run-1", status: "bogus" },
      driver: driverOf(),
    });
    expect(malformed.status).toBe(400);
  });
});
