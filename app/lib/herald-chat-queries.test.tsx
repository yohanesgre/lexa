// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { HeraldChatThreadSummary } from "./api";

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return {
    ...actual,
    listHeraldChats: vi.fn(),
    updateHeraldChatMeta: vi.fn(),
    resetHeraldChat: vi.fn(),
  };
});

import * as api from "./api";
import { useHeraldChatList, useRenameHeraldChat, useDeleteHeraldChat, useUpdateHeraldChatMeta } from "./queries";

const mockedApi = vi.mocked(api);

const THREADS: HeraldChatThreadSummary[] = [
  { chatId: "c1", title: "Payments migration questions", pinned: false, snippet: null, createdAt: "2026-08-22T09:00:00Z", updatedAt: "2026-08-22T10:00:00Z" },
  { chatId: "c2", title: null, pinned: true, snippet: null, createdAt: "2026-08-21T09:00:00Z", updatedAt: "2026-08-21T11:00:00Z" },
];

function makeWrapper(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useHeraldChatList", () => {
  it("fetches the thread list once projectId exists", async () => {
    mockedApi.listHeraldChats.mockResolvedValue({ data: THREADS });
    const qc = new QueryClient();
    const { result } = renderHook(() => useHeraldChatList("p1"), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(result.current.data).toHaveLength(2));
    expect(mockedApi.listHeraldChats).toHaveBeenCalledWith("p1", undefined);
  });

  it("passes a trimmed ?q= and keys the cache per query", async () => {
    mockedApi.listHeraldChats.mockResolvedValue({ data: [] });
    const qc = new QueryClient();
    const { result, rerender } = renderHook(({ q }) => useHeraldChatList("p1", q), {
      wrapper: makeWrapper(qc),
      initialProps: { q: "  runbook  " },
    });
    await waitFor(() => expect(mockedApi.listHeraldChats).toHaveBeenCalledWith("p1", "runbook"));
    expect(qc.getQueryData(["herald-chats", "p1", "runbook"])).toEqual([]);

    rerender({ q: "" });
    await waitFor(() => expect(mockedApi.listHeraldChats).toHaveBeenCalledWith("p1", undefined));
    // Empty query falls back to the null-keyed (unfiltered) cache entry.
    expect(qc.getQueryData(["herald-chats", "p1", null])).toBeDefined();
    void result;
  });

  it("stays disabled without a projectId", () => {
    const qc = new QueryClient();
    const { result } = renderHook(() => useHeraldChatList(undefined), { wrapper: makeWrapper(qc) });
    expect(result.current.fetchStatus).toBe("idle");
    expect(mockedApi.listHeraldChats).not.toHaveBeenCalled();
  });
});

describe("useRenameHeraldChat", () => {
  it("patches the list cache in place via setQueryData — no refetch", async () => {
    mockedApi.updateHeraldChatMeta.mockResolvedValue({ chatId: "c2", title: "Rollback runbook draft" });
    const qc = new QueryClient();
    qc.setQueryData(["herald-chats", "p1"], THREADS);
    const spy = vi.spyOn(qc, "invalidateQueries");
    const { result } = renderHook(() => useRenameHeraldChat("p1"), { wrapper: makeWrapper(qc) });
    await act(async () => {
      await result.current.mutateAsync({ chatId: "c2", title: "Rollback runbook draft" });
    });
    const cache = qc.getQueryData<HeraldChatThreadSummary[]>(["herald-chats", "p1"])!;
    expect(cache.find((t) => t.chatId === "c2")?.title).toBe("Rollback runbook draft");
    expect(cache.find((t) => t.chatId === "c1")?.title).toBe("Payments migration questions");
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("useUpdateHeraldChatMeta", () => {
  it("pin toggle patches every cached query variant and re-sorts pinned-first / updatedAt DESC", async () => {
    mockedApi.updateHeraldChatMeta.mockResolvedValue({ chatId: "c1", pinned: true });
    const qc = new QueryClient();
    qc.setQueryData(["herald-chats", "p1"], THREADS);
    qc.setQueryData(["herald-chats", "p1", "runbook"], [THREADS[0]]);
    const spy = vi.spyOn(qc, "invalidateQueries");
    const { result } = renderHook(() => useUpdateHeraldChatMeta("p1"), { wrapper: makeWrapper(qc) });
    await act(async () => {
      await result.current.mutateAsync({ chatId: "c1", pinned: true });
    });
    const cache = qc.getQueryData<HeraldChatThreadSummary[]>(["herald-chats", "p1"])!;
    expect(cache.map((t) => t.chatId)).toEqual(["c1", "c2"]);
    expect(cache[0]!.pinned).toBe(true);
    expect((qc.getQueryData<HeraldChatThreadSummary[]>(["herald-chats", "p1", "runbook"]) ?? [])[0]!.pinned).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  it("unpin re-sorts by updatedAt DESC", async () => {
    mockedApi.updateHeraldChatMeta.mockResolvedValue({ chatId: "c2", pinned: false });
    const qc = new QueryClient();
    qc.setQueryData(["herald-chats", "p1"], THREADS);
    const { result } = renderHook(() => useUpdateHeraldChatMeta("p1"), { wrapper: makeWrapper(qc) });
    await act(async () => {
      await result.current.mutateAsync({ chatId: "c2", pinned: false });
    });
    const cache = qc.getQueryData<HeraldChatThreadSummary[]>(["herald-chats", "p1"])!;
    expect(cache.map((t) => t.chatId)).toEqual(["c1", "c2"]);
  });
});

describe("useDeleteHeraldChat", () => {
  it("filters the row out of the list cache and evicts the transcript entry", async () => {
    mockedApi.resetHeraldChat.mockResolvedValue(undefined);
    const qc = new QueryClient();
    qc.setQueryData(["herald-chats", "p1"], THREADS);
    qc.setQueryData(["herald-chat", "c1"], { messages: [] });
    const spy = vi.spyOn(qc, "invalidateQueries");
    const { result } = renderHook(() => useDeleteHeraldChat("p1"), { wrapper: makeWrapper(qc) });
    await act(async () => {
      await result.current.mutateAsync({ chatId: "c1" });
    });
    const cache = qc.getQueryData<HeraldChatThreadSummary[]>(["herald-chats", "p1"])!;
    expect(cache.map((t) => t.chatId)).toEqual(["c2"]);
    expect(qc.getQueryData(["herald-chat", "c1"])).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });
});
