import { describe, expect, it } from "vitest";
import { buildHeraldTools, toolCallDetail, WIKI_READ_CAP, type HeraldToolDeps, type WikiPageContent, type WikiSearchHit } from "./tools";
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
