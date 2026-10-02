// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { QueryClient } from "@tanstack/react-query";
import { createQueryWrapper, createTestQueryClient } from "../../test-utils";
import type { ChatAttachmentRef } from "../../lib/assistant-image";

const navigateMock = vi.hoisted(() => vi.fn());
const getAssistantChatMock = vi.hoisted(() => vi.fn());
// Captured turns handed to ChatTranscriptArea — the settle/reconciliation result
// the shell would render as approval chips.
const shellCapture = vi.hoisted(() => ({ turns: null as unknown }));
// Captured composer props — landing tests read the seed the page hands down.
const composerCapture = vi.hoisted(() => ({
  seed: null as { text: string; nonce: number } | null,
  onSend: null as ((message: string, attachments: ChatAttachmentRef[]) => boolean) | null,
}));

// Captured transport calls: the send envelope the page builds (new thread via
// the keyed bridge, existing thread via the live socket).
const transportCapture = vi.hoisted(() => ({ sendForKey: vi.fn(), send: vi.fn() }));

// Mutable assistant-stream snapshot: the page test drives the live session
// state (idle / suspended) for the key it subscribes to, so a nav-return test
// can assert a run that survived unmount re-attaches with its pending batch.
const streamFx = vi.hoisted(() => {
  const idle = () => ({
    status: "idle",
    frames: [] as unknown[],
    text: "",
    tools: [] as unknown[],
    items: [] as unknown[],
    reasoningText: "",
    reasoningActive: false,
    reasoningMs: null as number | null,
    pending: [] as unknown[],
    suspendedBatchId: null as string | null,
    error: null as { code: string; message: string } | null,
    usage: null as { in: number; out: number } | null,
    hasIngress: false,
  });
  const state = { current: idle() };
  return { idle, state, reset: () => { state.current = idle(); } };
});

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
  let listLoading = false;
  const reset = () => {
    lists.p1 = [thread("A", "Thread A"), thread("B", "Thread B")];
    lists.p2 = [thread("C", "Thread C")];
    settings = { projectId: "p1", primarySupportsImages: false };
    listLoading = false;
  };
  let settings: { projectId: string; primarySupportsImages: boolean } | null = { projectId: "p1", primarySupportsImages: false };
  reset();
  return {
    projects: [
      { id: "p1", slug: "nimbus", name: "Nimbus" },
      { id: "p2", slug: "other", name: "Other" },
    ],
    lists,
    reset,
    get settings() {
      return settings;
    },
    set settings(value: { projectId: string; primarySupportsImages: boolean } | null) {
      settings = value;
    },
    get listLoading() {
      return listLoading;
    },
    set listLoading(value: boolean) {
      listLoading = value;
    },
  };
});

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
}));

vi.mock("../../lib/queries", () => ({
  useProjects: () => ({ data: fx.projects }),
  useAgents: () => ({ data: [] }),
  useSkills: () => ({ data: [] }),
  useAssistantSettings: () => ({ data: fx.settings, isLoading: false }),
  useAssistantChatList: (projectId: string) => ({ data: fx.lists[projectId] ?? [], isLoading: fx.listLoading }),
  useCapabilities: () => ({ data: { chatAttachments: true }, isFetched: true }),
  useChatAttachments: () => ({ data: [] }),
  useUploadChatAttachment: () => ({ mutateAsync: vi.fn(async () => ({})) }),
  useRenameAssistantChat: () => ({ mutateAsync: vi.fn(async () => {}) }),
  useUpdateAssistantChatMeta: () => ({ mutateAsync: vi.fn(async () => {}) }),
  useDeleteAssistantChat: () => ({
    // Mirror the real hook's onSuccess cache eviction (queries.ts), so a deleted
    // thread's cached transcript is not re-applied when the list snapshot no
    // longer contains it — the page must stay on the fresh landing.
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

vi.mock("../../lib/use-assistant-agent", () => ({
  assistantSendForKey: transportCapture.sendForKey,
  useAssistantAgent: (key: string | null) => {
    const snapshot = key ? streamFx.state.current : streamFx.idle();
    return {
      ...snapshot,
      send: transportCapture.send,
      abort: vi.fn(),
      reset: vi.fn(),
      subscribe: () => () => {},
      getSnapshot: () => snapshot,
      reconnecting: false,
      resumed: false,
    };
  },
}));

vi.mock("../ui/Toast", () => ({ useToast: () => ({ push: vi.fn() }) }));

vi.mock("./AssistantChatShell", () => ({
  ChatHeader: (props: { landing: boolean; onDelete: () => void }) =>
    props.landing ? null : (
      <button type="button" aria-label="Delete thread" onClick={props.onDelete}>
        Delete thread
      </button>
    ),
  ChatTranscriptArea: (props: { turns: unknown }) => {
    shellCapture.turns = props.turns;
    return null;
  },
  ChatComposerArea: (props: {
    seed?: { text: string; nonce: number } | null | undefined;
    onSend?: (message: string, attachments: ChatAttachmentRef[]) => boolean;
  }) => {
    composerCapture.seed = props.seed ?? null;
    composerCapture.onSend = props.onSend ?? null;
    return null;
  },
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
  permissionMode: "ask",
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

function renderPage(
  initial: { slug?: string; thread?: string } = {},
  queryClient: QueryClient = createTestQueryClient()
) {
  const wrapper = createQueryWrapper(queryClient);
  const utils = render(<AssistantChatPage slug={initial.slug ?? "nimbus"} thread={initial.thread} />, { wrapper });
  const rerenderPage = (next: { slug?: string; thread?: string }) =>
    utils.rerender(<AssistantChatPage slug={next.slug ?? initial.slug ?? "nimbus"} thread={next.thread} />);
  return { ...utils, rerenderPage, queryClient };
}

function deleteThreadA() {
  fireEvent.click(screen.getByLabelText("Delete thread"));
}

beforeEach(() => {
  fx.reset();
  streamFx.reset();
  window.localStorage.clear();
  getAssistantChatMock.mockReset();
  navigateMock.mockReset();
  shellCapture.turns = null;
  composerCapture.seed = null;
  composerCapture.onSend = null;
  transportCapture.sendForKey.mockReset();
  transportCapture.send.mockReset();
});

describe("AssistantChatPage thread selection", () => {
  it("restores the last active thread when no ?thread= is given (LX-8 return)", async () => {
    // fx.lists.p1 already holds threads "A" and "B"; lexa-chat-last points at
    // "A", so entering the chat with no deep link re-enters "A" instead of the
    // new-chat landing — a run that survived a navigation re-attaches.
    window.localStorage.setItem("lexa-chat-last:p1", "A");
    getAssistantChatMock.mockResolvedValue({ ...TRANSCRIPT, messages: [{ role: "user", content: "hi" }] });
    const { container } = renderPage();

    await waitFor(() => expect(getAssistantChatMock).toHaveBeenCalledWith("A"));
    expect(container.querySelector(".chat-landing")).toBeNull();
    expect(container.querySelector(".thread-row.active")?.textContent).toContain("Thread A");
  });

  it("opens the new-chat landing when there is no ?thread= and no last-visited memory", () => {
    const { container } = renderPage();

    expect(container.querySelector(".chat-landing")).toBeTruthy();
    expect(screen.getByText("Thread A")).toBeTruthy();
    expect(getAssistantChatMock).not.toHaveBeenCalled();
    expect(container.querySelector(".thread-row.active")).toBeNull();
  });

  it("opens a ?thread= deep link and switches the transcript query when a sidebar row is clicked", async () => {
    getAssistantChatMock.mockResolvedValue(TRANSCRIPT);
    renderPage({ thread: "A" });

    await waitFor(() => expect(getAssistantChatMock).toHaveBeenCalledWith("A"));
    getAssistantChatMock.mockClear();

    fireEvent.click(screen.getByText("Thread B"));
    await waitFor(() => expect(getAssistantChatMock).toHaveBeenCalledWith("B"));
  });

  it("lands fresh on reload when a ?thread= 404s while it is the last-visited (never opens a list head)", async () => {
    // Reload shape: the URL carries a fresh uuid, lexa-chat-last points at it
    // (so it is NOT an "untracked" deep link → recovery applies), the list
    // snapshot holds OTHER threads, and the transcript 404s for the unknown id.
    const fresh = "11111111-1111-4111-8111-111111111111";
    window.localStorage.setItem("lexa-chat-last:p1", fresh);
    getAssistantChatMock.mockRejectedValue(Object.assign(new Error("404"), { code: "ASSISTANT_THREAD_NOT_FOUND" }));
    const { container } = renderPage({ thread: fresh });

    await waitFor(() => expect(getAssistantChatMock).toHaveBeenCalledWith(fresh));

    // The dead uuid must NOT resolve to the list head "A": landing, no active
    // row, and no other thread's transcript is ever fetched.
    await waitFor(() => expect(container.querySelector(".chat-landing")).toBeTruthy());
    expect(container.querySelectorAll(".chat-landing-chip")).toHaveLength(3);
    expect(container.querySelector(".thread-row.active")).toBeNull();
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith({ search: {}, replace: true }));
    expect(getAssistantChatMock.mock.calls.map((c) => c[0])).toEqual([fresh]);
  });

  it("lands fresh for a dead ?thread= that no list snapshot contains", async () => {
    const ghost = "22222222-2222-4222-8222-222222222222";
    window.localStorage.setItem("lexa-chat-last:p1", ghost);
    getAssistantChatMock.mockRejectedValue(Object.assign(new Error("404"), { code: "ASSISTANT_THREAD_NOT_FOUND" }));
    const { container } = renderPage({ thread: ghost });

    await waitFor(() => expect(getAssistantChatMock).toHaveBeenCalledWith(ghost));
    await waitFor(() => expect(container.querySelector(".chat-landing")).toBeTruthy());
    expect(container.querySelectorAll(".chat-landing-chip")).toHaveLength(3);
    expect(container.querySelector(".thread-row.active")).toBeNull();
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith({ search: {}, replace: true }));
    expect(getAssistantChatMock.mock.calls.map((c) => c[0])).toEqual([ghost]);
  });

  it("keeps a deep-linked thread on a transient (non-404) transcript error", async () => {
    const transient = "33333333-3333-4333-8333-333333333333";
    window.localStorage.setItem("lexa-chat-last:p1", transient);
    const qc = createTestQueryClient();
    // The id is present in a cached list variant: a transient read failure is
    // not dead-link evidence, so it must not be evicted from the cache nor have
    // ?thread= cleared, and it must not paint the hero over the failed read.
    qc.setQueryData(["assistant-chats", "p1"], [
      { chatId: transient, title: "Transient", pinned: false, snippet: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
    ]);
    getAssistantChatMock.mockRejectedValue(new Error("500 Internal Server Error"));
    const { container } = renderPage({ thread: transient }, qc);

    await waitFor(() => expect(getAssistantChatMock).toHaveBeenCalledWith(transient));
    await waitFor(() => expect(qc.getQueryState(["assistant-chat", transient])?.status).toBe("error"));

    expect(navigateMock).not.toHaveBeenCalledWith({ search: {}, replace: true });
    expect(qc.getQueryState(["assistant-chat", transient])).toBeTruthy();
    expect((qc.getQueryData(["assistant-chats", "p1"]) as Array<{ chatId: string }>).some((t) => t.chatId === transient)).toBe(true);
    expect(container.querySelector(".chat-landing")).toBeNull();
  });

  it("lands on a fresh empty chat after deleting the active thread (no head fallback)", async () => {
    getAssistantChatMock.mockResolvedValue(TRANSCRIPT);
    const { container } = renderPage();

    // The landing is the default; a thread is opened explicitly via the sidebar.
    fireEvent.click(screen.getByText("Thread A"));
    await waitFor(() => expect(getAssistantChatMock).toHaveBeenCalledWith("A"));
    getAssistantChatMock.mockClear();

    deleteThreadA();
    await waitFor(() => expect(container.querySelector(".chat-landing")).toBeTruthy());
    // The list head is now "B" (the deleted row was evicted, mirroring the real
    // hook), yet the view must stay empty: no fallback fetch, landing restored.
    expect(getAssistantChatMock).not.toHaveBeenCalled();
    expect(container.querySelector(".thread-row.active")).toBeNull();
    expect(container.querySelector(".chat-landing")).toBeTruthy();
  });

  it("does not leak the active thread across a project switch", async () => {
    getAssistantChatMock.mockResolvedValue(TRANSCRIPT);
    const { container, rerenderPage } = renderPage();

    fireEvent.click(screen.getByText("Thread A"));
    await waitFor(() => expect(getAssistantChatMock).toHaveBeenCalledWith("A"));
    getAssistantChatMock.mockClear();

    // Switch to project B: its list must NOT auto-select a thread, and the
    // previous project's active thread must not leak through.
    rerenderPage({ slug: "other" });
    await waitFor(() => expect(container.querySelector(".chat-landing")).toBeTruthy());
    expect(getAssistantChatMock).not.toHaveBeenCalled();
    expect(container.querySelector(".thread-row.active")).toBeNull();
  });
});

describe("AssistantChatPage — return restore (LX-8)", () => {
  it("re-enters the last active thread after a navigation without ?thread=", async () => {
    const qc = createTestQueryClient();
    getAssistantChatMock.mockResolvedValue({ ...TRANSCRIPT, messages: [{ role: "user", content: "hi" }] });
    const first = renderPage({ thread: "A" }, qc);
    await waitFor(() => expect(getAssistantChatMock).toHaveBeenCalledWith("A"));
    await waitFor(() => expect(qc.getQueryState(["assistant-chat", "A"])?.fetchStatus).toBe("idle"));
    expect(window.localStorage.getItem("lexa-chat-last:p1")).toBe("A");
    first.unmount();

    // Return through the nav link: the URL carries no ?thread= param.
    getAssistantChatMock.mockClear();
    renderPage({}, qc);
    // The restore re-enters "A" and the reconcile read runs on mount.
    await waitFor(() => expect(getAssistantChatMock).toHaveBeenCalledWith("A"));
    expect(shellCapture.turns ?? []).toHaveLength(1);
  });

  it("re-attaches a run that suspended for approval while unmounted", async () => {
    const qc = createTestQueryClient();
    getAssistantChatMock.mockResolvedValue({ ...TRANSCRIPT, messages: [{ role: "user", content: "go" }] });
    const first = renderPage({ thread: "A" }, qc);
    await waitFor(() => expect(getAssistantChatMock).toHaveBeenCalledWith("A"));
    await waitFor(() => expect(qc.getQueryState(["assistant-chat", "A"])?.fetchStatus).toBe("idle"));
    first.unmount();

    // The module session survived the unmount and sits at its suspended frame.
    streamFx.state.current = {
      ...streamFx.idle(),
      status: "suspended",
      hasIngress: true,
      suspendedBatchId: "b1",
      pending: [{ approvalId: "a1", batchId: "b1", seq: 0, name: "create_task", diff: DIFF }],
    };
    renderPage({}, qc);

    await waitFor(() => expect(batchChips(shellCapture.turns)).toHaveLength(1));
    expect(batchChips(shellCapture.turns)[0]!.approvalId).toBe("a1");
    expect(batchChips(shellCapture.turns)[0]!.state).toBe("pending");
  });

  it("reconciles a run that finished while unmounted (terminal refetch)", async () => {
    const qc = createTestQueryClient();
    getAssistantChatMock.mockResolvedValue({ ...TRANSCRIPT, messages: [{ role: "user", content: "hi" }] });
    const first = renderPage({ thread: "A" }, qc);
    await waitFor(() => expect(getAssistantChatMock).toHaveBeenCalledWith("A"));
    await waitFor(() => expect(qc.getQueryState(["assistant-chat", "A"])?.fetchStatus).toBe("idle"));
    first.unmount();

    // The run completed while the page was gone — the session is terminal and
    // the stored thread now holds the reply the client never saw.
    streamFx.state.current = { ...streamFx.idle(), status: "done", hasIngress: true };
    getAssistantChatMock.mockClear();
    getAssistantChatMock.mockResolvedValue({
      ...TRANSCRIPT,
      messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }],
    });
    renderPage({}, qc);

    await waitFor(() => expect(getAssistantChatMock).toHaveBeenCalledWith("A"));
    await waitFor(() => expect(shellCapture.turns ?? []).toHaveLength(2));
  });
});

describe("AssistantChatPage — approval reconciliation on remount", () => {
  it("refetches the transcript when the chat remounts and renders reconciled chips terminal", async () => {
    const qc = createTestQueryClient();
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
    const qc = createTestQueryClient();
    getAssistantChatMock.mockRejectedValue(
      Object.assign(new Error("404"), { code: "ASSISTANT_THREAD_NOT_FOUND" })
    );
    const first = renderPage({ thread: "NEW" }, qc);
    await waitFor(() => expect(getAssistantChatMock).toHaveBeenCalledWith("NEW"));
    expect(first.container.querySelector(".thread-row.active")).toBeNull();
    first.unmount();

    // Remount with the 404 still in play: refetchOnMount re-runs the GET. Hold
    // that read open so the pre-settle window is deterministic — the fresh uuid
    // is still a zero-turn chat (no hero flashing over it, no recovery redirect).
    let failRead!: (error: unknown) => void;
    getAssistantChatMock.mockClear();
    getAssistantChatMock.mockReturnValue(
      new Promise((_resolve, reject) => {
        failRead = reject;
      })
    );
    const second = renderPage({ thread: "NEW" }, qc);
    await waitFor(() => expect(getAssistantChatMock).toHaveBeenCalledWith("NEW"));
    expect(second.container.querySelector(".chat-landing")).toBeNull();
    expect(shellCapture.turns).toEqual([]);
    expect(navigateMock).not.toHaveBeenCalled();

    await act(async () => {
      failRead(Object.assign(new Error("404"), { code: "ASSISTANT_THREAD_NOT_FOUND" }));
    });
  });
});

describe("AssistantChatPage — zero-turn landing", () => {
  it("shows the hero with three starter chips on a fresh empty chat", () => {
    fx.lists.p1 = [];
    const { container } = renderPage();
    expect(container.querySelector(".chat-landing")).toBeTruthy();
    expect(screen.getByText("What should we get done?")).toBeTruthy();
    const chips = container.querySelectorAll(".chat-landing-chip");
    expect(Array.from(chips).map((c) => c.textContent)).toEqual([
      "Summarize the board",
      "Create a task from my notes",
      "Find related wiki pages",
    ]);
  });

  it("prefills the composer from a starter chip without sending", () => {
    fx.lists.p1 = [];
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Create a task from my notes" }));

    expect(composerCapture.seed?.text).toBe("Create a task from my notes");
    expect(composerCapture.seed?.nonce).toBeGreaterThan(0);
    // No optimistic user turn / stream: the chip never sends.
    expect(shellCapture.turns ?? []).toEqual([]);
    expect(getAssistantChatMock).not.toHaveBeenCalled();
  });

  it("clears the starter seed once a turn exists (no stale draft refill on a later landing)", async () => {
    fx.lists.p1 = [];
    getAssistantChatMock.mockResolvedValue({ ...TRANSCRIPT, messages: [{ role: "user", content: "hi" }] });
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Create a task from my notes" }));
    expect(composerCapture.seed?.text).toBe("Create a task from my notes");

    // Sending starts a turn: the composer is no longer a fresh landing, so the
    // seed must drop — otherwise returning to the landing remounts the composer
    // and refills the draft with the stale chip text.
    act(() => {
      expect(composerCapture.onSend!("Create a task from my notes", [])).toBe(true);
    });

    await waitFor(() => expect(composerCapture.seed).toBeNull());
  });

  it("keeps the landing after New chat mints a fresh ?thread= uuid that 404s", async () => {
    fx.lists.p1 = [];
    getAssistantChatMock.mockRejectedValue(
      Object.assign(new Error("404"), { code: "ASSISTANT_THREAD_NOT_FOUND" })
    );
    const { container, rerenderPage } = renderPage();
    expect(container.querySelector(".chat-landing")).toBeTruthy();

    // New chat mints a fresh uuid and deep-links it as ?thread=<uuid>.
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    const freshId = navigateMock.mock.calls.at(-1)?.[0]?.search?.thread as string;
    expect(freshId).toBeTruthy();

    // The route applies the uuid as the ?thread= param.
    rerenderPage({ thread: freshId });
    await waitFor(() => expect(getAssistantChatMock).toHaveBeenCalledWith(freshId));

    // A settled zero-turn uuid IS the new-chat landing — not an empty docked
    // transcript — so the hero and its starter chips come back.
    await waitFor(() => expect(container.querySelector(".chat-landing")).toBeTruthy());
    expect(container.querySelectorAll(".chat-landing-chip")).toHaveLength(3);
  });

  it("shows the landing for a settled existing thread that has zero turns", async () => {
    getAssistantChatMock.mockResolvedValue({ ...TRANSCRIPT, messages: [] });
    const { container } = renderPage({ thread: "A" });
    await waitFor(() => expect(getAssistantChatMock).toHaveBeenCalledWith("A"));

    await waitFor(() => expect(container.querySelector(".chat-landing")).toBeTruthy());
    expect(container.querySelectorAll(".chat-landing-chip")).toHaveLength(3);
  });

  it("hides the hero once the thread has turns", async () => {
    getAssistantChatMock.mockResolvedValue({ ...TRANSCRIPT, messages: [{ role: "user", content: "hi" }] });
    const { container } = renderPage({ thread: "A" });
    await waitFor(() => expect(shellCapture.turns).not.toBeNull());
    expect(container.querySelector(".chat-landing")).toBeNull();
  });

  it("hides the hero when the provider is missing", () => {
    fx.lists.p1 = [];
    fx.settings = null;
    const { container } = renderPage();
    expect(container.querySelector(".chat-landing")).toBeNull();
  });

  it("does not paint the hero while the thread list is still loading", () => {
    fx.lists.p1 = [];
    fx.listLoading = true;
    const { container } = renderPage();
    expect(container.querySelector(".chat-landing")).toBeNull();
  });

  it("does not flash the hero on a ?thread= deep link while the transcript still loads", async () => {
    let resolveTranscript!: (value: unknown) => void;
    getAssistantChatMock.mockReturnValue(
      new Promise((resolve) => {
        resolveTranscript = resolve;
      })
    );
    const { container } = renderPage({ thread: "A" });
    await waitFor(() => expect(getAssistantChatMock).toHaveBeenCalledWith("A"));

    // The real thread's GET is in flight and turns are still empty: the hero
    // must not paint over it.
    expect(container.querySelector(".chat-landing")).toBeNull();

    resolveTranscript({ ...TRANSCRIPT, messages: [{ role: "user", content: "hi" }] });
    await waitFor(() => expect(shellCapture.turns ?? []).toHaveLength(1));
    expect(container.querySelector(".chat-landing")).toBeNull();
  });
});

describe("AssistantChatPage — permissionMode envelope", () => {
  it("omits permissionMode on a brand-new thread before any transcript or pick", async () => {
    const { container } = renderPage();
    expect(container.querySelector(".chat-landing")).toBeTruthy();
    await waitFor(() => expect(composerCapture.onSend).toBeTruthy());

    act(() => {
      expect(composerCapture.onSend!("hi there", [])).toBe(true);
    });

    expect(transportCapture.sendForKey).toHaveBeenCalledTimes(1);
    const [key, body] = transportCapture.sendForKey.mock.calls[0] as [string, Record<string, unknown>];
    expect(key).toMatch(/^assistant-chat:/);
    // Unhydrated and un-picked: the envelope must NOT carry a mode, so the DO
    // keeps its sticky value (a fresh thread resolves to "ask" server-side).
    expect(body).not.toHaveProperty("permissionMode");
    expect(transportCapture.send).not.toHaveBeenCalled();
  });

  it("includes the transcript's permissionMode once this thread is hydrated", async () => {
    getAssistantChatMock.mockResolvedValue({
      ...TRANSCRIPT,
      permissionMode: "auto",
      messages: [{ role: "user", content: "hi" }],
    });
    renderPage({ thread: "A" });
    await waitFor(() => expect(shellCapture.turns ?? []).toHaveLength(1));

    act(() => {
      composerCapture.onSend!("next", []);
    });

    expect(transportCapture.send).toHaveBeenCalledWith(
      "/api/assistant/chat/stream",
      expect.objectContaining({ permissionMode: "auto" })
    );
  });
});
