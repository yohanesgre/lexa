import { describe, expect, it, vi } from "vitest";
import { ASSISTANT_STALL_TIMEOUT_MS, type StreamFrame } from "../../shared/assistant";
import {
  applyResumeResults,
  buildStream,
  findPendingBatch,
  modelOptionsForEffort,
  resolveChatTitle,
  resolveAssistantThread,
  resolveReasoningEffort,
  type StreamRunContext,
} from "./assistant.service";
import {
  ALL_TASKS_CAP,
  buildAssistantTools,
  JEV_ASSESS_BUDGET_CODE,
  JEV_ASSESS_MAX_CALLS,
  JEV_ASSESS_MAX_STATE_CHARS,
  MAX_CHAT_TOOL_ROUNDS,
  MAX_TOOL_ROUNDS,
  WIKI_READ_CAP,
  type AssistantToolDeps,
  type TaskRef,
  type WikiPageContent,
} from "../assistant/tools";
import { summaryWindow, SUMMARY_WINDOW } from "../assistant/summarize";
import type { JevQuestions, JevRuntimeConfig } from "../assistant/jev";
import type { AssistantThread } from "../repos/assistant-thread.repo";
import type { TipTapDoc } from "../../shared/types";

const providerMock = vi.hoisted(() => ({
  script: [] as Array<Record<string, unknown>>,
  calls: [] as Array<{ input?: { modelOptions?: Record<string, unknown> | undefined } | undefined }>,
}));

vi.mock("../assistant/provider", () => ({
  streamChat: async function* (input?: { modelOptions?: Record<string, unknown> | undefined }) {
    providerMock.calls.push({ ...(input !== undefined ? { input } : {}) });
    for (const chunk of providerMock.script) {
      if (typeof chunk.delayMs === "number") await new Promise((r) => setTimeout(r, chunk.delayMs as number));
      if (chunk.hang === true) await new Promise<void>(() => {});
      yield chunk;
    }
  },
  completeText: async () => {
    throw new Error("unexpected summarize call");
  },
  testConnection: async () => undefined,
  translateRunError: (e: unknown) => e,
  clientFacingErrorMessage: (err: unknown) => {
    const e = err as { _tag?: string; message?: unknown; providerMessage?: unknown } | null;
    const tag = typeof e?._tag === "string" ? e._tag : "";
    const providerMessage = typeof e?.providerMessage === "string" && e.providerMessage.length > 0 ? e.providerMessage : null;
    if (tag === "ProviderAuthFailed" || tag === "ProviderUnreachable" || tag === "AssistantGenerationFailed") {
      if (providerMessage) return providerMessage.slice(0, 500);
      if (tag === "ProviderAuthFailed") return "The AI provider rejected the API key";
      if (tag === "ProviderUnreachable") return "The AI provider could not be reached";
      return "Assistant generation failed";
    }
    return typeof e?.message === "string" && e.message.length > 0 ? e.message : "Assistant generation failed";
  },
}));

// ── toolset helpers ─────────────────────────────────────────────────────────

function toolDeps(overrides: Partial<AssistantToolDeps> = {}): AssistantToolDeps {
  return {
    projectId: "p1",
    allowlist: null,
    searchApiKey: null,
    fetchImpl: fetch,
    storageGet: async () => new Uint8Array(),
    projectOwnsStorageKey: async () => true,
    findTaskByRef: async () => null,
    searchTasksByTitle: async () => [],
    searchWikiPages: async () => [],
    findWikiPageBySlug: async () => null,
    listAllTasks: async () => [],
    listWikiPagesFull: async () => [],
    getBoardStructure: async () => ({ columns: [], swimlanes: [], milestones: [] }),
    ...overrides,
  };
}

type Exec = (args: Record<string, unknown>) => Promise<Record<string, unknown>>;

function tool(depsOverrides: Partial<AssistantToolDeps>, name: string): Exec {
  const t = buildAssistantTools(toolDeps(depsOverrides)).find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return (t as unknown as { execute: Exec }).execute;
}

const doc = (text: string): TipTapDoc => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

describe("Assistant toolset (read-only surface)", () => {
  it("carries the read tools and never a write tool name", () => {
    const names = buildAssistantTools(toolDeps({ loadSkillByName: async () => null })).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["search_wiki", "read_wiki_page", "get_task", "search_tasks"]));
    for (const n of names) expect(n).not.toMatch(/^(create|update|move|archive|delete|add|set)_/);
  });
});

describe("bulk read caps", () => {
  const task = (key: string, markdown: string): TaskRef => ({
    id: `id-${key}`,
    key,
    title: `Task ${key}`,
    priority: "p2",
    dueAt: null,
    archivedAt: null,
    markdown,
  });

  it("get_all_tasks and get_all_wiki_pages cap each document and flag truncation", async () => {
    const under = tool({ listAllTasks: async () => [task("LEX-1", "first"), task("LEX-2", "second")] }, "get_all_tasks");
    const out = await under({});
    expect(out.truncated).toBeUndefined();
    const tasks = out.tasks as Array<{ key: string; markdown: string }>;
    expect(tasks.map((t) => t.key)).toEqual(["LEX-1", "LEX-2"]);
    expect(tasks[0]!.markdown).toBe("first");

    const big = task("LEX-1", "x".repeat(ALL_TASKS_CAP - 10));
    const capped = tool({ listAllTasks: async () => [big, task("LEX-2", "y".repeat(100))] }, "get_all_tasks");
    const over = await capped({});
    expect(over.truncated).toBe(true);
    expect(over.tasks).toHaveLength(1);

    const pages: WikiPageContent[] = [
      { title: "Big", slug: "big", content: doc("x".repeat(WIKI_READ_CAP + 500)) },
      { title: "Small", slug: "small", content: doc("hi") },
    ];
    const underWiki = tool({ listWikiPagesFull: async () => pages }, "get_all_wiki_pages");
    const wikiOut = await underWiki({});
    expect(wikiOut.truncated).toBeUndefined();
    expect((wikiOut.pages! as Array<{ markdown: string }>)[0]!.markdown.length).toBe(WIKI_READ_CAP);
    expect((wikiOut.pages! as Array<{ markdown: string }>)[1]!.markdown).toBe("hi");

    const many: WikiPageContent[] = Array.from({ length: 10 }, (_, i) => ({
      title: `P${i}`,
      slug: `p${i}`,
      content: doc("x".repeat(WIKI_READ_CAP)),
    }));
    const cappedWiki = tool({ listWikiPagesFull: async () => many }, "get_all_wiki_pages");
    const wikiOver = await cappedWiki({});
    expect(wikiOver.truncated).toBe(true);
    expect((wikiOver.pages as unknown[]).length).toBeLessThan(10);
  });
});

describe("get_skill", () => {
  const loader = async (name: string) =>
    name === "Status Report" ? { name: "Status Report", description: "rank work", instructions: "## Status\nrank" } : null;

  it("returns a typed error result for an unbound name — never a throw", async () => {
    const exec = tool({ loadSkillByName: loader }, "get_skill");
    const out = await exec({ name: "nope" });
    expect(out.error).toContain("nope");
    expect(out.instructions).toBeUndefined();
  });
});

// ── jev_assess caps + per-stream budget ─────────────────────────────────────

const JEV_CONFIG: JevRuntimeConfig = { apiKey: "tk-secret", baseUrl: "", model: "" };
const ASK_QUESTIONS: JevQuestions = {
  next_step: { type: "choice", instructions: "What next?", criteria: { act: null, ask: null } },
};

function jevFetch(payload: unknown, status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function jevTool(overrides: Partial<AssistantToolDeps> = {}): { exec: Exec; calls: Array<{ url: string; init: RequestInit }> } {
  const { fetchImpl, calls } = jevFetch({
    model: "jev-latest",
    answers: { next_step: { type: "choice", choice: "ask", probabilities: { act: 0.4, ask: 0.6 }, confidence: 0.6 } },
    usage: { input_tokens: 10, output_tokens: 4 },
  });
  return { exec: tool({ ...overrides, jevConfig: JEV_CONFIG, fetchImpl }, "jev_assess"), calls };
}

describe("jev_assess caps and per-stream budget", () => {
  it("refuses over-cap state without a request, and enforces the per-stream call budget", async () => {
    const stateTooLarge = jevTool();
    const out = await stateTooLarge.exec({ state: "x".repeat(JEV_ASSESS_MAX_STATE_CHARS + 1), questions: ASK_QUESTIONS });
    expect(out).toEqual({
      ok: false,
      code: "STATE_TOO_LARGE",
      message: `state exceeds the ${JEV_ASSESS_MAX_STATE_CHARS}-character limit — re-send a shorter state`,
    });
    expect(stateTooLarge.calls).toHaveLength(0);

    const { exec, calls } = jevTool();
    for (let i = 0; i < JEV_ASSESS_MAX_CALLS; i++) {
      expect(await exec({ state: "s", questions: ASK_QUESTIONS })).toMatchObject({ ok: true });
    }
    expect(calls).toHaveLength(JEV_ASSESS_MAX_CALLS);
    const over = await exec({ state: "s", questions: ASK_QUESTIONS });
    expect(over).toEqual({
      ok: false,
      code: JEV_ASSESS_BUDGET_CODE,
      message: `budget exhausted — at most ${JEV_ASSESS_MAX_CALLS} jev_assess calls per run`,
    });
    expect(calls).toHaveLength(JEV_ASSESS_MAX_CALLS);
  });
});

// ── thread / title resolution ───────────────────────────────────────────────

function thread(overrides: Partial<AssistantThread> = {}): AssistantThread {
  return {
    documentType: "task",
    documentId: "t1",
    projectId: "p1",
    ownerUserId: null,
    title: null,
    pinned: false,
    agentId: "a1",
    skillId: "s1",
    permissionMode: "ask",
    messages: [{ role: "user", content: "hello" }],
    summary: "prior summary",
    summarizedCount: 4,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("resolveAssistantThread", () => {
  it("resolves fresh (summary slots cleared) vs continue, ignoring a differing stored skill id", () => {
    const fresh = resolveAssistantThread(null, "a1");
    expect(fresh.mode).toBe("fresh");
    expect(fresh.messages).toEqual([]);
    expect(fresh.summary).toBeNull();
    expect(fresh.summarizedCount).toBe(0);

    expect(resolveAssistantThread(thread(), "a2").mode).toBe("fresh");
    const unbound = thread({ agentId: null, skillId: null });
    expect(resolveAssistantThread(unbound, "a1").mode).toBe("fresh");
    expect(resolveAssistantThread(unbound, null).mode).toBe("continue");

    const t = thread();
    const v = resolveAssistantThread(t, "a1");
    expect(v.mode).toBe("continue");
    expect(v.messages).toBe(t.messages);
    expect(v.summary).toBe("prior summary");
    expect(v.summarizedCount).toBe(4);
    // Skills are per-message now: a differing stored skillId is not a mismatch.
    expect(resolveAssistantThread(thread({ skillId: "other" }), "a1").mode).toBe("continue");
  });
});

describe("resolveChatTitle", () => {
  it("derives from the message text when untitled, but a stored title wins and survives an agent wipe", () => {
    expect(resolveChatTitle(null, "Fix the login bug\r\nthen verify sessions")).toBe(
      "Fix the login bug then verify sessions"
    );
    const row = thread({ documentType: "chat", documentId: "c1", ownerUserId: "u1", title: null });
    expect(resolveChatTitle(row, "second message text")).toBe("second message text");
    expect(resolveChatTitle(null, "   \n\t ")).toBeNull();
    expect(resolveChatTitle(null, "")).toBeNull();

    const t = thread({
      documentType: "chat",
      documentId: "c1",
      ownerUserId: "u1",
      title: "Kept title",
      messages: [{ role: "user", content: "old conversation" }],
    });
    expect(resolveChatTitle(t, "a brand new message")).toBe("Kept title");
    expect(resolveAssistantThread(t, "a2").messages).toEqual([]);
    expect(resolveChatTitle(t, "whatever comes next")).toBe("Kept title");
  });
});

// ── summary window (carried from server/assistant/summarize.test.ts) ────────

describe("summaryWindow", () => {
  const msg = (i: number) => ({
    id: `m${i}`,
    role: i % 2 === 0 ? "user" : "assistant",
    parts: [{ type: "text", text: `message ${i}` }],
  });
  const many = (count: number) => Array.from({ length: count }, (_, i) => msg(i));

  it("slides only the not-yet-summarized prefix and reports the new total", () => {
    const window = summaryWindow(many(41), 0);
    expect(window?.older).toHaveLength(41 - SUMMARY_WINDOW);
    expect(window?.summarizedCount).toBe(41 - SUMMARY_WINDOW);
    const incremental = summaryWindow(many(42), 33);
    expect(incremental?.older).toHaveLength(1);
    expect(incremental?.summarizedCount).toBe(34);
  });

  it("is idempotent: a repeat of the same transcript yields no window", () => {
    const window = summaryWindow(many(41), 0);
    expect(window).not.toBeNull();
    expect(summaryWindow(many(41), window!.summarizedCount)).toBeNull();
  });
});

// ── resume markers (carried from server/services/assistant-resume.test.ts) ──

describe("findPendingBatch", () => {
  it("prefers the newest marker and the object shape over a legacy string", () => {
    const messages = [
      { role: "assistant", content: "old", pendingBatch: "batch-string" },
      { role: "assistant", content: "new", pendingBatch: { batchId: "batch-object", approvals: [] } },
    ];
    expect(findPendingBatch(messages)).toBe("batch-object");
  });
});

describe("applyResumeResults", () => {
  it("clears the object markers of resolved batches and leaves unresolved ones alone", () => {
    const resolved = {
      role: "assistant",
      content: "proposed writes",
      ts: "2026-08-24T00:00:00Z",
      pendingBatch: { batchId: "b1", approvals: [{ approvalId: "a1", toolCallId: "call_1" }] },
    };
    const out = applyResumeResults([{ role: "user", content: "go" }, resolved], ["b1"]);
    expect(out[0]!).toEqual({ role: "user", content: "go" });
    expect(out[1]!).toEqual({ role: "assistant", content: "proposed writes", ts: "2026-08-24T00:00:00Z" });

    const unresolved = { role: "assistant", content: "a", pendingBatch: { batchId: "b2", approvals: [] } };
    const kept = applyResumeResults([unresolved], ["b1"]);
    expect(kept[0]!).toEqual(unresolved);
  });

  it("does not mutate the input transcript", () => {
    const messages = [{ role: "assistant", content: "a", pendingBatch: "b1" }];
    applyResumeResults(messages, ["b1"]);
    expect(messages[0]!).toHaveProperty("pendingBatch", "b1");
  });
});

// ── buildStream ─────────────────────────────────────────────────────────────

const toolEnd = (name = "search_wiki"): Record<string, unknown> => ({ type: "TOOL_CALL_END", toolCallName: name });

async function drain(s: ReadableStream<StreamFrame>): Promise<StreamFrame[]> {
  const out: StreamFrame[] = [];
  const reader = s.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(value);
  }
  return out;
}

function ctx(overrides: Partial<StreamRunContext> = {}): StreamRunContext & { persistCalls: unknown[][] } {
  const persistCalls: unknown[][] = [];
  return {
    keyId: "c1",
    idField: "chatId",
    threadId: "c1",
    registry: new Map(),
    config: { kind: "openai_compatible", baseUrl: "https://x.example", apiKey: "k", model: "m" },
    systemPrompts: [],
    history: [],
    userTs: "2026-08-24T00:00:00Z",
    getCitations: () => [],
    userContent: "hi",
    tools: [],
    toolRoundCap: MAX_CHAT_TOOL_ROUNDS,
    loadImageBase64: async () => null,
    imageMode: "inline",
    historySummary: () => null,
    historySummarizedCount: () => 0,
    persist: async (messages) => {
      persistCalls.push(messages);
    },
    persistCalls,
    onDone: async () => {},
    onFail: async () => {},
    onCancel: async () => {},
    ...overrides,
  };
}

describe("Assistant tool budget", () => {
  it("allows exactly the round cap and trips at +1 for both the chat and document-task caps", async () => {
    for (const cap of [MAX_CHAT_TOOL_ROUNDS, MAX_TOOL_ROUNDS]) {
      providerMock.script = Array.from({ length: cap }, () => toolEnd()).concat([{ type: "RUN_FINISHED" }]);
      const ok = await drain(buildStream(ctx({ toolRoundCap: cap })));
      expect(ok.at(-1)!?.type).toBe("done");
      expect(ok.some((f) => f.type === "error")).toBe(false);

      providerMock.script = Array.from({ length: cap + 1 }, () => toolEnd());
      const frames = await drain(buildStream(ctx({ toolRoundCap: cap })));
      const err = frames.find((f) => f.type === "error") as { code?: string; message?: string } | undefined;
      expect(err?.code).toBe("ASSISTANT_TOOL_BUDGET_EXCEEDED");
      expect(err?.message).toContain(`(${cap} rounds)`);
    }
  });
});

describe("stream stall watchdog", () => {
  it("trips at 90s of silence → ASSISTANT_GENERATION_FAILED + partial text persisted", async () => {
    vi.useFakeTimers();
    try {
      providerMock.script = [{ type: "TEXT_MESSAGE_CONTENT", delta: "par" }, { hang: true }];
      const c = ctx();
      const pending = drain(buildStream(c));
      await vi.advanceTimersByTimeAsync(ASSISTANT_STALL_TIMEOUT_MS);
      const frames = await pending;
      const err = frames.find((f) => f.type === "error") as { code?: string; message?: string } | undefined;
      expect(err?.code).toBe("ASSISTANT_GENERATION_FAILED");
      expect(err?.message).toBe("Assistant generation failed");
      const last = (c.persistCalls.at(-1)! as Array<{ role?: string; content?: unknown; error?: unknown }>).at(-1)!;
      expect(last).toMatchObject({
        role: "assistant",
        content: "par",
        error: { code: "ASSISTANT_GENERATION_FAILED", message: "Assistant generation failed" },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("a chunk before the deadline resets the timer (trips only after a fresh 90s)", async () => {
    vi.useFakeTimers();
    try {
      providerMock.script = [
        { type: "TEXT_MESSAGE_CONTENT", delta: "a", delayMs: 50_000 },
        { type: "TEXT_MESSAGE_CONTENT", delta: "b", delayMs: 50_000 },
        { hang: true },
      ];
      const pending = drain(buildStream(ctx()));
      await vi.advanceTimersByTimeAsync(50_000); // chunk 1 lands at t=50s, timer resets
      await vi.advanceTimersByTimeAsync(50_000); // chunk 2 lands at t=100s, timer resets
      await vi.advanceTimersByTimeAsync(90_000); // trips at t=190s (90s after the last chunk)
      const frames = await pending;
      expect(frames.some((f) => f.type === "error")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("normal streams finish without tripping the watchdog", async () => {
    vi.useFakeTimers();
    try {
      providerMock.script = [{ type: "TEXT_MESSAGE_CONTENT", delta: "ok" }, { type: "RUN_FINISHED" }];
      const pending = drain(buildStream(ctx()));
      await vi.advanceTimersByTimeAsync(ASSISTANT_STALL_TIMEOUT_MS * 2);
      const frames = await pending;
      expect(frames.at(-1)!?.type).toBe("done");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("reasoning effort resolution", () => {
  it("per-turn override beats the project default, and buildStream forwards the body key", async () => {
    expect(resolveReasoningEffort("high", "low")).toBe("low");
    expect(resolveReasoningEffort("medium", undefined)).toBe("medium");
    expect(resolveReasoningEffort(null, null)).toBeNull();
    expect(modelOptionsForEffort(null)).toBeUndefined();
    expect(modelOptionsForEffort("high")).toEqual({ reasoning_effort: "high" });

    providerMock.script = [{ type: "TEXT_MESSAGE_CONTENT", delta: "ok" }, { type: "RUN_FINISHED" }];
    providerMock.calls = [];
    await drain(buildStream(ctx({ modelOptions: { reasoning_effort: "high" } })));
    expect(providerMock.calls.at(-1)!?.input?.modelOptions).toEqual({ reasoning_effort: "high" });

    providerMock.calls = [];
    await drain(buildStream(ctx()));
    expect(providerMock.calls.at(-1)!?.input?.modelOptions).toBeUndefined();
  });
});
