import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
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
  calls: [] as Array<{ systemPrompts: unknown; tools: unknown; messages: unknown }>,
}));
vi.mock("../assistant/provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../assistant/provider")>();
  return {
    ...actual,
    // The adapter construction is real in production and rejects an empty key;
    // these suites exercise Jev preflight/gateway resolution, not adapter
    // wiring, so the snapshot build is stubbed (streamChat is stubbed too).
    buildAdapter: () => ({}) as never,
    streamChat: (input: { systemPrompts: unknown; tools?: unknown; messages?: unknown }) => {
      providerMock.calls.push({ systemPrompts: input.systemPrompts, tools: input.tools ?? [], messages: input.messages ?? [] });
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
  VALUES ('chat', 'c1', 'p1', 'u1', '[{"role":"user","content":"create it"},{"role":"assistant","content":"proposed","toolCalls":[{"name":"create_task","detail":"New task"}],"pendingBatch":{"batchId":"b1","approvals":[{"approvalId":"ap1","toolCallId":"call_1","seq":0,"name":"create_task","diff":{"type":"task_create","title":"New task","fields":{}}}]}}]');
INSERT INTO assistant_pending_writes (id, project_id, document_type, document_id, owner_user_id, batch_id, seq, tool_name, args, diff, status, expires_at)
  VALUES ('ap1', 'p1', 'chat', 'c1', 'u1', 'b1', 0, 'create_task', '{"title":"New task"}', '{"type":"task_create","title":"New task","fields":{}}', 'pending', '2099-01-01 00:00:00');
`);

    const decided = await run(service.decideApproval("ap1", "u1", "approve"));
    expect(decided.remaining).toBe(0);

    const frames = await drain(await run(service.resumeChatStream("c1", "u1")));
    const applied = frames.filter((f) => f.type === "approval_result") as Array<{ status: string }>;
    expect(applied.map((f) => f.status)).toContain("applied");
    expect(frames.some((f) => f.type === "done")).toBe(true);
    expect(frames.some((f) => f.type === "error" && (f as { code?: string }).code === "ASSISTANT_GENERATION_FAILED")).toBe(false);
    const created = db.prepare("SELECT title FROM tasks WHERE project_id = 'p1'").all() as Array<{ title: string }>;
    expect(created.map((c) => c.title)).toContain("New task");
    // Mock seam: provider.streamChat is stubbed, so this assertion on the exact
    // messages handed to it (not the library) is the hermetic boundary guard.
    const handed = providerMock.calls[0]!.messages as Array<Record<string, unknown>>;
    const assistantHanded = handed.find((m) => m.role === "assistant")!;
    expect(assistantHanded.toolCalls).toBeUndefined();
    // The resumed provider context carries the executed-writes note (tool +
    // created ticket key + status) so the model does not re-propose it...
    const note = handed.find((m) => m.role === "user" && String(m.content).includes("[approved write results]"))!;
    expect(note).toBeDefined();
    expect(String(note.content)).toContain("create_task");
    expect(String(note.content)).toContain("[EG-2]");
    expect(String(note.content)).toContain("applied");
    // ...while the persisted transcript never gains it as a turn.
    const persisted = db.prepare("SELECT messages FROM assistant_threads WHERE document_type = 'chat' AND document_id = 'c1'").get() as { messages: string };
    expect(persisted.messages).not.toContain("[approved write results]");
  });

  it("tells the resumed model an all-rejected batch was not executed", async () => {
    stubFetch(() => Promise.resolve(jevResponse()));
    setup();
    db.exec(`
INSERT INTO assistant_threads (document_type, document_id, project_id, owner_user_id, messages)
  VALUES ('chat', 'c1', 'p1', 'u1', '[{"role":"user","content":"go"},{"role":"assistant","content":"proposed","pendingBatch":{"batchId":"b1","approvals":[{"approvalId":"ap1","toolCallId":"call_1","seq":0,"name":"delete_task"}]}}]');
INSERT INTO assistant_pending_writes (id, project_id, document_type, document_id, owner_user_id, batch_id, seq, tool_name, args, diff, status, expires_at)
  VALUES ('ap1', 'p1', 'chat', 'c1', 'u1', 'b1', 0, 'delete_task', '{"ref":"EG-1"}', '{}', 'rejected', '2099-01-01 00:00:00');
`);

    const frames = await drain(await run(service.resumeChatStream("c1", "u1")));
    const applied = frames.filter((f) => f.type === "approval_result") as Array<{ status: string }>;
    expect(applied.map((f) => f.status)).toEqual(["denied"]);
    expect(frames.some((f) => f.type === "done")).toBe(true);

    const handed = providerMock.calls[0]!.messages as Array<Record<string, unknown>>;
    const note = handed.find((m) => String(m.content).includes("[approved write results]"))!;
    expect(String(note.content)).toContain("None of the proposed writes were executed.");
    expect(String(note.content)).toContain("rejected (not executed)");
  });

  it("notes a failed write with its error in the resumed context", async () => {
    stubFetch(() => Promise.resolve(jevResponse()));
    setup();
    db.exec(`
INSERT INTO assistant_threads (document_type, document_id, project_id, owner_user_id, messages)
  VALUES ('chat', 'c1', 'p1', 'u1', '[{"role":"user","content":"go"},{"role":"assistant","content":"proposed","pendingBatch":{"batchId":"b1","approvals":[{"approvalId":"ap1","toolCallId":"call_1","seq":0,"name":"update_task"}]}}]');
INSERT INTO assistant_pending_writes (id, project_id, document_type, document_id, owner_user_id, batch_id, seq, tool_name, args, diff, status, expires_at)
  VALUES ('ap1', 'p1', 'chat', 'c1', 'u1', 'b1', 0, 'update_task', '{"ref":"EG-999","title":"t"}', '{}', 'approved', '2099-01-01 00:00:00');
`);

    const frames = await drain(await run(service.resumeChatStream("c1", "u1")));
    const applied = frames.filter((f) => f.type === "approval_result") as Array<{ status: string }>;
    expect(applied.map((f) => f.status)).toEqual(["failed"]);

    const handed = providerMock.calls[0]!.messages as Array<Record<string, unknown>>;
    const note = handed.find((m) => String(m.content).includes("[approved write results]"))!;
    expect(String(note.content)).toContain("update_task");
    expect(String(note.content)).toContain("failed (not executed)");
    expect(String(note.content)).toMatch(/failed \(not executed\): /);
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

// The chat harness is reused as-is: real migrations seed the `assistant` agent
// with six junction-bound skills (Status/Review/Polish/Requirements/…), so the
// `$name` path can be exercised end-to-end without touching the DB schema.
describe("chat — per-message $skills", () => {
  function userContentOf(call: { messages: unknown }): unknown {
    return (call.messages as Array<Record<string, unknown>>).find((m) => m.role === "user")?.content;
  }

  it("injects a mentioned bound skill under `## Skill: {name}`", async () => {
    setup({ jev: "no-secret" });
    await drain(await runStream("c1", "give me a $Status update"));

    const text = promptText(providerMock.calls[0]!);
    expect(text).toContain("## Skill: Status");
    expect(text).toContain("Be honest; flag risks early.");
  });

  it("injects only the first three mentions; the fourth stays literal", async () => {
    setup({ jev: "no-secret" });
    await drain(await runStream("c1", "$Status $Review $Polish $Requirements"));

    const text = promptText(providerMock.calls[0]!);
    expect(text).toContain("## Skill: Status");
    expect(text).toContain("## Skill: Review");
    expect(text).toContain("## Skill: Polish");
    expect(text).not.toContain("## Skill: Requirements");
    // The user's message is handed to the model untouched — the dropped token
    // is still literal text, not rewritten or removed.
    expect(userContentOf(providerMock.calls[0]!)).toBe("$Status $Review $Polish $Requirements");
  });

  it("leaves an unbound `$name` literal with nothing injected", async () => {
    setup({ jev: "no-secret" });
    await drain(await runStream("c1", "please $nope that"));

    expect(promptText(providerMock.calls[0]!)).not.toContain("## Skill:");
    expect(userContentOf(providerMock.calls[0]!)).toBe("please $nope that");
  });

  it("carries the bound-skill catalog when skills are bound", async () => {
    setup({ jev: "no-secret" });
    await drain(await runStream("c1", "hi"));

    const text = promptText(providerMock.calls[0]!);
    expect(text).toContain("Available skills");
    expect(text).toContain("- Status — ");
  });

  it("omits the catalog when no skills are bound", async () => {
    setup({ jev: "no-secret" });
    db.exec("DELETE FROM lexa_agent_skills");
    await drain(await runStream("c1", "hi"));

    expect(promptText(providerMock.calls[0]!)).not.toContain("Available skills");
  });

  it("omits the trailing dash for a catalog skill with no description", async () => {
    setup({ jev: "no-secret" });
    db.exec("DELETE FROM lexa_agent_skills");
    db.exec(`INSERT INTO lexa_skills (id, name, description, instructions) VALUES ('sk-nodesc', 'NoDesc', '', '');
            INSERT INTO lexa_agent_skills (agent_id, skill_id) VALUES ('assistant', 'sk-nodesc');`);
    await drain(await runStream("c1", "hi"));

    const text = promptText(providerMock.calls[0]!);
    expect(text).toContain("- NoDesc");
    expect(text).not.toContain("- NoDesc —");
  });

  it("offers get_skill only when the agent has bound skills", async () => {
    setup({ jev: "no-secret" });
    await drain(await runStream("c1", "hi"));
    expect(toolNames(providerMock.calls[0]!)).toContain("get_skill");

    providerMock.calls.length = 0;
    db.exec("DELETE FROM lexa_agent_skills");
    await drain(await runStream("c2", "hi"));
    expect(toolNames(providerMock.calls[0]!)).not.toContain("get_skill");
  });

  it("describes at most 20 catalog skills and counts the rest", async () => {
    setup({ jev: "no-secret" });
    db.exec("DELETE FROM lexa_agent_skills");
    const seed = Array.from({ length: 25 }, (_, i) => {
      const n = String(i + 1).padStart(2, "0");
      return `INSERT INTO lexa_skills (id, name, description, instructions) VALUES ('sk${n}', 'Skill ${n}', 'does ${n}', '');
              INSERT INTO lexa_agent_skills (agent_id, skill_id) VALUES ('assistant', 'sk${n}');`;
    }).join("\n");
    db.exec(seed);
    await drain(await runStream("c1", "hi"));

    const text = promptText(providerMock.calls[0]!);
    expect(text).toContain("- Skill 01 — does 01");
    expect(text).toContain("… and 5 more");
  });

  it("changing the `$skill` between turns does not mint a fresh thread", async () => {
    setup({ jev: "no-secret" });
    await drain(await runStream("c1", "$Status first turn"));
    await drain(await runStream("c1", "$Review second turn"));

    expect(providerMock.calls).toHaveLength(2);
    const secondText = promptText(providerMock.calls[1]!);
    expect(secondText).toContain("## Skill: Review");
    expect(secondText).not.toContain("## Skill: Status");
    // History survived: the earlier user turn rides the second request.
    const handed = providerMock.calls[1]!.messages as Array<Record<string, unknown>>;
    expect(handed.some((m) => m.role === "user" && m.content === "$Status first turn")).toBe(true);
    const count = db.prepare("SELECT COUNT(*) AS c FROM assistant_threads WHERE document_type = 'chat' AND document_id = 'c1'").get() as { c: number };
    expect(count.c).toBe(1);
  });
});

describe("chat — @mention resolution", () => {
  // Milestones/swimlanes/columns have no `slug` column, so the token is the
  // derived slug of the name (mentionSlug = shared/skill-tokens#skillToken).
  function seedEntities(): void {
    db.exec(`
INSERT INTO milestones (id, project_id, name, description, position, due_at) VALUES ('m1', 'p1', 'Q3 Launch', '', 0, '2026-09-30');
INSERT INTO swimlanes (id, project_id, name, position, kind) VALUES ('s-design', 'p1', 'Design Sprint', 1, 'sprint');
INSERT INTO columns (id, project_id, name, position) VALUES ('c-review', 'p1', 'In Review', 2);
`);
  }

  it("resolves one @token per entity type into the ephemeral context block", async () => {
    setup({ jev: "no-secret" });
    seedEntities();
    await drain(await runStream("c1", "@q3-launch @design-sprint @in-review please"));

    const text = promptText(providerMock.calls[0]!);
    expect(text).toContain("- [milestone] Q3 Launch\ndue 2026-09-30");
    expect(text).toContain("- [swimlane] Design Sprint\nsprint");
    expect(text).toContain("- [column] In Review\nposition 3");
  });

  it("skips an unknown slug with nothing injected", async () => {
    setup({ jev: "no-secret" });
    await drain(await runStream("c1", "@nope please"));

    expect(promptText(providerMock.calls[0]!)).not.toContain("Referenced by the user just now:");
  });

  it("resolves a swimlane's owning milestone name in its context line", async () => {
    setup({ jev: "no-secret" });
    seedEntities();
    db.exec(`UPDATE swimlanes SET milestone_id = 'm1' WHERE id = 's-design'`);
    await drain(await runStream("c1", "@design-sprint"));

    expect(promptText(providerMock.calls[0]!)).toContain("- [swimlane] Design Sprint\nsprint · milestone Q3 Launch");
  });

  it("resolves every kind a slug matches — a wiki page and a column collide, both contribute", async () => {
    setup({ jev: "no-secret" });
    db.exec(`
INSERT INTO wiki_pages (id, project_id, title, slug, content) VALUES ('w-rev', 'p1', 'In Review', 'in-review', '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"How review works."}]}]}');
INSERT INTO columns (id, project_id, name, position) VALUES ('c-rev', 'p1', 'In Review', 3);
`);
    await drain(await runStream("c1", "@in-review"));

    const text = promptText(providerMock.calls[0]!);
    expect(text).toContain("- [wiki] In Review");
    expect(text).toContain("- [column] In Review");
  });
});

describe("chat — document attachments", () => {
  it("feeds extracted document text to the model and persists a document-ref part", async () => {
    stubFetch(() => Promise.resolve(jevResponse()));
    setup();

    const bytes = new TextEncoder().encode("# Spec\n\nThe widget enqueues work.");
    const sha = createHash("sha256").update(bytes).digest("hex");
    const key = `blobs/${sha}`;
    const onDisk = join(dir, "blobs", key);
    mkdirSync(dirname(onDisk), { recursive: true });
    writeFileSync(onDisk, bytes);
    db.exec(`
INSERT INTO assistant_threads (document_type, document_id, project_id, owner_user_id, messages)
  VALUES ('chat', 'c1', 'p1', 'u1', '[]');
`);
    db.prepare(
      `INSERT INTO chat_attachments (id, project_id, document_type, document_id, filename, mime_type, size_bytes, sha256, storage_key, uploaded_by)
       VALUES ('ca1', 'p1', 'chat', 'c1', 'spec.md', 'text/markdown', ?, ?, ?, 'u1')`
    ).run(bytes.byteLength, sha, key);

    const frames = await drain(await run(service.runChatStream("c1", "u1", {
      projectId: "p1",
      chatId: "c1",
      message: "summarize the spec",
      attachments: [{ storageKey: key, mimeType: "text/markdown", name: "spec.md" }],
    })));
    expect(frames.some((f) => f.type === "done")).toBe(true);

    // The model saw the extracted text, labelled with the file name.
    const sent = JSON.stringify(providerMock.calls[0]!.messages);
    expect(sent).toContain("attached document: spec.md");
    expect(sent).toContain("The widget enqueues work.");

    // The transcript persists the document-ref part (reload labels by name).
    const row = db.prepare("SELECT messages FROM assistant_threads WHERE document_type = 'chat' AND document_id = 'c1'").get() as { messages: string };
    const messages = JSON.parse(row.messages) as Array<{ role: string; content: unknown }>;
    const user = messages.find((m) => m.role === "user")!;
    expect(user.content).toEqual([
      { type: "text", content: "summarize the spec" },
      { type: "document-ref", storageKey: key, mimeType: "text/markdown", name: "spec.md" },
    ]);
  });

  it("blocks the send with AttachmentExtractionFailed when a document yields no text", async () => {
    stubFetch(() => Promise.resolve(jevResponse()));
    setup();

    const bytes = new TextEncoder().encode("not really a pdf");
    const sha = createHash("sha256").update(bytes).digest("hex");
    const key = `blobs/${sha}`;
    const onDisk = join(dir, "blobs", key);
    mkdirSync(dirname(onDisk), { recursive: true });
    writeFileSync(onDisk, bytes);
    db.exec(`
INSERT INTO assistant_threads (document_type, document_id, project_id, owner_user_id, messages)
  VALUES ('chat', 'c1', 'p1', 'u1', '[]');
`);
    db.prepare(
      `INSERT INTO chat_attachments (id, project_id, document_type, document_id, filename, mime_type, size_bytes, sha256, storage_key, uploaded_by)
       VALUES ('ca1', 'p1', 'chat', 'c1', 'broken.pdf', 'application/pdf', ?, ?, ?, 'u1')`
    ).run(bytes.byteLength, sha, key);

    const result = await run(Effect.either(service.runChatStream("c1", "u1", {
      projectId: "p1",
      chatId: "c1",
      message: "read this",
      attachments: [{ storageKey: key, mimeType: "application/pdf", name: "broken.pdf" }],
    })));
    expect(result._tag).toBe("Left");
    expect((result as { left: { _tag: string; filename: string } }).left).toMatchObject({
      _tag: "AttachmentExtractionFailed",
      filename: "broken.pdf",
    });
    expect(providerMock.calls).toHaveLength(0);
  });
});

describe("chat — attachment validation on the send path", () => {
  function seedThread(): void {
    db.exec(`
INSERT INTO assistant_threads (document_type, document_id, project_id, owner_user_id, messages)
  VALUES ('chat', 'c1', 'p1', 'u1', '[]');
`);
  }

  function insertChatAttachment(id: string, key: string, mime: string): void {
    db.prepare(
      `INSERT INTO chat_attachments (id, project_id, document_type, document_id, filename, mime_type, size_bytes, sha256, storage_key, uploaded_by)
       VALUES (?, 'p1', 'chat', 'c1', 'doc.md', ?, 5, ?, ?, 'u1')`
    ).run(id, mime, `sha-${id}`, key);
  }

  it("refuses a send carrying attachments when the kill switch is on", async () => {
    setup({ env: { LXK_DISABLE_CHAT_ATTACHMENTS: "1" } as RuntimeEnv });
    const result = await run(Effect.either(service.runChatStream("c1", "u1", {
      projectId: "p1",
      chatId: "c1",
      message: "read this",
      attachments: [{ storageKey: "blobs/x", mimeType: "text/plain", name: "x.txt" }],
    })));
    expect(result._tag).toBe("Left");
    expect((result as { left: { _tag: string } }).left._tag).toBe("ChatAttachmentsDisabled");
    expect(providerMock.calls).toHaveLength(0);
  });

  it("rejects a storage key that does not belong to the project", async () => {
    setup();
    const result = await run(Effect.either(service.runChatStream("c1", "u1", {
      projectId: "p1",
      chatId: "c1",
      message: "read this",
      attachments: [{ storageKey: "blobs/other-project", mimeType: "text/plain", name: "sneaky.txt" }],
    })));
    expect(result._tag).toBe("Left");
    expect((result as { left: { _tag: string; reason: string } }).left).toMatchObject({ _tag: "InvalidArgs" });
    expect((result as { left: { reason: string } }).left.reason).toContain("does not belong to this project");
    expect(providerMock.calls).toHaveLength(0);
  });

  it("rejects a declared mime that differs from the stored sniffed mime", async () => {
    setup();
    seedThread();
    insertChatAttachment("ca-mm", "blobs/mm", "text/markdown");
    const result = await run(Effect.either(service.runChatStream("c1", "u1", {
      projectId: "p1",
      chatId: "c1",
      message: "read this",
      attachments: [{ storageKey: "blobs/mm", mimeType: "text/plain", name: "doc.md" }],
    })));
    expect(result._tag).toBe("Left");
    expect((result as { left: { _tag: string; reason: string } }).left).toMatchObject({ _tag: "InvalidArgs" });
    expect((result as { left: { reason: string } }).left.reason).toContain("mimeType mismatch");
    expect(providerMock.calls).toHaveLength(0);
  });

  it("rejects a fourth attachment (images + documents share the count)", async () => {
    setup();
    seedThread();
    for (let i = 1; i <= 4; i += 1) insertChatAttachment(`ca-${i}`, `blobs/cap-${i}`, "text/plain");
    const result = await run(Effect.either(service.runChatStream("c1", "u1", {
      projectId: "p1",
      chatId: "c1",
      message: "many files",
      attachments: [1, 2, 3, 4].map((i) => ({ storageKey: `blobs/cap-${i}`, mimeType: "text/plain", name: `f${i}.txt` })),
    })));
    expect(result._tag).toBe("Left");
    expect((result as { left: { _tag: string; reason: string } }).left).toMatchObject({ _tag: "InvalidArgs" });
    expect((result as { left: { reason: string } }).left.reason).toContain("at most 3 attachments");
    expect(providerMock.calls).toHaveLength(0);
  });
});
