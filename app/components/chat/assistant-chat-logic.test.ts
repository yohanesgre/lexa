import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { renderTranscript } from "./assistant-chat-utils";
import { chipStateFromError, dropUnknownThread, resolveChatId } from "./assistant-chat-logic";

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
  };

  it("prefers ?thread= over the active selection", () => {
    expect(resolveChatId({ ...base, thread: "t1", currentChatId: "t2" })).toBe("t1");
  });

  it("treats a ?thread= equal to the active selection as already applied", () => {
    expect(resolveChatId({ ...base, thread: "t1", currentChatId: "t1" })).toBeNull();
  });

  it("opens the fresh landing when there is no ?thread= and no active selection", () => {
    expect(resolveChatId(base)).toBeNull();
  });

  it("does not clobber an active selection", () => {
    expect(resolveChatId({ ...base, currentChatId: "active" })).toBeNull();
  });

  it("returns null without a resolved project", () => {
    expect(resolveChatId({ ...base, projectId: undefined, thread: "t1" })).toBeNull();
  });
});

describe("dropUnknownThread — fresh landing, never a list head", () => {
  const thread = (chatId: string) => ({ chatId, title: chatId, pinned: false, snippet: null, createdAt: "x", updatedAt: "x" });

  it("clears the selection, evicts the dead id and never applies the next live head", () => {
    const qc = new QueryClient();
    qc.setQueryData(["assistant-chat", "dead"], { messages: [] });
    qc.setQueryData(["assistant-chats", "p1", null], [thread("dead"), thread("live")]);
    qc.setQueryData(["assistant-chats", "p1", "q"], [thread("dead"), thread("other")]);
    const applied: string[] = [];
    let cleared = false;
    dropUnknownThread({
      qc,
      projectId: "p1",
      chatId: "dead",
      setChatId: (id) => applied.push(`set:${id}`),
      clearThreadParam: () => {
        cleared = true;
      },
      clearParam: true,
    });
    // The live head "live" must NOT be applied — only the fresh empty state.
    expect(applied).toEqual(["set:"]);
    expect(cleared).toBe(true);
    expect(qc.getQueryState(["assistant-chat", "dead"])).toBeUndefined();
    expect(qc.getQueryData(["assistant-chats", "p1", null])).toEqual([thread("live")]);
    expect(qc.getQueryData(["assistant-chats", "p1", "q"])).toEqual([thread("other")]);
  });

  it("keeps the param when the URL no longer carries the dead thread", () => {
    const qc = new QueryClient();
    let cleared = false;
    const applied: string[] = [];
    dropUnknownThread({
      qc,
      projectId: "p1",
      chatId: "dead",
      setChatId: (id) => applied.push(`set:${id}`),
      clearThreadParam: () => {
        cleared = true;
      },
      clearParam: false,
    });
    expect(applied).toEqual(["set:"]);
    expect(cleared).toBe(false);
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
