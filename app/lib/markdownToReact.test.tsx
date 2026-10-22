// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { markdownToReact } from "./markdownToReact";

const html = (md: string, options?: Parameters<typeof markdownToReact>[1]) =>
  renderToStaticMarkup(<>{markdownToReact(md, options)}</>);

describe("TanStack Markdown render policies", () => {
  it("keeps only allowlisted links and opens external links safely", () => {
    expect(html("[x](https://example.com/a)")).toContain('href="https://example.com/a"');
    expect(html("[x](https://example.com/a)")).toContain('rel="noopener noreferrer"');
    expect(html("[x](mailto:a@b.c)")).toContain('href="mailto:a@b.c"');
    const unsafe = html("[x](javascript:alert(1))");
    expect(unsafe).not.toContain("<a");
    expect(unsafe).not.toContain("javascript:");
  });

  it("renders chat images as alt text and never executes raw HTML", () => {
    const out = html("![visible](https://example.com/image.png)\n\n<script>alert(1)</script>");
    expect(out).toContain("visible");
    expect(out).not.toContain("<img");
    expect(out).not.toContain("<script>");
    const comment = html("![tracking](https://example.com/image.png) [internal](/private)", { surface: "comment" });
    expect(comment).not.toContain("<img");
    expect(comment).not.toContain("<a");
  });

  it("does not decorate code text", () => {
    const renderText = (text: string) => <b>{text}</b>;
    const out = html("ordinary\n\n`literal`\n\n```txt\nfenced\n```", { renderText });
    const root = document.createElement("div");
    root.innerHTML = out;
    const code = [...root.querySelectorAll("code")];
    expect(code.map((node) => node.textContent?.trimEnd())).toEqual(["literal", "fenced"]);
    expect(code.some((node) => node.querySelector("b") !== null)).toBe(false);
  });

  it("rewrites share links and images only in rendered output", () => {
    const share = { token: "share-token", pageIds: new Map([["next", "page-2"]]) };
    const out = html("[next](/work/wiki/next) ![asset](/api/attachments/123e4567-e89b-12d3-a456-426614174000)", { surface: "share", share });
    expect(out).toContain('/share/share-token?page=page-2');
    expect(out).toContain('/api/share/share-token/attachments/123e4567-e89b-12d3-a456-426614174000');
  });
});
