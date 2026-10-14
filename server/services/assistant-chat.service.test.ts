import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Cause, Effect, Fiber, Layer, Context, Schema } from "effect";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { Sqlite } from "../db/database";
import { Db, type DbDriver, type LexaRow, type SqlParam } from "../db/db";
import { createBunSqliteDriver } from "../db/drivers/bun-sqlite";
import { Storage, StorageConfig } from "../storage/storage";
import { resolveStorageConfig } from "../storage/config";
import { RuntimeEnvLive } from "../runtime-env";
import { AssistantChatService } from "./assistant-chat.service";
import { activeChats } from "../assistant/active-chats";
import { encryptSecret, parseMasterKey } from "../assistant/secrets";
import type { AssistantPendingWriteRow } from "../repos/assistant-pending-writes.repo";
import {
  APPROVAL_TTL_HOURS,
  MAX_BULK_TASK_REFS,
  MAX_WRITES_PER_TURN,
  buildAssistantWriteTools,
  buildAutoWriteRecord,
  createWriteRecorder,
  type AssistantWriteToolDeps,
  type WriteRecorderInsertRow,
  type WriteTaskSnapshot,
} from "../assistant/write-tools";
import { executeAssistantWrite, type AssistantWriteExecutionCtx } from "../assistant/write-execution";
import {
  approvalCarriersOf,
  messageCarriesBatch,
  reconcileApprovalCarriers,
  withApprovalCarriers,
  withContinuationBoundary,
} from "../assistant/approval-carrier";
import { resolveMentionContext, firstUserText, lastUserText, type MentionResolverDeps } from "../assistant/context";
import type { TipTapDoc } from "../../shared/types";
import { ASSISTANT_APPROVAL_DATA_PART, ASSISTANT_MAX_OUTPUT_TOKENS, type AssistantWriteDiff, type StreamFrame } from "../../shared/assistant";
import type { UIMessage } from "ai";
import type { RuntimeEnv } from "../env";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

// The provider dispatch is the only outbound model call in these tests; every
// other export of the module stays real so the gateway's own resolution,
// normalization and logging paths are exercised.
const providerMock = vi.hoisted(() => ({
  calls: [] as Array<{ systemPrompts: unknown; tools: unknown; messages: unknown; modelOptions?: Record<string, unknown> | undefined }>,
  hold: undefined as { started: () => void; wait: Promise<void> } | undefined,
}));
vi.mock("../assistant/provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../assistant/provider")>();
  return {
    ...actual,
    // The adapter construction is real in production and rejects an empty key;
    // these suites exercise Jev preflight/gateway resolution, not adapter
    // wiring, so the snapshot build is stubbed (streamChat is stubbed too).
    buildAdapter: () => ({}) as never,
    streamChat: (input: { systemPrompts: unknown; tools?: unknown; messages?: unknown; modelOptions?: Record<string, unknown> | undefined }) => {
      providerMock.calls.push({ systemPrompts: input.systemPrompts, tools: input.tools ?? [], messages: input.messages ?? [], ...(input.modelOptions !== undefined ? { modelOptions: input.modelOptions } : {}) });
      return (async function* () {
        const hold = providerMock.hold;
        if (hold) {
          hold.started();
          await hold.wait;
        }
        yield { type: "TEXT_MESSAGE_CONTENT", delta: "ok" };
        yield { type: "RUN_FINISHED", usage: { input: 1, output: 1 } };
      })();
    },
  };
});

type FetchCall = { url: string; init: RequestInit };

let dir: string;
let db: Database;
let driver: DbDriver;
let service: AssistantChatService;
let env: RuntimeEnv;
const jevCalls: FetchCall[] = [];

// Jev is DB-only now: the config, the envelope-encrypted key, and the project
// opt-in all live in the registry, and the master key comes from RuntimeEnv.
const JEV_MASTER_KEY = Buffer.from("j".repeat(32)).toString("base64");
const JEV_PLAINTEXT = "tk-test";
const JEV_BASE_URL = "https://typesafe.test";
const jevSeed = await (async () => {
  const key = await parseMasterKey(JEV_MASTER_KEY);
  const sealed = await encryptSecret(JEV_PLAINTEXT, "jev", "default", key);
  return { ciphertext: sealed.ciphertextB64, iv: sealed.ivB64, keyId: sealed.keyId, hint: JEV_PLAINTEXT.slice(-4) };
})();

const ADVISORY_ANSWERS = {
  write_intent: { type: "choice", choice: "write", probabilities: { none: 0.05, read: 0.1, write: 0.85 }, confidence: 0.85 },
  ambiguity: { type: "noul", noul: 0.9 },
  memory_conflict: { type: "noul", noul: 0.05 },
};

function jevResponse(): Response {
  return new Response(
    JSON.stringify({ model: "jev-latest", answers: ADVISORY_ANSWERS, usage: { input_tokens: 12, output_tokens: 5 } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

// Records every outbound call and defers to the test's own responder. Jev is
// the only thing allowed to reach the network from this suite.
function stubFetch(impl: (call: FetchCall) => Promise<Response>): void {
  vi.stubGlobal("fetch", (async (input: unknown, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    jevCalls.push(call);
    return impl(call);
  }) as unknown as typeof fetch);
}

// The `MISSING_KEY` gate must prevent a request from ever being attempted, so
// the stub records and fails instead of returning a verdict.
function stubUnreachable(): void {
  stubFetch(() => Promise.reject(new Error("Jev must not be reachable without a key")));
}

// `full` = config enabled + stored key + project opt-in; the two partial modes
// drop one gate so a test can prove each one disables Jev on its own.
type JevSeedMode = "full" | "no-project" | "no-secret";

function setup(opts: { env?: RuntimeEnv; jev?: JevSeedMode } = {}) {
  dir = mkdtempSync(join(tmpdir(), "lexa-assistant-chat-svc-"));
  const dbPath = join(dir, "test.db");
  runMigrations(dbPath, MIGRATIONS);
  db = new Database(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  // Real registry rows exercise config resolution; outbound calls are stubbed.
  db.exec(`
INSERT INTO users (id, email, name, role) VALUES ('u1', 'a@lexa.test', 'A', 'superadmin');
INSERT INTO projects (id, name, slug, key, next_task_number) VALUES ('p1', 'P', 'p1', 'EG', 1);
INSERT INTO columns (id, project_id, name, position) VALUES ('c1', 'p1', 'Todo', 0);
INSERT INTO swimlanes (id, project_id, name, position, kind, due_at) VALUES ('s-backlog', 'p1', 'Backlog', 0, 'backlog', NULL);
INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, created_at, key, number)
  VALUES ('t1', 'p1', 'c1', 's-backlog', 'Fix login', 'a0', '2026-01-01 10:00:00', 'EG-1', 1);
INSERT INTO assistant_providers (id, label, base_url, api_key) VALUES ('pv1', 'Test', 'https://model.test/v1', '');
INSERT INTO assistant_models (id, provider_id, model_id, kind, priority, enabled)
  VALUES ('m1', 'pv1', 'test-model', 'openai_compatible', 0, 1);
INSERT INTO assistant_settings (project_id, write_tools, provider_id, primary_model_id)
  VALUES ('p1', '[]', 'pv1', 'm1');
`);
  const jev = opts.jev ?? "full";
  db.exec(`UPDATE assistant_jev_config SET base_url = '${JEV_BASE_URL}', model = 'jev-latest', enabled = 1 WHERE id = 'default'`);
  if (jev !== "no-secret") {
    db.exec(
      `INSERT INTO assistant_jev_secrets (config_id, ciphertext, iv, key_id, key_hint)
       VALUES ('default', '${jevSeed.ciphertext}', '${jevSeed.iv}', '${jevSeed.keyId}', '${jevSeed.hint}')`
    );
  }
  if (jev !== "no-project") {
    db.exec(`INSERT INTO assistant_jev_projects (project_id, enabled) VALUES ('p1', 1)`);
  }
  env = opts.env ?? ({ LXK_SECRETS_MASTER_KEY: JEV_MASTER_KEY } as RuntimeEnv);
  const cfg = resolveStorageConfig({}, dir);
  driver = createBunSqliteDriver(db);
  const layer = AssistantChatService.Default.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(Sqlite, db),
        Layer.succeed(Db, driver),
        Layer.succeed(StorageConfig, cfg),
        Storage.Default.pipe(Layer.provide(Layer.succeed(StorageConfig, cfg))),
        RuntimeEnvLive(env),
      ),
    ),
  );
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  service = Context.get(ctx, AssistantChatService);
}

// `currentEnv` is read when a service METHOD runs, so the snapshot has to be
// provided to the effect, not only to the built layer (the same place
// server/api/http.ts provides it per request).
function run<A, E>(eff: Effect.Effect<A, E>): Promise<A> {
  return Effect.runPromise(eff.pipe(Effect.provide(RuntimeEnvLive(env))) as Effect.Effect<A, E>);
}

async function drain(stream: ReadableStream<StreamFrame>): Promise<StreamFrame[]> {
  const out: StreamFrame[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(value);
  }
  return out;
}

function promptText(call: { systemPrompts: unknown }): string {
  return (call.systemPrompts as Array<{ content: string }>).map((p) => p.content).join("\n");
}

function toolNames(call: { tools: unknown }): Array<string | undefined> {
  return (call.tools as Array<{ name?: string }>).map((t) => t.name);
}

function runStream(chatId: string, message: string) {
  return run(service.runChatStream(chatId, "u1", { projectId: "p1", chatId, message }));
}

beforeEach(() => {
  jevCalls.length = 0;
  providerMock.calls.length = 0;
  providerMock.hold = undefined;
});

afterEach(() => {
  activeChats.clear();
  vi.unstubAllGlobals();
  try { db?.close(); } catch {}
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("chat preflight — new run", () => {
  it("releases an interrupted preflight so the next turn can complete", async () => {
    let entered!: () => void;
    let finish!: (response: Response) => void;
    const entering = new Promise<void>((resolve) => { entered = resolve; });
    const response = new Promise<Response>((resolve) => { finish = resolve; });
    stubFetch(() => { entered(); return response; });
    setup();
    const fiber = Effect.runFork(service.runChatStream("c1", "u1", { projectId: "p1", chatId: "c1", message: "reply briefly" }).pipe(Effect.provide(RuntimeEnvLive(env))));
    await entering;
    await Effect.runPromise(Fiber.interrupt(fiber));
    finish(jevResponse());
    expect(activeChats.has("c1")).toBe(false);
    stubFetch(() => Promise.resolve(jevResponse()));
    const frames = await drain(await runStream("c1", "next turn"));
    expect(frames.some((frame) => frame.type === "done")).toBe(true);
  });

  it("sends one preflight and the advisory segment reaches the system prompt", async () => {
    stubFetch(() => Promise.resolve(jevResponse()));
    setup();

    const frames = await drain(await runStream("c1", "rename the login task to Fix auth"));
    expect(frames.some((f) => f.type === "done")).toBe(true);

    expect(jevCalls).toHaveLength(1);
    expect(jevCalls[0]!.url).toBe("https://typesafe.test/v1/systemone");
    const body = JSON.parse(String(jevCalls[0]!.init.body)) as { state: string; model: string; questions: Record<string, { type: string }> };
    expect(body.model).toBe("jev-latest");
    expect(Object.keys(body.questions).sort()).toEqual(["ambiguity", "memory_conflict", "write_intent"]);
    const state = JSON.parse(body.state) as { runKind: string; projectId: string; threadId: string; userMessage: string };
    expect(state.runKind).toBe("chat");
    expect(state.projectId).toBe("p1");
    expect(state.threadId).toBe("c1");
    expect(state.userMessage).toBe("rename the login task to Fix auth");

    expect(providerMock.calls).toHaveLength(1);
    const text = promptText(providerMock.calls[0]!);
    expect(text).toContain("Jev advisory (non-authoritative)");
    expect(text).toContain("write intent: write");
    expect(text).toContain("live project data remains authoritative");
  });
});
describe("request-owned abort cleanup", () => {
  it("late abort from settled chat request leaves newer chat run alive", async () => {
    stubFetch(() => Promise.resolve(jevResponse()));
    setup();
    const oldRequest = new AbortController();
    await drain(await run(service.runChatStream("c1", "u1", { projectId: "p1", chatId: "c1", message: "first" }, oldRequest.signal)));

    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    providerMock.hold = { started: started.resolve, wait: finish.promise };
    const nextStream = await run(service.runChatStream("c1", "u1", { projectId: "p1", chatId: "c1", message: "second" }));
    await started.promise;
    const nextController = activeChats.get("c1")!;

    oldRequest.abort();
    expect(nextController.signal.aborted).toBe(false);
    finish.resolve();
    await drain(nextStream);
  });
});

describe("chat resume — carrier-shaped transcript (DO path)", () => {
  const carrierThread = (status: "approved" | "pending") =>
    `INSERT INTO assistant_threads (document_type, document_id, project_id, owner_user_id, messages)
       VALUES ('chat', 'c1', 'p1', 'u1', '[{"id":"m1","role":"user","parts":[{"type":"text","text":"go"}]},{"id":"m2","role":"assistant","parts":[{"type":"text","text":"proposed"},{"type":"data-assistant-approval","data":{"batchId":"b1","approvals":[{"approvalId":"ap1","seq":0,"name":"no_such_write_tool"}]}}]}]');
     INSERT INTO assistant_pending_writes (id, project_id, document_type, document_id, owner_user_id, batch_id, seq, tool_name, args, diff, status, expires_at)
       VALUES ('ap1', 'p1', 'chat', 'c1', 'u1', 'b1', 0, 'no_such_write_tool', '{}', '{}', '${status}', '2099-01-01 00:00:00');`;

  it("still 409s while a carrier approval remains pending", async () => {
    setup();
    db.exec(carrierThread("pending"));

    const result = await run(Effect.either(service.resumeChatStream("c1", "u1")));
    expect(result._tag).toBe("Left");
    expect((result as { left: { _tag: string; batchId: string; remaining: number } }).left).toMatchObject({
      _tag: "ApprovalsPending",
      batchId: "b1",
      remaining: 1,
    });
    expect(providerMock.calls).toHaveLength(0);
  });

  it("targets the newest marker across both shapes", async () => {
    setup();
    // Legacy b-old (decided) lives in the earlier message; carrier b-new (still
    // pending) is newer, so the gate must resolve b-new, not the legacy b-old.
    db.exec(`
INSERT INTO assistant_threads (document_type, document_id, project_id, owner_user_id, messages)
  VALUES ('chat', 'c1', 'p1', 'u1', '[{"role":"assistant","content":"old","pendingBatch":{"batchId":"b-old","approvals":[{"approvalId":"ap-old"}]}},{"id":"m2","role":"assistant","parts":[{"type":"text","text":"new"},{"type":"data-assistant-approval","data":{"batchId":"b-new","approvals":[{"approvalId":"ap-new","seq":0,"name":"no_such_write_tool"}]}}]}]');
INSERT INTO assistant_pending_writes (id, project_id, document_type, document_id, owner_user_id, batch_id, seq, tool_name, args, diff, status, expires_at)
  VALUES ('ap-old', 'p1', 'chat', 'c1', 'u1', 'b-old', 0, 'no_such_write_tool', '{}', '{}', 'approved', '2099-01-01 00:00:00'),
         ('ap-new', 'p1', 'chat', 'c1', 'u1', 'b-new', 0, 'no_such_write_tool', '{}', '{}', 'pending', '2099-01-01 00:00:00');
`);

    const result = await run(Effect.either(service.resumeChatStream("c1", "u1")));
    expect(result._tag).toBe("Left");
    expect((result as { left: { _tag: string; batchId: string; remaining: number } }).left).toMatchObject({
      _tag: "ApprovalsPending",
      batchId: "b-new",
      remaining: 1,
    });
    expect(providerMock.calls).toHaveLength(0);
  });
});

describe("chat preflight — fail-open and disable", () => {
  it("a throwing transport leaves the run intact with no advisory", async () => {
    stubFetch(() => Promise.reject(new Error("socket hang up")));
    setup();

    const frames = await drain(await runStream("c1", "hello"));
    expect(frames.some((f) => f.type === "done")).toBe(true);
    expect(jevCalls).toHaveLength(1);
    expect(promptText(providerMock.calls[0]!)).not.toContain("Jev advisory");
  });

  it("every missing gate (no stored key, no project opt-in, no master key) disables Jev and omits jev_assess", async () => {
    setup({ jev: "no-secret" });
    stubUnreachable();
    const noSecret = await drain(await runStream("c1", "hello"));
    expect(noSecret.some((f) => f.type === "done")).toBe(true);
    expect(jevCalls).toHaveLength(0);
    expect(promptText(providerMock.calls.at(-1)!)).not.toContain("Jev advisory");
    expect(toolNames(providerMock.calls.at(-1)!)).not.toContain("jev_assess");

    setup({ jev: "no-project" });
    stubUnreachable();
    await drain(await runStream("c1", "hello"));
    expect(jevCalls).toHaveLength(0);
    expect(toolNames(providerMock.calls.at(-1)!)).not.toContain("jev_assess");

    setup({ env: {} as unknown as RuntimeEnv });
    stubUnreachable();
    await drain(await runStream("c1", "hello"));
    expect(jevCalls).toHaveLength(0);
    expect(toolNames(providerMock.calls.at(-1)!)).not.toContain("jev_assess");
  });
});

describe("reconcileChatApprovals", () => {
  it("reconciles every pending batch marker, not just the newest", async () => {
    setup();
    // A thread can hold an older decided marker plus a newer pending one; the
    // newest-only path left the older batch rebuilt as pending (re-armed chip).
    db.exec(`
INSERT INTO assistant_threads (document_type, document_id, project_id, owner_user_id, messages)
  VALUES ('chat', 'c1', 'p1', 'u1', '[]');
INSERT INTO assistant_pending_writes (id, project_id, document_type, document_id, owner_user_id, batch_id, seq, tool_name, args, diff, status, expires_at)
  VALUES ('w-old', 'p1', 'chat', 'c1', 'u1', 'b-old', 0, 'create_task', '{}', '{"type":"task_create","title":"old","fields":{}}', 'approved', '2099-01-01 00:00:00'),
         ('w-new', 'p1', 'chat', 'c1', 'u1', 'b-new', 0, 'create_task', '{}', '{"type":"task_create","title":"new","fields":{}}', 'pending', '2099-01-01 00:00:00');
`);
    const messages = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "old",
        pendingBatch: { batchId: "b-old", approvals: [{ approvalId: "w-old", seq: 0, name: "create_task", diff: { type: "task_create", title: "old", fields: {} } }] },
      },
      {
        role: "assistant",
        content: "new",
        pendingBatch: { batchId: "b-new", approvals: [{ approvalId: "w-new", seq: 0, name: "create_task", diff: { type: "task_create", title: "new", fields: {} } }] },
      },
    ];
    const out = (await run(service.reconcileChatApprovals(messages))) as Array<{
      pendingBatch?: { approvals: Array<{ approvalId: string; status?: string }> };
    }>;
    const statusOf = (id: string) =>
      out.flatMap((m) => m.pendingBatch?.approvals ?? []).find((a) => a.approvalId === id)?.status;
    expect(statusOf("w-old")).toBe("approved");
    expect(statusOf("w-new")).toBe("pending");
  });
});

// ADR-0005 §Port P3 (LX-80): one execution per approval batch. A claim row
// makes a duplicate resume idempotent.
describe("chat resume — claim idempotency", () => {
  const claimCount = (): number =>
    (db.prepare("SELECT COUNT(*) AS c FROM assistant_resume_claims WHERE batch_id = 'b1'").get() as { c: number }).c;
  const newTaskCount = (): number =>
    (db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE project_id = 'p1' AND title = 'New task'").get() as { c: number }).c;

  const seed = (status: "approved" | "pending", tool = "create_task", args = '{"title":"New task"}', diff = '{"type":"task_create","title":"New task","fields":{}}'): void => {
    db.exec(`
INSERT INTO priority_options (id, project_id, label, color, position) VALUES ('prio-1', 'p1', 'Medium', '#888', 0);
INSERT INTO type_options (id, project_id, label, color, position) VALUES ('type-1', 'p1', 'Task', '#888', 0);
INSERT INTO assistant_threads (document_type, document_id, project_id, owner_user_id, messages)
  VALUES ('chat', 'c1', 'p1', 'u1', '[{"role":"user","content":"create it"},{"role":"assistant","content":"proposed","pendingBatch":{"batchId":"b1","approvals":[{"approvalId":"ap1","toolCallId":"call_1","seq":0,"name":"${tool}","diff":${diff}}]}}]');
INSERT INTO assistant_pending_writes (id, project_id, document_type, document_id, owner_user_id, batch_id, seq, tool_name, args, diff, status, expires_at)
  VALUES ('ap1', 'p1', 'chat', 'c1', 'u1', 'b1', 0, '${tool}', '${args}', '${diff}', '${status}', '2099-01-01 00:00:00');
`);
  };

  it.each(["rejected", "expired"] as const)("settles an entirely %s batch before later transcript replacement", async (status) => {
    stubFetch(() => Promise.resolve(jevResponse()));
    setup();
    seed("approved");
    db.prepare("UPDATE assistant_pending_writes SET status = ? WHERE id = 'ap1'").run(status);
    const acknowledged = await drain(await run(service.resumeChatStream("c1", "u1", "b1")));
    expect(acknowledged.at(-1)?.type).toBe("done");
    const history = db.prepare("SELECT messages FROM assistant_threads WHERE document_type = 'chat' AND document_id = 'c1'");
    const StoredChatMessage = Schema.Struct({
      role: Schema.String,
      content: Schema.Unknown,
      pendingBatch: Schema.optional(Schema.Unknown),
    });
    const parseHistory = Schema.decodeUnknownSync(Schema.Array(StoredChatMessage), { onExcessProperty: "preserve" });
    const parseRow = Schema.decodeUnknownSync(Schema.Struct({ messages: Schema.String }));
    const storedMessages = () => {
      const row = parseRow(history.get());
      return parseHistory(JSON.parse(row.messages));
    };
    const afterAcknowledgement = storedMessages();
    expect(newTaskCount()).toBe(0);
    expect(claimCount()).toBe(0);
    const later = await drain(await run(service.runChatStream("c1", "u1", { projectId: "p1", chatId: "c1", message: "Later read-only request", permissionMode: "deny" })));
    expect(later.at(-1)?.type).toBe("done");
    const beforeEdit = storedMessages();
    const fromIndex = beforeEdit.findLastIndex((message) => message.role === "user");
    const replaced = await drain(await run(service.runChatStream("c1", "u1", { projectId: "p1", chatId: "c1", message: "Edited read-only request", permissionMode: "deny", fromIndex })));
    expect(replaced.at(-1)?.type).toBe("done");
    const afterEdit = storedMessages();
    expect(afterEdit.slice(0, fromIndex)).toEqual(beforeEdit.slice(0, fromIndex));
    expect(afterEdit.slice(fromIndex).map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(afterEdit[fromIndex]?.content).toBe("Edited read-only request");
    expect(afterEdit.some((message) => message.pendingBatch !== undefined)).toBe(false);
    expect(afterAcknowledgement.some((message) => message.pendingBatch !== undefined)).toBe(false);
    expect(newTaskCount()).toBe(0);
    expect(claimCount()).toBe(0);
  });

  it("Stop settles the first approved mutation without starting the second", async () => {
    stubFetch(() => Promise.resolve(jevResponse()));
    setup();
    seed("approved");
    db.exec(`INSERT INTO assistant_pending_writes
      (id, project_id, document_type, document_id, owner_user_id, batch_id, seq, tool_name, args, diff, status, expires_at)
      SELECT 'ap2', project_id, document_type, document_id, owner_user_id, batch_id, 1, tool_name,
        '{"title":"Must not start"}', '{"type":"task_create","title":"Must not start","fields":{}}', status, expires_at
      FROM assistant_pending_writes WHERE id = 'ap1'`);
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const batch = driver.batch.bind(driver);
    let mutationBatches = 0;
    const spy = vi.spyOn(driver, "batch").mockImplementation(async (stmts) => {
      if (stmts.some((stmt) => /INSERT INTO tasks\b/i.test(stmt.sql))) {
        mutationBatches += 1;
        if (mutationBatches === 1) {
          entered.resolve();
          await finish.promise;
        }
      }
      return batch(stmts);
    });
    try {
      const resuming = run(service.resumeChatStream("c1", "u1", "b1"));
      await entered.promise;
      const controller = activeChats.get("c1")!;
      expect(service.abortChat("c1")).toBe(true);
      expect(controller.signal.aborted).toBe(true);
      expect(newTaskCount()).toBe(0);
      expect(activeChats.get("c1")).toBe(controller);
      finish.resolve();
      const frames = await drain(await resuming);
      expect(mutationBatches).toBe(1);
      expect(newTaskCount()).toBe(1);
      expect(db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE title = 'Must not start'").get()).toEqual({ n: 0 });
      expect(frames.filter((frame) => frame.type === "approval_result")).toEqual([
        { type: "approval_result", approvalId: "ap1", status: "applied" },
        { type: "approval_result", approvalId: "ap2", status: "failed", error: "Assistant stopped" },
      ]);
      expect(claimCount()).toBe(1);
      expect(activeChats.has("c1")).toBe(false);
      const saved = db.prepare("SELECT messages FROM assistant_threads WHERE document_type = 'chat' AND document_id = 'c1'").get() as { messages: string };
      const messages = JSON.parse(saved.messages) as Array<Record<string, unknown>>;
      expect(messages.at(-1)).toMatchObject({
        role: "assistant", content: "", stopped: true,
        toolLog: [
          { name: "create_task", detail: expect.stringMatching(/^applied: New task/) },
          { name: "create_task", detail: expect.stringMatching(/^failed: Must not start/) },
        ],
      });
      expect(providerMock.calls).toHaveLength(0);
      const replay = await run(Effect.either(service.resumeChatStream("c1", "u1", "b1")));
      expect(replay).toMatchObject({ _tag: "Left", left: { _tag: "ApprovalNotFound", id: "b1" } });
      expect(newTaskCount()).toBe(1);
      expect(mutationBatches).toBe(1);
      expect(claimCount()).toBe(1);
      expect((await drain(await runStream("c1", "next turn"))).some((frame) => frame.type === "done")).toBe(true);
    } finally {
      finish.resolve();
      spy.mockRestore();
    }
  });

  it("Stop preserves a bulk approval's committed prefix without starting its remaining mutations", async () => {
    setup();
    seed("approved", "archive_task", '{"refs":["t1","t2"]}', '{"type":"task_archive","taskRef":"2 tasks","taskTitle":"EG-1, EG-2"}');
    db.exec(`INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, position, created_at, key, number)
      VALUES ('t2', 'p1', 'c1', 's-backlog', 'Second task', 'a1', '2026-01-01 10:00:00', 'EG-2', 2)`);
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const batch = driver.batch.bind(driver);
    let mutationBatches = 0;
    const spy = vi.spyOn(driver, "batch").mockImplementation(async (stmts) => {
      if (stmts.some((stmt) => /UPDATE tasks SET archived_at/i.test(stmt.sql))) {
        mutationBatches += 1;
        if (mutationBatches === 1) {
          entered.resolve();
          await finish.promise;
        }
      }
      return batch(stmts);
    });
    try {
      const resuming = run(service.resumeChatStream("c1", "u1", "b1"));
      await entered.promise;
      expect(service.abortChat("c1")).toBe(true);
      finish.resolve();
      const frames = await drain(await resuming);
      expect(mutationBatches).toBe(1);
      expect(db.prepare("SELECT id FROM tasks WHERE archived_at IS NOT NULL ORDER BY id").all()).toEqual([{ id: "t1" }]);
      expect(db.prepare("SELECT archived_at FROM tasks WHERE id = 't2'").get()).toEqual({ archived_at: null });
      expect(frames.find((frame) => frame.type === "approval_result")).toMatchObject({
        approvalId: "ap1", status: "applied", partial: { applied: 1, failed: 1, errors: ["Assistant stopped"] },
      });
      expect(claimCount()).toBe(1);
      const saved = db.prepare("SELECT messages FROM assistant_threads WHERE document_type = 'chat' AND document_id = 'c1'").get() as { messages: string };
      const messages = JSON.parse(saved.messages) as Array<Record<string, unknown>>;
      expect(messages.at(-1)).toMatchObject({
        stopped: true,
        toolLog: [{ name: "archive_task", detail: expect.stringMatching(/^applied: 2 tasks.*1 applied, 1 failed/) }],
      });
      const replay = await run(Effect.either(service.resumeChatStream("c1", "u1", "b1")));
      expect(replay).toMatchObject({ _tag: "Left", left: { _tag: "ApprovalNotFound", id: "b1" } });
      expect(mutationBatches).toBe(1);
      expect(db.prepare("SELECT archived_at FROM tasks WHERE id = 't2'").get()).toEqual({ archived_at: null });
      expect(claimCount()).toBe(1);
    } finally {
      finish.resolve();
      spy.mockRestore();
    }
  });

  it.each(["Stop", "Fiber"] as const)("releases an unused claim when %s interrupts the executor lookup before mutation", async (cancellation) => {
    setup();
    seed("approved");
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const settled = Promise.withResolvers<void>();
    const prepare = driver.prepare.bind(driver);
    const spy = vi.spyOn(driver, "prepare").mockImplementation((sql) => {
      const stmt = prepare(sql);
      if (!/SELECT id FROM columns WHERE project_id = \? ORDER BY position ASC LIMIT 1/i.test(sql)) return stmt;
      return {
        ...stmt,
        all: stmt.all.bind(stmt),
        run: stmt.run.bind(stmt),
        first: async <T extends LexaRow>(...params: SqlParam[]) => {
          entered.resolve();
          await finish.promise;
          try { return await stmt.first<T>(...params); }
          finally { settled.resolve(); }
        },
      };
    });
    try {
      const fiber = Effect.runFork(service.resumeChatStream("c1", "u1", "b1").pipe(Effect.provide(RuntimeEnvLive(env))));
      await entered.promise;
      expect(claimCount()).toBe(1);
      if (cancellation === "Stop") expect(service.abortChat("c1")).toBe(true);
      else await Effect.runPromise(Fiber.interruptFork(fiber));
      finish.resolve();
      if (cancellation === "Stop") await drain(await Effect.runPromise(Fiber.join(fiber)));
      else {
        const exit = await Effect.runPromise(Fiber.await(fiber));
        expect(exit._tag === "Failure" && Cause.isInterrupted(exit.cause)).toBe(true);
      }
      await settled.promise;
      expect(newTaskCount()).toBe(0);
      expect(claimCount()).toBe(0);
      expect(activeChats.has("c1")).toBe(false);
      const saved = db.prepare("SELECT messages FROM assistant_threads WHERE document_type = 'chat' AND document_id = 'c1'").get() as { messages: string };
      expect(JSON.parse(saved.messages)).toEqual(expect.arrayContaining([
        expect.objectContaining({ pendingBatch: expect.objectContaining({ batchId: "b1" }) }),
      ]));
      spy.mockRestore();
      await drain(await run(service.resumeChatStream("c1", "u1", "b1")));
      expect(newTaskCount()).toBe(1);
      const replay = await run(Effect.either(service.resumeChatStream("c1", "u1", "b1")));
      expect(replay).toMatchObject({ _tag: "Left", left: { _tag: "ApprovalNotFound", id: "b1" } });
      expect(newTaskCount()).toBe(1);
      expect(claimCount()).toBe(1);
    } finally {
      finish.resolve();
      spy.mockRestore();
    }
  });

  it.each(["owned", "duplicate"] as const)("cleans up only its own asynchronous claim INSERT after interruption (%s)", async (ownership) => {
    setup();
    seed("approved");
    if (ownership === "duplicate") db.exec("INSERT INTO assistant_resume_claims (batch_id) VALUES ('b1')");
    db.exec("INSERT INTO assistant_resume_claims (batch_id) VALUES ('another-invocation')");
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const settled = Promise.withResolvers<void>();
    const prepare = driver.prepare.bind(driver);
    const spy = vi.spyOn(driver, "prepare").mockImplementation((sql) => {
      const stmt = prepare(sql);
      if (!/INSERT OR IGNORE INTO assistant_resume_claims\b/i.test(sql)) return stmt;
      return {
        ...stmt,
        all: stmt.all.bind(stmt),
        first: stmt.first.bind(stmt),
        run: async (...params) => {
          entered.resolve();
          await finish.promise;
          try { return await stmt.run(...params); }
          finally { settled.resolve(); }
        },
      };
    });
    try {
      const fiber = Effect.runFork(service.resumeChatStream("c1", "u1", "b1").pipe(Effect.provide(RuntimeEnvLive(env))));
      await entered.promise;
      await Effect.runPromise(Fiber.interruptFork(fiber));
      finish.resolve();
      await settled.promise;
      const exit = await Effect.runPromise(Fiber.await(fiber));
      expect(exit._tag === "Failure" && Cause.isInterrupted(exit.cause)).toBe(true);
      expect(claimCount()).toBe(ownership === "owned" ? 0 : 1);
      expect(db.prepare("SELECT batch_id FROM assistant_resume_claims WHERE batch_id = 'another-invocation'").get()).toEqual({ batch_id: "another-invocation" });
      expect(newTaskCount()).toBe(0);
      expect(activeChats.has("c1")).toBe(false);
      spy.mockRestore();
      await drain(await run(service.resumeChatStream("c1", "u1", "b1")));
      expect(newTaskCount()).toBe(ownership === "owned" ? 1 : 0);
      expect(claimCount()).toBe(1);
      if (ownership === "owned") {
        const replay = await run(Effect.either(service.resumeChatStream("c1", "u1", "b1")));
        expect(replay).toMatchObject({ _tag: "Left", left: { _tag: "ApprovalNotFound", id: "b1" } });
      } else {
        expect(await drain(await run(service.resumeChatStream("c1", "u1", "b1")))).toEqual([
          { type: "done", text: "", usage: { in: 0, out: 0 } },
        ]);
      }
      expect(newTaskCount()).toBe(ownership === "owned" ? 1 : 0);
      expect(claimCount()).toBe(1);
    } finally {
      finish.resolve();
      spy.mockRestore();
    }
  });

  // Contract A8: resumed outcomes and retained claims match real domain changes.
  it("executes once and reports mixed results matching stored tasks", async () => {
    stubFetch(() => Promise.resolve(jevResponse()));
    setup();
    seed("approved");
    const insert = db.prepare(`INSERT INTO assistant_pending_writes
      (id, project_id, document_type, document_id, owner_user_id, batch_id, seq, tool_name, args, diff, status, expires_at)
      SELECT ?, project_id, document_type, document_id, owner_user_id, batch_id, ?, ?, ?, ?, ?, expires_at
      FROM assistant_pending_writes WHERE id = 'ap1'`);
    insert.run("ap2", 1, "archive_task", JSON.stringify({ refs: ["t1", "missing"] }), JSON.stringify({ type: "task_archive", taskRef: "2 tasks", taskTitle: "EG-1, missing" }), "approved");
    insert.run("ap3", 2, "archive_task", JSON.stringify({ refs: ["missing"] }), JSON.stringify({ type: "task_archive", taskRef: "missing", taskTitle: "Missing task" }), "approved");
    insert.run("ap4", 3, "create_task", JSON.stringify({ title: "Rejected task" }), JSON.stringify({ type: "task_create", title: "Rejected task", fields: {} }), "rejected");
    insert.run("ap5", 4, "create_task", JSON.stringify({ title: "Expired task" }), JSON.stringify({ type: "task_create", title: "Expired task", fields: {} }), "expired");
    const frames = await drain(await run(service.resumeChatStream("c1", "u1")));
    const results = frames.filter((frame) => frame.type === "approval_result");
    expect(frames.some((frame) => frame.type === "done")).toBe(true);
    expect(results.find((frame) => frame.approvalId === "ap1")).toMatchObject({ status: "applied" });
    expect(results.find((frame) => frame.approvalId === "ap2")).toMatchObject({ status: "applied", partial: { applied: 1, failed: 1 } });
    expect(results.find((frame) => frame.approvalId === "ap3")).toMatchObject({ status: "failed" });
    expect(results.find((frame) => frame.approvalId === "ap4")).toMatchObject({ status: "denied" });
    expect(results.some((frame) => frame.approvalId === "ap5")).toBe(false);
    expect(db.prepare("SELECT count(*) AS c FROM tasks WHERE id = 't1' AND archived_at IS NOT NULL").get()).toEqual({ c: 1 });
    expect(db.prepare("SELECT count(*) AS c FROM tasks WHERE title IN ('Rejected task', 'Expired task')").get()).toEqual({ c: 0 });
    const failed = db.prepare("SELECT execution_error FROM assistant_pending_writes WHERE id = 'ap3'").get() as { execution_error: string };
    expect(failed.execution_error).toMatch(/^TASK_NOT_FOUND:/);
    expect(claimCount()).toBe(1);
    expect(newTaskCount()).toBe(1);
    const saved = db.prepare("SELECT messages FROM assistant_threads WHERE document_type = 'chat' AND document_id = 'c1'").get() as { messages: string };
    const messages = JSON.parse(saved.messages) as Array<Record<string, unknown>>;
    expect(messages.at(-1)).toMatchObject({
      toolLog: [
        { name: "create_task", detail: expect.stringMatching(/^applied: New task/) },
        { name: "archive_task", detail: expect.stringMatching(/^applied: 2 tasks.*1 applied, 1 failed/) },
        { name: "archive_task", detail: expect.stringMatching(/^failed:/) },
        { name: "create_task", detail: expect.stringMatching(/^denied: Rejected task/) },
        { name: "create_task", detail: expect.stringMatching(/^expired: Expired task/) },
      ],
    });
    const repeated = await run(Effect.either(service.resumeChatStream("c1", "u1", "b1")));
    if (repeated._tag === "Right") await drain(repeated.right);
    expect(claimCount()).toBe(1);
    expect(newTaskCount()).toBe(1);
  });

  // Contract A4: an explicit batchId selects that thread marker instead of the newer default.
  it("resumes the explicitly selected batch", async () => {
    stubFetch(() => Promise.resolve(jevResponse()));
    setup();
    seed("approved");
    db.prepare("UPDATE assistant_threads SET messages = ? WHERE document_id = 'c1'").run(JSON.stringify([
      { role: "user", content: "create it" },
      { role: "assistant", content: "proposed", pendingBatch: { batchId: "b1", approvals: [{ approvalId: "ap1", seq: 0, name: "create_task" }] } },
      { role: "user", content: "another turn" },
      { role: "assistant", content: "proposed", pendingBatch: { batchId: "b2", approvals: [] } },
    ]));
    const frames = await drain(await run(service.resumeChatStream("c1", "u1", "b1")));
    expect(frames.some((f) => f.type === "approval_result" && (f as { approvalId?: string; status?: string }).approvalId === "ap1" && (f as { status?: string }).status === "applied")).toBe(true);
    expect(claimCount()).toBe(1);
    expect(newTaskCount()).toBe(1);
  });
  it("late abort from settled chat resume leaves newer chat run alive", async () => {
    stubFetch(() => Promise.resolve(jevResponse()));
    setup();
    seed("approved");
    const oldRequest = new AbortController();
    await drain(await run(service.resumeChatStream("c1", "u1", "b1", oldRequest.signal)));

    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    providerMock.hold = { started: started.resolve, wait: finish.promise };
    const nextStream = await run(service.runChatStream("c1", "u1", { projectId: "p1", chatId: "c1", message: "next" }));
    await started.promise;
    const nextController = activeChats.get("c1")!;

    oldRequest.abort();
    expect(nextController.signal.aborted).toBe(false);
    finish.resolve();
    await drain(nextStream);
  });

  // Contract A5: a duplicate no-op releases the chat run lock so the next normal send can start.
  it("a pre-claimed batch or a marker with no rows settles without executing", async () => {
    stubFetch(() => Promise.resolve(jevResponse()));
    setup();
    seed("approved");
    db.exec(`INSERT INTO assistant_resume_claims (batch_id) VALUES ('b1')`);
    const claimed = await drain(await run(service.resumeChatStream("c1", "u1")));
    // Settled (not empty): the client persists a duplicate instead of retrying.
    expect(claimed).toEqual([{ type: "done", text: "", usage: { in: 0, out: 0 } }]);
    expect(providerMock.calls).toHaveLength(0);
    expect(newTaskCount()).toBe(0);
    const nextTurn = await drain(await runStream("c1", "follow up"));
    expect(nextTurn.some((f) => f.type === "done")).toBe(true);

    activeChats.clear();
    setup();
    db.exec(`INSERT INTO assistant_threads (document_type, document_id, project_id, owner_user_id, messages)
      VALUES ('chat', 'c1', 'p1', 'u1', '[{"role":"user","content":"go"},{"role":"assistant","content":"proposed","pendingBatch":{"batchId":"b1","approvals":[]}}]');`);
    providerMock.calls.length = 0;
    const empty = await drain(await run(service.resumeChatStream("c1", "u1")));
    // Marker with no rows: settled with a terminal frame, no provider turn, and
    // the claim released.
    expect(empty).toEqual([{ type: "done", text: "", usage: { in: 0, out: 0 } }]);
    expect(providerMock.calls).toHaveLength(0);
    expect(claimCount()).toBe(0);
  });
});

// ── Carried assertions ─────────────────────────────────────────────────────
// The trim collapsed the assistant unit suites (write-tools / approval-carrier)
// into this file; each block keeps the assertion the manifest named, at the
// tier where the chat service owns it.

describe("carried — approval carrier continuation split and reconcile", () => {
  const DIFF: AssistantWriteDiff = { type: "task_create", title: "Write docs", fields: { priority: "high" } };

  function assistantTurn(proposal: Record<string, unknown>): UIMessage {
    return {
      id: "a1",
      role: "assistant",
      parts: [
        { type: "text", text: "I can do that." },
        {
          type: "tool-create_task",
          toolCallId: "call_1",
          state: "output-available",
          input: {},
          output: proposal,
        },
      ],
    } as unknown as UIMessage;
  }

  function proposal(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      proposed: true,
      approvalId: "w1",
      batchId: "b1",
      seq: 0,
      name: "create_task",
      detail: "Create “Write docs”",
      diff: DIFF,
      ...over,
    };
  }

  function combinedTurn(): UIMessage {
    const [proposalTurn] = withApprovalCarriers([assistantTurn(proposal())]);
    return {
      ...proposalTurn!,
      parts: [
        ...proposalTurn!.parts,
        { type: "step-start" },
        { type: "text", text: "Approved — done.", state: "done" },
      ],
    } as unknown as UIMessage;
  }

  it("splits the continuation into its own message and keeps a re-proposed write with it", () => {
    const split = withContinuationBoundary([combinedTurn()]);

    expect(split).toHaveLength(3);
    const [proposalTurn, boundary, continuation] = split;
    // Proposal bubble unchanged: same id, carrier still last.
    expect(proposalTurn!.id).toBe("a1");
    expect((proposalTurn!.parts.at(-1) as { type?: string }).type).toBe(ASSISTANT_APPROVAL_DATA_PART);
    expect(JSON.stringify(proposalTurn)).not.toContain("Approved — done.");
    // Boundary: zero-text, only the data-continuation part, names the batch.
    expect(boundary!.parts).toEqual([
      { type: "data-continuation", data: { batchId: "b1", ts: expect.any(String) } },
    ]);
    // Continuation: fresh id, only the appended parts, no carrier.
    expect(continuation!.id).not.toBe("a1");
    expect(continuation!.parts).toEqual([
      { type: "step-start" },
      { type: "text", text: "Approved — done.", state: "done" },
    ]);
    expect(messageCarriesBatch(continuation, "b1")).toBe(false);

    // A re-proposed write lands in the continuation bubble (carrier derived
    // after the split), never in the original proposal bubble.
    const [proposalTurn2] = withApprovalCarriers([assistantTurn(proposal())]);
    const combined = {
      ...proposalTurn2!,
      parts: [
        ...proposalTurn2!.parts,
        { type: "step-start" },
        {
          type: "tool-create_task",
          toolCallId: "call_2",
          state: "output-available",
          input: {},
          output: proposal({ approvalId: "w2", batchId: "b2" }),
        },
      ],
    } as unknown as UIMessage;

    const withCarriers = withApprovalCarriers(withContinuationBoundary([combined]));
    expect(withCarriers).toHaveLength(3);
    const [proposalBubble, , reContinuation] = withCarriers;
    expect(approvalCarriersOf(proposalBubble).map((c) => c.batchId)).toEqual(["b1"]);
    expect(JSON.stringify(proposalBubble)).not.toContain("call_2");
    expect(approvalCarriersOf(reContinuation).map((c) => c.batchId)).toEqual(["b2"]);
  });

  it("reconcileApprovalCarriers backfills a marker-only carrier from its decision rows", () => {
    const markerOnly = {
      role: "assistant",
      parts: [{ type: ASSISTANT_APPROVAL_DATA_PART, data: { batchId: "b1", approvals: [] } }],
    };
    const reconciled = reconcileApprovalCarriers([markerOnly], [
      { id: "w1", batchId: "b1", status: "pending", seq: 0, name: "create_task", diff: DIFF },
    ]);

    expect(approvalCarriersOf(reconciled[0])).toEqual([
      {
        batchId: "b1",
        approvals: [{ approvalId: "w1", seq: 0, name: "create_task", status: "pending", diff: DIFF }],
      },
    ]);
  });

  // D3: an approved row whose execution failed carries "CODE: message" in
  // `assistant_pending_writes.execution_error`; the transcript read must
  // reconcile it onto the carrier so a reloaded chip renders `failed` instead
  // of a clean `approved`.
  it("reconcileApprovalCarriers carries an execution failure onto the carrier", () => {
    const carrier = {
      role: "assistant",
      parts: [
        {
          type: ASSISTANT_APPROVAL_DATA_PART,
          data: { batchId: "b1", approvals: [{ approvalId: "w1", seq: 0, name: "create_task", status: "approved", diff: DIFF }] },
        },
      ],
    };
    const reconciled = reconcileApprovalCarriers([carrier], [
      { id: "w1", batchId: "b1", status: "approved", seq: 0, name: "create_task", diff: DIFF, executionError: "ASSISTANT_WRITE_FAILED: nope" },
    ]);

    expect(approvalCarriersOf(reconciled[0])[0]?.approvals[0]?.executionError).toBe("ASSISTANT_WRITE_FAILED: nope");
  });
});

describe("carried — continuation boundary text probes (LX-124)", () => {
  it("user-text probes ignore the approval/continuation markers", () => {
    const transcript = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        parts: [
          { type: "text", text: "proposed" },
          { type: "data-assistant-approval", data: { batchId: "b1", approvals: [] } },
        ],
      },
      { role: "assistant", parts: [{ type: "data-continuation", data: { batchId: "b1", ts: "2026-01-01T00:00:00Z" } }] },
      { role: "assistant", parts: [{ type: "text", text: "Done — nothing ran." }] },
    ];
    expect(lastUserText(transcript)).toBe("go");
    expect(firstUserText(transcript)).toBe("go");
    expect(lastUserText([...transcript, { role: "user", parts: [{ type: "text", text: "again" }] }])).toBe("again");
  });
});

describe("carried — mention resolution scoping, slug retry, fail-open", () => {
  const doc: TipTapDoc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "body" }] }] };
  const deps = (over: Partial<MentionResolverDeps> = {}): MentionResolverDeps => ({
    dbAll: async () => [],
    findTaskByKey: async () => null,
    findWikiBySlug: async () => null,
    ...over,
  });

  it("skips a cross-project task token, retries a wiki slug lowercased, and never throws", async () => {
    const foreign = await resolveMentionContext(
      deps({ findTaskByKey: async () => ({ id: "t1", projectId: "other", key: "LX-1", title: "X", description: doc }) }),
      "p1",
      "@LX-1"
    );
    expect(foreign).toBe("");

    const seen: string[] = [];
    const lowered = await resolveMentionContext(
      deps({
        findWikiBySlug: async (_p, slug) => {
          seen.push(slug);
          return slug === "guide" ? { id: "w1", title: "Guide", content: doc } : null;
        },
      }),
      "p1",
      "@Guide"
    );
    expect(seen).toEqual(["Guide", "guide"]);
    expect(lowered).toContain("- [wiki] Guide");

    const failed = await resolveMentionContext(
      deps({
        findTaskByKey: async () => {
          throw new Error("db down");
        },
        dbAll: async () => {
          throw new Error("db down");
        },
      }),
      "p1",
      "@LX-1 @Whatever"
    );
    expect(failed).toBe("");
  });
});

describe("carried — write-tools scope, budget, bulk schema, auto dedupe", () => {
  const writeSnapshot: WriteTaskSnapshot = {
    id: "t1",
    key: "NIM-1",
    title: "Task 1",
    columnName: "Todo",
    priority: "high",
    type: "bug",
    dueAt: null,
    assignees: [],
    descriptionText: "body",
    archivedAt: null,
  };

  interface CarriedTool {
    name: string;
    execute: (args: unknown) => Promise<Record<string, unknown>>;
    inputSchema: { safeParse: (v: unknown) => { success: boolean } };
  }

  function bulkDeps(): { recorded: Array<{ diff: AssistantWriteDiff }>; tool: (name: string) => CarriedTool } {
    const recorded: Array<{ diff: AssistantWriteDiff }> = [];
    const deps: AssistantWriteToolDeps = {
      projectId: "p1",
      findTaskByRef: async (ref) => (ref === "NIM-1" ? writeSnapshot : null),
      findColumn: async () => null,
      findWikiPageBySlug: async () => null,
      findMilestone: async () => null,
      countSprints: async () => 0,
      findSwimlane: async () => null,
      record: async (p) => {
        recorded.push(p as { diff: AssistantWriteDiff });
        return { approvalId: "ap-1", batchId: "b1", seq: recorded.length - 1 };
      },
    };
    const all = buildAssistantWriteTools(deps) as unknown as CarriedTool[];
    return { recorded, tool: (name: string) => all.find((t) => t.name === name)! };
  }

  it("denies a task ref that resolves to another project", async () => {
    const marked: string[] = [];
    let updateCalled = false;
    const row = {
      id: "a1",
      project_id: "p1",
      owner_user_id: "u1",
      tool_name: "update_task",
      args: JSON.stringify({ ref: "foreign-task", title: "New title" }),
    } as unknown as AssistantPendingWriteRow;
    const ctx = {
      authz: { projectAccess: () => Effect.succeed({ role: "admin" }) },
      pendingWritesRepo: {
        markExecutionError: (id: string, message: string) => Effect.sync(() => { marked.push(`${id}:${message}`); }),
      },
      taskRepo: {
        findById: () => Effect.succeed({ id: "foreign-task", projectId: "p2" }),
        findByKey: () => Effect.succeed({ id: "foreign-task", projectId: "p2" }),
      },
      taskService: {
        update: () => { updateCalled = true; return Effect.void; },
      },
    } as unknown as AssistantWriteExecutionCtx;

    const out = (await Effect.runPromise(executeAssistantWrite(row, ctx))) as { ok: boolean; error?: string };
    expect(out.ok).toBe(false);
    expect(out.error).toContain("FORBIDDEN");
    expect(marked).toHaveLength(1);
    expect(updateCalled).toBe(false);
  });

  it("accepts up to MAX_WRITES_PER_TURN proposals with a ~TTL expiry, then rejects the next", async () => {
    const rows: WriteRecorderInsertRow[] = [];
    const turn = { projectId: "p1", documentType: "chat" as const, documentId: "c1", ownerUserId: "u1" };
    const recorder = createWriteRecorder(turn, async (r) => {
      rows.push(r);
    });
    const turnProposal = (n: number) => ({
      name: "create_task" as const,
      args: { title: `t${n}` },
      diff: { type: "task_create", title: `t${n}`, fields: {} } as AssistantWriteDiff,
    });

    for (let i = 0; i < MAX_WRITES_PER_TURN; i += 1) {
      const r = await recorder.record(turnProposal(i));
      expect("error" in r).toBe(false);
    }
    const over = await recorder.record(turnProposal(MAX_WRITES_PER_TURN));
    expect(over).toEqual({ error: `write budget exceeded — at most ${MAX_WRITES_PER_TURN} proposals per turn` });

    const expectedMs = Date.now() + APPROVAL_TTL_HOURS * 3_600_000;
    const actualMs = Date.parse((rows[0]!.expiresAt as string).replace(" ", "T") + "Z");
    expect(Math.abs(expectedMs - actualMs)).toBeLessThan(5_000);
  });

  it("bulk refs: rejects over-cap/empty/missing at the schema and dedupes + trims repeats", async () => {
    const { recorded, tool } = bulkDeps();
    const schema = tool("archive_task").inputSchema;
    const tooMany = Array.from({ length: MAX_BULK_TASK_REFS + 1 }, (_, i) => `NIM-${i + 1}`);
    expect(schema.safeParse({ refs: tooMany }).success).toBe(false);
    expect(schema.safeParse({ refs: [] }).success).toBe(false);
    expect(schema.safeParse({}).success).toBe(false);

    const out = await tool("archive_task").execute({ refs: ["NIM-1", "NIM-1", " NIM-1 "] });
    expect(out).toEqual({ proposed: true, approvalId: "ap-1" });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.diff).toEqual({ type: "task_archive", taskRef: "NIM-1", taskTitle: "Task 1" });
  });

  it("auto executes an identical (tool, args) call once (loop safety net, M5b)", async () => {
    const applied: Array<{ name: string; args: unknown }> = [];
    const record = buildAutoWriteRecord({
      apply: async (name, args) => { applied.push({ name, args }); return { ok: true, result: { id: "t9" } }; },
    });
    const deps: AssistantWriteToolDeps = {
      projectId: "p1",
      findTaskByRef: async (ref) => (ref === "NIM-1" ? writeSnapshot : null),
      findColumn: async () => null,
      findWikiPageBySlug: async () => null,
      findMilestone: async () => null,
      countSprints: async () => 0,
      findSwimlane: async () => null,
      record,
    };
    const t = (buildAssistantWriteTools(deps) as unknown as CarriedTool[]).find((x) => x.name === "archive_task")!;
    const first = await t.execute({ ref: "NIM-1" });
    const second = await t.execute({ ref: "NIM-1" });
    expect(first).toEqual({ ok: true, applied: true, result: { id: "t9" } });
    expect(second).toEqual(first);
    expect(applied).toHaveLength(1);
  });
});

// M2 contract (docs/API.md `POST /api/assistant/chat/stream` body + docs/LAYERS.md
// → Assistant stream limits): the composer's EFFORT pick and the documented
// output ceiling both ride `modelOptions` verbatim into the provider request
// body. The owner's 506s turn sent NEITHER — its project default was NULL and no
// per-message effort was picked.
describe("chat model options reach the provider request (M2)", () => {
  it("sends the per-message effort override together with the output ceiling", async () => {
    stubFetch(() => Promise.resolve(jevResponse()));
    setup();
    await drain(await run(service.runChatStream("c1", "u1", { projectId: "p1", chatId: "c1", message: "hello", reasoningEffort: "low" })));
    expect(providerMock.calls.at(-1)?.modelOptions).toEqual({ reasoning_effort: "low", max_tokens: ASSISTANT_MAX_OUTPUT_TOKENS });
  });

  it("sends the ceiling alone when no effort is resolved anywhere", async () => {
    stubFetch(() => Promise.resolve(jevResponse()));
    setup();
    await drain(await runStream("c1", "hello"));
    expect(providerMock.calls.at(-1)?.modelOptions).toEqual({ max_tokens: ASSISTANT_MAX_OUTPUT_TOKENS });
  });
});
