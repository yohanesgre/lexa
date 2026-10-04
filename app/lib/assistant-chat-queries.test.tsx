// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { AssistantChatThreadSummary } from "./api";

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return {
    ...actual,
    listAssistantChats: vi.fn(),
    updateAssistantChatMeta: vi.fn(),
    resetAssistantChat: vi.fn(),
  };
});

import * as api from "./api";
import { useAssistantChatList, useRenameAssistantChat, useDeleteAssistantChat, useUpdateAssistantChatMeta } from "./queries";

const mockedApi = vi.mocked(api);

const THREADS: AssistantChatThreadSummary[] = [
  // c1 (the toggled row) is the OLDEST on purpose: the server bumps
  // `updatedAt` on PATCH, so the patched cache must move it to the top of
  // the pinned group. Dropping `updatedAt` would leave c2 first.
  { chatId: "c1", title: "Payments migration questions", pinned: false, snippet: null, createdAt: "2026-08-21T09:00:00Z", updatedAt: "2026-08-21T10:00:00Z" },
  { chatId: "c2", title: null, pinned: true, snippet: null, createdAt: "2026-08-22T09:00:00Z", updatedAt: "2026-08-22T11:00:00Z" },
];

function makeWrapper(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useAssistantChatList", () => {
  it("fetches the thread list once projectId exists", async () => {
    mockedApi.listAssistantChats.mockResolvedValue({ data: THREADS });
    const qc = new QueryClient();
    const { result } = renderHook(() => useAssistantChatList("p1"), { wrapper: makeWrapper(qc) });
    await waitFor(() => expect(result.current.data).toHaveLength(2));
    expect(mockedApi.listAssistantChats).toHaveBeenCalledWith("p1", undefined);
  });
});
describe("useRenameAssistantChat", () => {
  it("patches the list cache in place via setQueryData — no refetch", async () => {
    mockedApi.updateAssistantChatMeta.mockResolvedValue({ chatId: "c2", title: "Rollback runbook draft" });
    const qc = new QueryClient();
    qc.setQueryData(["assistant-chats", "p1"], THREADS);
    const spy = vi.spyOn(qc, "invalidateQueries");
    const { result } = renderHook(() => useRenameAssistantChat("p1"), { wrapper: makeWrapper(qc) });
    await act(async () => {
      await result.current.mutateAsync({ chatId: "c2", title: "Rollback runbook draft" });
    });
    const cache = qc.getQueryData<AssistantChatThreadSummary[]>(["assistant-chats", "p1"])!;
    expect(cache.find((t) => t.chatId === "c2")?.title).toBe("Rollback runbook draft");
    expect(cache.find((t) => t.chatId === "c1")?.title).toBe("Payments migration questions");
    // Invariant #6: the deterministic patch is authoritative — no refetch.
    expect(spy).not.toHaveBeenCalled();
  });
});
describe("useUpdateAssistantChatMeta", () => {
  it("pin toggle patches every cached query variant and re-sorts pinned-first / updatedAt DESC", async () => {
    mockedApi.updateAssistantChatMeta.mockResolvedValue({ chatId: "c1", pinned: true });
    const qc = new QueryClient();
    qc.setQueryData(["assistant-chats", "p1"], THREADS);
    qc.setQueryData(["assistant-chats", "p1", "runbook"], [THREADS[0]]);
    const spy = vi.spyOn(qc, "invalidateQueries");
    const { result } = renderHook(() => useUpdateAssistantChatMeta("p1"), { wrapper: makeWrapper(qc) });
    await act(async () => {
      await result.current.mutateAsync({ chatId: "c1", pinned: true });
    });
    const cache = qc.getQueryData<AssistantChatThreadSummary[]>(["assistant-chats", "p1"])!;
    expect(cache.map((t) => t.chatId)).toEqual(["c1", "c2"]);
    expect(cache[0]!.pinned).toBe(true);
    // The server bumps updatedAt on PATCH; the patch must mirror it or the
    // pinned group re-sorts wrong (c2 would win on its newer timestamp).
    expect(cache[0]!.updatedAt).not.toBe(THREADS[0]!.updatedAt);
    expect((qc.getQueryData<AssistantChatThreadSummary[]>(["assistant-chats", "p1", "runbook"]) ?? [])[0]!.pinned).toBe(true);
    // Invariant #6: pin toggle patches every cached variant — no refetch.
    expect(spy).not.toHaveBeenCalled();
  });
});
describe("useDeleteAssistantChat", () => {
  it("filters the row out of the list cache and evicts the transcript entry", async () => {
    mockedApi.resetAssistantChat.mockResolvedValue(undefined);
    const qc = new QueryClient();
    qc.setQueryData(["assistant-chats", "p1"], THREADS);
    qc.setQueryData(["assistant-chat", "c1"], { messages: [] });
    const spy = vi.spyOn(qc, "invalidateQueries");
    const { result } = renderHook(() => useDeleteAssistantChat("p1"), { wrapper: makeWrapper(qc) });
    await act(async () => {
      await result.current.mutateAsync({ chatId: "c1" });
    });
    const cache = qc.getQueryData<AssistantChatThreadSummary[]>(["assistant-chats", "p1"])!;
    expect(cache.map((t) => t.chatId)).toEqual(["c2"]);
    expect(qc.getQueryData(["assistant-chat", "c1"])).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });
});
