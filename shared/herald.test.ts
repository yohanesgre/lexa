import { describe, expect, it } from "vitest";
import { deriveChatTitle } from "./herald";

describe("deriveChatTitle", () => {
  it("returns the text as-is when already clean and short", () => {
    expect(deriveChatTitle("Fix the login bug")).toBe("Fix the login bug");
  });

  it("collapses CRLF and newlines to single spaces", () => {
    expect(deriveChatTitle("line one\r\nline two\nline three")).toBe("line one line two line three");
  });

  it("collapses whitespace runs", () => {
    expect(deriveChatTitle("a \t b   c")).toBe("a b c");
  });

  it("trims leading/trailing whitespace", () => {
    expect(deriveChatTitle("  hello world  ")).toBe("hello world");
  });

  it("slices to 60 chars", () => {
    const long = "x".repeat(100);
    expect(deriveChatTitle(long)).toHaveLength(60);
    expect(deriveChatTitle(long)).toBe("x".repeat(60));
  });

  it("empty or whitespace-only input → empty string (caller stores NULL)", () => {
    expect(deriveChatTitle("")).toBe("");
    expect(deriveChatTitle("   \n\t ")).toBe("");
  });
});
