import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { renderTranscript } from "./assistant-chat-utils";
import { chipStateFromError, recoverStaleThread, resolveChatId } from "./assistant-chat-logic";

const DIFF = { type: "task_delete", taskRef: "LX-1", taskTitle: "old" } as const;

describe("renderTranscript — persisted pendingBatch approvals", () => {
  it("rebuilds decidable chips from the full approvals payload", () => {
    const turns = renderTranscript([
      {
        role: "assistant",
        content: "proposed",
        pendingBatch: {
          batchId: "b1",
          approvals: [{ approvalId: "a1", toolCallId: "call_1", seq: 0, name: "delete_task", detail: "Delete LX-1", diff: DIFF }],
        },
      },
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.batch).toEqual({
      batchId: "b1",
      chips: [{ approvalId: "a1", batchId: "b1", seq: 0, name: "delete_task", detail: "Delete LX-1", diff: DIFF, state: "pending" }],
    });
    expect(turns[0]!.suspendedBatchId).toBeUndefined();
  });

  it("falls back to the waiting marker when the payload is incomplete", () => {
    const turns = renderTranscript([
      { role: "assistant", content: "proposed", pendingBatch: { batchId: "b1", approvals: [{ approvalId: "a1", toolCallId: "call_1" }] } },
    ]);
    expect(turns[0]!.batch).toBeUndefined();
    expect(turns[0]!.suspendedBatchId).toBe("b1");
  });

  it("keeps legacy string markers marker-only", () => {
    const turns = renderTranscript([{ role: "assistant", content: "proposed", pendingBatch: "b-legacy" }]);
    expect(turns[0]!.suspendedBatchId).toBe("b-legacy");
  });

  it("renders a reconciled decision as a terminal chip, not pending", () => {
    const turns = renderTranscript([
      {
        role: "assistant",
        content: "proposed",
        pendingBatch: {
          batchId: "b1",
          approvals: [
            { approvalId: "a1", toolCallId: "call_1", seq: 0, name: "delete_task", diff: DIFF, status: "approved" },
            { approvalId: "a2", toolCallId: "call_2", seq: 1, name: "create_task", diff: { type: "task_create", title: "t", fields: {} }, status: "rejected" },
          ],
        },
      },
    ]);
    expect(turns[0]!.batch?.chips.map((c) => c.state)).toEqual(["approved", "rejected"]);
  });
});

describe("resolveChatId", () => {
  const base = {
    projectId: "p1",
    thread: undefined as string | undefined,
    currentChatId: "",
    last: null as string | null,
    head: undefined as string | undefined,
  };

  it("prefers ?thread= over last-visited and the list head", () => {
    expect(resolveChatId({ ...base, thread: "t1", last: "t2", head: "t3" })).toBe("t1");
  });

  it("falls back to last-visited, then the history list head", () => {
    expect(resolveChatId({ ...base, last: "t2", head: "t3" })).toBe("t2");
    expect(resolveChatId({ ...base, head: "t3" })).toBe("t3");
  });

  it("returns null for the fresh empty state", () => {
    expect(resolveChatId(base)).toBeNull();
  });

  it("does not clobber an active selection from a stale fallback", () => {
    expect(resolveChatId({ ...base, currentChatId: "active", last: "t2", head: "t3" })).toBeNull();
    expect(resolveChatId({ ...base, currentChatId: "active", thread: "active" })).toBeNull();
  });

  it("honors an explicit ?thread= switch away from the active selection", () => {
    expect(resolveChatId({ ...base, currentChatId: "a", thread: "b" })).toBe("b");
  });
});

describe("recoverStaleThread — dead-head eviction", () => {
  const thread = (chatId: string) => ({ chatId, title: chatId, pinned: false, snippet: null, createdAt: "x", updatedAt: "x" });

  it("evicts the dead id from cached lists and falls back to the next live head", () => {
    const qc = new QueryClient();
    qc.setQueryData(["assistant-chats", "p1", null], [thread("dead"), thread("live")]);
    qc.setQueryData(["assistant-chats", "p1", "q"], [thread("dead"), thread("other")]);
    const applied: string[] = [];
    recoverStaleThread({
      qc,
      projectId: "p1",
      chatId: "dead",
      listData: [thread("dead"), thread("live")],
      applyChatId: (id) => applied.push(id),
      setChatId: (id) => applied.push(`set:${id}`),
      clearThreadParam: () => {},
      clearParam: true,
    });
    expect(applied).toEqual(["live"]);
    expect(qc.getQueryData(["assistant-chats", "p1", null])).toEqual([thread("live")]);
    expect(qc.getQueryData(["assistant-chats", "p1", "q"])).toEqual([thread("other")]);
  });

  it("clears the selection when the dead id was the only entry", () => {
    const qc = new QueryClient();
    qc.setQueryData(["assistant-chats", "p1", null], [thread("dead")]);
    const applied: string[] = [];
    recoverStaleThread({
      qc,
      projectId: "p1",
      chatId: "dead",
      listData: [thread("dead")],
      applyChatId: (id) => applied.push(id),
      setChatId: (id) => applied.push(`set:${id}`),
      clearThreadParam: () => {},
      clearParam: true,
    });
    expect(applied).toEqual(["set:"]);
    expect(qc.getQueryData(["assistant-chats", "p1", null])).toEqual([]);
  });
});

describe("chipStateFromError", () => {
  it("retires a chip whose decision row is gone, so the composer cannot stay locked", () => {
    expect(chipStateFromError(Object.assign(new Error("missing"), { code: "APPROVAL_NOT_FOUND" }))).toBe("expired");
  });

  it("keeps the existing decision-state mappings", () => {
    expect(chipStateFromError(Object.assign(new Error("x"), { code: "APPROVAL_EXPIRED" }))).toBe("expired");
    expect(
      chipStateFromError(Object.assign(new Error("x"), { code: "APPROVAL_ALREADY_DECIDED", details: { status: "approved" } }))
    ).toBe("approved");
    expect(chipStateFromError(Object.assign(new Error("x"), { code: "OTHER" }))).toBeNull();
  });
});
