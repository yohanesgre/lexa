import { describe, it, expect } from "vitest";
import { safeHref, safeRelativeHref } from "./safe-href";

describe("safeHref", () => {
  it("allows http, https, mailto", () => {
    expect(safeHref("https://example.com/x")).toBe("https://example.com/x");
    expect(safeHref("http://example.com")).toBe("http://example.com");
    expect(safeHref("mailto:a@b.c")).toBe("mailto:a@b.c");
    expect(safeHref("HTTPS://EXAMPLE.COM")).toBe("HTTPS://EXAMPLE.COM");
  });

  it("drops javascript:, data:, vbscript: and other schemes", () => {
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("JaVaScRiPt:alert(1)")).toBeNull();
    expect(safeHref("data:text/html,<script>1</script>")).toBeNull();
    expect(safeHref("vbscript:msgbox(1)")).toBeNull();
    expect(safeHref("  javascript:alert(1)  ")).toBeNull(); // whitespace-padded
  });

  it("drops non-strings and empties", () => {
    expect(safeHref(null)).toBeNull();
    expect(safeHref(undefined)).toBeNull();
    expect(safeHref(42)).toBeNull();
    expect(safeHref("")).toBeNull();
    expect(safeHref("   ")).toBeNull();
  });
});

describe("safeRelativeHref", () => {
  it("accepts same-origin root-relative paths", () => {
    expect(safeRelativeHref("/demo/wiki/child")).toBe("/demo/wiki/child");
    expect(safeRelativeHref("/demo/wiki/child?x=1#h")).toBe("/demo/wiki/child?x=1#h");
    expect(safeRelativeHref("  /demo/wiki/child  ")).toBe("/demo/wiki/child");
  });

  it("rejects protocol-relative and backslash-smuggled origins", () => {
    expect(safeRelativeHref("//evil.example/x")).toBeNull();
    expect(safeRelativeHref("/\\evil.example")).toBeNull();
  });

  it("still accepts http(s)/mailto and drops other schemes", () => {
    expect(safeRelativeHref("https://example.com/x")).toBe("https://example.com/x");
    expect(safeRelativeHref("mailto:a@b.c")).toBe("mailto:a@b.c");
    expect(safeRelativeHref("javascript:alert(1)")).toBeNull();
    expect(safeRelativeHref("data:text/html,<script>1</script>")).toBeNull();
    expect(safeRelativeHref(null)).toBeNull();
    expect(safeRelativeHref("")).toBeNull();
  });
});
