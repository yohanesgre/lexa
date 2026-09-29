// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const navigateMock = vi.hoisted(() => vi.fn());
const getAssistantChatMock = vi.hoisted(() => vi.fn());

const fx = vi.hoisted(() => {
  const thread = (chatId: string, title: string) => ({
    chatId,
    title,
    pinned: false,
    snippet: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  });
  const lists: Record<string, unknown[]> = {};
  const reset = () => {
    lists.p1 = [thread("A", "Thread A"), thread("B", "Thread B")];
    lists.p2 = [thread("C", "Thread C")];
  };
  reset();
  return {
    projects: [
      { id: "p1", slug: "nimbus", name: "Nimbus" },
      { id: "p2", slug: "other", name: "Other" },
    ],
    lists,
    reset,
  };
});

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
}));

vi.mock("../../lib/queries", () => ({
  useProjects: () => ({ data: fx.projects }),
  useAgents: () => ({ data: [] }),
  useSkills: () => ({ data: [] }),
  useAssistantSettings: () => ({ data: { projectId: "p1", primarySupportsImages: false }, isLoading: false }),
  useAssistantChatList: (projectId: string) => ({ data: fx.lists[projectId] ?? [], isLoading: false }),
  useRenameAssistantChat: () => ({ mutateAsync: vi.fn(async () => {}) }),
  useUpdateAssistantChatMeta: () => ({ mutateAsync: vi.fn(async () => {}) }),
  useDeleteAssistantChat: () => ({
    // Mirror the real hook's onSuccess cache eviction (queries.ts): without it
    // the list keeps the deleted id and a missing latch would re-apply the
    // cached transcript instead of falling back to an uncached head.
    mutateAsync: vi.fn(async ({ chatId }: { chatId: string }) => {
      for (const key of Object.keys(fx.lists)) {
        fx.lists[key] = (fx.lists[key] as Array<{ chatId: string }>).filter((t) => t.chatId !== chatId);
      }
    }),
  }),
}));

vi.mock("../../lib/api", () => ({
  getAssistantChat: getAssistantChatMock,
  getProject: vi.fn(),
  decideAssistantApproval: vi.fn(),
}));

vi.mock("../../lib/use-assistant-stream", () => ({
  assistantSendForKey: vi.fn(),
  useAssistantStream: () => ({
    status: "idle",
    frames: [],
    text: "",
    tools: [],
    items: [],
    reasoningText: "",
    reasoningActive: false,
    reasoningMs: null,
    pending: [],
    suspendedBatchId: null,
    error: null,
    usage: null,
    hasIngress: false,
    send: vi.fn(),
    abort: vi.fn(),
    reset: vi.fn(),
    subscribe: () => () => {},
    getSnapshot: () => ({}),
  }),
}));

vi.mock("../ui/Toast", () => ({ useToast: () => ({ push: vi.fn() }) }));

vi.mock("./AssistantChatShell", () => ({
  ChatHeader: () => null,
  ChatTranscriptArea: () => null,
  ChatComposerArea: () => null,
}));

vi.mock("./AssistantChatTurns", () => ({ ChatProviderMissingPanel: () => null }));

import { AssistantChatPage } from "./AssistantChatPage";

const TRANSCRIPT = {
  chatId: "A",
  projectId: "p1",
  ownerUserId: "u1",
  agentId: null,
  skillId: null,
  messages: [],
  summary: null,
  summarizedCount: 0,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

function renderPage(initial: { slug?: string; thread?: string } = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const utils = render(<AssistantChatPage slug={initial.slug ?? "nimbus"} thread={initial.thread} />, { wrapper });
  const rerenderPage = (next: { slug?: string; thread?: string }) =>
    utils.rerender(<AssistantChatPage slug={next.slug ?? initial.slug ?? "nimbus"} thread={next.thread} />);
  return { ...utils, rerenderPage };
}

function deleteThreadA() {
  fireEvent.click(screen.getByLabelText("Delete Thread A"));
  fireEvent.click(screen.getByRole("button", { name: "Delete chat" }));
}

beforeEach(() => {
  fx.reset();
  getAssistantChatMock.mockReset();
  navigateMock.mockReset();
});

describe("AssistantChatPage thread selection", () => {
  it("resolves ?thread= and switches the transcript query when a sidebar row is clicked", async () => {
    getAssistantChatMock.mockResolvedValue(TRANSCRIPT);
    renderPage({ thread: "A" });

    await waitFor(() => expect(getAssistantChatMock).toHaveBeenCalledWith("A"));
    getAssistantChatMock.mockClear();

    fireEvent.click(screen.getByText("Thread B"));
    await waitFor(() => expect(getAssistantChatMock).toHaveBeenCalledWith("B"));
  });

  it("lands on a fresh empty chat after deleting the active thread (no head fallback)", async () => {
    getAssistantChatMock.mockResolvedValue(TRANSCRIPT);
    const { container } = renderPage();

    // Initial resolution falls back to the history list head ("A").
    await waitFor(() => expect(getAssistantChatMock).toHaveBeenCalledWith("A"));
    getAssistantChatMock.mockClear();

    deleteThreadA();
    await waitFor(() => expect(screen.queryByText("Delete this chat?")).not.toBeInTheDocument());
    // The list head is now "B" (the deleted row was evicted, mirroring the real
    // hook), yet the latch must keep the view empty: no fallback fetch, no
    // active row.
    expect(getAssistantChatMock).not.toHaveBeenCalled();
    expect(container.querySelector(".thread-row.active")).toBeNull();
  });

  it("clears the intentional-empty latch on a project round trip (A→B→A)", async () => {
    getAssistantChatMock.mockResolvedValue(TRANSCRIPT);
    const { container, rerenderPage } = renderPage();

    await waitFor(() => expect(getAssistantChatMock).toHaveBeenCalledWith("A"));
    getAssistantChatMock.mockClear();

    deleteThreadA();
    await waitFor(() => expect(screen.queryByText("Delete this chat?")).not.toBeInTheDocument());
    expect(getAssistantChatMock).not.toHaveBeenCalled();
    expect(container.querySelector(".thread-row.active")).toBeNull();

    // Switch to project B: its own head resolves.
    rerenderPage({ slug: "other" });
    await waitFor(() => expect(getAssistantChatMock).toHaveBeenCalledWith("C"));

    // Back to project A: the latch was cleared on the switch, so A re-resolves
    // to its (now only) remaining thread "B" instead of staying empty.
    rerenderPage({ slug: "nimbus" });
    await waitFor(() =>
      expect(screen.getByText("Thread B").closest(".thread-row")?.className).toContain("active")
    );
  });
});
