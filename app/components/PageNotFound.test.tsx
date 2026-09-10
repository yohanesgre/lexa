// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import type { WikiPageMeta } from "../../shared/types";

vi.mock("@tanstack/react-router", () => ({
  useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => unknown }) =>
    select({ location: { pathname: "/emberfall/sprnt-7" } }),
  Link: ({
    to,
    params,
    className,
    children,
  }: {
    to: string;
    params?: Record<string, string> | undefined;
    className?: string | undefined;
    children: ReactNode;
  }) => (
    <a href={to} data-params={params ? JSON.stringify(params) : undefined} className={className}>
      {children}
    </a>
  ),
}));

import { PageNotFound } from "./PageNotFound";
import { WikiPageNotFound } from "./wiki/WikiPageNotFound";

describe("PageNotFound", () => {
  it("shows the heading and always links back to the dashboard", () => {
    render(<PageNotFound />);
    expect(screen.getByRole("heading", { name: "Page not found" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Back to Dashboard/ })).toHaveAttribute("href", "/");
  });

  it("prints the attempted pathname", () => {
    render(<PageNotFound />);
    expect(screen.getByText(/GET \/emberfall\/sprnt-7 → NO MATCH/)).toBeInTheDocument();
  });
});

describe("WikiPageNotFound", () => {
  it("shows the heading and the attempted slug", () => {
    render(<WikiPageNotFound slug="emberfall" pageSlug="missing-page" />);
    expect(screen.getByRole("heading", { name: "Page not found" })).toBeInTheDocument();
    expect(screen.getByText("/wiki/missing-page")).toBeInTheDocument();
  });

  it("links to the first loaded page and hides the action when there are none", () => {
    const pages: WikiPageMeta[] = [
      {
        id: "p2",
        projectId: "pr1",
        title: "Second",
        slug: "second",
        parentId: null,
        position: 1,
        updatedBy: null,
        updatedByName: null,
        updatedAt: "2026-08-21T10:00:00.000Z",
      },
      {
        id: "p1",
        projectId: "pr1",
        title: "Home",
        slug: "home",
        parentId: null,
        position: 0,
        updatedBy: null,
        updatedByName: null,
        updatedAt: "2026-08-21T10:00:00.000Z",
      },
    ];
    const { rerender } = render(
      <WikiPageNotFound slug="emberfall" pageSlug="missing-page" pages={pages} />,
    );
    const first = screen.getByRole("link", { name: "Go to first page" });
    expect(first).toHaveAttribute("data-params", JSON.stringify({ slug: "emberfall", pageSlug: "home" }));

    rerender(<WikiPageNotFound slug="emberfall" pageSlug="missing-page" pages={[]} />);
    expect(screen.queryByRole("link", { name: "Go to first page" })).toBeNull();
  });
});
