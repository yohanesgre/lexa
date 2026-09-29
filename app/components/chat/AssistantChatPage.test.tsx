// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const navigateMock = vi.hoisted(() => vi.fn());
const getAssistantChatMock = vi.hoisted(() => vi.fn());
// Captured turns handed to ChatTranscriptArea — the settle/reconciliation result
// the shell would render as approval chips.
const shellCapture = vi.hoisted(() => ({ turns: null as unknown }));

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
  ChatTranscriptArea: (props: { turns: unknown }) => {
    shellCapture.turns = props.turns;
    return null;
  },
  ChatComposerArea: () => null,
}));

vi.mock("./AssistantChatTurns", () => ({ ChatProviderMissingPanel: () => null }));

import { AssistantChatPage } from "./AssistantChatPage";
import { AssistantApprovalBatch } from "./AssistantApprovals";
import type { ApprovalChip } from "./AssistantApprovals";

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

const DIFF = { type: "task_create", title: "New task", fields: {} };

// A persisted pre-decision marker: approvals carry their chip payload but no
// reconciled `status`, so a cached render rebuilds them as pending chips.
function pendingMarkerTranscript() {
  return {
    ...TRANSCRIPT,
    messages: [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "proposed",
        pendingBatch: {
          batchId: "b1",
          approvals: [
            { approvalId: "a1", seq: 0, name: "create_task", diff: DIFF },
            { approvalId: "a2", seq: 1, name: "create_task", diff: DIFF },
          ],
        },
      },
    ],
  };
}

// The same transcript after GET reconciliation backfilled the decisions.
function reconciledMarkerTranscript() {
  return {
    ...TRANSCRIPT,
    messages: [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "proposed",
        pendingBatch: {
          batchId: "b1",
          approvals: [
            { approvalId: "a1", seq: 0, name: "create_task", diff: DIFF, status: "approved" },
            { approvalId: "a2", seq: 1, name: "create_task", diff: DIFF, status: "rejected" },
          ],
        },
      },
    ],
  };
}

function batchChips(turns: unknown): ApprovalChip[] {
  const arr = (turns ?? []) as Array<{ batch?: { chips: ApprovalChip[] } }>;
  return arr.flatMap((t) => t.batch?.chips ?? []);
}

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderPage(
  initial: { slug?: string; thread?: string } = {},
  queryClient: QueryClient = makeQueryClient()
) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const utils = render(<AssistantChatPage slug={initial.slug ?? "nimbus"} thread={initial.thread} />, { wrapper });
  const rerenderPage = (next: { slug?: string; thread?: string }) =>
    utils.rerender(<AssistantChatPage slug={next.slug ?? initial.slug ?? "nimbus"} thread={next.thread} />);
  return { ...utils, rerenderPage, queryClient };
}

function deleteThreadA() {
  fireEvent.click(screen.getByLabelText("Delete Thread A"));
  fireEvent.click(screen.getByRole("button", { name: "Delete chat" }));
}

beforeEach(() => {
  fx.reset();
  getAssistantChatMock.mockReset();
  navigateMock.mockReset();
  shellCapture.turns = null;
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

describe("AssistantChatPage — approval reconciliation on remount", () => {
  it("refetches the transcript when the chat remounts and renders reconciled chips terminal", async () => {
    const qc = makeQueryClient();
    // Previous visit cached the pre-decision marker (pending chips, no statuses).
    qc.setQueryData(["assistant-chat", "A"], pendingMarkerTranscript());
    getAssistantChatMock.mockResolvedValue(pendingMarkerTranscript());
    const first = renderPage({ thread: "A" }, qc);

    await waitFor(() => expect(batchChips(shellCapture.turns)).toHaveLength(2));
    expect(batchChips(shellCapture.turns).every((c) => c.state === "pending")).toBe(true);
    // Let the mount read settle before navigating away, so the remount's GET is
    // a fresh request rather than a dedupe of an in-flight one.
    await waitFor(() => expect(getAssistantChatMock).toHaveBeenCalledWith("A"));
    await waitFor(() => expect(qc.getQueryState(["assistant-chat", "A"])?.fetchStatus).toBe("idle"));
    // Navigate away (SPA unmount keeps the QueryClient cache).
    first.unmount();

    // Returning: the GET now reconciles the decisions (same message count).
    getAssistantChatMock.mockClear();
    getAssistantChatMock.mockResolvedValue(reconciledMarkerTranscript());
    renderPage({ thread: "A" }, qc);

    // Refetch on mount runs the reconciliation read...
    await waitFor(() => expect(getAssistantChatMock).toHaveBeenCalledWith("A"));
    // ...and the chips resolve terminal instead of re-arming pending.
    await waitFor(() => {
      const chips = batchChips(shellCapture.turns);
      expect(chips).toHaveLength(2);
      expect(chips.some((c) => c.state === "pending")).toBe(false);
    });
    const chips = batchChips(shellCapture.turns);
    expect(chips.find((c) => c.approvalId === "a1")!.state).toBe("approved");
    expect(chips.find((c) => c.approvalId === "a2")!.state).toBe("rejected");

    // The batch header therefore offers no pending "Approve all" action.
    render(
      <AssistantApprovalBatch chips={chips} locked={false} onDecide={() => {}} onApproveAll={() => {}} onRejectAll={() => {}} />
    );
    expect(screen.queryByText("Approve all")).not.toBeInTheDocument();
  });

  it("keeps a fresh-chat 404 remount on the empty state", async () => {
    const qc = makeQueryClient();
    getAssistantChatMock.mockRejectedValue(
      Object.assign(new Error("404"), { code: "ASSISTANT_THREAD_NOT_FOUND" })
    );
    const first = renderPage({ thread: "NEW" }, qc);
    await waitFor(() => expect(getAssistantChatMock).toHaveBeenCalledWith("NEW"));
    expect(first.container.querySelector(".thread-row.active")).toBeNull();
    first.unmount();

    // Remount with the 404 still in play: refetchOnMount re-runs the GET and
    // still resolves to the empty state — no stale-thread recovery redirect.
    getAssistantChatMock.mockClear();
    renderPage({ thread: "NEW" }, qc);
    await waitFor(() => expect(getAssistantChatMock).toHaveBeenCalledWith("NEW"));
    expect(shellCapture.turns).toEqual([]);
    expect(navigateMock).not.toHaveBeenCalled();
  });
});
