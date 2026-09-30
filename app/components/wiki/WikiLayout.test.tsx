// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { WikiPageMeta } from "../../../shared/types";
import { stubMatchMedia } from "../../test-utils";
import { WikiLayout } from "./WikiLayout";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children?: ReactNode }) => <a>{children}</a>,
  useNavigate: () => vi.fn(),
}));

const wikiState = vi.hoisted(() => ({ pages: [] as WikiPageMeta[], refetch: vi.fn() }));

vi.mock("../../lib/queries", () => ({
  useWikiPages: () => ({ data: wikiState.pages, isLoading: false, error: null, refetch: wikiState.refetch }),
  useDeleteWikiPage: () => ({ mutate: vi.fn(), isPending: false }),
  useSearchWikiPages: () => ({ data: [], isLoading: false }),
  useUpdateWikiPage: () => ({ mutate: vi.fn(), isPending: false }),
}));

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

function stubViewport(isDesktop: boolean) {
  stubMatchMedia(isDesktop);
}

function renderLayout() {
  return render(
    <WikiLayout slug="demo">
      {() => <div>content</div>}
    </WikiLayout>
  );
}

describe("WikiLayout sidebar state", () => {
  beforeEach(() => {
    window.localStorage.clear();
    wikiState.pages = [];
    wikiState.refetch.mockClear();
    vi.unstubAllGlobals();
  });

  it("renders the desktop tree inline with no overlay or scroll lock", () => {
    stubViewport(true);
    renderLayout();
    expect(document.querySelector("#wiki-sidebar")).toBeInTheDocument();
    expect(document.querySelector(".wiki-sidebar-backdrop")).toBeNull();
    expect(document.body.getAttribute("data-scroll-lock")).toBeNull();
  });

  it("starts closed with no overlay on mobile first paint", () => {
    stubViewport(false);
    renderLayout();
    expect(document.querySelector(".wiki-sidebar-open")).toBeNull();
    expect(document.querySelector(".wiki-sidebar-rail")).toBeInTheDocument();
    expect(document.querySelector(".wiki-sidebar-backdrop")).toBeNull();
    expect(document.body.getAttribute("data-scroll-lock")).toBeNull();
  });

  it("opens the mobile overlay with scrim + scroll lock and closes on Escape", () => {
    stubViewport(false);
    renderLayout();
    act(() => {
      window.dispatchEvent(new CustomEvent("lexa:toggle-wiki-sidebar"));
    });
    expect(document.querySelector(".wiki-sidebar-open")).toBeInTheDocument();
    expect(document.querySelector(".wiki-sidebar-backdrop")).toBeInTheDocument();
    expect(document.body.getAttribute("data-scroll-lock")).toBe("true");

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(document.querySelector(".wiki-sidebar-open")).toBeNull();
    expect(document.querySelector(".wiki-sidebar-backdrop")).toBeNull();
    expect(document.body.getAttribute("data-scroll-lock")).toBeNull();
  });

  it("keeps desktop intent across a remount", () => {
    stubViewport(true);
    const first = renderLayout();
    act(() => {
      window.dispatchEvent(new CustomEvent("lexa:toggle-wiki-sidebar"));
    });
    expect(document.querySelector(".wiki-sidebar-rail")).toBeInTheDocument();
    expect(document.body.getAttribute("data-scroll-lock")).toBeNull();

    first.unmount();
    renderLayout();
    expect(document.querySelector(".wiki-sidebar-rail")).toBeInTheDocument();
    expect(document.querySelector(".wiki-sidebar-open")).toBeNull();
  });

  it("returns focus to the originating row when the context menu closes on Escape", () => {
    stubViewport(true);
    wikiState.pages = [page];
    renderLayout();

    const row = screen.getByRole("treeitem");
    fireEvent.contextMenu(row);
    expect(screen.getByRole("menu", { name: "Page actions" })).toBeInTheDocument();

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(document.activeElement).toBe(row);
  });
});
