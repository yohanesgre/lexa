// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { TipTapDoc } from "../../shared/types";
import { renderDoc } from "./tiptap-render";

function docWith(mention: Record<string, unknown>): TipTapDoc {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: "see " }, { type: "mention", attrs: mention }],
      },
    ],
  };
}

describe("tiptap-render mention chips", () => {
  it("task mention links to the board deep-link with task-key anatomy", () => {
    render(<div>{renderDoc(docWith({ refType: "task", refId: "seed-task-f-01", label: "NIM-231" }), "task", "nimbus")}</div>);
    const chip = screen.getByRole("link", { name: "@NIM-231" });
    expect(chip).toHaveAttribute("href", "/nimbus/board?task=seed-task-f-01");
    expect(chip.className).toContain("mention-chip");
    expect(chip.querySelector(".task-key")).not.toBeNull();
  });

  it("wiki mention links to the wiki page route using the slug refId", () => {
    render(<div>{renderDoc(docWith({ refType: "wiki", refId: "api-reference", label: "API Reference" }), "wiki", "nimbus")}</div>);
    const chip = screen.getByRole("link", { name: "@API Reference" });
    expect(chip).toHaveAttribute("href", "/nimbus/wiki/api-reference");
  });

  it("rejects dangerous refIds — no href ever rendered (safe-href discipline)", () => {
    render(
      <div>
        {renderDoc(docWith({ refType: "task", refId: "javascript:alert(1)", label: "evil" }), "task", "nimbus")}
        {renderDoc(docWith({ refType: "wiki", refId: "//evil.example", label: "proto-relative" }), "wiki", "nimbus")}
      </div>
    );
    for (const label of ["@evil", "@proto-relative"]) {
      const el = screen.getByText(label);
      expect(el.closest("a")).toBeNull(); // chip without a link
      expect(el.closest("span.mention-chip")).not.toBeNull();
    }
    expect(document.querySelector('a[href*="javascript:"]')).toBeNull();
    expect(document.querySelector('a[href^="//"]')).toBeNull();
  });

  it("without a project slug the chip renders unlinked (share pages)", () => {
    render(<div>{renderDoc(docWith({ refType: "task", refId: "t1", label: "NIM-1" }), "task")}</div>);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("@NIM-1").closest("span.mention-chip")).not.toBeNull();
  });
});
