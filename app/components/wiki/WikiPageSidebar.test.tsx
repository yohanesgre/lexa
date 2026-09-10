// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import type { WikiPageMeta } from "../../../shared/types";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, className }: { children: ReactNode; className?: string }) => <a className={className}>{children}</a>,
  useNavigate: () => vi.fn(),
}));

vi.mock("../../lib/queries", () => ({
  useSearchWikiPages: () => ({ data: [], isLoading: false }),
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

function renderSidebar(pages: WikiPageMeta[] | undefined) {
  return render(
    <WikiPageSidebar
      slug="demo"
      pages={pages}
      isLoading={false}
      error={null}
      contextMenuPageId={null}
      onContextMenu={vi.fn()}
      onNewPage={vi.fn()}
      onClose={vi.fn()}
      expanded={new Set()}
      onToggleExpand={vi.fn()}
      query=""
      onQueryChange={vi.fn()}
      searchFocused={false}
      onSearchFocusedChange={vi.fn()}
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
