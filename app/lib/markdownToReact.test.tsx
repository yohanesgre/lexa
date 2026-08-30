// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { MarkdownContent } from "./markdownToReact";

function mount(md: string, opts?: { renderText?: (text: string) => ReactNode; trailing?: ReactNode }) {
  const { container } = render(<MarkdownContent md={md} {...opts} />);
  // MarkdownContent renders a fragment — blocks land as direct children.
  return container;
}

describe("markdownToReact", () => {
  it("bold/emphasis render as elements, not literal asterisks", () => {
    const root = mount("**bold** and *em* text");
    expect(root.querySelector("strong")?.textContent).toBe("bold");
    expect(root.querySelector("em")?.textContent).toBe("em");
    expect(root.textContent).not.toContain("**");
    expect(root.textContent).not.toContain("*em*");
  });
  it("lists: unordered, ordered, nested task checkboxes", () => {
    const ul = mount("- one\n- two");
    expect(ul.querySelectorAll("ul > li")).toHaveLength(2);

    const ol = mount("1. first\n2. second");
    expect(ol.querySelectorAll("ol > li")).toHaveLength(2);

    const tasks = mount("- [ ] open\n- [x] done");
    const boxes = tasks.querySelectorAll('input[type="checkbox"]');
    expect(boxes).toHaveLength(2);
    expect(boxes[0]).not.toBeChecked();
    expect(boxes[1]).toBeChecked();
  });
});
