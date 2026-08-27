import { describe, expect, it } from "vitest";
import {
  ALL_TASKS_CAP,
  buildHeraldTools,
  toolCallDetail,
  WIKI_READ_CAP,
  type BoardStructure,
  type HeraldToolDeps,
  type TaskRef,
  type WikiPageContent,
  type WikiSearchHit,
} from "./tools";
import type { TipTapDoc } from "../../shared/types";

function deps(overrides: Partial<HeraldToolDeps> = {}): HeraldToolDeps {
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

function tool(depsOverrides: Partial<HeraldToolDeps>, name: string): Exec {
  const t = buildHeraldTools(deps(depsOverrides)).find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return (t as unknown as { execute: Exec }).execute;
}

const doc = (text: string): TipTapDoc => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

describe("buildHeraldTools — wiki tools present", () => {
  it("includes search_wiki and read_wiki_page even without a search key", () => {
    const names = buildHeraldTools(deps()).map((t) => t.name);
    expect(names).toContain("search_wiki");
    expect(names).toContain("read_wiki_page");
  });

  it("includes the bulk read tools", () => {
    const names = buildHeraldTools(deps()).map((t) => t.name);
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
});
