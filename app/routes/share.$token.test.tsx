// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SharedWikiPage, fetchSharedTree } from "./share.$token";

const child = {
  id: "w2", title: "Child", slug: "child",
  content: { type: "doc" as const, content: [] },
  updatedAt: "2026-08-20T10:00:00.000Z", children: [],
};

const tree = {
  root: {
    id: "w1", title: "API Reference", slug: "home",
    content: { type: "doc" as const, content: [] },
    updatedAt: "2026-08-21T10:00:00.000Z",
    children: [child],
  },
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("fetchSharedTree", () => {
  it("returns the payload on 200", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => tree }));
    expect(await fetchSharedTree("tok")).toEqual(tree);
    expect(fetch).toHaveBeenCalledWith("/api/share/tok");
  });

  it("returns null on 404 — no auth header ever attached", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false });
    vi.stubGlobal("fetch", fetchMock);
    expect(await fetchSharedTree("bad")).toBeNull();
    const headers = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]?.headers;
    expect(headers).toBeUndefined();
  });
});

describe("SharedWikiPage", () => {
  it("renders header badge, title, and child-pages sidebar from the payload", () => {
    render(<SharedWikiPage tree={tree} token="tok" />);
    expect(screen.getByText("Shared read-only")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("API Reference");
    expect(screen.getByLabelText("Child pages")).toBeTruthy();
    // Sidebar lists the whole subtree — root row first, then children.
    const rootRow = screen.getByRole("button", { name: "API Reference" });
    expect(rootRow.getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("button", { name: "Child" })).toBeTruthy();
    expect(screen.getByText(/Last edited Aug 21, 2026 · Published via Lexa share link/)).toBeTruthy();
  });

  it("renders the not-found state for a dead link with attempted path readout", () => {
    render(<SharedWikiPage tree={null} token="x7f2k9" />);
    expect(screen.getByText("Page not available")).toBeTruthy();
    expect(screen.getByText(/invalid, has expired, or was revoked/)).toBeTruthy();
    expect(screen.getByText("/share/x7f2k9")).toBeTruthy();
    expect(screen.queryByText("Shared read-only")).toBeNull();
  });

  it("child click reports selection via onSelectPage — no second fetch", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const onSelectPage = vi.fn();
    render(<SharedWikiPage tree={tree} token="tok" onSelectPage={onSelectPage} />);
    fireEvent.click(screen.getByRole("button", { name: /Child/ }));
    expect(onSelectPage).toHaveBeenCalledWith("w2");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("pageId prop selects the rendered node (URL param drives deep links + Back)", () => {
    render(<SharedWikiPage tree={tree} token="tok" pageId="w2" />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Child");
    // Sidebar keeps the whole subtree visible; the selected row is marked.
    expect(screen.getByRole("button", { name: "Child" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("button", { name: "API Reference" }).getAttribute("aria-current")).toBeNull();
  });

  it("sidebar collapses to an icon rail and expands again", () => {
    render(<SharedWikiPage tree={tree} token="tok" />);
    expect(screen.getByRole("navigation", { name: "Child pages" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    expect(screen.queryByRole("navigation", { name: "Child pages" })).toBeNull();
    expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
    expect(screen.getByRole("navigation", { name: "Child pages" })).toBeTruthy();
  });

  it("emits a noindex robots meta", () => {
    render(<SharedWikiPage tree={tree} token="tok" />);
    expect(document.querySelector('meta[name="robots"][content="noindex"]')).toBeTruthy();
  });

  it("theme toggle flips data-theme on the document", () => {
    localStorage.setItem("lexa:theme", "dark");
    render(<SharedWikiPage tree={tree} token="tok" />);
    const toggle = screen.getByRole("button", { name: "Switch to light theme" });
    fireEvent.click(toggle);
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(localStorage.getItem("lexa:theme")).toBe("light");
    expect(screen.getByRole("button", { name: "Switch to dark theme" })).toBeTruthy();
  });

  it("renders an empty page (content:{}) without crashing", () => {
    const emptyTree = {
      root: {
        id: "w9", title: "Empty", slug: "empty",
        content: {},
        updatedAt: "2026-08-21T10:00:00.000Z",
        children: [],
      },
    };
    render(<SharedWikiPage tree={emptyTree} token="tok" />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Empty");
  });

  it("fetch rejection resolves to the dead-link state, never a blank page", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    await expect(fetchSharedTree("tok")).resolves.toBeNull();
  });
});
