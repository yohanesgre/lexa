// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { TextEditor } from "./TextEditor";
import { DescriptionEditor } from "./DescriptionEditor";
import type { TipTapDoc } from "../../shared/types";

const DOC: TipTapDoc = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "hello world" }] }],
};

// Render-only smoke: TipTap editors mount in jsdom with an empty ProseMirror
// node — no interaction tests (flaky in jsdom, established in the prior phase).
describe("TextEditor", () => {
  it("mounts without crashing and renders the toolbar", async () => {
    render(<TextEditor initialContent={DOC} />);
    await waitFor(() => expect(document.querySelector(".ProseMirror")).not.toBeNull());
    expect(screen.getByRole("button", { name: "Bold" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Italic" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Heading 2" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Bullet list" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Link" })).toBeInTheDocument();
  });

  it("disables the Forge button when no forge config is provided", async () => {
    render(<TextEditor initialContent={DOC} />);
    await waitFor(() => expect(document.querySelector(".ProseMirror")).not.toBeNull());
    expect(screen.getByRole("button", { name: "Forge AI writing assistant" })).toBeDisabled();
  });
});

describe("DescriptionEditor", () => {
  it("mounts without crashing in editable mode", async () => {
    const onChange = () => {};
    render(<DescriptionEditor initialContent={DOC} onChange={onChange} />);
    await waitFor(() => expect(document.querySelector(".ProseMirror")).not.toBeNull());
    expect(screen.getByRole("button", { name: "Bold" })).toBeInTheDocument();
  });
});
