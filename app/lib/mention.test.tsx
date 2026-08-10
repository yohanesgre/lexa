// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TipTapDoc } from "../../shared/types";
import { renderCommentBody } from "./mention";

describe("renderCommentBody", () => {
  it("wraps known member names, leaves unknown names plain", () => {
    const doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "ping @Maria Kim and @Ghost" }] }] } as TipTapDoc;
    const html = renderToStaticMarkup(<>{renderCommentBody(doc, ["Maria Kim"])}</>);
    expect(html).toContain('class="mention-chip"');
    expect(html).toContain('mention-chip">@Maria Kim');
    expect(html).not.toContain("mention-chip\">@Ghost"); // unknown name not wrapped
    expect(html).toContain("and @Ghost"); // stays plain text
  });

  it("matches longest member name first", () => {
    const doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "see @Maria Kim today" }] }] } as TipTapDoc;
    const html = renderToStaticMarkup(<>{renderCommentBody(doc, ["Maria", "Maria Kim"])}</>);
    expect(html).toContain('mention-chip">@Maria Kim');
  });

  it("does not wrap when the name continues with word chars", () => {
    // The designer's matcher stops at whitespace/punctuation after the name
    // (no leading boundary) — a longer word like @Mariax must stay plain.
    const doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "ping @Mariax now" }] }] } as TipTapDoc;
    const html = renderToStaticMarkup(<>{renderCommentBody(doc, ["Maria"])}</>);
    expect(html).not.toContain("mention-chip");
    expect(html).toContain("ping @Mariax now");
  });

  it("returns null for an empty doc", () => {
    const doc = { type: "doc", content: [] } as TipTapDoc;
    expect(renderCommentBody(doc, ["Maria"])).toBeNull();
  });
});

describe("renderCommentBody DOM rendering", () => {
  const html = (doc: TipTapDoc, members: string[]) => {
    const { container } = render(<>{renderCommentBody(doc, members)}</>);
    return container.innerHTML;
  };

  it("applies bold/italic/code marks around mentions", () => {
    const doc = {
      type: "doc",
      content: [{
        type: "paragraph",
        content: [{
          type: "text",
          text: "ping @Maria",
          marks: [{ type: "bold" as const }, { type: "italic" as const }, { type: "code" as const }],
        }],
      }],
    } as TipTapDoc;
    const out = html(doc, ["Maria"]);
    expect(out).toContain("<strong>");
    expect(out).toContain("<em>");
    expect(out).toContain("td-code");
    expect(out).toContain('class="mention-chip"');
  });

  it("renders safe links as anchors and drops disallowed schemes", () => {
    const safe = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "see docs", marks: [{ type: "link" as const, attrs: { href: "https://lexa.test/docs" } }] }] }],
    } as TipTapDoc;
    const out = html(safe, []);
    expect(out).toContain('<a href="https://lexa.test/docs"');
    const evil = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "see docs", marks: [{ type: "link" as const, attrs: { href: "javascript:alert(1)" } }] }] }],
    } as TipTapDoc;
    const evilOut = html(evil, []);
    expect(evilOut).not.toContain("<a ");
    expect(evilOut).toContain("see docs");
  });

  it("renders hardBreak, codeBlock, lists, blockquote and horizontalRule", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "line1" }, { type: "hardBreak" }, { type: "text", text: "line2" }] },
        { type: "codeBlock", content: [{ type: "text", text: "code <body>" }] },
        { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "item" }] }] }] },
        { type: "blockquote", content: [{ type: "paragraph", content: [{ type: "text", text: "quote" }] }] },
        { type: "horizontalRule" },
      ],
    } as TipTapDoc;
    const out = html(doc, []);
    expect(out).toContain("<br>");
    expect(out).toContain("td-pre");
    expect(out).toContain("code &lt;body&gt;");
    expect(out).toContain("td-ul");
    expect(out).not.toContain("td-ol"); // bulletList only — no ordered list here
    expect(out).toContain("<li>");
    expect(out).toContain("td-quote");
    expect(out).toContain("<hr");
  });

  it("renders headings with level-specific classes (clamped at td-h1)", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "H1" }] },
        { type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: "H3" }] },
      ],
    } as TipTapDoc;
    const out = html(doc, []);
    expect(out).toContain('class="td-h1"');
    expect(out).toContain('class="td-h3"');
  });

  it("matches mentions followed by punctuation", () => {
    const doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "@Maria, @Maria!" }] }] } as TipTapDoc;
    const out = html(doc, ["Maria"]);
    expect(out).toContain('mention-chip">@Maria</span>, <span class="mention-chip">@Maria</span>');
  });

  it("escapes regex-special member names", () => {
    const doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "hi @C++ dev" }] }] } as TipTapDoc;
    const out = html(doc, ["C++"]);
    expect(out).toContain('mention-chip">@C++');
  });

  it("renders plain text when there are no mentions or member names", () => {
    const doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "no mentions here" }] }] } as TipTapDoc;
    expect(html(doc, ["Maria"])).toBe('<p class="td-p"><span>no mentions here</span></p>');
    expect(html(doc, [])).toContain("no mentions here");
  });

  it("falls back to a div for unknown block node types", () => {
    const doc = { type: "doc", content: [{ type: "customBlock", content: [{ type: "text", text: "x" }] }] } as TipTapDoc;
    const out = html(doc, []);
    expect(out).toContain("<div>");
  });
});
