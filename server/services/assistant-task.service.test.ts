import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Cause, Effect, Fiber, Layer, Context } from "effect";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { Sqlite } from "../db/database";
import { Db, type DbDriver } from "../db/db";
import { createBunSqliteDriver } from "../db/drivers/bun-sqlite";
import { Storage, StorageConfig } from "../storage/storage";
import { resolveStorageConfig } from "../storage/config";
import { RuntimeEnvLive, RuntimeEnvTag } from "../runtime-env";
import { AssistantTaskService } from "./assistant-task.service";
import { AssistantPendingWritesRepo } from "../repos/assistant-pending-writes.repo";
import { TaskService } from "./task.service";
import { AUTO_SKILL_INSTRUCTION } from "../assistant/prompt";
import { encryptSecret, parseMasterKey } from "../assistant/secrets";
// `loadTaskRepoContent` is best-effort but its requirements are resolved from
// the ambient context (a missing one is a defect, not a typed failure), so the
// suite provides the same GitHub/repo-registry pieces the API base layer does.
import { ProjectReposRepo } from "../repos/project-repos.repo";
import { TaskRepo } from "../repos/task.repo";
import { GitHubClient } from "../github/client";
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
    // See assistant-chat.service.test.ts: the adapter snapshot is stubbed so a
    // keyless test provider never rejects provider construction.
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
let service: AssistantTaskService;
let pendingWritesRepo: AssistantPendingWritesRepo;
let taskService: TaskService;
let driver: DbDriver;
let env: RuntimeEnv;
let baseLayer: Layer.Layer<
  Sqlite | Db | Storage | StorageConfig | RuntimeEnvTag | ProjectReposRepo | TaskRepo | GitHubClient
>;
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
  dir = mkdtempSync(join(tmpdir(), "lexa-assistant-task-svc-"));
  const dbPath = join(dir, "test.db");
  runMigrations(dbPath, MIGRATIONS);
  db = new Database(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  // A real provider + model + binding plus the agent/skill pair the queue
  // resolves, so only the Jev call is faked, never the model dispatch.
  db.exec(`
INSERT INTO users (id, email, name, role) VALUES ('u1', 'a@lexa.test', 'A', 'superadmin');
INSERT INTO projects (id, name, slug, key, next_task_number) VALUES ('p1', 'P', 'p1', 'EG', 1);
INSERT INTO columns (id, project_id, name, position) VALUES ('c1', 'p1', 'Todo', 0);
INSERT INTO swimlanes (id, project_id, name, position, kind, due_at) VALUES ('s-backlog', 'p1', 'Backlog', 0, 'backlog', NULL);
INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, description, position, created_at, key, number)
  VALUES ('t1', 'p1', 'c1', 's-backlog', 'Fix login', 'The login button is broken.', 'a0', '2026-01-01 10:00:00', 'EG-1', 1);
INSERT INTO lexa_agents (id, name, description, instructions, is_builtin) VALUES ('a1', 'Test Agent', '', 'Be precise.', 0);
INSERT INTO lexa_skills (id, name, description, instructions, is_builtin) VALUES ('sk1', 'Test Polish', '', 'Polish the text.', 0);
INSERT INTO lexa_agent_skills (agent_id, skill_id) VALUES ('a1', 'sk1');
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
  const dbLayer = Layer.mergeAll(
    Layer.succeed(Sqlite, db),
    Layer.succeed(Db, driver),
    Layer.succeed(StorageConfig, cfg),
    Storage.Default.pipe(Layer.provide(Layer.succeed(StorageConfig, cfg))),
    RuntimeEnvLive(env),
  );
  // `mergeAll` does not satisfy a member's own requirements, so the repo
  // registry, task repo and GitHub client are provided the db layer explicitly.
  baseLayer = Layer.mergeAll(dbLayer, ProjectReposRepo.Default, TaskRepo.Default, GitHubClient.Default).pipe(Layer.provide(dbLayer));
  const ctx = Effect.runSync(Effect.scoped(Layer.build(Layer.mergeAll(AssistantTaskService.Default, AssistantPendingWritesRepo.Default, TaskService.Default).pipe(Layer.provide(baseLayer)))));
  service = Context.get(ctx, AssistantTaskService);
  pendingWritesRepo = Context.get(ctx, AssistantPendingWritesRepo);
  taskService = Context.get(ctx, TaskService);
}

// A service method runs in the CALLER's context, not the layer it was built in:
// `currentEnv` and `loadTaskRepoContent` both read the ambient environment when
// the method executes. So the base layer is provided to the effect, exactly
// where server/api/http.ts provides it per request. The requirements stay in
// the signature (`R`) so the provide is what discharges them, not a cast.
function run<A, E, R>(eff: Effect.Effect<A, E, R>): Promise<A> {
  return Effect.runPromise(eff.pipe(Effect.provide(baseLayer)) as Effect.Effect<A, E, never>);
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

function queueRun(id: string): void {
  db.exec(`
INSERT INTO assistant_tasks (id, project_id, document_type, document_id, agent_id, skill_id, extra_prompt, selection, status)
  VALUES ('${id}', 'p1', 'task', 't1', 'a1', 'sk1', 'tighten the wording', '', 'queued');
`);
}

function runStream(taskId: string) {
  return run(service.runStream(taskId, { userId: "u1" }));
}

beforeEach(() => {
  jevCalls.length = 0;
  providerMock.calls.length = 0;
});

afterEach(() => {
  service?.activeTasks.clear();
  service?.activeDocuments.clear();
  vi.unstubAllGlobals();
  try { db?.close(); } catch {}
  if (dir) rmSync(dir, { recursive: true, force: true });
});

it("does not expose private chat images to document tools until a project attachment authorizes the bytes", async () => {
  setup({ jev: "no-project" });
  db.exec(`
    UPDATE assistant_settings SET vision_model = 'test-model' WHERE project_id = 'p1';
    INSERT INTO assistant_threads (document_type, document_id, project_id, owner_user_id, messages)
      VALUES ('chat', 'private-images', 'p1', 'u1', '[]');
    INSERT INTO chat_attachments (id, project_id, document_type, document_id, filename, mime_type, size_bytes, sha256, storage_key, uploaded_by)
      VALUES ('private-image', 'p1', 'chat', 'private-images', 'private.png', 'image/png', 8, 'private-image-hash', 'blobs/private-image', 'u1');
  `);
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  await run(Effect.gen(function* () { yield* (yield* Storage).put("blobs/private-image", bytes); }));
  stubFetch(() => Promise.resolve(new Response(JSON.stringify({
    choices: [{ message: { content: "A project-visible screenshot." } }],
  }), { headers: { "content-type": "application/json" } })));
  queueRun("private-image-check");
  await drain(await runStream("private-image-check"));
  const tools = providerMock.calls[0]!.tools as Array<{
    name: string;
    execute: (input: { storageKey: string; question: string }) => Promise<{ description: string; error?: string }>;
  }>;
  const analyze = tools.find((tool) => tool.name === "analyze_image");
  if (!analyze) throw new Error("Missing image tool for configured vision provider");
  const denied = await analyze.execute({ storageKey: "blobs/private-image", question: "Describe the image" });
  expect(denied.description).toBe("");
  expect(denied.error).toEqual(expect.any(String));
  expect(jevCalls).toHaveLength(0);

  db.exec(`
    INSERT INTO attachments (id, project_id, task_id, filename, mime_type, size_bytes, sha256, storage_key, uploaded_by)
      VALUES ('project-image', 'p1', 't1', 'project.png', 'image/png', 8, 'private-image-hash', 'blobs/private-image', 'u1');
  `);
  const allowed = await analyze.execute({ storageKey: "blobs/private-image", question: "Describe the image" });
  expect(allowed).not.toHaveProperty("error");
  expect(jevCalls).toHaveLength(1);
});

  it("settles a claimed task and releases its controller when setup fails before streaming", async () => {
    setup();
    queueRun("at1");
    db.exec("DELETE FROM assistant_settings WHERE project_id = 'p1'");

    const outcome = await run(Effect.either(service.runStream("at1", { userId: "u1" })));
    expect(outcome._tag).toBe("Left");
    if (outcome._tag !== "Left") throw new Error("expected setup failure");
    expect(outcome.left).toMatchObject({ _tag: "ProviderNotConfigured" });

    expect(db.prepare("SELECT status FROM assistant_tasks WHERE id = 'at1'").get()).toMatchObject({ status: "failed" });
    expect(service.activeTasks.size).toBe(0);
    expect(service.activeDocuments.size).toBe(0);

    db.exec("INSERT INTO assistant_settings (project_id, write_tools, provider_id, primary_model_id) VALUES ('p1', '[]', 'pv1', 'm1')");
    stubFetch(() => Promise.resolve(jevResponse()));
    queueRun("at2");
    const frames = await drain(await runStream("at2"));
    expect(frames.at(-1)?.type).toBe("done");
    expect(db.prepare("SELECT status FROM assistant_tasks WHERE id = 'at2'").get()).toMatchObject({ status: "completed" });
  });

describe("task preflight — new run", () => {
  it("sends one preflight over the task context, offers jev_assess + get_skill, and the advisory reaches the system prompt", async () => {
    stubFetch(() => Promise.resolve(jevResponse()));
    setup();
    queueRun("at1");

    const frames = await drain(await runStream("at1"));
    expect(frames.some((f) => f.type === "done")).toBe(true);

    expect(jevCalls).toHaveLength(1);
    expect(jevCalls[0]!.url).toBe("https://typesafe.test/v1/systemone");
    const body = JSON.parse(String(jevCalls[0]!.init.body)) as { state: string; model: string; questions: Record<string, { type: string }> };
    expect(body.model).toBe("jev-latest");
    expect(Object.keys(body.questions).sort()).toEqual(["ambiguity", "memory_conflict", "write_intent"]);
    const state = JSON.parse(body.state) as {
      runKind: string;
      projectId: string;
      threadId: string;
      threadLabel: string;
      userMessage: string;
      taskWikiContext: string;
    };
    expect(state.runKind).toBe("task");
    expect(state.projectId).toBe("p1");
    expect(state.threadId).toBe("t1");
    expect(state.threadLabel).toBe("Fix login");
    // The judgment sees the same text the model will: the selection wrapped as
    // selected text plus the extra prompt, never the transcript history.
    expect(state.userMessage).toContain("tighten the wording");
    expect(state.taskWikiContext).toContain("EG-1 — Fix login");
    expect(state.taskWikiContext).toContain("The login button is broken.");
    expect(state).not.toHaveProperty("history");

    expect(providerMock.calls).toHaveLength(1);
    // The Jev tool and the bound-skill tool are both offered on a configured run.
    const tools = toolNames(providerMock.calls[0]!);
    expect(tools).toContain("jev_assess");
    expect(tools).toContain("get_skill");
    const text = promptText(providerMock.calls[0]!);
    expect(text).toContain("Jev advisory (non-authoritative)");
    expect(text).toContain("write intent: write");
    expect(text).toContain("live project data remains authoritative");
  });

});

describe("task enqueue — auto skill selection", () => {
  it("enqueues without a skillId (auto mode) but rejects a skillId that is not bound to the agent", async () => {
    setup();
    const task = await run(service.enqueue({
      projectId: "p1",
      documentType: "task",
      documentId: "t1",
      prompt: "improve this doc",
      agentId: "a1",
    }));
    expect(task.status).toBe("queued");
    expect(task.skillId).toBeNull();

    stubFetch(() => Promise.resolve(jevResponse()));
    const frames = await drain(await run(service.runStream(task.id, { userId: "u1" })));
    expect(frames.some((f) => f.type === "done")).toBe(true);
    const text = promptText(providerMock.calls[0]!);
    expect(text).toContain(AUTO_SKILL_INSTRUCTION);
    // Bun parity with the Worker DO: the auto-pick instruction is backed by the
    // bound-skill catalog (same `buildSkillPromptParts` source `context.ts` uses).
    expect(text).toContain("Available skills");
    expect(text).toContain("- Test Polish");
    expect(text).not.toContain("Polish the text.");

    db.exec("INSERT INTO lexa_skills (id, name, description, instructions, is_builtin) VALUES ('sk2', 'Other', '', 'x', 0)");
    const result = await run(Effect.either(service.enqueue({
      projectId: "p1",
      documentType: "task",
      documentId: "t1",
      prompt: "",
      agentId: "a1",
      skillId: "sk2",
    })));
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") expect(result.left._tag).toBe("SkillNotFound");
  });
});

describe("task skill tolerance — deleted skill row", () => {
  it("a dangling task skill_id degrades to auto mode instead of failing the run", async () => {
    stubFetch(() => Promise.resolve(jevResponse()));
    setup();
    queueRun("at1");
    // Simulate the Bun/FK-OFF runner: a skill deleted after enqueue leaves the
    // row's skill_id dangling. The service must swallow findSkillById's
    // RowNotFound and run in auto mode, never surface SkillNotFound.
    db.exec("PRAGMA foreign_keys = OFF");
    db.prepare("UPDATE assistant_tasks SET skill_id = 'ghost' WHERE id = 'at1'").run();
    db.exec("PRAGMA foreign_keys = ON");

    const frames = await drain(await runStream("at1"));
    expect(frames.some((f) => f.type === "done")).toBe(true);
    expect(frames.some((f) => f.type === "error")).toBe(false);
    const text = promptText(providerMock.calls[0]!);
    expect(text).toContain(AUTO_SKILL_INSTRUCTION);
    expect(text).not.toContain("Polish the text.");
  });
});

describe("task preflight — resume", () => {
  // A decided batch whose tool is unknown to the executor: resume must apply
  // the verdicts and still reach the model, without Jev being consulted.
  const seedDecidedBatch = (skillId = "sk1"): void => {
    db.exec(`
INSERT INTO assistant_threads (document_type, document_id, project_id, owner_user_id, agent_id, skill_id, messages)
  VALUES ('task', 't1', 'p1', 'u1', 'a1', '${skillId}', '[{"role":"user","content":"go"},{"role":"assistant","content":"proposed","pendingBatch":"b1"}]');
INSERT INTO assistant_pending_writes (id, project_id, document_type, document_id, owner_user_id, batch_id, seq, tool_name, args, diff, status, expires_at)
  VALUES ('ap1', 'p1', 'task', 't1', 'u1', 'b1', 0, 'no_such_write_tool', '{}', '{}', 'approved', '2099-01-01 00:00:00');
`);
  };

  it("a stale thread skill_id degrades resumeThreadStream to auto mode", async () => {
    stubFetch(() => Promise.resolve(jevResponse()));
    setup();
    // assistant_threads.skill_id has no FK; a skill deleted after the thread was
    // written leaves the thread pointing at a vanished row. The resume must
    // swallow RowNotFound and fall back to auto mode, never SkillNotFound.
    seedDecidedBatch("ghost");

    const frames = await drain(await run(service.resumeThreadStream("task", "t1")));
    expect(frames.some((f) => f.type === "done")).toBe(true);
    expect(frames.some((f) => f.type === "error")).toBe(false);
    const text = promptText(providerMock.calls[0]!);
    expect(text).toContain(AUTO_SKILL_INSTRUCTION);
    expect(text).not.toContain("Polish the text.");
  });

  // Contract A4/A8: an explicit task batch beats a newer marker and reports the applied domain result.
  it("applies the explicitly selected batch and streams the follow-up", async () => {
    stubFetch(() => Promise.resolve(jevResponse()));
    setup();
    db.exec(`
INSERT INTO priority_options (id, project_id, label, color, position) VALUES ('prio-1', 'p1', 'Medium', '#888', 0);
INSERT INTO type_options (id, project_id, label, color, position) VALUES ('type-1', 'p1', 'Task', '#888', 0);
INSERT INTO assistant_threads (document_type, document_id, project_id, owner_user_id, agent_id, skill_id, messages)
  VALUES ('task', 't1', 'p1', 'u1', 'a1', 'sk1', '[{"role":"user","content":"go"},{"role":"assistant","content":"proposed","toolCalls":[{"name":"create_task","detail":"New task"}],"pendingBatch":{"batchId":"b1","approvals":[{"approvalId":"ap1","toolCallId":"call_1","seq":0,"name":"create_task","diff":{"type":"task_create","title":"New task","fields":{}}}]}}]');
INSERT INTO assistant_pending_writes (id, project_id, document_type, document_id, owner_user_id, batch_id, seq, tool_name, args, diff, status, expires_at)
  VALUES ('ap1', 'p1', 'task', 't1', 'u1', 'b1', 0, 'create_task', '{"title":"New task"}', '{"type":"task_create","title":"New task","fields":{}}', 'approved', '2099-01-01 00:00:00');
`);
    const saved = db.prepare("SELECT messages FROM assistant_threads WHERE document_id = 't1'").get() as { messages: string };
    const messages = JSON.parse(saved.messages) as unknown[];
    messages.push({ role: "assistant", content: "newer proposal", pendingBatch: { batchId: "b2", approvals: [] } });
    db.prepare("UPDATE assistant_threads SET messages = ? WHERE document_id = 't1'").run(JSON.stringify(messages));

    const frames = await drain(await run(service.resumeThreadStream("task", "t1", "b1")));
    const applied = frames.filter((f) => f.type === "approval_result") as Array<{ status: string }>;
    expect(applied.map((f) => f.status)).toContain("applied");
    expect(frames.some((f) => f.type === "done")).toBe(true);
    expect(frames.some((f) => f.type === "error" && (f as { code?: string }).code === "ASSISTANT_GENERATION_FAILED")).toBe(false);
    const created = db.prepare("SELECT title FROM tasks WHERE project_id = 'p1'").all() as Array<{ title: string }>;
    expect(created.map((c) => c.title)).toContain("New task");
    expect(db.prepare("SELECT batch_id FROM assistant_resume_claims ORDER BY batch_id").all()).toEqual([{ batch_id: "b1" }]);
    const handed = providerMock.calls[0]!.messages as Array<Record<string, unknown>>;
    const assistantHanded = handed.find((m) => m.role === "assistant")!;
    expect(assistantHanded.toolCalls).toBeUndefined();
    const canonical = db.prepare("SELECT messages FROM assistant_threads WHERE document_type = 'task' AND document_id = 't1'").get() as { messages: string };
    const canonicalMessages = JSON.parse(canonical.messages) as Array<Record<string, unknown>>;
    expect(canonicalMessages.at(-1)).toMatchObject({
      toolLog: [{ name: "create_task", detail: expect.stringMatching(/^applied: New task/) }],
    });
  });
});

describe("task resume — no-op settle (ADR-0005 M2 follow-up)", () => {
  // A thread whose trailing assistant turn carries a pending-batch marker.
  const seedMarker = (): void => {
    db.exec(`
INSERT INTO assistant_threads (document_type, document_id, project_id, owner_user_id, agent_id, skill_id, messages)
  VALUES ('task', 't1', 'p1', 'u1', 'a1', 'sk1', '[{"role":"user","content":"go"},{"role":"assistant","content":"proposed","pendingBatch":{"batchId":"b1","approvals":[]}}]');
`);
  };

  const seedApprovedBatch = (): void => {
    seedMarker();
    db.exec(`
INSERT INTO priority_options (id, project_id, label, color, position) VALUES ('prio-1', 'p1', 'Medium', '#888', 0);
INSERT INTO type_options (id, project_id, label, color, position) VALUES ('type-1', 'p1', 'Task', '#888', 0);
UPDATE assistant_threads SET messages = '[{"role":"user","content":"go"},{"role":"assistant","content":"proposed","pendingBatch":{"batchId":"b1","approvals":[{"approvalId":"ap1","seq":0,"name":"create_task"}]}}]' WHERE document_type = 'task' AND document_id = 't1';
INSERT INTO assistant_pending_writes (id, project_id, document_type, document_id, owner_user_id, batch_id, seq, tool_name, args, diff, status, expires_at)
  VALUES ('ap1', 'p1', 'task', 't1', 'u1', 'b1', 0, 'create_task', '{"title":"Recovered task"}', '{"type":"task_create","title":"Recovered task","fields":{}}', 'approved', '2099-01-01 00:00:00');
`);
  };

  it("Stop settles the first approved document mutation without starting the second", async () => {
    stubFetch(() => Promise.resolve(jevResponse()));
    setup();
    seedApprovedBatch();
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
      const resuming = run(service.resumeThreadStream("task", "t1", "b1"));
      await entered.promise;
      const controller = service.activeTasks.get("t1")!;
      expect(service.abortStream("t1")).toBe(true);
      expect(controller.signal.aborted).toBe(true);
      expect(db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE title = 'Recovered task'").get()).toEqual({ n: 0 });
      expect(service.activeTasks.get("t1")).toBe(controller);
      finish.resolve();
      const frames = await drain(await resuming);
      expect(mutationBatches).toBe(1);
      expect(db.prepare("SELECT title FROM tasks WHERE title IN ('Recovered task', 'Must not start')").all()).toEqual([{ title: "Recovered task" }]);
      expect(frames.filter((frame) => frame.type === "approval_result")).toEqual([
        { type: "approval_result", approvalId: "ap1", status: "applied" },
        { type: "approval_result", approvalId: "ap2", status: "failed", error: "Assistant stopped" },
      ]);
      expect(db.prepare("SELECT batch_id FROM assistant_resume_claims WHERE batch_id = 'b1'").all()).toEqual([{ batch_id: "b1" }]);
      expect(service.activeTasks.size).toBe(0);
      expect(service.activeDocuments.size).toBe(0);
      const saved = db.prepare("SELECT messages FROM assistant_threads WHERE document_type = 'task' AND document_id = 't1'").get() as { messages: string };
      const messages = JSON.parse(saved.messages) as Array<Record<string, unknown>>;
      expect(messages.at(-1)).toMatchObject({
        role: "assistant", content: "", stopped: true,
        toolLog: [
          { name: "create_task", detail: expect.stringMatching(/^applied: Recovered task/) },
          { name: "create_task", detail: expect.stringMatching(/^failed: Must not start/) },
        ],
      });
      expect(providerMock.calls).toHaveLength(0);
      const replay = await run(Effect.either(service.resumeThreadStream("task", "t1", "b1")));
      expect(replay).toMatchObject({ _tag: "Left", left: { _tag: "ApprovalNotFound", id: "b1" } });
      expect(mutationBatches).toBe(1);
      expect(db.prepare("SELECT title FROM tasks WHERE title IN ('Recovered task', 'Must not start')").all()).toEqual([{ title: "Recovered task" }]);
      expect(db.prepare("SELECT batch_id FROM assistant_resume_claims WHERE batch_id = 'b1'").all()).toEqual([{ batch_id: "b1" }]);
      queueRun("at-next");
      expect((await drain(await runStream("at-next"))).some((frame) => frame.type === "done")).toBe(true);
      expect(db.prepare("SELECT status FROM assistant_tasks WHERE id = 'at-next'").get()).toEqual({ status: "completed" });
    } finally {
      finish.resolve();
      spy.mockRestore();
    }
  });

  it.each(["owned", "duplicate"] as const)("cleans up only its own asynchronous document claim INSERT after interruption (%s)", async (ownership) => {
    setup();
    seedApprovedBatch();
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
      const fiber = Effect.runFork(service.resumeThreadStream("task", "t1", "b1").pipe(Effect.provide(baseLayer)));
      await entered.promise;
      await Effect.runPromise(Fiber.interruptFork(fiber));
      finish.resolve();
      await settled.promise;
      const exit = await Effect.runPromise(Fiber.await(fiber));
      expect(exit._tag === "Failure" && Cause.isInterrupted(exit.cause)).toBe(true);
      expect(db.prepare("SELECT COUNT(*) AS n FROM assistant_resume_claims WHERE batch_id = 'b1'").get()).toEqual({ n: ownership === "owned" ? 0 : 1 });
      expect(db.prepare("SELECT batch_id FROM assistant_resume_claims WHERE batch_id = 'another-invocation'").get()).toEqual({ batch_id: "another-invocation" });
      expect(db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE title = 'Recovered task'").get()).toEqual({ n: 0 });
      expect(service.activeTasks.size).toBe(0);
      expect(service.activeDocuments.size).toBe(0);
      spy.mockRestore();
      await drain(await run(service.resumeThreadStream("task", "t1", "b1")));
      expect(db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE title = 'Recovered task'").get()).toEqual({ n: ownership === "owned" ? 1 : 0 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM assistant_resume_claims WHERE batch_id = 'b1'").get()).toEqual({ n: 1 });
      if (ownership === "owned") {
        const replay = await run(Effect.either(service.resumeThreadStream("task", "t1", "b1")));
        expect(replay).toMatchObject({ _tag: "Left", left: { _tag: "ApprovalNotFound", id: "b1" } });
      } else {
        expect(await drain(await run(service.resumeThreadStream("task", "t1", "b1")))).toEqual([
          { type: "done", text: "", usage: { in: 0, out: 0 } },
        ]);
      }
      expect(db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE title = 'Recovered task'").get()).toEqual({ n: ownership === "owned" ? 1 : 0 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM assistant_resume_claims WHERE batch_id = 'b1'").get()).toEqual({ n: 1 });
    } finally {
      finish.resolve();
      spy.mockRestore();
    }
  });

  // Contract A5: duplicate and empty resumes release the document lock for a later continuation.
  it("a duplicate resume claim settles with a terminal done frame (no re-execution)", async () => {
    setup();
    seedMarker();
    db.exec(`INSERT INTO assistant_resume_claims (batch_id) VALUES ('b1')`);

    const frames = await drain(await run(service.resumeThreadStream("task", "t1")));
    // Settled, not empty: the client persists the duplicate instead of reading
    // an empty stream as a stall and retrying forever (parity with chat).
    expect(frames).toEqual([{ type: "done", text: "", usage: { in: 0, out: 0 } }]);
    expect(await drain(await run(service.resumeThreadStream("task", "t1")))).toEqual([{ type: "done", text: "", usage: { in: 0, out: 0 } }]);
    expect(providerMock.calls).toHaveLength(0);
    // The pre-existing claim SURVIVES a duplicate resume (it is never released);
    // this is what distinguishes a duplicate from the marker-with-no-rows case.
    const claims = (db.prepare("SELECT COUNT(*) AS n FROM assistant_resume_claims WHERE batch_id = 'b1'").get() as { n: number }).n;
    expect(claims).toBe(1);
  });

  // Contract A5: a missing approval row releases both the acquired claim and document lock.
  it("a marker with no rows settles with a terminal done frame and releases the claim", async () => {
    setup();
    seedMarker();

    const frames = await drain(await run(service.resumeThreadStream("task", "t1")));
    expect(frames).toEqual([{ type: "done", text: "", usage: { in: 0, out: 0 } }]);
    expect(await drain(await run(service.resumeThreadStream("task", "t1")))).toEqual([{ type: "done", text: "", usage: { in: 0, out: 0 } }]);
    expect(providerMock.calls).toHaveLength(0);
    const claims = (db.prepare("SELECT COUNT(*) AS n FROM assistant_resume_claims").get() as { n: number }).n;
    expect(claims).toBe(0);
  });
  it("releases an interrupted pre-execution claim and retries the approved batch once", async () => {
    setup();
    db.exec(`
INSERT INTO priority_options (id, project_id, label, color, position) VALUES ('prio-1', 'p1', 'Medium', '#888', 0);
INSERT INTO type_options (id, project_id, label, color, position) VALUES ('type-1', 'p1', 'Task', '#888', 0);
INSERT INTO assistant_threads (document_type, document_id, project_id, owner_user_id, agent_id, skill_id, messages)
  VALUES ('task', 't1', 'p1', 'u1', 'a1', 'sk1', '[{"role":"user","content":"go"},{"role":"assistant","content":"proposed","pendingBatch":{"batchId":"b1","approvals":[{"approvalId":"ap1","seq":0,"name":"create_task"}]}}]');
INSERT INTO assistant_pending_writes (id, project_id, document_type, document_id, owner_user_id, batch_id, seq, tool_name, args, diff, status, expires_at)
  VALUES ('ap1', 'p1', 'task', 't1', 'u1', 'b1', 0, 'create_task', '{"title":"Recovered task"}', '{"type":"task_create","title":"Recovered task","fields":{}}', 'approved', '2099-01-01 00:00:00');
`);
    const entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    const finishList: Array<() => void> = [];
    const listByBatch = pendingWritesRepo.listByBatch.bind(pendingWritesRepo);
    let calls = 0;
    const spy = vi.spyOn(pendingWritesRepo, "listByBatch").mockImplementation((batchId) => {
      if (calls >= entered.length) return listByBatch(batchId);
      const index = calls++;
      return Effect.async((resume) => {
        entered[index]!.resolve();
        finishList[index] = () => resume(listByBatch(batchId));
      });
    });

    try {
      const oldRequest = new AbortController();
      const fiber = Effect.runFork(service.resumeThreadStream("task", "t1", "b1", oldRequest.signal).pipe(Effect.provide(baseLayer)));
      await entered[0]!.promise;
      await Effect.runPromise(Fiber.interrupt(fiber));
      expect(db.prepare("SELECT COUNT(*) AS n FROM assistant_resume_claims WHERE batch_id = 'b1'").get()).toEqual({ n: 0 });
      finishList[0]!();

      const retry = Effect.runFork(service.resumeThreadStream("task", "t1", "b1").pipe(Effect.provide(baseLayer)));
      await entered[1]!.promise;
      const retryController = service.activeTasks.get("t1")!;
      oldRequest.abort();
      expect(retryController.signal.aborted).toBe(false);
      finishList[1]!();
      const frames = await drain(await Effect.runPromise(Fiber.join(retry)));
      expect(frames.some((frame) => frame.type === "done")).toBe(true);
      expect(db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE project_id = 'p1' AND title = 'Recovered task'").get()).toEqual({ n: 1 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM assistant_resume_claims WHERE batch_id = 'b1'").get()).toEqual({ n: 1 });
    } finally {
      spy.mockRestore();
    }
  });
  it("retains claim when approved mutation commits before resumed execution is interrupted", async () => {
    setup();
    db.exec(`
INSERT INTO priority_options (id, project_id, label, color, position) VALUES ('prio-1', 'p1', 'Medium', '#888', 0);
INSERT INTO type_options (id, project_id, label, color, position) VALUES ('type-1', 'p1', 'Task', '#888', 0);
INSERT INTO assistant_threads (document_type, document_id, project_id, owner_user_id, agent_id, skill_id, messages)
  VALUES ('task', 't1', 'p1', 'u1', 'a1', 'sk1', '[{"role":"user","content":"go"},{"role":"assistant","content":"proposed","pendingBatch":{"batchId":"b1","approvals":[{"approvalId":"ap1","seq":0,"name":"create_task"}]}}]');
INSERT INTO assistant_pending_writes (id, project_id, document_type, document_id, owner_user_id, batch_id, seq, tool_name, args, diff, status, expires_at)
  VALUES ('ap1', 'p1', 'task', 't1', 'u1', 'b1', 0, 'create_task', '{"title":"Committed before interruption"}', '{"type":"task_create","title":"Committed before interruption","fields":{}}', 'approved', '2099-01-01 00:00:00');
`);
    const entered = Promise.withResolvers<void>();
    let finish!: () => void;
    const create = taskService.create.bind(taskService);
    const spy = vi.spyOn(taskService, "create").mockImplementation((...args) =>
      create(...args).pipe(Effect.tap(() => Effect.async((resume) => {
        entered.resolve();
        finish = () => resume(Effect.succeed(undefined));
      })))
    );

    try {
      const fiber = Effect.runFork(service.resumeThreadStream("task", "t1", "b1").pipe(Effect.provide(baseLayer)));
      await entered.promise;
      await Effect.runPromise(Fiber.interruptFork(fiber));
      expect(db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE title = 'Committed before interruption'").get()).toEqual({ n: 1 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM assistant_resume_claims WHERE batch_id = 'b1'").get()).toEqual({ n: 1 });
      finish();
      const exit = await Effect.runPromise(Fiber.await(fiber));
      expect(exit._tag === "Failure" && Cause.isInterrupted(exit.cause)).toBe(true);
      const saved = db.prepare("SELECT messages FROM assistant_threads WHERE document_type = 'task' AND document_id = 't1'").get() as { messages: string };
      const messages = JSON.parse(saved.messages) as Array<Record<string, unknown>>;
      expect(messages.at(-1)).toMatchObject({
        stopped: true,
        toolLog: [{ name: "create_task", detail: expect.stringMatching(/^applied: Committed before interruption/) }],
      });

      const replay = await run(Effect.either(service.resumeThreadStream("task", "t1", "b1")));
      expect(replay).toMatchObject({ _tag: "Left", left: { _tag: "ApprovalNotFound", id: "b1" } });
      expect(db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE title = 'Committed before interruption'").get()).toEqual({ n: 1 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM assistant_resume_claims WHERE batch_id = 'b1'").get()).toEqual({ n: 1 });
    } finally {
      spy.mockRestore();
    }
  });
});

describe("task preflight — fail-open and disable", () => {
  it("a throwing transport leaves the run intact with no advisory", async () => {
    stubFetch(() => Promise.reject(new Error("socket hang up")));
    setup();
    queueRun("at1");

    const frames = await drain(await runStream("at1"));
    expect(frames.some((f) => f.type === "done")).toBe(true);
    expect(jevCalls).toHaveLength(1);
    expect(promptText(providerMock.calls[0]!)).not.toContain("Jev advisory");
  });

  it("every missing gate (no stored key, no project opt-in, no master key) disables Jev and omits jev_assess", async () => {
    setup({ jev: "no-secret" });
    stubUnreachable();
    queueRun("at1");
    const frames = await drain(await runStream("at1"));
    expect(frames.some((f) => f.type === "done")).toBe(true);
    expect(jevCalls).toHaveLength(0);
    expect(promptText(providerMock.calls.at(-1)!)).not.toContain("Jev advisory");
    expect(toolNames(providerMock.calls.at(-1)!)).not.toContain("jev_assess");

    setup({ jev: "no-project" });
    stubUnreachable();
    queueRun("at1");
    await drain(await runStream("at1"));
    expect(promptText(providerMock.calls.at(-1)!)).not.toContain("Jev advisory");
    expect(toolNames(providerMock.calls.at(-1)!)).not.toContain("jev_assess");

    setup({ env: {} as unknown as RuntimeEnv });
    stubUnreachable();
    queueRun("at1");
    await drain(await runStream("at1"));
    expect(jevCalls).toHaveLength(0);
    expect(toolNames(providerMock.calls.at(-1)!)).not.toContain("jev_assess");
  });

  it("task terminal transitions ride one batch, and a second call is a no-op (idempotent)", async () => {
    setup();
    queueRun("at1");
    db.prepare("UPDATE assistant_tasks SET status = 'running' WHERE id = 'at1'").run();

    const t = await run(service.complete("at1", "done"));
    expect(t.status).toBe("completed");
    expect(t.result).toBe("done");
    const acts = db.prepare("SELECT type FROM task_activity WHERE task_id = 't1' ORDER BY id").all() as Array<{ type: string }>;
    expect(acts.map((a) => a.type)).toEqual(["assistant_completed"]);

    // A repeat is a no-op: the first result stands and no second row is emitted.
    const again = await run(service.complete("at1", "second"));
    expect(again.status).toBe("completed");
    expect(again.result).toBe("done");
    const count = db.prepare("SELECT COUNT(*) AS n FROM task_activity WHERE task_id = 't1' AND type = 'assistant_completed'").get() as { n: number };
    expect(count.n).toBe(1);
  });

  it("concurrent terminal calls emit exactly one activity row; the loser gets the current row, not a 404", async () => {
    setup();
    queueRun("at1");
    db.prepare("UPDATE assistant_tasks SET status = 'running' WHERE id = 'at1'").run();

    const [ra, rb] = await Promise.all([
      run(Effect.either(service.complete("at1", "a"))),
      run(Effect.either(service.complete("at1", "b"))),
    ]);

    // Both callers succeed: the loser's conditional UPDATE returns no row, but
    // the task still exists, so it re-reads and returns the current row rather
    // than a false AssistantTaskNotFound.
    expect(ra._tag).toBe("Right");
    expect(rb._tag).toBe("Right");
    const a = ra._tag === "Right" ? ra.right : null;
    const b = rb._tag === "Right" ? rb.right : null;
    expect(a!.status).toBe("completed");
    expect(b!.status).toBe("completed");
    expect(a!.result).toBe(b!.result);

    const n = (db.prepare("SELECT COUNT(*) AS n FROM task_activity WHERE task_id = 't1' AND type = 'assistant_completed'").get() as { n: number }).n;
    expect(n).toBe(1);
    const t = await run(service.getById("at1"));
    expect(t.status).toBe("completed");
  });

  it("cancel from queued emits one assistant_cancelled, and Jev neither writes nor emits task activity", async () => {
    // A wiki run's completion emits no task activity; a queued cancel emits one.
    setup();
    db.exec("INSERT INTO wiki_pages (id, project_id, title, slug, content, content_text, position) VALUES ('w1','p1','Home','home','{\"type\":\"doc\",\"content\":[]}','',0)");
    db.exec("INSERT INTO assistant_tasks (id, project_id, document_type, document_id, agent_id, skill_id, extra_prompt, selection, status) VALUES ('atw','p1','wiki','home','a1','sk1','','','queued')");
    db.prepare("UPDATE assistant_tasks SET status = 'running' WHERE id = 'atw'").run();

    const wikiDone = await run(service.complete("atw", "done"));
    expect(wikiDone.status).toBe("completed");
    expect((db.prepare("SELECT COUNT(*) AS n FROM task_activity").get() as { n: number }).n).toBe(0);

    queueRun("at2");
    const cancelled = await run(service.cancel("at2"));
    expect(cancelled.status).toBe("cancelled");
    const cancelActs = db.prepare("SELECT type FROM task_activity WHERE task_id = 't1' ORDER BY id").all() as Array<{ type: string }>;
    expect(cancelActs.map((a) => a.type)).toEqual(["assistant_cancelled"]);

    // The Jev advisory is prompt text only: a normal run's sole activity row is
    // its own terminal `assistant_completed` (invariant #12), and no write
    // proposal was ever queued on Jev's say-so.
    setup();
    stubFetch(() => Promise.resolve(jevResponse()));
    queueRun("at1");
    await drain(await runStream("at1"));
    const activity = db.prepare("SELECT type FROM task_activity ORDER BY id").all() as Array<{ type: string }>;
    expect(activity.map((r) => r.type)).toEqual(["assistant_completed"]);
    const queued = db.prepare("SELECT COUNT(*) AS n FROM assistant_pending_writes").get() as { n: number };
    expect(queued.n).toBe(0);
  });
});
