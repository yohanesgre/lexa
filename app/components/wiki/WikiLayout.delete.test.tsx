// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { WikiPageMeta } from "../../../shared/types";
import { stubMatchMedia } from "../../test-utils";
import { WikiLayout } from "./WikiLayout";

const deleteMock = vi.hoisted(() => ({ mutateAsync: vi.fn(), isPending: false }));
const navigateMock = vi.hoisted(() => vi.fn());
const wikiState = vi.hoisted(() => ({ pages: [] as WikiPageMeta[], refetch: vi.fn() }));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children?: ReactNode }) => <a>{children}</a>,
  useNavigate: () => navigateMock,
}));

vi.mock("../../lib/queries", () => ({
  useWikiPages: () => ({ data: wikiState.pages, isLoading: false, error: null, refetch: wikiState.refetch }),
  useDeleteWikiPage: () => deleteMock,
  useSearchWikiPages: () => ({ data: [], isLoading: false }),
  useUpdateWikiPage: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

const parent: WikiPageMeta = {
  id: "p1",
  projectId: "proj",
  title: "Parent",
  slug: "parent",
  parentId: null,
  position: 0,
  updatedBy: null,
  updatedByName: null,
  updatedAt: "2026-08-20T10:00:00.000Z",
};

const child: WikiPageMeta = { ...parent, id: "c1", title: "Child", slug: "child", parentId: "p1", position: 1 };

function renderLayout(activePageSlug: string) {
  return render(
    <WikiLayout slug="demo" activePageSlug={activePageSlug}>
      {() => <div>content</div>}
    </WikiLayout>
  );
}

function openDeleteOnFirstRow() {
  fireEvent.contextMenu(screen.getAllByRole("treeitem")[0]!);
  fireEvent.click(screen.getByRole("menuitem", { name: /Delete/ }));
}

beforeEach(() => {
  stubMatchMedia(true);
  window.localStorage.clear();
  deleteMock.mutateAsync.mockReset();
  navigateMock.mockReset();
});

describe("WikiLayout delete flow", () => {
  it("blocks deleting a page with children and explains why", () => {
    wikiState.pages = [parent, child];
    renderLayout("parent");
    openDeleteOnFirstRow();

    expect(screen.getByText(/has child pages/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
    expect(deleteMock.mutateAsync).not.toHaveBeenCalled();
  });

  it("navigates away only after the delete resolves", async () => {
    wikiState.pages = [parent];
    let resolveDelete!: () => void;
    deleteMock.mutateAsync.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveDelete = resolve;
      })
    );
    renderLayout("parent");
    openDeleteOnFirstRow();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(deleteMock.mutateAsync).toHaveBeenCalledWith("parent"));
    expect(navigateMock).not.toHaveBeenCalled();

    act(() => resolveDelete());
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith({ to: "/$slug/wiki", params: { slug: "demo" } }));
  });
});
