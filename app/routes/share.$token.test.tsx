// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SharedWikiPage } from "./share.$token";
import { fetchSharedTree } from "../lib/share";

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
