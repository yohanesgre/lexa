// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import type { WikiPageMeta } from "../../../shared/types";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, className }: { children: ReactNode; className?: string }) => <a className={className}>{children}</a>,
}));

import { WikiSearchResults } from "./WikiSearchResults";

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

function renderResults(props: {
  query?: string;
  results?: (WikiPageMeta & { snippet: string })[];
  searching?: boolean;
  error?: boolean;
  onRetry?: () => void;
} = {}) {
  return render(
    <WikiSearchResults
      query={props.query ?? "pagination"}
      results={props.results ?? []}
      searching={props.searching ?? false}
      error={props.error ?? false}
      slug="demo"
      pagesById={new Map([["w1", page]])}
      onRetry={props.onRetry ?? vi.fn()}
    />
  );
}

describe("WikiSearchResults states", () => {
  it("renders the searching skeleton with the aria-live count", () => {
    renderResults({ searching: true });
    expect(screen.getByRole("status")).toHaveTextContent("Searching…");
    expect(document.querySelectorAll(".skeleton")).toHaveLength(5);
  });

  it("renders the no-results empty state echoing the query", () => {
    renderResults({ query: "zzzz" });
    expect(screen.getByText("000 Results")).toBeInTheDocument();
    expect(screen.getByText("No results for “zzzz”")).toBeInTheDocument();
    expect(screen.getByText("Try a shorter term or check the spelling.")).toBeInTheDocument();
  });

  it("renders the search-error block and retries", () => {
    const onRetry = vi.fn();
    renderResults({ error: true, onRetry });
    expect(screen.getByText("Search unavailable")).toBeInTheDocument();
    expect(screen.getByText("Couldn’t search")).toBeInTheDocument();
    expect(screen.getByText("The search index didn’t respond.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("renders the padded result count and rows", () => {
    renderResults({ results: [{ ...page, snippet: "…**pagination**…" }] });
    expect(screen.getByText("001 Results")).toBeInTheDocument();
    expect(screen.getByText("API Reference")).toBeInTheDocument();
    expect(screen.getByText("pagination")).toBeInTheDocument();
  });
});
