import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer, Context } from "effect";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { Sqlite } from "../db/database";
import { Db, DbBunLive } from "../db/db";
import { Storage, StorageConfig } from "../storage/storage";
import { resolveStorageConfig } from "../storage/config";
import { RuntimeEnvLive, RuntimeEnvTag } from "../runtime-env";
import { AssistantTaskService } from "./assistant-task.service";
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
  VALUES ('t1', 'p1', 'c1', 's-backlog', 'Fix login', '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"The login button is broken."}]}]}', 'a0', '2026-01-01 10:00:00', 'EG-1', 1);
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
  const dbLayer = Layer.mergeAll(
    Layer.succeed(Sqlite, db),
    DbBunLive(db),
    Layer.succeed(StorageConfig, cfg),
    Storage.Default.pipe(Layer.provide(Layer.succeed(StorageConfig, cfg))),
    RuntimeEnvLive(env),
  );
  // `mergeAll` does not satisfy a member's own requirements, so the repo
  // registry, task repo and GitHub client are provided the db layer explicitly.
  baseLayer = Layer.mergeAll(dbLayer, ProjectReposRepo.Default, TaskRepo.Default, GitHubClient.Default).pipe(Layer.provide(dbLayer));
  const ctx = Effect.runSync(Effect.scoped(Layer.build(AssistantTaskService.Default.pipe(Layer.provide(baseLayer)))));
  service = Context.get(ctx, AssistantTaskService);
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

function toolNames(call: { tools: unknown }): Array<string | undefined> {
  return (call.tools as Array<{ name?: string }>).map((t) => t.name);
}

function queueRun(id: string, extraPrompt = "tighten the wording", selection = ""): void {
  db.exec(`
INSERT INTO assistant_tasks (id, project_id, document_type, document_id, agent_id, skill_id, extra_prompt, selection, status)
  VALUES ('${id}', 'p1', 'task', 't1', 'a1', 'sk1', '${extraPrompt}', '${selection}', 'queued');
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
  vi.unstubAllGlobals();
  try { db?.close(); } catch {}
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("task preflight — new run", () => {
  it("sends one preflight over the task context and the advisory reaches the system prompt", async () => {
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
    const text = promptText(providerMock.calls[0]!);
    expect(text).toContain("Jev advisory (non-authoritative)");
    expect(text).toContain("write intent: write");
    expect(text).toContain("live project data remains authoritative");
  });

  it("puts the selection text in the preflight message when the run has one", async () => {
    stubFetch(() => Promise.resolve(jevResponse()));
    setup();
    queueRun("at1", "polish this", "the login button");

    await drain(await runStream("at1"));
    const state = JSON.parse(String(jevCalls[0]!.init.body)).state as string;
    const userMessage = (JSON.parse(state) as { userMessage: string }).userMessage;
    expect(userMessage).toContain("the login button");
    expect(userMessage).toContain("polish this");
  });

  it("offers jev_assess to the model on a new run when Jev is configured", async () => {
    stubFetch(() => Promise.resolve(jevResponse()));
    setup();
    queueRun("at1");

    await drain(await runStream("at1"));
    expect(toolNames(providerMock.calls[0]!)).toContain("jev_assess");
  });

  it("offers get_skill only when the agent has bound skills", async () => {
    stubFetch(() => Promise.resolve(jevResponse()));
    setup();
    queueRun("at1");
    await drain(await runStream("at1"));
    expect(toolNames(providerMock.calls[0]!)).toContain("get_skill");

    providerMock.calls.length = 0;
    db.exec("DELETE FROM lexa_agent_skills");
    queueRun("at2");
    await drain(await runStream("at2"));
    expect(toolNames(providerMock.calls[0]!)).not.toContain("get_skill");
  });
});

describe("task enqueue — auto skill selection", () => {
  it("enqueues without a skillId and streams with no skill markdown", async () => {
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
  });

  it("still rejects a skillId that is not bound to the agent", async () => {
    setup();
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

  it("keeps an explicitly bound skillId", async () => {
    setup();
    const task = await run(service.enqueue({
      projectId: "p1",
      documentType: "task",
      documentId: "t1",
      prompt: "",
      agentId: "a1",
      skillId: "sk1",
    }));
    expect(task.skillId).toBe("sk1");
  });
});

describe("task preflight — resume", () => {
  // A decided batch whose tool is unknown to the executor: resume must apply
  // the verdicts and still reach the model, without Jev being consulted.
  const seedDecidedBatch = (skillId: string | null = "sk1"): void => {
    db.exec(`
INSERT INTO assistant_threads (document_type, document_id, project_id, owner_user_id, agent_id, skill_id, messages)
  VALUES ('task', 't1', 'p1', 'u1', 'a1', ${skillId === null ? "NULL" : `'${skillId}'`}, '[{"role":"user","content":"go"},{"role":"assistant","content":"proposed","pendingBatch":"b1"}]');
INSERT INTO assistant_pending_writes (id, project_id, document_type, document_id, owner_user_id, batch_id, seq, tool_name, args, diff, status, expires_at)
  VALUES ('ap1', 'p1', 'task', 't1', 'u1', 'b1', 0, 'no_such_write_tool', '{}', '{}', 'approved', '2099-01-01 00:00:00');
`);
  };

  it("resumes a document thread with no bound skill (auto mode)", async () => {
    stubFetch(() => Promise.resolve(jevResponse()));
    setup();
    seedDecidedBatch(null);

    const frames = await drain(await run(service.resumeThreadStream("task", "t1")));
    expect(frames.some((f) => f.type === "done")).toBe(true);
    const text = promptText(providerMock.calls[0]!);
    expect(text).toContain(AUTO_SKILL_INSTRUCTION);
    expect(text).toContain("- Test Polish");
  });

  it("resumes with zero Jev calls and no advisory block", async () => {
    stubFetch(() => Promise.resolve(jevResponse()));
    setup();
    seedDecidedBatch();

    const frames = await drain(await run(service.resumeThreadStream("task", "t1")));
    expect(frames.some((f) => f.type === "done")).toBe(true);
    expect(jevCalls).toHaveLength(0);
    expect(providerMock.calls).toHaveLength(1);
    expect(promptText(providerMock.calls[0]!)).not.toContain("Jev advisory");
  });

  it("still offers jev_assess on a resume — its budget is per stream", async () => {
    stubFetch(() => Promise.resolve(jevResponse()));
    setup();
    seedDecidedBatch();

    await drain(await run(service.resumeThreadStream("task", "t1")));
    expect(toolNames(providerMock.calls[0]!)).toContain("jev_assess");
  });

  it("applies an approved create_task on the task path and streams the follow-up (no Die)", async () => {
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

    const frames = await drain(await run(service.resumeThreadStream("task", "t1")));
    const applied = frames.filter((f) => f.type === "approval_result") as Array<{ status: string }>;
    expect(applied.map((f) => f.status)).toContain("applied");
    expect(frames.some((f) => f.type === "done")).toBe(true);
    expect(frames.some((f) => f.type === "error" && (f as { code?: string }).code === "ASSISTANT_GENERATION_FAILED")).toBe(false);
    const created = db.prepare("SELECT title FROM tasks WHERE project_id = 'p1'").all() as Array<{ title: string }>;
    expect(created.map((c) => c.title)).toContain("New task");
    const handed = providerMock.calls[0]!.messages as Array<Record<string, unknown>>;
    const assistantHanded = handed.find((m) => m.role === "assistant")!;
    expect(assistantHanded.toolCalls).toBeUndefined();
  });

  it("hands the executed-writes note to the provider but never persists it", async () => {
    stubFetch(() => Promise.resolve(jevResponse()));
    setup();
    db.exec(`
INSERT INTO priority_options (id, project_id, label, color, position) VALUES ('prio-1', 'p1', 'Medium', '#888', 0);
INSERT INTO type_options (id, project_id, label, color, position) VALUES ('type-1', 'p1', 'Task', '#888', 0);
INSERT INTO assistant_threads (document_type, document_id, project_id, owner_user_id, agent_id, skill_id, messages)
  VALUES ('task', 't1', 'p1', 'u1', 'a1', 'sk1', '[{"role":"user","content":"go"},{"role":"assistant","content":"proposed","pendingBatch":{"batchId":"b1","approvals":[{"approvalId":"ap1","toolCallId":"call_1","seq":0,"name":"create_task","diff":{"type":"task_create","title":"New task","fields":{}}}]}}]');
INSERT INTO assistant_pending_writes (id, project_id, document_type, document_id, owner_user_id, batch_id, seq, tool_name, args, diff, status, expires_at)
  VALUES ('ap1', 'p1', 'task', 't1', 'u1', 'b1', 0, 'create_task', '{"title":"New task"}', '{"type":"task_create","title":"New task","fields":{}}', 'approved', '2099-01-01 00:00:00');
`);

    const frames = await drain(await run(service.resumeThreadStream("task", "t1")));
    expect(frames.some((f) => f.type === "done")).toBe(true);

    const handed = providerMock.calls[0]!.messages as Array<Record<string, unknown>>;
    const note = handed.find((m) => m.role === "user" && String(m.content).includes("[approved write results]"));
    expect(note).toBeDefined();
    expect(String(note!.content)).toContain('create_task "New task" [EG-2]: applied');

    const persisted = db.prepare("SELECT messages FROM assistant_threads WHERE document_type = 'task' AND document_id = 't1'").get() as { messages: string };
    expect(persisted.messages).not.toContain("[approved write results]");
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

  it("an upstream rejection leaves the run intact with no advisory", async () => {
    stubFetch(() => Promise.resolve(new Response("nope", { status: 500 })));
    setup();
    queueRun("at1");

    const frames = await drain(await runStream("at1"));
    expect(frames.some((f) => f.type === "done")).toBe(true);
    expect(promptText(providerMock.calls[0]!)).not.toContain("Jev advisory");
  });

  it("an unreadable answer payload leaves the run intact with no advisory", async () => {
    stubFetch(() => Promise.resolve(new Response("not json", { status: 200 })));
    setup();
    queueRun("at1");

    const frames = await drain(await runStream("at1"));
    expect(frames.some((f) => f.type === "done")).toBe(true);
    expect(promptText(providerMock.calls[0]!)).not.toContain("Jev advisory");
  });

  it("no stored key disables the preflight and omits jev_assess entirely", async () => {
    setup({ jev: "no-secret" });
    stubUnreachable();
    queueRun("at1");

    const frames = await drain(await runStream("at1"));
    expect(frames.some((f) => f.type === "done")).toBe(true);
    expect(jevCalls).toHaveLength(0);
    expect(promptText(providerMock.calls[0]!)).not.toContain("Jev advisory");
    expect(toolNames(providerMock.calls[0]!)).not.toContain("jev_assess");
  });

  it("an absent project opt-in disables Jev", async () => {
    setup({ jev: "no-project" });
    stubUnreachable();
    queueRun("at1");

    await drain(await runStream("at1"));
    expect(jevCalls).toHaveLength(0);
    expect(toolNames(providerMock.calls[0]!)).not.toContain("jev_assess");
  });

  it("no master key leaves the stored ciphertext unopenable, disabling Jev", async () => {
    setup({ env: {} as unknown as RuntimeEnv });
    stubUnreachable();
    queueRun("at1");

    await drain(await runStream("at1"));
    expect(jevCalls).toHaveLength(0);
    expect(toolNames(providerMock.calls[0]!)).not.toContain("jev_assess");
  });

  it("stays silent on stderr without a key — an unconfigured Jev is not a run event", async () => {
    setup({ env: {} as unknown as RuntimeEnv });
    stubUnreachable();
    queueRun("at1");
    const lines = await captureStderr(async () => {
      await drain(await runStream("at1"));
    });
    expect(lines.filter((l) => l.includes("assistant-jev"))).toEqual([]);
  });

  it("still logs a configured preflight that actually failed", async () => {
    stubFetch(() => Promise.resolve(new Response("nope", { status: 500 })));
    setup();
    queueRun("at1");
    const lines = await captureStderr(async () => {
      await drain(await runStream("at1"));
    });
    const jev = lines.filter((l) => l.includes("assistant-jev")).map((l) => JSON.parse(l) as { meta: Record<string, unknown> });
    expect(jev).toHaveLength(1);
    expect(jev[0]!.meta.code).toBe("HTTP_500");
    expect(jev[0]!.meta.outcome).toBe("failed");
  });

  it("task terminal transitions ride one batch", async () => {
    setup();
    queueRun("at1");
    db.prepare("UPDATE assistant_tasks SET status = 'running' WHERE id = 'at1'").run();

    const t = await run(service.complete("at1", "done"));
    expect(t.status).toBe("completed");
    expect(t.result).toBe("done");
    const acts = db.prepare("SELECT type FROM task_activity WHERE task_id = 't1' ORDER BY id").all() as Array<{ type: string }>;
    expect(acts.map((a) => a.type)).toEqual(["assistant_completed"]);
  });

  it("a second terminal call is a no-op with no extra activity (idempotent)", async () => {
    setup();
    queueRun("at1");
    db.prepare("UPDATE assistant_tasks SET status = 'running' WHERE id = 'at1'").run();
    await run(service.complete("at1", "first"));

    const again = await run(service.complete("at1", "second"));
    expect(again.status).toBe("completed");
    expect(again.result).toBe("first");
    const n = (db.prepare("SELECT COUNT(*) AS n FROM task_activity WHERE task_id = 't1' AND type = 'assistant_completed'").get() as { n: number }).n;
    expect(n).toBe(1);
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

  it("cancel from queued emits exactly one assistant_cancelled and no task activity for a wiki run", async () => {
    setup();
    db.exec("INSERT INTO wiki_pages (id, project_id, title, slug, content, content_text, position) VALUES ('w1','p1','Home','home','{\"type\":\"doc\",\"content\":[]}','',0)");
    db.exec("INSERT INTO assistant_tasks (id, project_id, document_type, document_id, agent_id, skill_id, extra_prompt, selection, status) VALUES ('atw','p1','wiki','home','a1','sk1','','','queued')");
    db.prepare("UPDATE assistant_tasks SET status = 'running' WHERE id = 'atw'").run();

    const t = await run(service.complete("atw", "done"));
    expect(t.status).toBe("completed");
    const n = (db.prepare("SELECT COUNT(*) AS n FROM task_activity").get() as { n: number }).n;
    expect(n).toBe(0);

    queueRun("at2");
    const c = await run(service.cancel("at2"));
    expect(c.status).toBe("cancelled");
    const acts = db.prepare("SELECT type FROM task_activity WHERE task_id = 't1' ORDER BY id").all() as Array<{ type: string }>;
    expect(acts.map((a) => a.type)).toEqual(["assistant_cancelled"]);
  });

  it("Jev neither writes nor emits task activity — the only row is the run's own terminal one", async () => {
    stubFetch(() => Promise.resolve(jevResponse()));
    setup();
    queueRun("at1");

    await drain(await runStream("at1"));
    // The advisory is prompt text: it can change what the model SAYS, never
    // what the service DOES. Exactly one activity row survives — the run's own
    // terminal `assistant_completed` (invariant #12) — and no write proposal
    // was ever queued on Jev's say-so.
    const activity = db.prepare("SELECT type FROM task_activity ORDER BY id").all() as Array<{ type: string }>;
    expect(activity.map((r) => r.type)).toEqual(["assistant_completed"]);
    const queued = db.prepare("SELECT COUNT(*) AS n FROM assistant_pending_writes").get() as { n: number };
    expect(queued.n).toBe(0);
  });
});
