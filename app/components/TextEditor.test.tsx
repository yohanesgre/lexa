// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TextEditor } from "./TextEditor";
import { DescriptionEditor } from "./DescriptionEditor";
import type { TipTapDoc } from "../../shared/types";

function makeClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

const DOC: TipTapDoc = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "hello world" }] }],
};

// Render-only smoke: TipTap editors mount in jsdom with an empty ProseMirror
// node — no interaction tests (flaky in jsdom, established in the prior phase).
describe("TextEditor", () => {
  it("mounts without crashing and renders the toolbar", async () => {
    render(
      <QueryClientProvider client={makeClient()}>
        <TextEditor initialContent={DOC} />
      </QueryClientProvider>
    );
    await waitFor(() => expect(document.querySelector(".ProseMirror")).not.toBeNull());
    expect(screen.getByRole("button", { name: "Bold" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Italic" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Heading 2" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Bullet list" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Link" })).toBeInTheDocument();
  });

  it("disables the Hearth button when no hearth config is provided", async () => {
    render(
      <QueryClientProvider client={makeClient()}>
        <TextEditor initialContent={DOC} />
      </QueryClientProvider>
    );
    await waitFor(() => expect(document.querySelector(".ProseMirror")).not.toBeNull());
    expect(screen.getByRole("button", { name: "Hearth AI writing assistant" })).toBeDisabled();
  });
});

describe("DescriptionEditor", () => {
  it("mounts without crashing in editable mode", async () => {
    const onChange = () => {};
    render(
      <QueryClientProvider client={makeClient()}>
        <DescriptionEditor initialContent={DOC} onChange={onChange} />
      </QueryClientProvider>
    );
    await waitFor(() => expect(document.querySelector(".ProseMirror")).not.toBeNull());
    expect(screen.getByRole("button", { name: "Bold" })).toBeInTheDocument();
  });
});
