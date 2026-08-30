// @vitest-environment jsdom
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import * as api from "./api";

const fetchMock = vi.fn();

// jsdom has no object-URL implementation — swap in stubs for the download path.
function stubObjectUrls() {
  const create = vi.fn(() => "blob:x");
  const revoke = vi.fn();
  Object.defineProperty(URL, "createObjectURL", { value: create, configurable: true });
  Object.defineProperty(URL, "revokeObjectURL", { value: revoke, configurable: true });
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("herald chat api", () => {
  it("listHeraldChats appends ?q= only for non-empty queries", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 })));
    await api.listHeraldChats("p1");
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/herald/chats/p1");
    await api.listHeraldChats("p1", "  runbook ");
    expect(fetchMock.mock.calls[1]![0]).toBe("/api/herald/chats/p1?q=runbook");
    await api.listHeraldChats("p1", "   ");
    expect(fetchMock.mock.calls[2]![0]).toBe("/api/herald/chats/p1");
  });
  it("updateHeraldChatMeta PATCHes {title?, pinned?}", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ chatId: "c1", pinned: true }), { status: 200 }));
    await api.updateHeraldChatMeta("c1", { pinned: true });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/herald/chat/c1");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({ pinned: true });
  });
});
