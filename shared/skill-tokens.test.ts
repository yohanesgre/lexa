import { describe, expect, it } from "vitest";
import { parseSkillTokens, skillToken } from "./skill-tokens";

describe("skillToken", () => {
  it("normalizes display names to the canonical token form", () => {
    expect(skillToken("Status Report")).toBe("status-report");
    expect(skillToken("Definition of Done")).toBe("definition-of-done");
    expect(skillToken("polish")).toBe("polish");
  });

  it("collapses non-alphanumerics and trims leading/trailing dashes", () => {
    expect(skillToken("  Foo -- Bar  ")).toBe("foo-bar");
    expect(skillToken("--Foo--Bar--")).toBe("foo-bar");
    expect(skillToken("a_b.c/d")).toBe("a-b-c-d");
  });

  it("is empty for empty / non-alphanumeric input", () => {
    expect(skillToken("")).toBe("");
    expect(skillToken("  ")).toBe("");
    expect(skillToken("-_-")).toBe("");
  });
});

describe("parseSkillTokens", () => {
  it("parses, normalizes, dedupes and preserves order of appearance", () => {
    expect(parseSkillTokens("use $Status and $status-report, costs $5, $PATH is env")).toEqual([
      "status",
      "status-report",
      "path",
    ]);
  });

  it("never parses a non-letter first character (prices, positional args)", () => {
    expect(parseSkillTokens("costs $5 and $99")).toEqual([]);
    expect(parseSkillTokens("$1 $2 $3")).toEqual([]);
  });

  it("dedupes repeats of the same normalized token", () => {
    expect(parseSkillTokens("$Status then $status then $STATUS")).toEqual(["status"]);
  });

  it("requires a left boundary — a token embedded in a word stays prose", () => {
    expect(parseSkillTokens("email me at a$b")).toEqual([]);
  });

  it("returns nothing for a message without tokens", () => {
    expect(parseSkillTokens("no tokens here")).toEqual([]);
    expect(parseSkillTokens("")).toEqual([]);
    expect(parseSkillTokens("trailing dollar $")).toEqual([]);
  });

  it("accepts dashes inside the token but not a leading digit", () => {
    expect(parseSkillTokens("$status-report-2")).toEqual(["status-report-2"]);
    expect(parseSkillTokens("$2-status")).toEqual([]);
  });
});
