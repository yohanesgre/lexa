// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SharedWikiPage } from "../components/share/SharedWikiPage";
import { fetchSharedTree } from "../lib/share";

const child = {
  id: "w2", title: "Child", slug: "child",
  content: "",
  updatedAt: "2026-08-20T10:00:00.000Z", children: [],
};

const tree = {
  root: {
    id: "w1", title: "API Reference", slug: "home",
    content: "# API Reference",
    updatedAt: "2026-08-21T10:00:00.000Z",
    children: [child],
  },
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("fetchSharedTree", () => {
  it("returns null on 404 — no auth header ever attached", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false });
    vi.stubGlobal("fetch", fetchMock);
    expect(await fetchSharedTree("bad")).toBeNull();
    const headers = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]?.headers;
    expect(headers).toBeUndefined();
  });
});

describe("SharedWikiPage dead link", () => {
  it("does not retain document content when navigation leaves the shared subtree", () => {
    const scopedTree = { root: { ...tree.root, content: "Shared document body sentinel" } };
    const view = render(<SharedWikiPage tree={scopedTree} token="tok" />);
    expect(screen.getByText("Shared document body sentinel")).toBeInTheDocument();
    view.rerender(<SharedWikiPage tree={scopedTree} token="tok" pageId="not-in-tree" />);
    expect(screen.queryByText("Shared document body sentinel")).toBeNull();
  });
});
