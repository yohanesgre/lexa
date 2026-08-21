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
  it("renders header badge, title, and child-pages nav from the payload", () => {
    render(<SharedWikiPage tree={tree} token="tok" />);
    expect(screen.getByText("Shared read-only")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("API Reference");
    expect(screen.getByText("Child pages")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Child/ })).toBeTruthy();
    expect(screen.getByText(/Last edited Aug 21, 2026 · Published via Lexa share link/)).toBeTruthy();
  });

  it("renders the not-found state for a dead link with attempted path readout", () => {
    render(<SharedWikiPage tree={null} token="x7f2k9" />);
    expect(screen.getByText("Page not available")).toBeTruthy();
    expect(screen.getByText(/invalid, has expired, or was revoked/)).toBeTruthy();
    expect(screen.getByText("/share/x7f2k9")).toBeTruthy();
    expect(screen.queryByText("Shared read-only")).toBeNull();
  });

  it("child click renders that child from the SAME payload — no second fetch", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<SharedWikiPage tree={tree} token="tok" />);
    fireEvent.click(screen.getByRole("button", { name: /Child/ }));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Child");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("emits a noindex robots meta", () => {
    render(<SharedWikiPage tree={tree} token="tok" />);
    expect(document.querySelector('meta[name="robots"][content="noindex"]')).toBeTruthy();
  });
});
