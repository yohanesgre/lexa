// @vitest-environment jsdom
// AssistantPopover — the assistant-only editor Generate popover shell
// (herald-popover.html). Renders the panel in a body portal when open; closed
// renders nothing.
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { Editor } from "@tiptap/core";

vi.mock("./AssistantPanel", () => ({
  AssistantPanel: (props: { slug: string; documentId: string }) => (
    <div data-testid="assistant-panel" data-slug={props.slug} data-document={props.documentId} />
  ),
}));

import { AssistantPopover } from "./AssistantPopover";

const editor = {} as Editor;

afterEach(() => cleanup());

describe("AssistantPopover", () => {
  it("renders the assistant panel in a portal marked data-assistant-popover", () => {
    render(
      <AssistantPopover
        editor={editor}
        slug="demo"
        documentType="task"
        documentId="t1"
        open
        onClose={vi.fn()}
        onReview={vi.fn()}
        reviewActive={false}
        anchorRect={null}
      />
    );
    const marker = document.querySelector("[data-assistant-popover]");
    expect(marker).not.toBeNull();
    expect(screen.getByTestId("assistant-panel")).toHaveAttribute("data-slug", "demo");
    expect(screen.getByTestId("assistant-panel")).toHaveAttribute("data-document", "t1");
  });

  it("renders nothing when closed", () => {
    render(
      <AssistantPopover
        editor={editor}
        slug="demo"
        documentType="task"
        documentId="t1"
        open={false}
        onClose={vi.fn()}
        onReview={vi.fn()}
        reviewActive={false}
        anchorRect={null}
      />
    );
    expect(document.querySelector("[data-assistant-popover]")).toBeNull();
    expect(screen.queryByTestId("assistant-panel")).not.toBeInTheDocument();
  });
});
