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
    expect(fetchMock.mock.calls[0][0]).toBe("/api/herald/chats/p1");
    await api.listHeraldChats("p1", "  runbook ");
    expect(fetchMock.mock.calls[1][0]).toBe("/api/herald/chats/p1?q=runbook");
    await api.listHeraldChats("p1", "   ");
    expect(fetchMock.mock.calls[2][0]).toBe("/api/herald/chats/p1");
  });

  it("updateHeraldChatMeta PATCHes {title?, pinned?}", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ chatId: "c1", pinned: true }), { status: 200 }));
    await api.updateHeraldChatMeta("c1", { pinned: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/herald/chat/c1");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({ pinned: true });
  });

  it("exportHeraldChat downloads the markdown attachment (filename from Content-Disposition)", async () => {
    stubObjectUrls();
    let clicked = false;
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicked = true;
      expect(this.download).toBe("rollback-runbook.md");
    });
    fetchMock.mockResolvedValue(
      new Response("# Thread\n\nhello", {
        status: 200,
        headers: { "Content-Type": "text/markdown", "Content-Disposition": 'attachment; filename="rollback-runbook.md"' },
      })
    );
    await api.exportHeraldChat("c1");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/herald/chat/c1/export");
    expect(clicked).toBe(true);
    clickSpy.mockRestore();
  });

  it("exportHeraldChat falls back to a chatId filename and surfaces error codes", async () => {
    stubObjectUrls();
    let downloadName = "";
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      downloadName = this.download;
    });
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "HERALD_TASK_ACTIVE", message: "busy" } }), { status: 409 })
    );
    await expect(api.exportHeraldChat("c2")).rejects.toMatchObject({ code: "HERALD_TASK_ACTIVE" });
    fetchMock.mockResolvedValue(new Response("# ok", { status: 200, headers: { "Content-Type": "text/markdown" } }));
    await api.exportHeraldChat("c3");
    expect(downloadName).toBe("herald-chat-c3.md");
    clickSpy.mockRestore();
  });
});
