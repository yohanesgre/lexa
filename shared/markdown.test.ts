import { describe, expect, it } from "vitest";
import { docToMarkdown, markdownToDoc, normalizeMarkdownForEcho } from "./markdown";
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

const UUID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";

describe("markdownToDoc authoring boundary", () => {
  it("drops javascript: link hrefs and keeps safe schemes", () => {
    const doc = markdownToDoc("Click [x](javascript:alert(1)) or [safe](https://ok.dev)");
    const para = (doc.content as Record<string, unknown>[])[0]!;
    const children = para.content as Record<string, unknown>[];
    const linkMarks = (c: Record<string, unknown>) =>
      ((c.marks as { type: string; attrs?: Record<string, unknown> }[] | undefined) ?? []).filter(
        (m) => m.type === "link"
      );
    // "Click ", [x](js:...), " or ", [safe](...)
    expect(linkMarks(children[1]!)).toHaveLength(1);
    expect(linkMarks(children[1]!)[0]!.attrs?.href).toBeUndefined(); // dropped
    expect(linkMarks(children[3]!)[0]!.attrs?.href).toBe("https://ok.dev");
  });
});

describe("round-trip", () => {
  it("round-trips bold, bullet/ordered lists, code blocks and blockquotes", () => {
    expect(rd("**bold**")).toBe("**bold**");
    expect(rd("- a\n- b\n- c")).toBe("- a\n- b\n- c");
    expect(rd("1. a\n2. b")).toBe("1. a\n1. b");
    expect(rd("```ts\nconst x = 1;\n```")).toBe("```ts\nconst x = 1;\n```");
    expect(rd("> quote")).toBe("> quote");
  });

  it("task list round-trip preserves checked state", () => {
    expect(rd("- [ ] todo\n- [x] done")).toBe("- [ ] todo\n- [x] done");
  });

  it("image and table round-trips preserve alignment", () => {
    expect(rd("![alt](https://x.com/i.png)")).toBe("![alt](https://x.com/i.png)");
    expect(rd("| a | b |\n| --- | --- |\n| 1 | 2 |")).toBe("| a | b |\n| --- | --- |\n| 1 | 2 |");
    expect(rd("| a | b |\n| :--- | ---: |\n| 1 | 2 |")).toBe("| a |  b |\n| :--- | ---: |\n| 1 |  2 |");
  });
});

describe("normalizeMarkdownForEcho", () => {
  it("trims edges + converts CRLF, leaving internal structure untouched", () => {
    expect(normalizeMarkdownForEcho("  hello\n")).toBe("hello");
    expect(normalizeMarkdownForEcho("a\r\nb\r\n")).toBe("a\nb");
    expect(normalizeMarkdownForEcho("\r\n# Title\r\n\r\nbody\r\n")).toBe("# Title\n\nbody");
    const md = "  - [x] done\n\n  | a | b |\n  |---|---|\n  | 1 | 2 |\n\n";
    expect(normalizeMarkdownForEcho(md)).toBe("- [x] done\n\n  | a | b |\n  |---|---|\n  | 1 | 2 |");
  });

  it("treats null and empty as equal, and is idempotent", () => {
    expect(normalizeMarkdownForEcho(null)).toBe("");
    expect(normalizeMarkdownForEcho("")).toBe("");
    expect(normalizeMarkdownForEcho(null)).toBe(normalizeMarkdownForEcho(""));
    const md = " x \r\n ";
    expect(normalizeMarkdownForEcho(normalizeMarkdownForEcho(md))).toBe(normalizeMarkdownForEcho(md));
  });
});

describe("attachment image srcs", () => {
  const REL = `/api/attachments/${UUID}`;
  const img = (src: string): TipTapDoc => ({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "image", attrs: { src, alt: "pic" } }] }],
  });

  it("absolutizes attachment srcs with a baseUrl and keeps them relative without", () => {
    expect(docToMarkdown(img(REL), { baseUrl: "https://lexa.example" })).toBe(
      `![pic](https://lexa.example${REL})`
    );
    expect(docToMarkdown(img(REL))).toBe(`![pic](${REL})`);
  });

  it("drops non-attachment relative and javascript: srcs in both directions", () => {
    expect(docToMarkdown(img("/etc/passwd"))).not.toContain("![");
    expect(hasNodeOfType(markdownToDoc("![x](/etc/passwd)"), "image")).toBe(false);
    expect(docToMarkdown(img("javascript:alert(1)"))).toBe("");
    expect(hasNodeOfType(markdownToDoc("![x](javascript:alert(1))"), "image")).toBe(false);
  });
});

describe("mention nodes", () => {
  const mentionDoc = (refType: string, refId: string, label: string): TipTapDoc => ({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "mention", attrs: { refType, refId, label } }] }],
  });
  const opts = { baseUrl: "https://lexa.example", projectSlug: "demo" };

  it("task and wiki mentions render as absolute deep links", () => {
    expect(docToMarkdown(mentionDoc("task", UUID, "LEX-42"), opts)).toBe(
      `[LEX-42](https://lexa.example/demo/tasks?task=${UUID})`
    );
    expect(docToMarkdown(mentionDoc("wiki", "home", "Home"), opts)).toBe(
      "[Home](https://lexa.example/demo/wiki/home)"
    );
  });

  it("entity refTypes emit the bare label; malformed mentions render empty", () => {
    expect(docToMarkdown(mentionDoc("milestone", "m1", "Q3 Launch"), opts)).toBe("Q3 Launch");
    expect(docToMarkdown(mentionDoc("swimlane", "s1", "Design Sprint"), opts)).toBe("Design Sprint");
    expect(docToMarkdown(mentionDoc("column", "c1", "In Review"), opts)).toBe("In Review");
    expect(docToMarkdown(mentionDoc("task", "", "X"), opts)).toBe("");
    expect(docToMarkdown(mentionDoc("task", UUID, ""), opts)).toBe("");
  });

  it("echo round-trip stability: pushed link re-renders identically on the next push", () => {
    const md1 = docToMarkdown(mentionDoc("task", UUID, "LEX-42"), opts);
    const pulled = markdownToDoc(md1);
    // Pull direction degrades to a plain link node — never a mention node.
    const para = JSON.stringify((pulled.content as Record<string, unknown>[])[0]);
    expect(para).not.toContain('"mention"');
    expect(para).toContain("/demo/tasks?task=");
    const md2 = docToMarkdown(pulled, opts);
    expect(md2).toBe(md1);
    expect(normalizeMarkdownForEcho(md2)).toBe(normalizeMarkdownForEcho(md1));
  });
});
