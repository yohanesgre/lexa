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
  calls: [] as Array<{ systemPrompts: unknown; tools: unknown }>,
}));
vi.mock("../assistant/provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../assistant/provider")>();
  return {
    ...actual,
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
let service: AssistantTaskService;
let env: RuntimeEnv;
let baseLayer: Layer.Layer<
  Sqlite | Db | Storage | StorageConfig | RuntimeEnvTag | ProjectReposRepo | TaskRepo | GitHubClient
>;
const jevCalls: FetchCall[] = [];

const JEV_ENV = { TYPESAFE_API_KEY: "tk-test", TYPESAFE_BASE_URL: "https://typesafe.test" } as const;

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

function setup(opts: { env?: RuntimeEnv } = {}) {
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
INSERT INTO assistant_providers (id, label, base_url, api_key) VALUES ('pv1', 'Test', 'https://model.test/v1', 'mk');
INSERT INTO assistant_models (id, provider_id, model_id, kind, priority, enabled)
  VALUES ('m1', 'pv1', 'test-model', 'openai_compatible', 0, 1);
INSERT INTO assistant_settings (project_id, write_tools, provider_id, primary_model_id)
  VALUES ('p1', '[]', 'pv1', 'm1');
`);
  env = opts.env ?? ({ ...JEV_ENV } as unknown as RuntimeEnv);
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
});

describe("task preflight — resume", () => {
  // A decided batch whose tool is unknown to the executor: resume must apply
  // the verdicts and still reach the model, without Jev being consulted.
  const seedDecidedBatch = (): void => {
    db.exec(`
INSERT INTO assistant_threads (document_type, document_id, project_id, owner_user_id, agent_id, skill_id, messages)
  VALUES ('task', 't1', 'p1', 'u1', 'a1', 'sk1', '[{"role":"user","content":"go"},{"role":"assistant","content":"proposed","pendingBatch":"b1"}]');
INSERT INTO assistant_pending_writes (id, project_id, document_type, document_id, owner_user_id, batch_id, seq, tool_name, args, diff, status, expires_at)
  VALUES ('ap1', 'p1', 'task', 't1', 'u1', 'b1', 0, 'no_such_write_tool', '{}', '{}', 'approved', '2099-01-01 00:00:00');
`);
  };

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

  it("a missing API key disables the preflight and omits jev_assess entirely", async () => {
    setup({ env: {} as unknown as RuntimeEnv });
    stubUnreachable();
    queueRun("at1");

    const frames = await drain(await runStream("at1"));
    expect(frames.some((f) => f.type === "done")).toBe(true);
    expect(jevCalls).toHaveLength(0);
    expect(promptText(providerMock.calls[0]!)).not.toContain("Jev advisory");
    expect(toolNames(providerMock.calls[0]!)).not.toContain("jev_assess");
  });

  it("a blank API key is treated as absent", async () => {
    setup({ env: { TYPESAFE_API_KEY: "   " } as unknown as RuntimeEnv });
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
