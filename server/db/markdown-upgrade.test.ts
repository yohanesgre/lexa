import { Database } from "bun:sqlite";
import { describe, expect, it } from "vitest";
import { parseMarkdown } from "@tanstack/markdown";
import { Effect } from "effect";
import { markdownToText } from "../../shared/markdown";
import { createBunSqliteDriver } from "./drivers/bun-sqlite";
import { applyMarkdownUpgrade, auditMarkdownUpgrade } from "./markdown-upgrade";
import { serializeLegacyTiptap } from "./legacy-tiptap";
import { assertMarkdownReady } from "./document-format";

const doc = (text: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

function database(): { sqlite: Database; driver: ReturnType<typeof createBunSqliteDriver> } {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT);
    CREATE TABLE _markdown_migration (
      table_name TEXT NOT NULL, row_key TEXT NOT NULL, source_hash TEXT NOT NULL,
      target_hash TEXT NOT NULL, PRIMARY KEY (table_name, row_key)
    );
    CREATE TABLE projects (id TEXT PRIMARY KEY, slug TEXT NOT NULL);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, key TEXT, description TEXT NOT NULL);
    CREATE TABLE wiki_pages (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, slug TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', content TEXT NOT NULL, content_text TEXT NOT NULL);
    CREATE TABLE wiki_page_revisions (id TEXT PRIMARY KEY, page_id TEXT NOT NULL, content TEXT NOT NULL, content_text TEXT NOT NULL);
    CREATE TABLE task_comments (id INTEGER PRIMARY KEY, task_id TEXT NOT NULL, body TEXT NOT NULL);
    CREATE TABLE assistant_pending_writes (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, tool_name TEXT NOT NULL, args TEXT NOT NULL, diff TEXT NOT NULL, status TEXT NOT NULL);
    CREATE VIRTUAL TABLE wiki_fts USING fts5(
      title,
      content_text,
      content='wiki_pages',
      content_rowid='rowid'
    );
    CREATE TRIGGER wiki_fts_ai AFTER INSERT ON wiki_pages BEGIN
      INSERT INTO wiki_fts(rowid, title, content_text)
      VALUES (new.rowid, new.title, new.content_text);
    END;
    CREATE TRIGGER wiki_fts_au AFTER UPDATE ON wiki_pages BEGIN
      INSERT INTO wiki_fts(wiki_fts, rowid, title, content_text)
      VALUES ('delete', old.rowid, old.title, old.content_text);
      INSERT INTO wiki_fts(rowid, title, content_text)
      VALUES (new.rowid, new.title, new.content_text);
    END;
  `);
  sqlite.prepare("INSERT INTO settings (key, value) VALUES ('documents.format', 'tiptap-v1')").run();
  sqlite.prepare("INSERT INTO projects (id, slug) VALUES ('p1', 'demo')").run();
  sqlite.prepare("INSERT INTO tasks (id, project_id, key, description) VALUES (?, ?, ?, ?)")
    .run("t1", "p1", "DEMO-1", JSON.stringify(doc("literal *text*")));
  sqlite.prepare("INSERT INTO wiki_pages (id, project_id, slug, content, content_text) VALUES (?, ?, ?, ?, ?)")
    .run("w1", "p1", "home", JSON.stringify(doc("page body")), "page body");
  sqlite.prepare("INSERT INTO wiki_page_revisions (id, page_id, content, content_text) VALUES (?, ?, ?, ?)")
    .run("r1", "w1", JSON.stringify(doc("revision body")), "revision body");
  sqlite.prepare("INSERT INTO task_comments (id, task_id, body) VALUES (?, ?, ?)")
    .run(1, "t1", JSON.stringify(doc("comment body")));
  sqlite.prepare("INSERT INTO assistant_pending_writes (id, project_id, tool_name, args, diff, status) VALUES (?, ?, ?, ?, ?, ?)")
    .run("historical", "p1", "unsupported_tool", JSON.stringify({ unsupported: { type: "doc", content: [] } }), "{}", "approved");
  return { sqlite, driver: createBunSqliteDriver(sqlite) };
}

describe("legacy TipTap to Markdown upgrade", () => {
  it("preserves literal Markdown metacharacters and hard breaks in the serialized source", () => {
    const source = JSON.stringify({
      type: "doc",
      content: [{ type: "paragraph", content: [
        { type: "text", text: "literal *text*" },
        { type: "hardBreak" },
        { type: "text", text: "next line" },
      ] }],
    });
    const markdown = serializeLegacyTiptap(source, { projectSlug: "demo" });
    expect(markdownToText(markdown)).toBe("literal *text*\nnext line");
    expect(serializeLegacyTiptap('{"type":"doc","content":[{"type":"paragraph"}]}')).toBe("");
    const spaces = serializeLegacyTiptap(JSON.stringify({
      type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "  ", marks: [{ type: "code" }] }] }],
    }));
    expect(parseMarkdown(spaces).children).toMatchObject([{
      type: "paragraph", children: [{ type: "inlineCode", value: "  " }],
    }]);
  });

  it("preserves nested list ownership beneath multi-digit ordered markers", () => {
    const source = JSON.stringify({
      type: "doc",
      content: [{ type: "orderedList", attrs: { start: 12 }, content: [{
        type: "listItem", content: [
          { type: "paragraph", content: [{ type: "text", text: "Parent twelve" }] },
          { type: "bulletList", content: [{
            type: "listItem", content: [
              { type: "paragraph", content: [{ type: "text", text: "Nested child" }] },
              { type: "codeBlock", content: [{ type: "text", text: "literal\n\ncode" }] },
            ],
          }] },
        ],
      }] }],
    });
    const parsed = parseMarkdown(serializeLegacyTiptap(source));
    expect(parsed.children).toMatchObject([{
      type: "list", ordered: true, start: 12, items: [{
        children: [
          { type: "paragraph", children: [{ type: "text", value: "Parent twelve" }] },
          { type: "list", ordered: false, items: [{
            children: [
              { type: "paragraph", children: [{ type: "text", value: "Nested child" }] },
              { type: "code", value: "literal\n\ncode" },
            ],
          }] },
        ],
      }],
    }]);
  });
  it("rejects unrepresentable link and image titles and keeps adjacent ordered-list boundaries", () => {
    const link = {
      type: "doc",
      content: [{ type: "paragraph", content: [{
        type: "text", text: "draft", marks: [{ type: "link", attrs: { href: "https://example.invalid", title: "(draft" } }],
      }] }],
    };
    const image = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "image", attrs: { src: "https://example.invalid/image.png", title: "(draft" } }] }],
    };
    expect(() => serializeLegacyTiptap(JSON.stringify(link))).toThrow(/invalid link title/);
    expect(() => serializeLegacyTiptap(JSON.stringify(image))).toThrow(/invalid image title/);
    const backslashDestination = {
      type: "doc",
      content: [{ type: "paragraph", content: [{
        type: "text", text: "link", marks: [{ type: "link", attrs: { href: "https://example.invalid/a\\\\b" } }],
      }] }],
    };
    expect(() => serializeLegacyTiptap(JSON.stringify(backslashDestination))).toThrow(/unsupported link href/);
    const backslashImageDestination = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "image", attrs: { src: "https://example.invalid/a\\\\b.png" } }] }],
    };
    expect(() => serializeLegacyTiptap(JSON.stringify(backslashImageDestination))).toThrow(/unsupported image source/);
    for (const marks of [
      [{ type: "italic" }, { type: "link", attrs: { href: "https://example.invalid/a*b" } }],
      [{ type: "link", attrs: { href: "https://example.invalid/a*b" } }, { type: "italic" }],
    ]) {
      const styledLink = { type: "doc", content: [{
        type: "paragraph", content: [{ type: "text", text: "label", marks }],
      }] };
      expect(parseMarkdown(serializeLegacyTiptap(JSON.stringify(styledLink))).children).toMatchObject([{
        type: "paragraph", children: [{
          type: "link", href: "https://example.invalid/a*b",
          children: [{ type: "emphasis", children: [{ type: "text", value: "label" }] }],
        }],
      }]);
    }

    const item = (text: string) => ({ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
    const unordered = (type: "bulletList" | "taskList", text: string) => ({
      type,
      content: [{ ...item(text), type: type === "taskList" ? "taskItem" : "listItem",
        ...(type === "taskList" ? { attrs: { checked: true } } : {}) }],
    });
    for (const separator of [
      [],
      [{ type: "paragraph" }],
      [{ type: "paragraph", content: [{ type: "text", text: " \t " }] }],
    ]) {
      const nested = {
        type: "doc",
        content: [{
          type: "bulletList",
          content: [{ type: "listItem", content: [
            { type: "paragraph", content: [{ type: "text", text: "Parent" }] },
            { type: "orderedList", attrs: { start: 12 }, content: [item("Nested twelve")] },
            ...separator,
            { type: "orderedList", attrs: { start: 1 }, content: [item("Nested one")] },
          ] }],
        }],
      };
      const adjacent = {
        type: "doc",
        content: [
          { type: "orderedList", attrs: { start: 12 }, content: [item("First")] },
          ...separator,
          { type: "orderedList", attrs: { start: 1 }, content: [item("Restart")] },
        ],
      };
      expect(parseMarkdown(serializeLegacyTiptap(JSON.stringify(adjacent))).children).toMatchObject([
        { type: "list", ordered: true, start: 12, items: [{ children: [{ type: "paragraph", children: [{ value: "First" }] }] }] },
        { type: "list", ordered: true, start: 1, items: [{ children: [{ type: "paragraph", children: [{ value: "Restart" }] }] }] },
      ]);
      expect(parseMarkdown(serializeLegacyTiptap(JSON.stringify(nested))).children).toMatchObject([{
        items: [{ children: [
          { type: "paragraph", children: [{ value: "Parent" }] },
          { type: "list", ordered: true, start: 12 },
          { type: "list", ordered: true, start: 1 },
        ] }],
      }]);
      for (const left of ["bulletList", "taskList"] as const) {
        for (const right of ["bulletList", "taskList"] as const) {
          const pair = [unordered(left, "First"), ...separator, unordered(right, "Second")];
          const expected = [
            { type: "list", ordered: false, items: [{ ...(left === "taskList" ? { checked: true } : {}),
              children: [{ type: "paragraph", children: [{ value: "First" }] }] }] },
            { type: "list", ordered: false, items: [{ ...(right === "taskList" ? { checked: true } : {}),
              children: [{ type: "paragraph", children: [{ value: "Second" }] }] }] },
          ];
          expect(parseMarkdown(serializeLegacyTiptap(JSON.stringify({ type: "doc", content: pair }))).children)
            .toMatchObject(expected);
          const nestedPair = { type: "doc", content: [{ type: "bulletList", content: [{
            type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Parent" }] }, ...pair],
          }] }] };
          expect(parseMarkdown(serializeLegacyTiptap(JSON.stringify(nestedPair))).children)
            .toMatchObject([{ items: [{ children: [{ type: "paragraph" }, ...expected] }] }]);
        }
      }
    }
    const boundary = { type: "doc", content: [{
      type: "orderedList", attrs: { start: 999_999_999 }, content: [item("First"), item("Second")],
    }] };
    expect(parseMarkdown(serializeLegacyTiptap(JSON.stringify(boundary))).children).toMatchObject([{
      type: "list", ordered: true, start: 999_999_999, items: [
        { children: [{ children: [{ value: "First" }] }] },
        { children: [{ children: [{ value: "Second" }] }] },
      ],
    }]);
  });

  it("blocks over-limit durable and pending comments, including resumed journal rows, without writes", async () => {
    const { sqlite, driver } = database();
    const oldDocument = JSON.stringify(doc("*".repeat(30_000)));
    const markdown = "\\*".repeat(30_000);
    const oldArgs = JSON.stringify({ body: doc("*".repeat(30_000)) });
    const oldDiff = "{}";
    try {
      sqlite.prepare("UPDATE task_comments SET body = ? WHERE id = 1").run(oldDocument);
      sqlite.prepare("INSERT INTO assistant_pending_writes (id, project_id, tool_name, args, diff, status) VALUES (?, ?, ?, ?, ?, ?)")
        .run("pending-comment", "p1", "add_comment", oldArgs, oldDiff, "pending");
      const firstAudit = await auditMarkdownUpgrade(driver, "fixture:oversized-comments");
      expect(firstAudit.blockers.map(({ table_name, row_key }) => [table_name, row_key])).toEqual(expect.arrayContaining([
        ["task_comments.body", "1"],
        ["assistant_pending_writes.args/diff", "pending-comment"],
      ]));
      expect((sqlite.prepare("SELECT body FROM task_comments WHERE id = 1").get() as { body: string }).body).toBe(oldDocument);
      expect((sqlite.prepare("SELECT args, diff FROM assistant_pending_writes WHERE id = 'pending-comment'").get() as { args: string; diff: string }))
        .toEqual({ args: oldArgs, diff: oldDiff });
      expect(sqlite.prepare("SELECT count(*) AS n FROM _markdown_migration").get()).toEqual({ n: 0 });

      const serializedArgs = JSON.stringify({ body: markdown });
      const serializedDiff = JSON.stringify({ bodyText: markdown });
      const hash = async (value: string): Promise<string> => {
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
        return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      };
      sqlite.prepare("UPDATE task_comments SET body = ? WHERE id = 1").run(markdown);
      sqlite.prepare("UPDATE assistant_pending_writes SET args = ?, diff = ? WHERE id = 'pending-comment'")
        .run(serializedArgs, serializedDiff);
      const insertJournal = sqlite.prepare("INSERT INTO _markdown_migration (table_name, row_key, source_hash, target_hash) VALUES (?, ?, ?, ?)");
      insertJournal.run("task_comments.body", "1", "0".repeat(64), await hash(markdown));
      insertJournal.run("assistant_pending_writes.args", "pending-comment", "0".repeat(64), await hash(serializedArgs));
      insertJournal.run("assistant_pending_writes.diff", "pending-comment", "0".repeat(64), await hash(serializedDiff));

      const resumedAudit = await auditMarkdownUpgrade(driver, "fixture:oversized-comments");
      expect(resumedAudit.blockers.map(({ table_name, row_key }) => [table_name, row_key])).toEqual(expect.arrayContaining([
        ["task_comments.body", "1"],
        ["assistant_pending_writes.args/diff", "pending-comment"],
      ]));
      expect((sqlite.prepare("SELECT body FROM task_comments WHERE id = 1").get() as { body: string }).body).toBe(markdown);
      expect((sqlite.prepare("SELECT args, diff FROM assistant_pending_writes WHERE id = 'pending-comment'").get() as { args: string; diff: string }))
        .toEqual({ args: serializedArgs, diff: serializedDiff });
      expect(sqlite.prepare("SELECT count(*) AS n FROM _markdown_migration").get()).toEqual({ n: 3 });
    } finally {
      sqlite.close();
    }
  });

  it("preserves table delimiters in code and destinations but refuses multiline cells", () => {
    const cell = (type: string, content: unknown[]) => ({ type, content: [{ type: "paragraph", content }] });
    const source = {
      type: "doc", content: [{ type: "table", content: [
        { type: "tableRow", content: ["Code", "Link", "Image", "Literal"].map((text) => cell("tableHeader", [{ type: "text", text }])) },
        { type: "tableRow", content: [
          cell("tableCell", [{ type: "text", text: "a\\|b", marks: [{ type: "code" }] }]),
          cell("tableCell", [{ type: "text", text: "Link", marks: [{ type: "link", attrs: { href: "https://example.invalid/a|b" } }] }]),
          cell("tableCell", [{ type: "image", attrs: { src: "https://example.invalid/a|b.png", alt: "Diagram" } }]),
          cell("tableCell", [{ type: "text", text: "literal \\| pipe" }]),
        ] },
      ] }],
    };
    const parsed = parseMarkdown(serializeLegacyTiptap(JSON.stringify(source))).children[0];
    if (parsed?.type !== "table") throw new Error("Converted table is missing");
    expect(parsed.rows).toMatchObject([[
      { children: [{ type: "inlineCode", value: "a\\|b" }] },
      { children: [{ type: "link", href: "https://example.invalid/a|b" }] },
      { children: [{ type: "image", src: "https://example.invalid/a|b.png", alt: "Diagram" }] },
      { children: [{ type: "text", value: "literal \\| pipe" }] },
    ]]);
    source.content[0]!.content[1]!.content[0] = cell("tableCell", [{ type: "text", text: "Before" }, { type: "hardBreak" }, { type: "text", text: "After" }]);
    expect(() => serializeLegacyTiptap(JSON.stringify(source))).toThrow();
  });

  it("audits all durable content rows without rewriting legacy source", async () => {
    const { sqlite, driver } = database();
    sqlite.exec("UPDATE wiki_pages SET content = '{}', content_text = ''; UPDATE wiki_page_revisions SET content = '{}', content_text = ''");
    try {
      const before = sqlite.prepare("SELECT description FROM tasks WHERE id = 't1'").get() as { description: string };
      const report = await auditMarkdownUpgrade(driver, "fixture:clean");
      expect(report.blockers).toEqual([]);
      expect(report.records.map((entry) => entry.table_name).sort()).toEqual([
        "task_comments.body", "tasks.description", "wiki_page_revisions.content", "wiki_pages.content",
      ]);
      expect((sqlite.prepare("SELECT description FROM tasks WHERE id = 't1'").get() as { description: string }).description)
        .toBe(before.description);
      expect(sqlite.prepare("SELECT count(*) AS n FROM _markdown_migration").get()).toEqual({ n: 0 });
    } finally {
      sqlite.close();
    }
  });
  it("resumes atomic progress through FTS writes and never reparses completed Markdown", async () => {
    const { sqlite, driver } = database();
    try {
      const audit = await auditMarkdownUpgrade(driver, "fixture:resume");
      sqlite.exec(`CREATE TRIGGER stop_upgrade BEFORE UPDATE ON wiki_pages BEGIN
        SELECT RAISE(ABORT, 'interrupted');
      END`);
      await expect(applyMarkdownUpgrade(driver, audit, "fixture:resume", 1)).rejects.toThrow();
      expect(sqlite.query("SELECT value FROM settings WHERE key = 'documents.format'").get())
        .toEqual({ value: "migrating-markdown-v1" });
      expect(sqlite.query("SELECT table_name, row_key FROM _markdown_migration").all())
        .toEqual([{ table_name: "tasks.description", row_key: "t1" }]);
      await expect(Effect.runPromise(assertMarkdownReady(driver))).rejects.toThrow();
      sqlite.exec("DROP TRIGGER stop_upgrade");
      await applyMarkdownUpgrade(driver, audit, "fixture:resume", 1);
      expect(sqlite.query("SELECT content_text FROM wiki_fts WHERE wiki_fts MATCH 'body'").all())
        .toEqual([{ content_text: "page body" }]);
      expect(sqlite.query("SELECT count(*) AS n FROM _markdown_migration").get()).toEqual({ n: 4 });
      expect(sqlite.query("SELECT value FROM settings WHERE key = 'documents.format'").get())
        .toEqual({ value: "markdown-v1" });
      const literal = '{"type":"doc","content":[]}';
      sqlite.prepare("UPDATE tasks SET description = ? WHERE id = 't1'").run(literal);
      await applyMarkdownUpgrade(driver, audit, "fixture:resume", 1);
      expect(sqlite.query("SELECT description FROM tasks WHERE id = 't1'").get()).toEqual({ description: literal });
    } finally {
      sqlite.close();
    }
  });


  it("blocks unsupported marks and malformed references without changing source", async () => {
    const { sqlite, driver } = database();
    try {
      const inputs = [
        { type: "text", text: "colored", marks: [{ type: "textStyle", attrs: { color: "red" } }] },
        { type: "mention", attrs: { refType: "task", refId: " ", label: " " } },
        { type: "mention", attrs: { refType: "wiki", refId: "path/fragment", label: "Unresolvable" } },
        { type: "text", text: "link", marks: [{ type: "link", attrs: { href: "https://example.invalid/a>b" } }] },
        { type: "image", attrs: { src: "https://example.invalid/a>b.png" } },
      ];
      const sources = [
        ...inputs.map((input) => JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [input] }] })),
        JSON.stringify({ type: "doc", content: [{ type: "text", text: "orphan text" }] }),
        JSON.stringify({ type: "doc", content: [{ type: "codeBlock", content: [{ type: "text", text: "code", marks: [{ type: "bold" }] }] }] }),
        JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "duplicate", marks: [{ type: "bold" }, { type: "bold" }] }] }] }),
        JSON.stringify({ type: "doc", content: [{ type: "orderedList", attrs: { start: 1_000_000_000 }, content: [
          { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Too large" }] }] },
        ] }] }),
        ...[false, true].map((bold) => JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [
          { type: "text", text: "a", marks: [{ type: "strike" }] },
          { type: "text", text: "b", marks: [{ type: "strike" }, ...(bold ? [{ type: "bold" }] : [])] },
        ] }] })),
        JSON.stringify({ type: "doc", content: [{ type: "heading", attrs: { level: 2 }, content: [
          { type: "text", text: "Before" }, { type: "hardBreak" }, { type: "text", text: "After" },
        ] }] }),
        ...[[], [{ type: "paragraph", content: [] }]].map((separator) => JSON.stringify({ type: "doc", content: [
          { type: "blockquote", content: [{ type: "paragraph", content: [{ type: "text", text: "First" }] }] },
          ...separator,
          { type: "blockquote", content: [{ type: "paragraph", content: [{ type: "text", text: "Second" }] }] },
        ] })),
        "confidential_invalid_document_body",
      ];
      for (const malformed of sources) {
        sqlite.prepare("UPDATE tasks SET description = ? WHERE id = 't1'").run(malformed);
        const report = await auditMarkdownUpgrade(driver, "fixture:malformed");
        expect(report.blockers.some((blocker) => blocker.table_name === "tasks.description")).toBe(true);
        expect(JSON.stringify(report)).not.toContain("confidential_invalid_document_body");
        expect((sqlite.prepare("SELECT description FROM tasks WHERE id = 't1'").get() as { description: string }).description)
          .toBe(malformed);
        expect(sqlite.prepare("SELECT count(*) AS n FROM _markdown_migration").get()).toEqual({ n: 0 });
      }
    } finally {
      sqlite.close();
    }
  });
});
