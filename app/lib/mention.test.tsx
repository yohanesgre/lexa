import { describe, it, expect } from "vitest";
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
