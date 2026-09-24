import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { markdownToReact } from "./markdownToReact";

const html = (md: string) => renderToStaticMarkup(<>{markdownToReact(md)}</>);

describe("markdownToReact link hrefs (shared safeHref)", () => {
  it("keeps anchors for allowed schemes", () => {
    expect(html("[x](https://example.com/a)")).toContain('href="https://example.com/a"');
    expect(html("[x](http://example.com)")).toContain('href="http://example.com"');
    expect(html("[x](mailto:a@b.c)")).toContain('href="mailto:a@b.c"');
  });

  it("drops javascript: to plain text with no anchor or scheme", () => {
    const out = html("[x](javascript:alert(1))");
    expect(out).not.toContain("<a");
    expect(out).not.toContain("javascript:");
    expect(out).toContain("x");
  });

  it("drops data: to plain text with no anchor or scheme", () => {
    const out = html("[x](data:text/html,hi)");
    expect(out).not.toContain("<a");
    expect(out).not.toContain("data:");
    expect(out).toContain("x");
  });
});
