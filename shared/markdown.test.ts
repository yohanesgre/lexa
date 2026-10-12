import { describe, expect, it } from "vitest";
import { carryNonMarkdownContent, docToMarkdown, markdownToDoc, normalizeMarkdownForEcho } from "./markdown";
import type { TipTapDoc, TipTapMark, TipTapNode } from "./types";

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

// The editor's Markdown pane authors the document as text (docToMarkdown →
// edit → markdownToDoc), so this direction is a data-integrity contract: a
// construct the pane cannot write back must be either exact or carried over.
describe("Markdown pane round trip", () => {
  const render = { baseUrl: "", projectSlug: "demo" };
  const parse = { mentions: { projectSlug: "demo", baseUrl: "" } };
  const para = (content: TipTapNode[]): TipTapDoc => ({
    type: "doc",
    content: [{ type: "paragraph", content }],
  });
  const text = (value: string, marks?: TipTapMark[]): TipTapNode =>
    marks ? { type: "text", text: value, marks } : { type: "text", text: value };

  it("keeps document-route mentions, entity mentions and attachment srcs", () => {
    const doc = para([
      text("see "),
      { type: "mention", attrs: { refType: "task", refId: UUID, label: "LEX-42" } },
      text(" and "),
      { type: "mention", attrs: { refType: "milestone", refId: "m1", label: "Q3 Launch" } },
      text(" "),
      { type: "image", attrs: { src: `/api/attachments/${UUID}`, alt: "shot" } },
    ]);
    // Root-relative deep links: the text is host-agnostic and the attachment
    // src is not absolutized, so both come back unchanged.
    expect(docToMarkdown(doc, render)).toBe(
      `see [LEX-42](/demo/tasks?task=${UUID}) and Q3 Launch ![shot](/api/attachments/${UUID})`
    );
    const back = carryNonMarkdownContent(doc, markdownToDoc(docToMarkdown(doc, render), parse));
    expect(back).toEqual(doc);
  });

  it("carries the marks and nodes Markdown has no syntax for", () => {
    const doc = para([
      text("hot", [{ type: "highlight" }]),
      text(" "),
      text("link", [{ type: "underline" }]),
    ]);
    const edited = para([text("hot "), text("link too")]);
    expect(carryNonMarkdownContent(doc, edited)).toEqual(
      para([
        text("hot", [{ type: "highlight" }]),
        text(" "),
        text("link", [{ type: "underline" }]),
        text(" too"),
      ])
    );
    // Nothing to carry: the document comes back untouched, by identity.
    const plain = para([text("other")]);
    expect(carryNonMarkdownContent(plain, edited)).toBe(edited);
  });

  it("keeps a code block inside a list item and emphasis with boundary whitespace", () => {
    const list = {
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            { type: "listItem", content: [{ type: "paragraph", content: [text("a")] }, { type: "codeBlock", content: [text("x = 1")] }] },
          ],
        },
      ],
    } as TipTapDoc;
    expect(markdownToDoc(docToMarkdown(list))).toEqual(list);
    const bold = para([text("bold ", [{ type: "bold" }]), text("rest")]);
    expect(docToMarkdown(bold)).toBe("**bold** rest");
  });
});
