import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer, Context } from "effect";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { Sqlite } from "../db/database";
import { DbBunLive } from "../db/db";
import { Storage, StorageConfig } from "../storage/storage";
import { resolveStorageConfig } from "../storage/config";
import { RuntimeEnvLive } from "../runtime-env";
import { AssistantChatService } from "./assistant-chat.service";
import { activeChats } from "../assistant/active-chats";
import { encryptSecret, parseMasterKey } from "../assistant/secrets";
import type { StreamFrame } from "../../shared/assistant";
import type { RuntimeEnv } from "../env";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

// The provider dispatch is the only outbound model call in these tests; every
// other export of the module stays real so the gateway's own resolution,
// normalization and logging paths are exercised.
const providerMock = vi.hoisted(() => ({
  calls: [] as Array<{ systemPrompts: unknown; tools: unknown }>,
}));
vi.mock("../assistant/provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../assistant/provider")>();
  return {
    ...actual,
    // The adapter construction is real in production and rejects an empty key;
    // these suites exercise Jev preflight/gateway resolution, not adapter
    // wiring, so the snapshot build is stubbed (streamChat is stubbed too).
    buildAdapter: () => ({}) as never,
    streamChat: (input: { systemPrompts: unknown; tools?: unknown }) => {
      providerMock.calls.push({ systemPrompts: input.systemPrompts, tools: input.tools ?? [] });
      return (async function* () {
        yield { type: "TEXT_MESSAGE_CONTENT", delta: "ok" };
        yield { type: "RUN_FINISHED", usage: { input: 1, output: 1 } };
      })();
    },
  };
});

type FetchCall = { url: string; init: RequestInit };

let dir: string;
let db: Database;
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
  // A real provider + model + binding: the gateway must resolve a config for
  // these runs, so only the Jev call is faked, never the model dispatch.
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
  const layer = AssistantChatService.Default.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(Sqlite, db),
        DbBunLive(db),
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

// The preflight writes its one-line record to stderr; captured here so a test
// can assert what a run logged without touching the real stream.
async function captureStderr(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
  return lines;
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
});

afterEach(() => {
  activeChats.clear();
  vi.unstubAllGlobals();
  try { db?.close(); } catch {}
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("chat preflight — new run", () => {
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

  it("offers jev_assess to the model on a new run when Jev is configured", async () => {
    stubFetch(() => Promise.resolve(jevResponse()));
    setup();

    await drain(await runStream("c1", "hello"));
    expect(toolNames(providerMock.calls[0]!)).toContain("jev_assess");
  });
});

describe("chat preflight — resume", () => {
  it("resumes with zero Jev calls and no advisory block", async () => {
    stubFetch(() => Promise.resolve(jevResponse()));
    setup();
    // A decided batch whose tool is unknown to the executor: resume must apply
    // the verdicts and still reach the model, without Jev being consulted.
    db.exec(`
INSERT INTO assistant_threads (document_type, document_id, project_id, owner_user_id, messages)
  VALUES ('chat', 'c1', 'p1', 'u1', '[{"role":"user","content":"go"},{"role":"assistant","content":"proposed","pendingBatch":"b1"}]');
INSERT INTO assistant_pending_writes (id, project_id, document_type, document_id, owner_user_id, batch_id, seq, tool_name, args, diff, status, expires_at)
  VALUES ('ap1', 'p1', 'chat', 'c1', 'u1', 'b1', 0, 'no_such_write_tool', '{}', '{}', 'approved', '2099-01-01 00:00:00');
`);

    const frames = await drain(await run(service.resumeChatStream("c1", "u1")));
    expect(frames.some((f) => f.type === "done")).toBe(true);
    expect(jevCalls).toHaveLength(0);
    expect(providerMock.calls).toHaveLength(1);
    expect(promptText(providerMock.calls[0]!)).not.toContain("Jev advisory");
  });

  it("still offers jev_assess on a resume — its budget is per stream", async () => {
    stubFetch(() => Promise.resolve(jevResponse()));
    setup();
    db.exec(`
INSERT INTO assistant_threads (document_type, document_id, project_id, owner_user_id, messages)
  VALUES ('chat', 'c1', 'p1', 'u1', '[{"role":"user","content":"go"},{"role":"assistant","content":"proposed","pendingBatch":"b1"}]');
INSERT INTO assistant_pending_writes (id, project_id, document_type, document_id, owner_user_id, batch_id, seq, tool_name, args, diff, status, expires_at)
  VALUES ('ap1', 'p1', 'chat', 'c1', 'u1', 'b1', 0, 'no_such_write_tool', '{}', '{}', 'approved', '2099-01-01 00:00:00');
`);

    await drain(await run(service.resumeChatStream("c1", "u1")));
    expect(toolNames(providerMock.calls[0]!)).toContain("jev_assess");
  });

  it("applies an approved create_task and streams the follow-up (no Die)", async () => {
    stubFetch(() => Promise.resolve(jevResponse()));
    setup();
    db.exec(`
INSERT INTO priority_options (id, project_id, label, color, position) VALUES ('prio-1', 'p1', 'Medium', '#888', 0);
INSERT INTO type_options (id, project_id, label, color, position) VALUES ('type-1', 'p1', 'Task', '#888', 0);
INSERT INTO assistant_threads (document_type, document_id, project_id, owner_user_id, messages)
  VALUES ('chat', 'c1', 'p1', 'u1', '[{"role":"user","content":"create it"},{"role":"assistant","content":"proposed","pendingBatch":{"batchId":"b1","approvals":[{"approvalId":"ap1","toolCallId":"call_1","seq":0,"name":"create_task","diff":{"type":"task_create","title":"New task","fields":{}}}]}}]');
INSERT INTO assistant_pending_writes (id, project_id, document_type, document_id, owner_user_id, batch_id, seq, tool_name, args, diff, status, expires_at)
  VALUES ('ap1', 'p1', 'chat', 'c1', 'u1', 'b1', 0, 'create_task', '{"title":"New task"}', '{"type":"task_create","title":"New task","fields":{}}', 'pending', '2099-01-01 00:00:00');
`);

    const decided = await run(service.decideApproval("ap1", "u1", "approve"));
    expect(decided.remaining).toBe(0);

    const frames = await drain(await run(service.resumeChatStream("c1", "u1")));
    const applied = frames.filter((f) => f.type === "approval_result") as Array<{ status: string }>;
    expect(applied.map((f) => f.status)).toContain("applied");
    expect(frames.some((f) => f.type === "done")).toBe(true);
    const created = db.prepare("SELECT title FROM tasks WHERE project_id = 'p1'").all() as Array<{ title: string }>;
    expect(created.map((c) => c.title)).toContain("New task");
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

  it("an upstream rejection leaves the run intact with no advisory", async () => {
    stubFetch(() => Promise.resolve(new Response("nope", { status: 500 })));
    setup();

    const frames = await drain(await runStream("c1", "hello"));
    expect(frames.some((f) => f.type === "done")).toBe(true);
    expect(promptText(providerMock.calls[0]!)).not.toContain("Jev advisory");
  });

  it("an unreadable answer payload leaves the run intact with no advisory", async () => {
    stubFetch(() => Promise.resolve(new Response("not json", { status: 200 })));
    setup();

    const frames = await drain(await runStream("c1", "hello"));
    expect(frames.some((f) => f.type === "done")).toBe(true);
    expect(promptText(providerMock.calls[0]!)).not.toContain("Jev advisory");
  });

  it("no stored key disables the preflight and omits jev_assess entirely", async () => {
    setup({ jev: "no-secret" });
    stubUnreachable();

    const frames = await drain(await runStream("c1", "hello"));
    expect(frames.some((f) => f.type === "done")).toBe(true);
    expect(jevCalls).toHaveLength(0);
    expect(promptText(providerMock.calls[0]!)).not.toContain("Jev advisory");
    expect(toolNames(providerMock.calls[0]!)).not.toContain("jev_assess");
  });

  it("an absent project opt-in disables Jev", async () => {
    setup({ jev: "no-project" });
    stubUnreachable();

    await drain(await runStream("c1", "hello"));
    expect(jevCalls).toHaveLength(0);
    expect(toolNames(providerMock.calls[0]!)).not.toContain("jev_assess");
  });

  it("no master key leaves the stored ciphertext unopenable, disabling Jev", async () => {
    setup({ env: {} as unknown as RuntimeEnv });
    stubUnreachable();

    await drain(await runStream("c1", "hello"));
    expect(jevCalls).toHaveLength(0);
    expect(toolNames(providerMock.calls[0]!)).not.toContain("jev_assess");
  });

  it("stays silent on stderr without a key — an unconfigured Jev is not a run event", async () => {
    setup({ env: {} as unknown as RuntimeEnv });
    stubUnreachable();
    const lines = await captureStderr(async () => {
      await drain(await runStream("c1", "hello"));
    });
    expect(lines.filter((l) => l.includes("assistant-jev"))).toEqual([]);
  });

  it("still logs a configured preflight that actually failed", async () => {
    stubFetch(() => Promise.resolve(new Response("nope", { status: 500 })));
    setup();
    const lines = await captureStderr(async () => {
      await drain(await runStream("c1", "hello"));
    });
    const jev = lines.filter((l) => l.includes("assistant-jev")).map((l) => JSON.parse(l) as { meta: Record<string, unknown> });
    expect(jev).toHaveLength(1);
    expect(jev[0]!.meta.code).toBe("HTTP_500");
    expect(jev[0]!.meta.outcome).toBe("failed");
  });
});
