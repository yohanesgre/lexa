import { describe, expect, it } from "vitest";
import type { TipTapDoc } from "../../shared/types";
import { buildWikiEditDiff } from "./write-tools";

// Criterion: the approval-display contract (docs/LAYERS.md → write tools, "the
// diff is what the approver sees"). A wiki page longer than the old 2,000-char
// preview cap must arrive at the approval card whole on both sides — the card
// scrolls it rather than cutting it. Regression guard for the owner report that
// a long page's proposal was shown truncated.

const doc = (...text: string[]): TipTapDoc => ({
  type: "doc",
  content: text.map((t) => ({ type: "paragraph", content: [{ type: "text", text: t }] })),
});

describe("buildWikiEditDiff", () => {
  it("carries a page over 2,000 characters whole on both sides", () => {
    const before = "b".repeat(2500);
    const after = "a".repeat(2600);
    const diff = buildWikiEditDiff({ slug: "intro", title: "Intro", text: before }, { title: "Intro v2", content: doc(after) });
    expect(diff.beforeText).toBe(before);
    expect(diff.afterText).toBe(after);
    expect(diff.title).toBe("Intro v2");
  });

  it("falls back to the page title and projects an empty doc as ''", () => {
    const diff = buildWikiEditDiff({ slug: "intro", title: "Intro", text: "" }, { content: { type: "doc", content: [] } });
    expect(diff.title).toBe("Intro");
    expect(diff.afterText).toBe("");
  });
});
