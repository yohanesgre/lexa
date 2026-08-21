import { describe, expect, it } from "vitest";
import { textEditorExtensions } from "./tiptap";

describe("textEditorExtensions", () => {
  it("exports the full extension stack", () => {
    expect(textEditorExtensions).toHaveLength(12);
    const names = textEditorExtensions.map((e) => e.name);
    expect(names).toEqual([
      "starterKit", "code", "underline", "highlight", "taskList", "taskItem",
      "image", "table", "tableRow", "tableHeader", "tableCell", "placeholder",
    ]);
  });

  it("StarterKit is configured with 2-5 heading levels and no bare code", () => {
    const starter = textEditorExtensions[0]!;
    const opts = (starter as unknown as { options: { heading?: { levels?: number[] }; link?: { openOnClick?: boolean }; code?: boolean } }).options;
    expect(opts.heading?.levels).toEqual([2, 3, 4, 5]);
    expect(opts.link?.openOnClick).toBe(false);
    expect(opts.code).toBe(false);
  });

  it("the code mark overrides the starter-kit exclusion so bold+code is valid", () => {
    const code = textEditorExtensions[1]!;
    expect(code.name).toBe("code");
    expect((code.config as { excludes?: string }).excludes).toBe("");
  });

  it("placeholder is configured with the starter text", () => {
    const placeholder = textEditorExtensions[11]!;
    expect(placeholder.name).toBe("placeholder");
    expect((placeholder as unknown as { options: { placeholder?: string } }).options.placeholder).toBe("Start writing...");
  });
});
