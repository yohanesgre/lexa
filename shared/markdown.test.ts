import { describe, expect, it } from "vitest";
import { docToMarkdown, markdownToDoc } from "./markdown";
import type { TipTapDoc } from "./types";

function rd(md: string): string {
  return docToMarkdown(markdownToDoc(md));
}

function hasNodeOfType(doc: TipTapDoc, nodeType: string): boolean {
  return searchNodes(doc.content as Record<string, unknown>[], nodeType);
}

function searchNodes(nodes: Record<string, unknown>[], nodeType: string): boolean {
  for (const n of nodes) {
    if (n.type === nodeType) return true;
    const children = n.content as Record<string, unknown>[] | undefined;
    if (children && searchNodes(children, nodeType)) return true;
  }
  return false;
}

describe("markdownToDoc", () => {
  it("maps headings (h1/h2/h3)", () => {
    const doc = markdownToDoc("# One\n\n## Two\n\n### Three");
    expect(doc.type).toBe("doc");
    const content = doc.content as Record<string, unknown>[];
    expect(content[0]).toMatchObject({ type: "heading", attrs: { level: 1 } });
    expect(content[1]).toMatchObject({ type: "heading", attrs: { level: 2 } });
    expect(content[2]).toMatchObject({ type: "heading", attrs: { level: 3 } });
  });

  it("maps paragraph", () => {
    const doc = markdownToDoc("Hello world");
    expect(doc.type).toBe("doc");
    const content = doc.content as Record<string, unknown>[];
    expect(content[0]).toMatchObject({ type: "paragraph" });
  });

  it("maps bold text", () => {
    const doc = markdownToDoc("This is **bold** text");
    const para = (doc.content as Record<string, unknown>[])[0];
    const children = para.content as Record<string, unknown>[];
    expect(children).toBeDefined();
    const bold = children.find(c => c.type === "text" && Array.isArray(c.marks));
    expect(bold).toBeDefined();
  });

  it("maps italic text", () => {
    const doc = markdownToDoc("This is *italic* text");
    const para = (doc.content as Record<string, unknown>[])[0];
    const children = para.content as Record<string, unknown>[];
    const italic = children.find(
      c =>
        c.type === "text" &&
        Array.isArray(c.marks) &&
        (c.marks as Record<string, unknown>[]).some(m => m.type === "italic"),
    );
    expect(italic).toBeDefined();
  });

  it("maps inline code", () => {
    const doc = markdownToDoc("Use `const x = 1` here");
    const para = (doc.content as Record<string, unknown>[])[0];
    const children = para.content as Record<string, unknown>[];
    const code = children.find(
      c =>
        c.type === "text" &&
        Array.isArray(c.marks) &&
        (c.marks as Record<string, unknown>[]).some(m => m.type === "code"),
    );
    expect(code).toBeDefined();
  });

  it("maps links", () => {
    const doc = markdownToDoc("Visit [example](https://example.com) now");
    const para = (doc.content as Record<string, unknown>[])[0];
    const children = para.content as Record<string, unknown>[];
    const link = children.find(
      c =>
        c.type === "text" &&
        Array.isArray(c.marks) &&
        (c.marks as Record<string, unknown>[]).some(m => m.type === "link"),
    );
    expect(link).toBeDefined();
  });

  it("drops javascript: link hrefs at the authoring boundary", () => {
    const doc = markdownToDoc("Click [x](javascript:alert(1)) or [safe](https://ok.dev)");
    const para = (doc.content as Record<string, unknown>[])[0];
    const children = para.content as Record<string, unknown>[];
    const marks = (c: Record<string, unknown>) =>
      (c.marks as { type: string; attrs?: Record<string, unknown> }[] | undefined)?.filter(m => m.type === "link") ?? [];
    const xMarks = marks(children[1] as Record<string, unknown>); // "Click ", [x](js:...), " or ", [safe](...)
    expect(xMarks).toHaveLength(1);
    expect(xMarks[0]!.attrs?.href).toBeUndefined(); // dropped, link mark has no href
    const safeMarks = marks(children[3] as Record<string, unknown>);
    expect(safeMarks[0]!.attrs?.href).toBe("https://ok.dev"); // safe schemes round-trip unchanged
  });

  it("maps unordered list", () => {
    const doc = markdownToDoc("- one\n- two\n- three");
    expect(hasNodeOfType(doc, "bulletList")).toBe(true);
  });

  it("maps ordered list", () => {
    const doc = markdownToDoc("1. first\n2. second\n3. third");
    expect(hasNodeOfType(doc, "orderedList")).toBe(true);
  });

  it("maps task list with unchecked items", () => {
    const doc = markdownToDoc("- [ ] buy milk\n- [ ] walk dog");
    expect(hasNodeOfType(doc, "taskList")).toBe(true);
  });

  it("maps task list with checked items", () => {
    const doc = markdownToDoc("- [x] buy milk\n- [x] walk dog");
    const content = doc.content as Record<string, unknown>[];
    const taskList = content[0];
    const items = taskList.content as Record<string, unknown>[];
    expect(items[0]).toMatchObject({ type: "taskItem", attrs: { checked: true } });
    expect(items[1]).toMatchObject({ type: "taskItem", attrs: { checked: true } });
  });

  it("maps fenced code block with language", () => {
    const doc = markdownToDoc("```ts\nconst x = 1;\n```");
    const content = doc.content as Record<string, unknown>[];
    expect(content[0]).toMatchObject({ type: "codeBlock" });
  });

  it("maps blockquote", () => {
    const doc = markdownToDoc("> quoted text");
    expect(hasNodeOfType(doc, "blockquote")).toBe(true);
  });

  it("maps horizontal rule", () => {
    const doc = markdownToDoc("---");
    const content = doc.content as Record<string, unknown>[];
    expect(content[0]).toMatchObject({ type: "horizontalRule" });
  });

  it("degrades tables to codeBlock", () => {
    const doc = markdownToDoc("| a | b |\n|---|---|\n| 1 | 2 |");
    const content = doc.content as Record<string, unknown>[];
    expect(content[0]).toMatchObject({ type: "codeBlock" });
  });

  it("degrades raw HTML to codeBlock", () => {
    const doc = markdownToDoc("<div>hello</div>");
    const content = doc.content as Record<string, unknown>[];
    expect(content[0]).toMatchObject({ type: "codeBlock" });
  });

  it("degrades images to codeBlock", () => {
    const doc = markdownToDoc("Look: ![alt](https://example.com/img.png)");
    // blocks are paragraph, image inline degrades to text
    const content = doc.content as Record<string, unknown>[];
    expect(content[0]).toMatchObject({ type: "paragraph" });
  });

  it("never throws on garbage input", () => {
    const doc = markdownToDoc(String.fromCharCode(0));
    expect(doc.type).toBe("doc");
  });
});

describe("docToMarkdown", () => {
  it("emits headings", () => {
    const doc: TipTapDoc = { type: "doc", content: [{ type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Title" }] }] };
    expect(docToMarkdown(doc)).toBe("# Title");
  });

  it("emits paragraph", () => {
    const doc: TipTapDoc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "plain text" }] }] };
    expect(docToMarkdown(doc)).toBe("plain text");
  });

  it("emits bold", () => {
    const doc: TipTapDoc = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "bold", marks: [{ type: "bold" }] }] }],
    };
    expect(docToMarkdown(doc)).toBe("**bold**");
  });

  it("emits italic", () => {
    const doc: TipTapDoc = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "italic", marks: [{ type: "italic" }] }] }],
    };
    expect(docToMarkdown(doc)).toBe("*italic*");
  });

  it("emits inline code", () => {
    const doc: TipTapDoc = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "x = 1", marks: [{ type: "code" }] }] }],
    };
    expect(docToMarkdown(doc)).toBe("`x = 1`");
  });

  it("emits links", () => {
    const doc: TipTapDoc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "click", marks: [{ type: "link", attrs: { href: "https://x.com" } }] }],
        },
      ],
    };
    expect(docToMarkdown(doc)).toBe("[click](https://x.com)");
  });

  it("emits bullet list", () => {
    const doc: TipTapDoc = {
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "a" }] }] },
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "b" }] }] },
          ],
        },
      ],
    };
    expect(docToMarkdown(doc)).toBe("- a\n- b");
  });

  it("emits ordered list", () => {
    const doc: TipTapDoc = {
      type: "doc",
      content: [
        {
          type: "orderedList",
          content: [
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "first" }] }] },
          ],
        },
      ],
    };
    expect(docToMarkdown(doc)).toBe("1. first");
  });

  it("emits task list with checked state", () => {
    const doc: TipTapDoc = {
      type: "doc",
      content: [
        {
          type: "taskList",
          content: [
            { type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph", content: [{ type: "text", text: "todo" }] }] },
            { type: "taskItem", attrs: { checked: true }, content: [{ type: "paragraph", content: [{ type: "text", text: "done" }] }] },
          ],
        },
      ],
    };
    expect(docToMarkdown(doc)).toBe("- [ ] todo\n- [x] done");
  });

  it("emits code block with language", () => {
    const doc: TipTapDoc = {
      type: "doc",
      content: [{ type: "codeBlock", attrs: { language: "ts" }, content: [{ type: "text", text: "const x = 1;" }] }],
    };
    expect(docToMarkdown(doc)).toBe("```ts\nconst x = 1;\n```");
  });

  it("emits blockquote", () => {
    const doc: TipTapDoc = {
      type: "doc",
      content: [{ type: "blockquote", content: [{ type: "paragraph", content: [{ type: "text", text: "quoted" }] }] }],
    };
    expect(docToMarkdown(doc)).toBe("> quoted");
  });

  it("emits horizontal rule", () => {
    const doc: TipTapDoc = { type: "doc", content: [{ type: "horizontalRule" }] };
    expect(docToMarkdown(doc)).toBe("---");
  });

  it("emits unknown node as fenced code block", () => {
    const doc: TipTapDoc = { type: "doc", content: [{ type: "customBlock", content: [{ type: "text", text: "hello" }] }] };
    expect(docToMarkdown(doc)).toBe("```\nhello\n```");
  });

  it("never throws on invalid doc", () => {
    const doc: unknown = { type: "doc", content: [{ type: "text", text: "ok" }] };
    const result = docToMarkdown(doc as TipTapDoc);
    expect(typeof result).toBe("string");
  });
});

describe("round-trip", () => {
  it("heading h1", () => expect(rd("# Hello")).toBe("# Hello"));
  it("heading h2", () => expect(rd("## Hello")).toBe("## Hello"));
  it("heading h3", () => expect(rd("### Hello")).toBe("### Hello"));
  it("paragraph", () => expect(rd("plain text")).toBe("plain text"));
  it("bold", () => expect(rd("**bold**")).toBe("**bold**"));
  it("italic", () => expect(rd("*italic*")).toBe("*italic*"));
  it("inline code", () => expect(rd("`code`")).toBe("`code`"));
  it("link", () => expect(rd("[link](https://x.com)")).toBe("[link](https://x.com)"));
  it("bullet list", () => expect(rd("- a\n- b\n- c")).toBe("- a\n- b\n- c"));
  it("ordered list", () => expect(rd("1. a\n2. b")).toBe("1. a\n1. b"));
  it("code block", () => expect(rd("```ts\nconst x = 1;\n```")).toBe("```ts\nconst x = 1;\n```"));
  it("blockquote", () => expect(rd("> quote")).toBe("> quote"));
  it("horizontal rule", () => expect(rd("---")).toBe("---"));

  it("task list round-trip preserves checked state", () => {
    const result = rd("- [ ] todo\n- [x] done");
    expect(result).toBe("- [ ] todo\n- [x] done");
  });

  it("table degrades to codeBlock", () => {
    const doc = markdownToDoc("| a | b |\n|---|---|\n| 1 | 2 |");
    const content = doc.content as Record<string, unknown>[];
    expect(content[0]).toMatchObject({ type: "codeBlock" });
  });
});
