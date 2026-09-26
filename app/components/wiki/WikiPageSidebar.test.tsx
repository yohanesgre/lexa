// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import type { WikiPageMeta } from "../../../shared/types";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to: _to,
    params: _params,
    ...props
  }: { children?: ReactNode; to?: unknown; params?: unknown } & ComponentPropsWithoutRef<"a">) => (
    <a href="#" {...props}>{children}</a>
  ),
  useNavigate: () => vi.fn(),
}));

vi.mock("../../lib/queries", () => ({
  useSearchWikiPages: () => ({ data: [], isLoading: false, error: null, refetch: vi.fn() }),
}));

import { WikiPageSidebar } from "./WikiPageSidebar";

const page: WikiPageMeta = {
  id: "w1",
  projectId: "p1",
  title: "API Reference",
  slug: "api-reference",
  parentId: null,
  position: 0,
  updatedBy: null,
  updatedByName: null,
  updatedAt: "2026-08-20T10:00:00.000Z",
};

const child: WikiPageMeta = {
  ...page,
  id: "w2",
  title: "Combat",
  slug: "combat",
  parentId: "w1",
};

interface RenderOptions {
  activePageSlug?: string;
  expanded?: Set<string>;
  onToggleExpand?: (id: string) => void;
  onNavigate?: () => void;
}

function renderSidebar(
  pages: WikiPageMeta[] | undefined,
  error: unknown = null,
  onRetryPages: () => void = vi.fn(),
  options: RenderOptions = {}
) {
  return render(
    <WikiPageSidebar
      slug="demo"
      activePageSlug={options.activePageSlug}
      pages={pages}
      isLoading={false}
      error={error}
      onRetryPages={onRetryPages}
      contextMenuPageId={null}
      onContextMenu={vi.fn()}
      onNewPage={vi.fn()}
      onClose={vi.fn()}
      expanded={options.expanded ?? new Set()}
      onToggleExpand={options.onToggleExpand ?? vi.fn()}
      query=""
      onQueryChange={vi.fn()}
      searchFocused={false}
      onSearchFocusedChange={vi.fn()}
      onNavigate={options.onNavigate}
    />
  );
}

describe("WikiPageSidebar empty state", () => {
  it("hides the search box when the project has no pages", () => {
    renderSidebar([]);
    expect(screen.queryByText("Search wiki...")).toBeNull();
    expect(screen.getByText("000 Pages")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /new page/i })).toBeInTheDocument();
  });

  it("shows the search box when pages exist", () => {
    renderSidebar([page]);
    expect(screen.getByText("Search wiki...")).toBeInTheDocument();
    expect(screen.queryByText("000 Pages")).toBeNull();
  });
});

describe("WikiPageSidebar list error", () => {
  it("renders the wireframe error card, keeps the header + New page, and retries the pages query", () => {
    const refetch = vi.fn();
    renderSidebar(undefined, new Error("boom"), refetch);
    expect(screen.getByText("Failed to load pages")).toBeInTheDocument();
    expect(screen.getByText(/the pages query failed to load/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /new page/i })).toBeInTheDocument();
    expect(screen.queryByText("000 Pages")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});

describe("WikiPageSidebar tree semantics", () => {
  it("exposes tree/treeitem roles, levels, selection and the sibling chevron", () => {
    renderSidebar([page, child], null, vi.fn(), {
      activePageSlug: "combat",
      expanded: new Set(["w1"]),
    });

    const tree = screen.getByRole("tree", { name: "Wiki pages" });
    expect(tree).toBeInTheDocument();

    const items = screen.getAllByRole("treeitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveAttribute("aria-level", "1");
    expect(items[0]).toHaveAttribute("aria-expanded", "true");
    expect(items[0]).toHaveAttribute("aria-selected", "false");
    expect(items[1]).toHaveAttribute("aria-level", "2");
    expect(items[1]).toHaveAttribute("aria-selected", "true");
    expect(items[1]).toHaveAttribute("aria-current", "page");

    expect(screen.getByRole("button", { name: "Collapse API Reference" })).toBeInTheDocument();
  });

  it("moves focus with arrows, Home/End and collapses with ArrowLeft", () => {
    const onToggleExpand = vi.fn();
    renderSidebar([page, child], null, vi.fn(), {
      expanded: new Set(["w1"]),
      onToggleExpand,
    });

    const items = screen.getAllByRole("treeitem");
    act(() => items[0]!.focus());
    expect(document.activeElement).toBe(items[0]);

    fireEvent.keyDown(items[0]!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);

    fireEvent.keyDown(items[1]!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(items[0]);

    fireEvent.keyDown(items[0]!, { key: "End" });
    expect(document.activeElement).toBe(items[1]);

    fireEvent.keyDown(items[1]!, { key: "Home" });
    expect(document.activeElement).toBe(items[0]);

    fireEvent.keyDown(items[0]!, { key: "ArrowLeft" });
    expect(onToggleExpand).toHaveBeenCalledWith("w1");
  });

  it("moves into a child with ArrowRight and back to the parent with ArrowLeft", () => {
    renderSidebar([page, child], null, vi.fn(), { expanded: new Set(["w1"]) });

    const items = screen.getAllByRole("treeitem");
    act(() => items[0]!.focus());

    fireEvent.keyDown(items[0]!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(items[1]);

    fireEvent.keyDown(items[1]!, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(items[0]);
  });

  it("activates the row link with Enter and Space", () => {
    const onNavigate = vi.fn();
    renderSidebar([page], null, vi.fn(), { onNavigate });

    const item = screen.getByRole("treeitem");
    act(() => item.focus());
    fireEvent.keyDown(item, { key: "Enter" });
    fireEvent.keyDown(item, { key: " " });
    expect(onNavigate).toHaveBeenCalledTimes(2);
  });
});
