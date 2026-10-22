import { describe, expect, it } from "vitest";
import { isMarkdownEmpty, markdownToText, normalizeMarkdownForEcho, safeImageSrc } from "./markdown";

const ATTACHMENT = "/api/attachments/3f2504e0-4f89-11d3-9a0c-0305e82c3301";

describe("Markdown string semantics", () => {
  it("projects visible text, code, and table cells while omitting image alt text", () => {
    const text = markdownToText(
      "# Heading\n\nText with \\*literal\\* punctuation and `code`.\n\n- [ ] \n- [x] done\n\n| key | value |\n| --- | --- |\n| row | cell |"
    );
    expect(text).toContain("Heading");
    expect(text).toContain("Text with *literal* punctuation and code.");
    expect(text).toContain("done");
    expect(text).toContain("key\tvalue");
    expect(text).toContain("row\tcell");
    expect(text).not.toContain("[ ]");
    expect(markdownToText("![alt only](https://example.com/image.png)")).toBe("");
    expect(markdownToText("```ts\nconst x = 1;\n```")).toContain("const x = 1;");
  });

  it("treats task markers and empty structures as empty", () => {
    expect(isMarkdownEmpty(" \n")).toBe(true);
    for (const source of ["- [ ]", "- [x]", "- [X]\n", "- [ ] \n", "* [x]", "> - [ ]", "- [ ]\n- [x]"]) {
      expect(isMarkdownEmpty(source)).toBe(true);
      expect(markdownToText(source)).toBe("");
    }
    for (const source of ["`- [ ]`", "```\n- [ ]\n```", "- \\[ \\]", "[ ]", "- first\n\n  [ ]"]) {
      expect(isMarkdownEmpty(source)).toBe(false);
    }
    expect(isMarkdownEmpty("| | |\n| - | - |\n| | |")).toBe(true);
    expect(isMarkdownEmpty("- [x] done")).toBe(false);
    expect(isMarkdownEmpty("| key | value |\n| - | - |\n| item | |")).toBe(false);
    expect(isMarkdownEmpty("---")).toBe(false);
    expect(isMarkdownEmpty("** **")).toBe(false);
  });

  it("accepts safe images and omits unsafe image sources", () => {
    expect(safeImageSrc(ATTACHMENT)).toBe(ATTACHMENT);
    expect(safeImageSrc("https://example.com/image.png")).toBe("https://example.com/image.png");
    expect(safeImageSrc("javascript:alert(1)")).toBeNull();
    expect(safeImageSrc("file:///etc/passwd")).toBeNull();
    expect(isMarkdownEmpty(`![image](${ATTACHMENT})`)).toBe(false);
    expect(isMarkdownEmpty("![image](javascript:alert(1))")).toBe(true);
  });
});

describe("normalizeMarkdownForEcho", () => {
  it("trims edges and normalizes CRLF without changing Markdown structure", () => {
    expect(normalizeMarkdownForEcho("  hello\n")).toBe("hello");
    expect(normalizeMarkdownForEcho("a\r\nb\r\n")).toBe("a\nb");
    expect(normalizeMarkdownForEcho("\r\n# Title\r\n\r\nbody\r\n")).toBe("# Title\n\nbody");
  });

  it("treats null and empty as equal and is idempotent", () => {
    expect(normalizeMarkdownForEcho(null)).toBe("");
    expect(normalizeMarkdownForEcho(null)).toBe(normalizeMarkdownForEcho(""));
    const markdown = " x \r\n ";
    expect(normalizeMarkdownForEcho(normalizeMarkdownForEcho(markdown))).toBe(normalizeMarkdownForEcho(markdown));
  });
});
