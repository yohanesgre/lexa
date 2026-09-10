// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { TipTapDoc } from "../../shared/types";
import { DescriptionEditor } from "./DescriptionEditor";

const fetchMock = vi.fn();
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

let queryClient: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  fetchMock.mockImplementation(() => Promise.resolve(json({ data: [] })));
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  queryClient.clear();
});

const DOC: TipTapDoc = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }],
};

describe("DescriptionEditor layouts", () => {
  it("wiki layout renders the label row above one card holding the toolbar", async () => {
    const onDone = vi.fn();
    const onCancel = vi.fn();
    const { container } = render(
      <DescriptionEditor
        initialContent={DOC}
        layout="wiki"
        onDone={onDone}
        onCancel={onCancel}
        placeholder="Add a description..."
      />,
      { wrapper }
    );

    expect(await screen.findByText("Editing description")).toBeInTheDocument();
    const editorWrapper = container.querySelector(".editor-wrapper");
    expect(editorWrapper).not.toBeNull();
    expect(editorWrapper!.querySelector(".editor-toolbar")).not.toBeNull();
    expect(container.querySelector(".task-editor-chrome")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Save and finish editing" }));
    expect(onDone).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Revert changes" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("band layout keeps the full-bleed chrome band", async () => {
    const { container } = render(
      <DescriptionEditor initialContent={DOC} layout="band" onDone={vi.fn()} onCancel={vi.fn()} />,
      { wrapper }
    );

    expect(await screen.findByText("Editing description")).toBeInTheDocument();
    expect(container.querySelector(".task-editor-chrome")).not.toBeNull();
    expect(container.querySelector(".task-editor-chrome .editor-toolbar")).not.toBeNull();
    expect(container.querySelector(".task-editor-host")).not.toBeNull();
  });

  it("Enter finishes and Escape reverts", async () => {
    const onDone = vi.fn();
    const onCancel = vi.fn();
    const { container } = render(
      <DescriptionEditor initialContent={DOC} layout="wiki" onDone={onDone} onCancel={onCancel} />,
      { wrapper }
    );

    await screen.findByText("Editing description");
    const proseMirror = container.querySelector(".ProseMirror");
    expect(proseMirror).not.toBeNull();

    fireEvent.keyDown(proseMirror!, { key: "Enter" });
    expect(onDone).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(proseMirror!, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
