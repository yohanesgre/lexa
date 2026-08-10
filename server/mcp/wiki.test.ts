import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { createMcpHandler } from "./server";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

const ADMIN_KEY = "lxk_" + "a".repeat(43);

async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

let dir: string;
let handler: (req: Request) => Promise<Response>;

async function call(method: string, params: unknown, key: string | null = ADMIN_KEY) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (key !== null) headers.Authorization = `Bearer ${key}`;
  const res = await handler(new Request("http://lexa.test/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: method, arguments: params } }),
  }));
  return (await res.json()) as any;
}

function toolResult(body: any): any {
  const text = body.result?.content?.[0]?.text;
  return typeof text === "string" ? JSON.parse(text) : null;
}

function toolError(body: any): any {
  const text = body.result?.content?.[0]?.text;
  return typeof text === "string" ? JSON.parse(text) : null;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "lexa-mcp-wiki-"));
  const dbPath = join(dir, "test.db");
  runMigrations(dbPath, MIGRATIONS);
  const adminHash = await sha256(ADMIN_KEY);
  const db = new Database(dbPath);
  db.exec(`
INSERT INTO projects (id, name, slug) VALUES ('p1', 'P', 'p1'), ('p2', 'P2', 'p2');
INSERT INTO wiki_pages (id, project_id, title, slug, content, content_text, position) VALUES
  ('w1', 'p1', 'Home', 'home', '{"type":"doc","content":[]}', '', 0),
  ('w2', 'p1', 'Guide', 'guide', '{"type":"doc","content":[]}', '', 1),
  ('w3', 'p1', 'FAQ', 'faq', '{"type":"doc","content":[]}', '', 2);
INSERT INTO api_keys (id, name, key_hash) VALUES ('k-admin', 'admin', '${adminHash}');
`);
  db.close();
  handler = createMcpHandler(dbPath);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("MCP wiki tools", () => {
  it("create_wiki_page stores Markdown, auto-slugs the title, and returns PageMeta", async () => {
    const res = await call("create_wiki_page", { project: "p1", title: "Getting Started", content: "**bold** intro\n\n- item" });
    expect(res.error).toBeUndefined();
    const out = toolResult(res);
    expect(out.title).toBe("Getting Started");
    expect(out.slug).toBe("getting-started");
    expect(out.parentSlug).toBeNull();
    expect(typeof out.updatedAt).toBe("string");
    // round-trip: get_wiki_page renders the content back as Markdown
    const got = await call("get_wiki_page", { project: "p1", pageSlug: "getting-started" });
    expect(toolResult(got).content).toContain("**bold**");
  });

  it("create_wiki_page nests under parentSlug and reports the parent's slug", async () => {
    const res = await call("create_wiki_page", { project: "p1", title: "Child", parentSlug: "home" });
    const out = toolResult(res);
    expect(out.parentSlug).toBe("home");
  });

  it("create_wiki_page duplicate slug → SLUG_TAKEN", async () => {
    const res = await call("create_wiki_page", { project: "p1", title: "Guide" });
    expect(res.result.isError).toBe(true);
    const err = toolError(res);
    expect(err.code).toBe("SLUG_TAKEN");
    expect(err.details.slug).toBe("guide");
    // same slug in another project is fine
    const other = await call("create_wiki_page", { project: "p2", title: "Guide" });
    expect(toolResult(other).slug).toBe("guide");
  });

  it("create_wiki_page with an unknown parentSlug → PAGE_NOT_FOUND", async () => {
    const res = await call("create_wiki_page", { project: "p1", title: "Orphan", parentSlug: "ghost" });
    expect(res.result.isError).toBe(true);
    expect(toolError(res).code).toBe("PAGE_NOT_FOUND");
  });

  it("get_wiki_page unknown pageSlug → PAGE_NOT_FOUND + availablePageSlugs", async () => {
    const res = await call("get_wiki_page", { project: "p1", pageSlug: "ghost" });
    expect(res.result.isError).toBe(true);
    const err = toolError(res);
    expect(err.code).toBe("PAGE_NOT_FOUND");
    expect(err.details.availablePageSlugs).toContain("home");
    expect(err.details.availablePageSlugs).toContain("getting-started");
    expect(err.details.availablePageSlugs).toContain("child");
  });

  it("update_wiki_page edits title and content", async () => {
    const res = await call("update_wiki_page", { project: "p1", pageSlug: "faq", title: "FAQ 2", content: "new body" });
    expect(res.error).toBeUndefined();
    const out = toolResult(res);
    expect(out.title).toBe("FAQ 2");
    expect(out.slug).toBe("faq");
    const got = await call("get_wiki_page", { project: "p1", pageSlug: "faq" });
    expect(toolResult(got).content).toBe("new body");
  });

  it("update_wiki_page unknown pageSlug → PAGE_NOT_FOUND", async () => {
    const res = await call("update_wiki_page", { project: "p1", pageSlug: "ghost", title: "X" });
    expect(res.result.isError).toBe(true);
    expect(toolError(res).code).toBe("PAGE_NOT_FOUND");
  });

  it("list_wiki_pages returns all pages and paginates with a base64 offset cursor", async () => {
    const all = await call("list_wiki_pages", { project: "p1" });
    const pages = toolResult(all).pages;
    expect(pages).toHaveLength(5);
    expect(pages.find((p: any) => p.slug === "child").parentSlug).toBe("home");
    const first = await call("list_wiki_pages", { project: "p1", limit: 2 });
    const page1 = toolResult(first);
    expect(page1.pages).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    const second = await call("list_wiki_pages", { project: "p1", limit: 2, cursor: page1.nextCursor });
    const page2 = toolResult(second);
    expect(page2.pages).toHaveLength(2);
    expect(page2.nextCursor).not.toBeNull();
    const third = await call("list_wiki_pages", { project: "p1", limit: 2, cursor: page2.nextCursor });
    expect(toolResult(third).pages).toHaveLength(1);
    expect(toolResult(third).nextCursor).toBeNull();
  });

  it("search_wiki finds FTS5 matches with a snippet", async () => {
    await call("create_wiki_page", { project: "p1", title: "Fractional Indexing", content: "fractional indexing keeps keys short" });
    const res = await call("search_wiki", { project: "p1", query: "fractional" });
    expect(res.error).toBeUndefined();
    const out = toolResult(res);
    expect(out.results).toHaveLength(1);
    expect(out.results[0].slug).toBe("fractional-indexing");
    expect(out.results[0].snippet).toContain("fractional");
    // no match → empty results
    const none = await call("search_wiki", { project: "p1", query: "zzz" });
    expect(toolResult(none).results).toEqual([]);
  });

  it("search_wiki invalid or hyphenated query → SEARCH_ERROR", async () => {
    const unterminated = await call("search_wiki", { project: "p1", query: "\"unterminated" });
    expect(unterminated.result.isError).toBe(true);
    expect(toolError(unterminated).code).toBe("SEARCH_ERROR");
    const hyphenated = await call("search_wiki", { project: "p1", query: "foo-bar" });
    expect(hyphenated.result.isError).toBe(true);
    expect(toolError(hyphenated).code).toBe("SEARCH_ERROR");
  });
});
