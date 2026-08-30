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
});
