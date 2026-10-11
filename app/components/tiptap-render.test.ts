import { describe, expect, it } from "vitest";
import { planHeadings, type TTNode } from "./tiptap-render";

function headingsDoc(texts: string[]): TTNode {
  return {
    type: "doc",
    content: texts.map((text) => ({
      type: "heading",
      attrs: { level: 2 },
      content: [{ type: "text", text }],
    })),
  };
}

describe("planHeadings", () => {
  it("keeps a heading that repeats the reserved page title addressable on its own", () => {
    const titleId = "release-checklist";
    const { headings } = planHeadings(headingsDoc(["Release Checklist", "Rollback"]), [titleId]);
    const all = [titleId, ...headings.map((heading) => heading.id)];
    expect(new Set(all).size).toBe(all.length);
    expect(headings[0]!.id).not.toBe(titleId);
    expect(headings[1]!.text).toBe("Rollback");
    expect(headings[1]!.id).toBe("rollback");
  });

  it("keeps three headings of the same name apart", () => {
    const { headings } = planHeadings(headingsDoc(["Retro", "Retro", "Retro"]));
    const ids = headings.map((heading) => heading.id);
    expect(new Set(ids).size).toBe(3);
  });
});
