import { describe, it, expect } from "vitest";
import { extractText } from "./tiptap-text";
import type { TipTapDoc } from "./types";

describe("extractText", () => {
  it("extracts heading + paragraph + list", () => {
    const doc: TipTapDoc = {
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 1 },
          content: [{ type: "text", text: "Hello World" }],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "This is a paragraph." }],
        },
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "First item" }],
                },
              ],
            },
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "Second item" }],
                },
              ],
            },
          ],
        },
      ],
    };

    expect(extractText(doc)).toBe(
      "Hello World\nThis is a paragraph.\nFirst item\nSecond item"
    );
  });

  it("returns empty string for nullish or content-less doc", () => {
    expect(extractText(null as unknown as TipTapDoc)).toBe("");
    expect(extractText({ type: "doc", content: [] })).toBe("");
  });

  it("handles inline marks without extra newlines", () => {
    const doc: TipTapDoc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Hello " },
            { type: "text", marks: [{ type: "bold" }], text: "bold" },
            { type: "text", text: " world" },
          ],
        },
      ],
    };
    expect(extractText(doc)).toBe("Hello bold world");
  });

  it("skips unknown node types gracefully", () => {
    const doc: TipTapDoc = {
      type: "doc",
      content: [
        {
          type: "customBlock",
          content: [{ type: "text", text: "inside" }],
        },
      ],
    };
    expect(extractText(doc)).toBe("inside");
  });

  it("handles nested ordered list", () => {
    const doc: TipTapDoc = {
      type: "doc",
      content: [
        {
          type: "orderedList",
          attrs: { start: 1 },
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "A" }],
                },
              ],
            },
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "B" }],
                },
              ],
            },
          ],
        },
      ],
    };
    expect(extractText(doc)).toBe("A\nB");
  });
});
