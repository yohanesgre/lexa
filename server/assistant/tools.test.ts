import { describe, expect, it, vi } from "vitest";
import {
  ALL_TASKS_CAP,
  buildAssistantTools,
  JEV_ASSESS_BUDGET_CODE,
  JEV_ASSESS_MAX_CALLS,
  JEV_ASSESS_MAX_QUESTIONS,
  JEV_ASSESS_MAX_STATE_CHARS,
  toolCallDetail,
  WIKI_READ_CAP,
  type AssistantToolDeps,
  type BoardStructure,
  type TaskRef,
  type WikiPageContent,
  type WikiSearchHit,
} from "./tools";
import type { JevQuestions, JevPreflightEnv } from "./jev";
import type { TipTapDoc } from "../../shared/types";

function deps(overrides: Partial<AssistantToolDeps> = {}): AssistantToolDeps {
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
  const t = buildAssistantTools(deps(depsOverrides)).find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return (t as unknown as { execute: Exec }).execute;
}

const doc = (text: string): TipTapDoc => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

describe("buildAssistantTools — wiki tools present", () => {
  it("includes search_wiki and read_wiki_page even without a search key", () => {
    const names = buildAssistantTools(deps()).map((t) => t.name);
    expect(names).toContain("search_wiki");
    expect(names).toContain("read_wiki_page");
  });

  it("includes the bulk read tools", () => {
    const names = buildAssistantTools(deps()).map((t) => t.name);
    expect(names).toContain("get_all_tasks");
    expect(names).toContain("get_all_wiki_pages");
    expect(names).toContain("get_board_structure");
  });
});

describe("get_all_tasks", () => {
  const task = (key: string, markdown: string): TaskRef => ({
    id: `id-${key}`,
    key,
    title: `Task ${key}`,
    priority: "p2",
    dueAt: null,
    archivedAt: null,
    markdown,
  });

  it("returns every task with markdown and no truncated flag under the cap", async () => {
    const exec = tool({ listAllTasks: async () => [task("LEX-1", "first"), task("LEX-2", "second")] }, "get_all_tasks");
    const out = await exec({});
    expect(out.truncated).toBeUndefined();
    expect(out.tasks).toEqual([
      { id: "id-LEX-1", key: "LEX-1", title: "Task LEX-1", priority: "p2", dueAt: null, archived: false, markdown: "first" },
      { id: "id-LEX-2", key: "LEX-2", title: "Task LEX-2", priority: "p2", dueAt: null, archived: false, markdown: "second" },
    ]);
  });

  it("stops appending and sets truncated once ALL_TASKS_CAP is hit", async () => {
    const big = task("LEX-1", "x".repeat(ALL_TASKS_CAP - 10));
    const second = task("LEX-2", "y".repeat(100));
    const exec = tool({ listAllTasks: async () => [big, second] }, "get_all_tasks");
    const out = await exec({});
    expect(out.truncated).toBe(true);
    expect(out.tasks).toHaveLength(1);
  });
});

describe("get_all_wiki_pages", () => {
  it("caps each page at WIKI_READ_CAP characters", async () => {
    const pages: WikiPageContent[] = [
      { title: "Big", slug: "big", content: doc("x".repeat(WIKI_READ_CAP + 500)) },
      { title: "Small", slug: "small", content: doc("hi") },
    ];
    const exec = tool({ listWikiPagesFull: async () => pages }, "get_all_wiki_pages");
    const out = await exec({});
    expect(out.truncated).toBeUndefined();
    expect((out.pages! as Array<{ markdown: string }>)[0]!.markdown.length).toBe(WIKI_READ_CAP);
    expect((out.pages! as Array<{ markdown: string }>)[1]!.markdown).toBe("hi");
  });

  it("sets truncated when the total exceeds ALL_WIKI_CAP", async () => {
    const pages: WikiPageContent[] = Array.from({ length: 10 }, (_, i) => ({
      title: `P${i}`,
      slug: `p${i}`,
      content: doc("x".repeat(WIKI_READ_CAP)),
    }));
    const exec = tool({ listWikiPagesFull: async () => pages }, "get_all_wiki_pages");
    const out = await exec({});
    expect(out.truncated).toBe(true);
    expect((out.pages as unknown[]).length).toBeLessThan(10);
  });
});

describe("get_board_structure", () => {
  it("passes through the mapped board structure", async () => {
    const board: BoardStructure = {
      columns: [{ id: "c1", name: "Todo", position: 0, wipLimit: 3, githubState: "open", isDone: false }],
      swimlanes: [{ id: "s1", name: "Sprint 1", kind: "sprint", startAt: "2026-01-01", dueAt: "2026-01-14", archived: false, milestoneId: "m1" }],
      milestones: [{ id: "m1", name: "v1.0", dueAt: "2026-02-01", archived: false }],
    };
    const exec = tool({ getBoardStructure: async () => board }, "get_board_structure");
    const out = await exec({});
    expect(out.columns).toEqual(board.columns);
    expect(out.swimlanes).toEqual(board.swimlanes);
    expect(out.milestones).toEqual(board.milestones);
  });
});

describe("get_task enrichment", () => {
  it("passes through the enriched optional fields", async () => {
    const ref: TaskRef = {
      id: "t1",
      key: "LEX-7",
      title: "Enriched",
      priority: "p1",
      dueAt: "2026-03-01",
      archivedAt: null,
      markdown: "body",
      columnName: "In Progress",
      swimlaneName: "Sprint 1",
      milestoneName: "v1.0",
      type: "bug",
      assignees: ["ana", "bo"],
      githubIssue: { repo: "yohanesgre/lexa", number: 12 },
    };
    const exec = tool({ findTaskByRef: async () => ref }, "get_task");
    const out = await exec({ ref: "LEX-7" });
    expect(out.task).toEqual({
      id: "t1",
      key: "LEX-7",
      title: "Enriched",
      priority: "p1",
      dueAt: "2026-03-01",
      archived: false,
      markdown: "body",
      columnName: "In Progress",
      swimlaneName: "Sprint 1",
      milestoneName: "v1.0",
      type: "bug",
      assignees: ["ana", "bo"],
      githubIssue: { repo: "yohanesgre/lexa", number: 12 },
    });
  });
});

describe("search_wiki", () => {
  it("passes the query with default limit and maps hits", async () => {
    const calls: Array<[string, number | undefined]> = [];
    const hits: WikiSearchHit[] = [{ title: "Setup", slug: "setup", snippet: "how to **install**…" }];
    const exec = tool(
      {
        searchWikiPages: async (query, limit) => {
          calls.push([query, limit]);
          return hits;
        },
      },
      "search_wiki"
    );
    const out = await exec({ query: "install" });
    expect(calls).toEqual([["install", 10]]);
    expect(out.pages).toEqual(hits);
  });

  it("forwards an explicit limit within [1,10]", async () => {
    const calls: Array<[string, number | undefined]> = [];
    const exec = tool(
      {
        searchWikiPages: async (query, limit) => {
          calls.push([query, limit]);
          return [];
        },
      },
      "search_wiki"
    );
    await exec({ query: "x", limit: 3 });
    expect(calls).toEqual([["x", 3]]);
  });

  it("returns no pages when the scoped repo finds nothing", async () => {
    const out = await tool({ searchWikiPages: async () => [] }, "search_wiki")({ query: "nope" });
    expect(out.pages).toEqual([]);
  });
});

describe("read_wiki_page", () => {
  const page = (content: TipTapDoc, title = "Home", slug = "home"): WikiPageContent => ({ title, slug, content });

  it("converts TipTap content to markdown", async () => {
    const exec = tool(
      {
        findWikiPageBySlug: async () =>
          page({
            type: "doc",
            content: [
              { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Setup" }] },
              {
                type: "paragraph",
                content: [
                  { type: "text", text: "bold", marks: [{ type: "bold" }] },
                  { type: "text", text: " step" },
                ],
              },
            ],
          }),
      },
      "read_wiki_page"
    );
    const out = await exec({ slug: "home" });
    expect(out.error).toBeUndefined();
    expect(out.page).toMatchObject({ title: "Home", slug: "home", markdown: "## Setup\n\n**bold** step" });
  });

  it("caps the markdown at WIKI_READ_CAP characters", async () => {
    const exec = tool({ findWikiPageBySlug: async () => page(doc("x".repeat(WIKI_READ_CAP + 500))) }, "read_wiki_page");
    const out = await exec({ slug: "home" });
    const p = out.page as { markdown: string };
    expect(p.markdown.length).toBe(WIKI_READ_CAP);
  });

  it("not-found slug → null page + error", async () => {
    const out = await tool({ findWikiPageBySlug: async () => null }, "read_wiki_page")({ slug: "missing" });
    expect(out.page).toBeNull();
    expect(out.error).toBe("wiki page not found");
  });
});

describe("toolCallDetail", () => {
  it("maps each tool's input to its frozen detail string", () => {
    expect(toolCallDetail("search_wiki", { query: "auth" })).toBe('Searching wiki for "auth"');
    expect(toolCallDetail("read_wiki_page", { slug: "setup" })).toBe('Reading wiki page "setup"');
    expect(toolCallDetail("search_tasks", { query: "login bug" })).toBe('Searching tasks for "login bug"');
    expect(toolCallDetail("get_task", { ref: "LEX-42" })).toBe("Looking up task LEX-42");
    expect(toolCallDetail("web_search", { query: "effect ts docs" })).toBe('Searching the web for "effect ts docs"');
    expect(toolCallDetail("fetch_url", { url: "https://docs.example.com/guide?x=1" })).toBe("Fetching docs.example.com");
    expect(toolCallDetail("read_s3_file", { key: "blobs/abc123" })).toBe("Reading attachment abc123");
    expect(toolCallDetail("analyze_image", { storageKey: "blobs/img9.png", question: "what" })).toBe(
      "Reading attachment img9.png"
    );
  });

  it("unknown tools or missing fields yield undefined", () => {
    expect(toolCallDetail("mystery_tool", {})).toBeUndefined();
    expect(toolCallDetail("search_wiki", {})).toBeUndefined();
    expect(toolCallDetail("search_wiki", null)).toBeUndefined();
    expect(toolCallDetail("fetch_url", { url: "not a url" })).toBeUndefined();
  });

  it("jev_assess reports the question count, never the state", () => {
    expect(toolCallDetail("jev_assess", { state: "s".repeat(200), questions: { a: {}, b: {} } })).toBe("Asking Jev 2 questions");
    expect(toolCallDetail("jev_assess", { state: "x", questions: { a: {} } })).toBe("Asking Jev 1 question");
    expect(toolCallDetail("jev_assess", { state: "x", questions: [] })).toBe("Asking Jev");
  });
});

// ── jev_assess ─────────────────────────────────────────────────────────────

const JEV_ENV: JevPreflightEnv = { TYPESAFE_API_KEY: "tk-secret" };
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

const jevDeps = (overrides: Partial<AssistantToolDeps> = {}): AssistantToolDeps =>
  deps({ jevEnv: JEV_ENV, ...overrides });

// jevLog writes one JSON line to stderr; the suite captures it so an assertion
// can read the meta a real call emitted.
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

function jevTool(overrides: Partial<AssistantToolDeps> = {}): { exec: Exec; calls: Array<{ url: string; init: RequestInit }> } {
  const { fetchImpl, calls } = jevFetch({
    model: "jev-latest",
    answers: { next_step: { type: "choice", choice: "ask", probabilities: { act: 0.4, ask: 0.6 }, confidence: 0.6 } },
    usage: { input_tokens: 10, output_tokens: 4 },
  });
  return { exec: tool(jevDeps({ fetchImpl, ...overrides }), "jev_assess"), calls };
}

describe("jev_assess presence", () => {
  it("is absent without a configured key and present with one", () => {
    expect(buildAssistantTools(deps()).map((t) => t.name)).not.toContain("jev_assess");
    expect(buildAssistantTools(deps({ jevEnv: null })).map((t) => t.name)).not.toContain("jev_assess");
    expect(buildAssistantTools(deps({ jevEnv: { TYPESAFE_API_KEY: "   " } })).map((t) => t.name)).not.toContain("jev_assess");
    expect(buildAssistantTools(jevDeps()).map((t) => t.name)).toContain("jev_assess");
  });

  it("sorts after the read toolset, so the read tools are offered first", () => {
    const names = buildAssistantTools(jevDeps({ searchApiKey: "exa-key" })).map((t) => t.name);
    expect(names.at(-1)).toBe("jev_assess");
    const read: Array<(typeof names)[number]> = ["get_task", "search_tasks", "search_wiki", "read_wiki_page", "get_all_tasks", "get_all_wiki_pages", "get_board_structure"];
    for (const name of read) {
      expect(names.indexOf(name), name).toBeLessThan(names.indexOf("jev_assess"));
    }
    // The move is positional only: no tool was added, dropped or reordered among
    // the read tools themselves.
    expect(names).toEqual([
      "web_search",
      "fetch_url",
      "read_s3_file",
      "get_task",
      "search_tasks",
      "search_wiki",
      "read_wiki_page",
      "get_all_tasks",
      "get_all_wiki_pages",
      "get_board_structure",
      "jev_assess",
    ]);
  });
});

describe("jev_assess results", () => {
  it("returns typed answers + usage from the mock REST call", async () => {
    const { exec, calls } = jevTool();
    const out = await exec({ state: "a task titled Fix login", questions: ASK_QUESTIONS });
    expect(out).toEqual({
      ok: true,
      answers: { next_step: { type: "choice", choice: "ask", probabilities: { act: 0.4, ask: 0.6 }, confidence: 0.6 } },
      usage: { input_tokens: 10, output_tokens: 4 },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.typesafe.ai/v1/systemone");
    const body = JSON.parse(String(calls[0]!.init.body)) as { state: string; questions: JevQuestions };
    expect(body.state).toBe("a task titled Fix login");
    expect(Object.keys(body.questions)).toEqual(["next_step"]);
  });

  it("upstream failures come back typed, never thrown", async () => {
    for (const [status, code] of [[401, "AUTH"], [429, "RATE_LIMITED"], [500, "HTTP_500"]] as const) {
      const { exec } = jevTool({ fetchImpl: (async () => new Response("nope", { status })) as unknown as typeof fetch });
      expect(await exec({ state: "s", questions: ASK_QUESTIONS })).toMatchObject({ ok: false, code });
    }
    const { exec } = jevTool({
      fetchImpl: (async () => {
        throw new Error("socket hang up");
      }) as unknown as typeof fetch,
    });
    expect(await exec({ state: "s", questions: ASK_QUESTIONS })).toMatchObject({ ok: false, code: "NETWORK" });
  });
});

describe("jev_assess bounds", () => {
  it("refuses state over the cap instead of truncating it (no request is sent)", async () => {
    const { exec, calls } = jevTool();
    const out = await exec({ state: "x".repeat(JEV_ASSESS_MAX_STATE_CHARS + 1), questions: ASK_QUESTIONS });
    expect(out).toEqual({
      ok: false,
      code: "STATE_TOO_LARGE",
      message: `state exceeds the ${JEV_ASSESS_MAX_STATE_CHARS}-character limit — re-send a shorter state`,
    });
    expect(calls).toHaveLength(0);
  });

  it("accepts state exactly at the cap", async () => {
    const { exec, calls } = jevTool();
    expect(await exec({ state: "x".repeat(JEV_ASSESS_MAX_STATE_CHARS), questions: ASK_QUESTIONS })).toMatchObject({ ok: true });
    expect(calls).toHaveLength(1);
  });

  it("refuses more than 8 questions and an empty question set", async () => {
    const { exec, calls } = jevTool();
    const many: JevQuestions = Object.fromEntries(
      Array.from({ length: JEV_ASSESS_MAX_QUESTIONS + 1 }, (_, i) => [`q${i}`, { type: "noul", instructions: "x" }]),
    ) as JevQuestions;
    expect(await exec({ state: "s", questions: many })).toMatchObject({ ok: false, code: "TOO_MANY_QUESTIONS" });
    expect(await exec({ state: "s", questions: {} })).toMatchObject({ ok: false, code: "NO_QUESTIONS" });
    expect(calls).toHaveLength(0);
  });

  it("accepts exactly 8 questions — the request is sent", async () => {
    const { exec, calls } = jevTool();
    const eight: JevQuestions = Object.fromEntries(
      Array.from({ length: JEV_ASSESS_MAX_QUESTIONS }, (_, i) => [`q${i}`, { type: "noul", instructions: "x" }]),
    ) as JevQuestions;
    // The stub only answers `next_step`, so the answer set is incomplete — the
    // point is that the question count passed the bound and a request went out.
    const out = await exec({ state: "s", questions: eight });
    expect(out).toMatchObject({ ok: false, code: "INVALID_RESPONSE" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("/v1/systemone");
  });
});

describe("jev_assess per-stream budget", () => {
  it(`allows ${JEV_ASSESS_MAX_CALLS} calls, then answers ${JEV_ASSESS_BUDGET_CODE} without calling upstream`, async () => {
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

  it("logs the budget code, not a codeless WARN with a fabricated latency", async () => {
    const { exec } = jevTool();
    for (let i = 0; i < JEV_ASSESS_MAX_CALLS; i++) await exec({ state: "s", questions: ASK_QUESTIONS });
    const lines = await captureStderr(async () => {
      await exec({ state: "s", questions: ASK_QUESTIONS });
    });
    expect(lines).toHaveLength(1);
    const meta = (JSON.parse(lines[0]!) as { meta: Record<string, unknown> }).meta;
    expect(meta.code).toBe(JEV_ASSESS_BUDGET_CODE);
    expect(meta.outcome).toBe("failed");
    // The refusal never reached the network, so there is no honest latency to
    // report — the field is omitted, not zeroed.
    expect(Object.hasOwn(meta, "latencyMs")).toBe(false);
  });

  it("is per buildAssistantTools call, so a fresh stream gets a fresh budget", async () => {
    const first = jevTool();
    for (let i = 0; i < JEV_ASSESS_MAX_CALLS; i++) await first.exec({ state: "s", questions: ASK_QUESTIONS });
    expect(await first.exec({ state: "s", questions: ASK_QUESTIONS })).toMatchObject({ ok: false, code: JEV_ASSESS_BUDGET_CODE });
    expect(await jevTool().exec({ state: "s", questions: ASK_QUESTIONS })).toMatchObject({ ok: true });
  });
});

describe("jev_assess is read-only", () => {
  it("exposes no write or approval surface on the tool definition", () => {
    const t = buildAssistantTools(jevDeps()).find((x) => x.name === "jev_assess") as unknown as {
      needsApproval?: boolean;
      approvalSchema?: unknown;
      inputSchema: { shape?: Record<string, unknown>; _def?: Record<string, unknown> };
      outputSchema?: unknown;
    };
    expect(t).toBeDefined();
    expect(t.needsApproval).toBeUndefined();
    expect(t.approvalSchema).toBeUndefined();
    const keys = new Set<string>(t.inputSchema.shape ? Object.keys(t.inputSchema.shape) : []);
    expect([...keys].sort()).toEqual(["questions", "state"]);
  });

  it("reads nothing but the network: a toolset whose data deps all reject still answers", async () => {
    const { exec, calls } = jevTool({
      storageGet: async () => {
        throw new Error("write path reached");
      },
      projectOwnsStorageKey: async () => {
        throw new Error("write path reached");
      },
      findTaskByRef: async () => {
        throw new Error("write path reached");
      },
      searchTasksByTitle: async () => {
        throw new Error("write path reached");
      },
      searchWikiPages: async () => {
        throw new Error("write path reached");
      },
      findWikiPageBySlug: async () => {
        throw new Error("write path reached");
      },
      listAllTasks: async () => {
        throw new Error("write path reached");
      },
      listWikiPagesFull: async () => {
        throw new Error("write path reached");
      },
      getBoardStructure: async () => {
        throw new Error("write path reached");
      },
    });
    expect(await exec({ state: "s", questions: ASK_QUESTIONS })).toMatchObject({ ok: true });
    expect(calls).toHaveLength(1);
  });

  it("the read-only toolset never carries a write tool name", () => {
    const names = buildAssistantTools(jevDeps()).map((t) => t.name);
    for (const n of names) expect(n).not.toMatch(/^(create|update|move|archive|delete|add|set)_/);
  });
});

